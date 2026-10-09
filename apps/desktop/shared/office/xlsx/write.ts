import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { CELL_TYPE, type CellSnapshot, cellsOf, type SheetSnapshot, type WorkbookSnapshot } from '../workbook.ts'
import { cellName, rangeName } from './address.ts'
import { argbOf } from './colors.ts'
import { finishPackage } from './finish.ts'
import { ERROR_VALUES, formulaToExcel, slideFormula } from './formula.ts'
import type { SheetExtras } from './read.ts'
import { conditionalToExcel, definedNamesXml, fileLinkTarget, filterXml, linksXml, readResource, RESOURCES, type SheetLink, type UAutoFilter, type UConditionalRule, type UDefinedName, type UValidation, validationsXml } from './rules.ts'
import { type BaseFont, composeStyles, differentDiagonals, excelFont, excelStyle, type UStyle } from './styles.ts'
import { columnWidth, pixelsToPoints } from './units.ts'
import { encodeXml } from './xml.ts'

/*
 * A Univer workbook snapshot as an .xlsx file. ExcelJS writes the cells, styles and layout into a
 * package left uncompressed; then the parts ExcelJS cannot write right (the Normal font, data
 * validation, filter conditions, links, defined names) are put in, then what ExcelJS has no model
 * for (charts, comments, the untouched parts of the file it was opened from: finish.ts), and the
 * package is compressed once.
 */

export interface XlsxWriteResult {
  bytes: Uint8Array
  /** What the file cannot keep of this workbook. */
  losses: string[]
}

/** Univer's own default font, for a workbook made in Herald without a Normal font of its own. */
export const UNIVER_BASE: BaseFont = { name: 'Arial', size: 11, color: null }

/** Text as a file holds it: control characters as `_xHHHH_`, and text that reads like such an escape escaped itself, so Excel reads back what was written. */
const escaped = (text: string): string =>
  text.replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1').replace(/[\x00-\x08\x0B-\x1F\uFFFE\uFFFF]/g, (char) => `_x${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`)

/** Sheet names a file can hold: at most 31 characters, none of [ ] : * ? / \, no quote at either end, each its own. */
export function excelSheetNames(names: string[]): string[] {
  const taken = new Set<string>()

  return names.map((name) => {
    const clean = name.replace(/[[\]:*?/\\]/g, '-').replace(/^'+|'+$/g, '').trim() || 'Sheet'
    let candidate = (clean.toLowerCase() === 'history' ? `${clean} 1` : clean).slice(0, 31)

    for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
      candidate = `${clean.slice(0, 31 - ` (${n})`.length)} (${n})`
    }

    taken.add(candidate.toLowerCase())

    return candidate
  })
}

function baseFont(workbook: WorkbookSnapshot): BaseFont {
  const first = workbook.sheets[workbook.sheetOrder[0]]
  const style = (workbook.defaultStyle ?? first?.defaultStyle) as UStyle | string | undefined
  const resolved = typeof style === 'string' ? (workbook.styles[style] as UStyle | undefined) : style

  return resolved?.ff || resolved?.fs ? { name: resolved.ff || UNIVER_BASE.name, size: resolved.fs || UNIVER_BASE.size, color: resolved.cl?.rgb ?? null } : UNIVER_BASE
}

const styleOf = (workbook: WorkbookSnapshot, style: unknown): UStyle | null => (typeof style === 'string' ? ((workbook.styles?.[style] as UStyle | undefined) ?? null) : ((style as UStyle | null | undefined) ?? null))

/** A cell's value (or a formula's last result) as ExcelJS takes it; a date stays its serial number, shown by its format. */
function valueFor(cell: CellSnapshot): ExcelJS.CellValue {
  const value = cell.v

  if (value === undefined || value === null || value === '') {
    return null
  }

  if (cell.t === CELL_TYPE.boolean) {
    return value === true || value === 1 || value === '1' || value === 'TRUE'
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  const text = String(value)

  return ERROR_VALUES.has(text) && cell.t !== CELL_TYPE.text ? ({ error: text } as ExcelJS.CellErrorValue) : text
}

interface Body {
  dataStream?: string
  textRuns?: { st: number; ed: number; ts?: UStyle }[]
  customRanges?: { startIndex: number; endIndex: number; rangeType: number; properties?: { url?: string; tooltip?: string } }[]
}

/** A cell's rich text: its text, its runs as ExcelJS's, and its link. */
function richTextOf(cell: CellSnapshot, base: BaseFont, cellStyle: UStyle): { text: string; runs: ExcelJS.RichText[] | null; link: { url: string; tooltip?: string } | null } | null {
  const body = (cell.p as { body?: Body } | undefined)?.body

  if (!body?.dataStream) {
    return null
  }

  const stream = body.dataStream.replace(/\r?\n$/, '').replace(/\r$/, '')
  // A break the file wrote as CR LF is one line break, and any other CR ends one of Univer's paragraphs: a line break too.
  const piece = (from: number, to?: number) => escaped(stream.slice(from, to).replace(/\r\n?/g, '\n'))
  const runs: ExcelJS.RichText[] = []
  let at = 0

  for (const run of (body.textRuns ?? []).slice().sort((a, b) => a.st - b.st)) {
    const start = Math.max(at, run.st)

    if (start > at) {
      runs.push({ text: piece(at, start), font: excelFont(cellStyle, base) })
    }

    if (run.ed > start) {
      runs.push({ text: piece(start, run.ed), font: excelFont(composeStyles(cellStyle, run.ts), base) })
      at = run.ed
    }
  }

  if (runs.length && at < stream.length) {
    runs.push({ text: piece(at), font: excelFont(cellStyle, base) })
  }

  const range = body.customRanges?.find((entry) => entry.rangeType === 0 && entry.properties?.url)

  return { text: piece(0), runs: runs.length ? runs : null, link: range ? { url: range.properties!.url!, ...(range.properties?.tooltip ? { tooltip: range.properties.tooltip } : {}) } : null }
}

interface SharedGroup {
  origin: { row: number; column: number; formula: string }
  members: { row: number; column: number }[]
  clean: boolean
  ref: string
}

/** A sheet's shared formulas (Univer's `si`): one whose first cell is its top-left corner stays shared. */
function sharedGroups(sheet: SheetSnapshot): Map<string, SharedGroup> {
  const groups = new Map<string, SharedGroup>()
  const members = new Map<string, { row: number; column: number }[]>()

  for (const { row, column, cell } of cellsOf(sheet)) {
    if (typeof cell.si !== 'string') {
      continue
    }

    if (cell.f) {
      groups.set(cell.si, { origin: { row, column, formula: cell.f }, members: [], clean: false, ref: '' })
    } else {
      members.set(cell.si, [...(members.get(cell.si) ?? []), { row, column }])
    }
  }

  for (const [id, group] of groups) {
    group.members = members.get(id) ?? []
    const all = [group.origin, ...group.members]
    const top = Math.min(...all.map((cell) => cell.row))
    const left = Math.min(...all.map((cell) => cell.column))
    group.clean = group.members.length > 0 && group.origin.row === top && group.origin.column === left
    group.ref = rangeName({ startRow: top, startColumn: left, endRow: Math.max(...all.map((cell) => cell.row)), endColumn: Math.max(...all.map((cell) => cell.column)) })
  }

  return groups
}

interface SheetPatch {
  validations: string
  filter: string | null
  links: SheetLink[]
}

function writeSheet(book: ExcelJS.Workbook, workbook: WorkbookSnapshot, sheet: SheetSnapshot, base: BaseFont, resources: { filters: Record<string, UAutoFilter>; conditional: Record<string, UConditionalRule[]>; validations: Record<string, UValidation[]> }, losses: Set<string>, sheetNameById: Map<string, string>): SheetPatch {
  const unitId = workbook.id
  const freeze = sheet.freeze as { xSplit?: number; ySplit?: number; startRow?: number; startColumn?: number } | undefined
  const xSplit = Math.max(0, freeze?.xSplit ?? 0)
  const ySplit = Math.max(0, freeze?.ySplit ?? 0)
  const zoom = typeof sheet.zoomRatio === 'number' && sheet.zoomRatio > 0 ? Math.round(sheet.zoomRatio * 100) : 100
  const common = { showGridLines: sheet.showGridlines !== 0, rightToLeft: sheet.rightToLeft === 1, zoomScale: Math.min(400, Math.max(10, zoom)) }
  const view = xSplit || ySplit ? { state: 'frozen' as const, xSplit, ySplit, topLeftCell: cellName(Math.max(ySplit, freeze?.startRow ?? 0), Math.max(xSplit, freeze?.startColumn ?? 0)), ...common } : { state: 'normal' as const, ...common }
  const tabColor = argbOf(typeof sheet.tabColor === 'string' ? sheet.tabColor : null)
  const defaultRow = typeof sheet.defaultRowHeight === 'number' ? pixelsToPoints(sheet.defaultRowHeight) : 15
  const ws = book.addWorksheet(sheetNameById.get(sheet.id) ?? sheet.name, {
    state: sheet.hidden === 2 ? 'veryHidden' : sheet.hidden === 1 ? 'hidden' : 'visible',
    views: [view as Partial<ExcelJS.WorksheetView>],
    properties: { defaultRowHeight: defaultRow, ...(tabColor ? { tabColor: { argb: tabColor } } : {}) } as Partial<ExcelJS.WorksheetProperties>
  })

  if (typeof sheet.defaultColumnWidth === 'number' && sheet.defaultColumnWidth !== 64) {
    Object.assign(ws.properties, { defaultColWidth: columnWidth(sheet.defaultColumnWidth) })
  }

  const extras = (sheet.custom as { herald?: SheetExtras } | undefined)?.herald

  if (extras?.page?.pageSetup || extras?.page?.margins) {
    ws.pageSetup = { ...(extras.page.pageSetup ?? {}), ...(extras.page.margins ? { margins: extras.page.margins } : {}) } as Partial<ExcelJS.PageSetup>
  }

  if (extras?.page?.headerFooter) {
    ws.headerFooter = extras.page.headerFooter as Partial<ExcelJS.HeaderFooter>
  }

  const rowStyles = new Map<number, UStyle | null>()
  const columnStyles = new Map<number, UStyle | null>()
  const filter = resources.filters[sheet.id]
  const filteredOut = new Set(filter?.cachedFilteredOut ?? [])

  for (const [key, meta] of Object.entries((sheet.columnData ?? {}) as Record<string, { w?: number; hd?: number; s?: unknown }>)) {
    const column = ws.getColumn(Number(key) + 1)
    const style = styleOf(workbook, meta?.s)

    if (typeof meta?.w === 'number') {
      column.width = columnWidth(meta.w)
    }

    if (meta?.hd) {
      column.hidden = true
    }

    if (style) {
      columnStyles.set(Number(key), style)
      column.style = excelStyle(style, base)
    }
  }

  const rowKeys = new Set([...Object.keys((sheet.rowData ?? {}) as object).map(Number), ...filteredOut])

  for (const index of rowKeys) {
    const meta = ((sheet.rowData ?? {}) as Record<number, { h?: number; ah?: number; ia?: number; hd?: number; s?: unknown }>)[index]
    const row = ws.getRow(index + 1)
    const height = meta?.ia && meta.ah ? meta.ah : meta?.h
    const style = styleOf(workbook, meta?.s)

    if (typeof height === 'number' && height > 0) {
      row.height = pixelsToPoints(height)
    }

    if (meta?.hd || filteredOut.has(index)) {
      row.hidden = true
    }

    if (style) {
      rowStyles.set(index, style)
      Object.assign(row, { style: excelStyle(style, base) })
    }
  }

  const groups = sharedGroups(sheet)
  const memberOf = new Map<string, SharedGroup>()

  for (const group of groups.values()) {
    for (const member of group.members) {
      memberOf.set(`${member.row}:${member.column}`, group)
    }
  }

  const composed = new Map<string, Partial<ExcelJS.Style>>()
  const links: SheetLink[] = []
  let formulasWithoutResults = false

  for (const { row, column, cell } of cellsOf(sheet)) {
    const own = styleOf(workbook, cell.s)
    const rowStyle = rowStyles.get(row)
    const columnStyle = columnStyles.get(column)
    const key = `${typeof cell.s === 'string' ? cell.s : JSON.stringify(cell.s ?? null)}|${rowStyles.has(row) ? row : ''}|${columnStyles.has(column) ? column : ''}`
    const layered = rowStyle || columnStyle ? composeStyles(rowStyle, columnStyle, own) : own
    let style = composed.get(key)

    if (!style) {
      style = excelStyle(layered, base)
      composed.set(key, style)
    }

    const target = ws.getCell(row + 1, column + 1)
    const result = valueFor(cell)
    const group = typeof cell.si === 'string' ? (cell.f ? groups.get(cell.si) : memberOf.get(`${row}:${column}`)) : undefined
    formulasWithoutResults ||= Boolean(cell.f || group) && (result === null || cell.ft === 2)

    if (cell.f && cell.ft === 2 && typeof cell.ref === 'string') {
      target.value = { formula: formulaToExcel(cell.f, unitId), shareType: 'array', ref: cell.ref, ...(result !== null ? { result } : {}) } as unknown as ExcelJS.CellValue
    } else if (cell.f && group?.clean) {
      target.value = { formula: formulaToExcel(cell.f, unitId), shareType: 'shared', ref: group.ref, ...(result !== null ? { result } : {}) } as unknown as ExcelJS.CellValue
    } else if (cell.f) {
      target.value = { formula: formulaToExcel(cell.f, unitId), ...(result !== null ? { result } : {}) } as ExcelJS.CellFormulaValue
    } else if (group?.clean) {
      target.value = { sharedFormula: cellName(group.origin.row, group.origin.column), ...(result !== null ? { result } : {}) } as ExcelJS.CellSharedFormulaValue
    } else if (group) {
      const slid = slideFormula(group.origin.formula, row - group.origin.row, column - group.origin.column)
      target.value = { formula: formulaToExcel(slid, unitId), ...(result !== null ? { result } : {}) } as ExcelJS.CellFormulaValue
    } else {
      const rich = richTextOf(cell, base, layered ?? {})

      if (rich) {
        target.value = rich.runs ? { richText: rich.runs } : rich.text

        if (rich.link) {
          const file = fileLinkTarget(rich.link.url, sheetNameById)

          if (file) {
            links.push({ row, column, ...file, ...(rich.link.tooltip ? { tooltip: rich.link.tooltip } : {}) })
          } else {
            losses.add('Some links to places Excel cannot name are saved as plain text.')
          }
        }
      } else {
        target.value = typeof result === 'string' ? escaped(result) : result
      }
    }

    target.style = style
  }

  if (formulasWithoutResults) {
    book.calcProperties = { ...book.calcProperties, fullCalcOnLoad: true }
  }

  for (const merge of (sheet.mergeData ?? []) as { startRow: number; startColumn: number; endRow: number; endColumn: number }[]) {
    try {
      // Each merged cell keeps its own style: the borders around a merge are on its edge cells.
      ws.mergeCellsWithoutStyle(merge.startRow + 1, merge.startColumn + 1, merge.endRow + 1, merge.endColumn + 1)
    } catch {
      losses.add('Merged cells that overlap other merged cells are saved unmerged.')
    }
  }

  const { formats, losses: conditionalLosses } = conditionalToExcel(resources.conditional[sheet.id] ?? [], unitId)
  formats.forEach((format) => ws.addConditionalFormatting(format))
  conditionalLosses.forEach((loss) => losses.add(loss))

  if (filter?.ref) {
    ws.autoFilter = rangeName(filter.ref)
  }

  const { xml: validations, losses: validationLosses } = validationsXml(resources.validations[sheet.id] ?? [], unitId)
  validationLosses.forEach((loss) => losses.add(loss))

  return { validations, filter: filter?.ref ? filterXml(filter) : null, links }
}

/** The ExcelJS font of the Normal style, as styles.xml's first `<font>`. */
function normalFontXml(base: BaseFont): string {
  const argb = argbOf(base.color)

  return `<font><sz val="${base.size}"/>${argb ? `<color rgb="${argb}"/>` : '<color theme="1"/>'}<name val="${encodeXml(base.name)}"/><family val="2"/></font>`
}

const LATER_ELEMENTS = ['printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst']

/** Put `xml` into a worksheet where the schema has it: before the first of the elements that follow it. */
function insertBeforeLater(sheetXml: string, xml: string): string {
  if (!xml) {
    return sheetXml
  }

  const at = LATER_ELEMENTS.map((name) => sheetXml.search(new RegExp(`<${name}[\\s/>]`))).filter((index) => index >= 0)
  const position = at.length ? Math.min(...at) : sheetXml.lastIndexOf('</worksheet>')

  return `${sheetXml.slice(0, position)}${xml}${sheetXml.slice(position)}`
}

const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const HYPERLINK_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink'

async function patchPackage(zip: JSZip, base: BaseFont, patches: SheetPatch[], definedNames: string): Promise<void> {
  const styles = await zip.file('xl/styles.xml')?.async('string')

  if (styles && (base.name !== 'Calibri' || base.size !== 11 || base.color)) {
    zip.file('xl/styles.xml', styles.replace(/(<fonts\b[^>]*>)<font>[\s\S]*?<\/font>/, `$1${normalFontXml(base)}`))
  }

  for (const [index, patch] of patches.entries()) {
    const path = `xl/worksheets/sheet${index + 1}.xml`
    let xml = await zip.file(path)?.async('string')

    if (!xml) {
      continue
    }

    if (patch.filter) {
      xml = xml.replace(/<autoFilter\b[^>]*\/>/, patch.filter)
    }

    let relationships = ''

    if (patch.links.length) {
      const relsPath = `xl/worksheets/_rels/sheet${index + 1}.xml.rels`
      const existing = (await zip.file(relsPath)?.async('string')) ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELATIONSHIPS}"></Relationships>`
      const ids = new Map<string, string>()
      let next = 1
      const relate = (target: string) => {
        let id = ids.get(target)

        if (!id) {
          while (existing.includes(`Id="rIdLink${next}"`)) {
            next++
          }

          id = `rIdLink${next++}`
          ids.set(target, id)
          relationships += `<Relationship Id="${id}" Type="${HYPERLINK_TYPE}" Target="${encodeXml(target)}" TargetMode="External"/>`
        }

        return id
      }
      const hyperlinks = linksXml(patch.links, relate)
      xml = insertBeforeLater(xml, `${patch.validations}${hyperlinks}`)

      if (relationships) {
        zip.file(relsPath, existing.replace('</Relationships>', `${relationships}</Relationships>`))
      }
    } else {
      xml = insertBeforeLater(xml, patch.validations)
    }

    zip.file(path, xml)
  }

  if (definedNames) {
    const workbook = await zip.file('xl/workbook.xml')?.async('string')

    if (workbook) {
      zip.file('xl/workbook.xml', workbook.includes('<definedNames>') ? workbook.replace('<definedNames>', definedNames.replace('</definedNames>', '')) : workbook.replace('</sheets>', `</sheets>${definedNames}`))
    }
  }
}

/** The workbook as an .xlsx file; with the file it was opened from, the parts of that file Herald does not model come along. */
export async function xlsxFromWorkbook(workbook: WorkbookSnapshot, options: { original?: Uint8Array } = {}): Promise<XlsxWriteResult> {
  const book = new ExcelJS.Workbook()
  const losses = new Set<string>()
  const base = baseFont(workbook)

  if (Object.values(workbook.styles ?? {}).some((style) => differentDiagonals((style as UStyle | null)?.bd))) {
    losses.add('Cells with different diagonal borders each way are saved with one diagonal style, as Excel has one.')
  }

  const properties = (workbook.custom as { herald?: { properties?: Record<string, string> } } | undefined)?.herald?.properties ?? {}

  for (const key of ['creator', 'title', 'subject', 'keywords', 'category', 'description', 'company', 'manager'] as const) {
    if (properties[key]) {
      Object.assign(book, { [key]: properties[key] })
    }
  }

  book.created = properties.created ? new Date(properties.created) : new Date()
  book.modified = new Date()

  if (workbook.dateSystem === 'date1904') {
    book.properties.date1904 = true
  }

  const resources = {
    filters: readResource<Record<string, UAutoFilter>>(workbook.resources, RESOURCES.filter) ?? {},
    conditional: readResource<Record<string, UConditionalRule[]>>(workbook.resources, RESOURCES.conditional) ?? {},
    validations: readResource<Record<string, UValidation[]>>(workbook.resources, RESOURCES.validation) ?? {}
  }
  const order = workbook.sheetOrder.filter((id) => workbook.sheets[id])
  const sheetNames = excelSheetNames(order.map((id) => String(workbook.sheets[id].name ?? '')))
  const sheetNameById = new Map(order.map((id, index) => [id, sheetNames[index]]))

  if (order.some((id, index) => workbook.sheets[id].name !== sheetNames[index])) {
    losses.add('Sheet names Excel does not allow (more than 31 characters, or any of [ ] : * ? / \\) are shortened or changed.')
  }
  const patches = order.map((id) => writeSheet(book, workbook, workbook.sheets[id], base, resources, losses, sheetNameById))
  const active = typeof workbook.activeSheetId === 'string' ? order.indexOf(workbook.activeSheetId) : -1
  book.views = [{ x: 0, y: 0, width: 28800, height: 17600, firstSheet: 0, activeTab: Math.max(0, active), visibility: 'visible' }]
  const names = readResource<Record<string, UDefinedName>>(workbook.resources, RESOURCES.definedNames)
  const buffer = await book.xlsx.writeBuffer({ zip: { compression: 'STORE' } } as never)
  const zip = await JSZip.loadAsync(buffer as ArrayBuffer)
  await patchPackage(zip, base, patches, definedNamesXml(names, order, workbook.id))
  await finishPackage(
    zip,
    workbook,
    order.map((id, index) => ({ id, name: sheetNames[index], path: `xl/worksheets/sheet${index + 1}.xml` })),
    { original: options.original, losses }
  )
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })

  return { bytes, losses: [...losses] }
}
