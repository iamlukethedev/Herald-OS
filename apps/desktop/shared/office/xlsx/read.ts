import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { CELL_TYPE, type CellMatrix, type CellSnapshot, type SheetSnapshot, type WorkbookSnapshot } from '../workbook.ts'
import { parseRange } from './address.ts'
import { type ExcelColor, indexedColors, type Palette, resolveColor, themeColors } from './colors.ts'
import { readExtras } from './extras.ts'
import { inspectPackage } from './fidelity.ts'
import { ERROR_VALUES, formulaFromExcel } from './formula.ts'
import { openPackage, type PackageSheet } from './package.ts'
import { conditionalFromExcel, definedNamesFromPackage, filterFromXml, linksFromXml, type Resource, RESOURCES, ruleId, type SheetLink, univerLinkPayload, type UAutoFilter, type UConditionalRule, type UValidation, validationsFromXml } from './rules.ts'
import { type BaseFont, baseStyle, EXCEL_BASE, fontStyle, styleFromExcel, type UStyle } from './styles.ts'
import { columnPixels, defaultColumnPixels, EXCEL_ROW_POINTS, pointsToPixels } from './units.ts'
import { attributesOf, elementsOf, firstElement } from './xml.ts'

/*
 * An .xlsx file as a Univer workbook snapshot. ExcelJS reads the cells, styles and layout; the
 * package itself gives what ExcelJS leaves out or mishandles (data validation, filter conditions,
 * links, defined names, the theme) and what Herald Sheets cannot keep, for the fidelity report.
 */

export interface XlsxReadResult {
  workbook: WorkbookSnapshot
  /** What Herald Sheets shows differently or drops, for the fidelity report. */
  notes: string[]
}

/** What a sheet has that Herald Sheets does not show but writes back as it was, kept in the sheet's custom data. */
export interface SheetExtras {
  page?: { pageSetup?: Record<string, unknown>; margins?: Record<string, unknown>; headerFooter?: Record<string, unknown> }
}

/** What ExcelJS gives every sheet's page setup when the file says nothing. */
const PAGE_DEFAULTS: Record<string, unknown> = { fitToPage: false, orientation: 'portrait', horizontalDpi: 4294967295, verticalDpi: 4294967295, pageOrder: 'downThenOver', blackAndWhite: false, draft: false, cellComments: 'None', errors: 'displayed', scale: 100, fitToWidth: 1, fitToHeight: 1, firstPageNumber: 1, useFirstPageNumber: false, usePrinterDefaults: false, copies: 1 }
const MARGIN_DEFAULTS: Record<string, unknown> = { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 }

/** The settings that differ from the defaults; null when none do. */
function changedFrom(settings: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> | null {
  const changed = Object.fromEntries(Object.entries(settings).filter(([key, value]) => value !== undefined && value !== null && value !== '' && value !== defaults[key]))

  return Object.keys(changed).length ? changed : null
}

const NUMBER_TEXT = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/
const DAY = 86400000
/** Day 0 of Excel's two date systems, as JavaScript times. */
const EPOCH = { date1900: Date.UTC(1899, 11, 30), date1904: Date.UTC(1904, 0, 1) }

/** The Normal font: the first font in styles.xml, which every cell without its own falls back on. */
function normalFont(stylesXml: string | undefined, palette: Palette): BaseFont {
  const fonts = stylesXml ? firstElement(stylesXml, 'fonts') : undefined
  const font = fonts ? firstElement(fonts.inner, 'font') : undefined

  if (!font) {
    return EXCEL_BASE
  }

  const attribute = (name: string, key = 'val') => {
    const match = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>`).exec(font.inner)

    return match ? attributesOf(match[0])[key] : undefined
  }
  const colorTag = /<(?:\w+:)?color\b[^>]*>/.exec(font.inner)
  const color = colorTag ? attributesOf(colorTag[0]) : {}
  const excelColor: ExcelColor = { ...(color.rgb ? { argb: color.rgb } : {}), ...(color.theme ? { theme: Number(color.theme) } : {}), ...(color.indexed ? { indexed: Number(color.indexed) } : {}), ...(color.tint ? { tint: Number(color.tint) } : {}) }
  const automatic = !colorTag || color.auto === '1' || (excelColor.theme === 1 && !excelColor.tint) || excelColor.indexed === 64

  return {
    name: attribute('name') || EXCEL_BASE.name,
    size: Number(attribute('sz')) || EXCEL_BASE.size,
    color: automatic ? null : resolveColor(excelColor, palette)
  }
}

/** The file's own number format codes, by the code ExcelJS gives (it drops backslash escapes). */
function formatCodes(stylesXml: string | undefined): (code: string) => string {
  const codes = new Map<string, string>()

  for (const { attributes } of elementsOf(firstElement(stylesXml ?? '', 'numFmts')?.inner ?? '', 'numFmt')) {
    const raw = attributes.formatCode

    if (raw && raw.includes('\\')) {
      codes.set(raw.replace(/\\(.)/g, '$1'), raw)
    }
  }

  return (code) => codes.get(code) ?? code
}

/** Univer's styles by id, shared by equal styles. */
class StyleTable {
  readonly styles: Record<string, UStyle> = {}
  private readonly ids = new Map<string, string>()
  private readonly byObject = new WeakMap<object, string | null>()

  constructor(
    private readonly base: BaseFont,
    private readonly palette: Palette,
    private readonly notes: Set<string>,
    private readonly formatCode: (code: string) => string
  ) {}

  /** The style id for an ExcelJS style; null when it says nothing beyond the default. */
  idFor(style: Partial<ExcelJS.Style> | undefined): string | null {
    if (!style || typeof style !== 'object') {
      return null
    }

    const known = this.byObject.get(style)

    if (known !== undefined) {
      return known
    }

    const converted = styleFromExcel(style, this.base, this.palette, this.notes, this.formatCode)
    const id = converted ? this.add(converted) : null
    this.byObject.set(style, id)

    return id
  }

  add(style: UStyle): string {
    const key = JSON.stringify(style)
    let id = this.ids.get(key)

    if (!id) {
      id = `s${this.ids.size + 1}`
      this.ids.set(key, id)
      this.styles[id] = style
    }

    return id
  }
}

// Whole milliseconds are subtracted before dividing: dividing first loses the last digits of a time, so it would change on every save.
const serialOf = (date: Date, date1904: boolean): number => (date.getTime() - (date1904 ? EPOCH.date1904 : EPOCH.date1900)) / DAY

/** A value (a cell's, or a formula's last result) as Univer's `v` and `t`. */
function valueOf(value: unknown, date1904: boolean): Pick<CellSnapshot, 'v' | 't'> | null {
  if (value === null || value === undefined) {
    return null
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? { v: value, t: CELL_TYPE.number } : null
  }

  if (typeof value === 'boolean') {
    return { v: value ? 1 : 0, t: CELL_TYPE.boolean }
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : { v: serialOf(value, date1904), t: CELL_TYPE.number }
  }

  if (typeof value === 'string') {
    return { v: value, t: NUMBER_TEXT.test(value.trim()) || ERROR_VALUES.has(value) ? CELL_TYPE.text : CELL_TYPE.string }
  }

  if (typeof value === 'object' && 'error' in (value as object)) {
    return { v: String((value as { error: unknown }).error), t: CELL_TYPE.string }
  }

  if (typeof value === 'object' && 'richText' in (value as object)) {
    return { v: ((value as ExcelJS.CellRichTextValue).richText ?? []).map((run) => run.text).join(''), t: CELL_TYPE.string }
  }

  return null
}

/** Univer's rich text (a small document) for a cell's text runs and link. */
export function cellDocument(text: string, runs: { text: string; style?: UStyle }[] | null, link?: { url: string; tooltip?: string }): Record<string, unknown> {
  const textRuns: { st: number; ed: number; ts: UStyle }[] = []
  let at = 0

  for (const run of runs ?? []) {
    if (run.style && Object.keys(run.style).length && run.text) {
      textRuns.push({ st: at, ed: at + run.text.length, ts: run.style })
    }

    at += run.text.length
  }

  const id = ruleId('link')

  return {
    id: 'cell',
    documentStyle: {},
    body: {
      dataStream: `${text}\r\n`,
      ...(textRuns.length ? { textRuns } : {}),
      paragraphs: [{ startIndex: text.length }],
      ...(link && text ? { customRanges: [{ startIndex: 0, endIndex: text.length - 1, rangeType: 0, rangeId: id, properties: { url: link.url, ...(link.tooltip ? { tooltip: link.tooltip } : {}) } }] } : {})
    }
  }
}

interface SheetResult {
  sheet: SheetSnapshot
  validations: UValidation[]
  filter: UAutoFilter | null
  conditional: UConditionalRule[]
}

interface Context {
  palette: Palette
  base: BaseFont
  styles: StyleTable
  notes: Set<string>
  date1904: boolean
  sheetIdByName: Map<string, string>
}

function convertSheet(worksheet: ExcelJS.Worksheet, source: PackageSheet, id: string, context: Context): SheetResult {
  const { palette, base, styles, notes, date1904 } = context
  const cellData: CellMatrix = {}
  const rowData: Record<number, Record<string, unknown>> = {}
  const columnData: Record<number, Record<string, unknown>> = {}
  const merges = new Map<string, { startRow: number; startColumn: number; endRow: number; endColumn: number }>()
  const arrays: { row: number; column: number; ref: string }[] = []
  let lastRow = -1
  let lastColumn = -1
  let formulasWithBrackets = false

  const put = (row: number, column: number, cell: CellSnapshot) => {
    cellData[row] ??= {}
    cellData[row][column] = cell
    lastRow = Math.max(lastRow, row)
    lastColumn = Math.max(lastColumn, column)
  }

  for (let r = 1; r <= worksheet.rowCount; r++) {
    const row = worksheet.findRow(r)

    if (!row) {
      continue
    }

    const rowIndex = r - 1
    const meta: Record<string, unknown> = {}

    if (typeof row.height === 'number' && row.height > 0) {
      meta.h = pointsToPixels(row.height)
    }

    if (row.hidden) {
      meta.hd = 1
    }

    const rowStyle = styles.idFor((row as unknown as { style?: Partial<ExcelJS.Style> }).style)

    if (rowStyle) {
      meta.s = rowStyle
    }

    if (Object.keys(meta).length) {
      rowData[rowIndex] = meta
      lastRow = Math.max(lastRow, rowIndex)
    }

    for (let c = 1; c <= row.cellCount; c++) {
      const cell = row.findCell(c)

      if (!cell) {
        continue
      }

      const column = c - 1
      const out: CellSnapshot = {}
      const style = styles.idFor(cell.style)

      if (style) {
        out.s = style
      }

      if (cell.type === ExcelJS.ValueType.Merge) {
        const master = cell.master
        const key = master.address
        const known = merges.get(key) ?? { startRow: Number(master.row) - 1, startColumn: Number(master.col) - 1, endRow: Number(master.row) - 1, endColumn: Number(master.col) - 1 }
        known.endRow = Math.max(known.endRow, rowIndex)
        known.endColumn = Math.max(known.endColumn, column)
        merges.set(key, known)
      } else if (cell.type === ExcelJS.ValueType.Formula) {
        const model = cell.model as ExcelJS.CellModel & { shareType?: string; ref?: string; sharedFormula?: string; formula?: string; result?: unknown }
        const text = model.formula ?? (model.sharedFormula ? undefined : cell.formula)
        const result = valueOf(model.result, date1904)
        formulasWithBrackets ||= /\[/.test(text ?? cell.formula ?? '')

        if (model.shareType === 'array' && text) {
          out.f = formulaFromExcel(text)
          out.ft = 2
          out.ref = model.ref ?? cell.address
          arrays.push({ row: rowIndex, column, ref: String(out.ref) })
        } else if (model.sharedFormula) {
          const master = worksheet.getCell(model.sharedFormula)

          if (master.formula) {
            out.si = `${id}!${model.sharedFormula}`
          } else if (cell.formula) {
            out.f = formulaFromExcel(cell.formula)
          }

          Object.assign(out, result)
        } else if (text) {
          out.f = formulaFromExcel(text)

          if (model.shareType === 'shared') {
            out.si = `${id}!${cell.address}`
          }

          Object.assign(out, result)
        } else {
          Object.assign(out, result)
        }
      } else if (cell.type === ExcelJS.ValueType.RichText) {
        const runs = (cell.value as ExcelJS.CellRichTextValue).richText ?? []
        const text = runs.map((run) => run.text).join('')
        out.v = text
        out.t = CELL_TYPE.string

        if (runs.some((run) => run.font && Object.keys(run.font).length)) {
          out.p = cellDocument(text, runs.map((run) => ({ text: run.text, style: run.font ? fontStyle(run.font, base, palette) : undefined })))
        }
      } else if (cell.type === ExcelJS.ValueType.Hyperlink) {
        const value = cell.value as ExcelJS.CellHyperlinkValue & { text?: unknown }
        Object.assign(out, valueOf(value.text ?? '', date1904))
      } else if (cell.type !== ExcelJS.ValueType.Null) {
        Object.assign(out, valueOf(cell.value, date1904))
      }

      if (Object.keys(out).length) {
        put(rowIndex, column, out)
      }
    }
  }

  // An array formula's other cells hold only its last results; Univer fills them when it works the formula out.
  for (const array of arrays) {
    const range = parseRange(array.ref)

    if (!range) {
      continue
    }

    for (let row = range.startRow; row <= range.endRow; row++) {
      for (let column = range.startColumn; column <= range.endColumn; column++) {
        const cell = cellData[row]?.[column]

        if (cell && !(row === array.row && column === array.column)) {
          const { v: _value, t: _type, ...rest } = cell

          if (Object.keys(rest).length) {
            cellData[row][column] = rest
          } else {
            delete cellData[row][column]
          }
        }
      }
    }

    const master = cellData[array.row][array.column]
    delete master.v
    delete master.t
  }

  if (formulasWithBrackets) {
    notes.add('Formulas that refer to tables by column name, or to other workbooks, do not work in Herald Sheets; they keep their last values until worked out again.')
  }

  // Links: the address from the package, the text the cell shows.
  for (const link of linksFromXml(source.tail, source.related)) {
    const cell = cellData[link.row]?.[link.column] ?? {}
    const text = typeof cell.v === 'string' || typeof cell.v === 'number' ? String(cell.v) : link.target
    const payload = univerLinkPayload(link as SheetLink, context.sheetIdByName)
    const runs = (cell.p as { body?: { textRuns?: { st: number; ed: number; ts: UStyle }[] } } | undefined)?.body?.textRuns
    const document = cellDocument(text, null, { url: payload, tooltip: link.tooltip })

    if (runs) {
      Object.assign(document.body as object, { textRuns: runs })
    }

    put(link.row, link.column, { ...cell, v: text, t: typeof cell.t === 'number' ? cell.t : CELL_TYPE.string, p: document })
  }

  for (const [index, column] of (worksheet.columns ?? []).entries()) {
    if (!column) {
      continue
    }

    const meta: Record<string, unknown> = {}
    const width = (column as { width?: number }).width

    if (typeof width === 'number' && width >= 0) {
      meta.w = columnPixels(width)
    }

    if (column.hidden) {
      meta.hd = 1
    }

    const columnStyle = styles.idFor(column.style)

    if (columnStyle) {
      meta.s = columnStyle
    }

    if (Object.keys(meta).length) {
      columnData[index] = meta
    }
  }

  const format = /<(?:\w+:)?sheetFormatPr\b[^>]*>/.exec(source.head)
  const formatAttributes = format ? attributesOf(format[0]) : {}
  const defaultRowPoints = Number(formatAttributes.defaultRowHeight) || EXCEL_ROW_POINTS
  const view = (worksheet.views?.[0] ?? {}) as Partial<ExcelJS.WorksheetViewFrozen & ExcelJS.WorksheetViewCommon & { zoomScale?: number }>
  const xSplit = view.state === 'frozen' ? Math.max(0, Math.round(view.xSplit ?? 0)) : 0
  const ySplit = view.state === 'frozen' ? Math.max(0, Math.round(view.ySplit ?? 0)) : 0
  const { filter, dropped } = filterFromXml(source.tail)

  if (dropped) {
    notes.add('Some filter conditions (by colour, top 10, dynamic dates) are not kept; the filter keeps the rest.')
  }

  // Rows a filter hid are hidden by the filter in Univer, so clearing it shows them again.
  if (filter?.filterColumns?.length) {
    const hiddenByFilter: number[] = []

    for (let row = filter.ref.startRow + 1; row <= filter.ref.endRow; row++) {
      if (rowData[row]?.hd) {
        hiddenByFilter.push(row)
        delete rowData[row].hd

        if (!Object.keys(rowData[row]).length) {
          delete rowData[row]
        }
      }
    }

    if (hiddenByFilter.length) {
      filter.cachedFilteredOut = hiddenByFilter
    }
  }

  const formats = (worksheet as unknown as { conditionalFormattings?: ExcelJS.ConditionalFormattingOptions[] }).conditionalFormattings ?? []
  const { rules: conditional, dropped: droppedRules } = conditionalFromExcel(formats, source.tail, palette)

  if (droppedRules) {
    notes.add(`${droppedRules === 1 ? 'One conditional format is' : `${droppedRules} conditional formats are`} not kept: Herald Sheets has no equivalent.`)
  }

  const extras: SheetExtras = {}
  const { printArea: _area, printTitlesRow: _rows, printTitlesColumn: _columns, margins: rawMargins, ...rawSetup } = (worksheet.pageSetup ?? {}) as Record<string, unknown>
  const pageSetup = changedFrom(rawSetup, PAGE_DEFAULTS)
  const margins = changedFrom((rawMargins ?? {}) as Record<string, unknown>, MARGIN_DEFAULTS)
  const headerFooter = changedFrom((worksheet.headerFooter ?? {}) as Record<string, unknown>, {})

  if (pageSetup || margins || headerFooter) {
    extras.page = { ...(pageSetup ? { pageSetup } : {}), ...(margins ? { margins: { ...MARGIN_DEFAULTS, ...margins } } : {}), ...(headerFooter ? { headerFooter } : {}) }
  }

  const tabColor = resolveColor(worksheet.properties?.tabColor as ExcelColor | undefined, palette)
  const sheet: SheetSnapshot = {
    id,
    name: worksheet.name,
    rowCount: Math.max(1000, lastRow + 101),
    columnCount: Math.max(26, lastColumn + 11, ...Object.keys(columnData).map((column) => Number(column) + 1)),
    cellData,
    rowData,
    columnData,
    mergeData: [...merges.values()],
    hidden: source.state === 'veryHidden' ? 2 : source.state === 'hidden' ? 1 : 0,
    tabColor: tabColor ?? '',
    freeze: { xSplit, ySplit, startRow: ySplit ? ySplit : -1, startColumn: xSplit ? xSplit : -1 },
    zoomRatio: view.zoomScale && view.zoomScale > 0 ? view.zoomScale / 100 : 1,
    showGridlines: view.showGridLines === false ? 0 : 1,
    rightToLeft: view.rightToLeft ? 1 : 0,
    defaultColumnWidth: defaultColumnPixels(Number(formatAttributes.defaultColWidth) || undefined, Number(formatAttributes.baseColWidth) || 8),
    defaultRowHeight: pointsToPixels(defaultRowPoints),
    defaultStyle: baseStyle(base),
    ...(Object.keys(extras).length ? { custom: { herald: extras } } : {})
  }

  return { sheet, validations: validationsFromXml(source.tail), filter, conditional }
}

const toBytes = (input: Uint8Array | ArrayBuffer): Uint8Array => (input instanceof Uint8Array ? input : new Uint8Array(input))

/** Parts Herald Sheets does not keep, which ExcelJS still reads (and can fail on). */
const UNKEPT_PART = /^xl\/(tables|drawings|pivotTables|pivotCache|threadedComments)\/|^xl\/comments\d*\.xml$/i
const UNKEPT_RELATIONSHIP = /\/(table|drawing|vmlDrawing|comments|pivotTable|pivotCacheDefinition|threadedComment)"/

/** The package without the parts Herald does not keep, and without what points at them. */
async function withoutUnkeptParts(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)

  for (const path of Object.keys(zip.files)) {
    if (UNKEPT_PART.test(path)) {
      zip.remove(path)
    } else if (path.endsWith('.rels')) {
      const xml = await zip.file(path)!.async('string')
      zip.file(path, xml.replace(/<Relationship\b[^>]*>/g, (tag) => (UNKEPT_RELATIONSHIP.test(tag) ? '' : tag)))
    } else if (/^xl\/worksheets\/[^/]+\.xml$/.test(path)) {
      const xml = await zip.file(path)!.async('string')
      zip.file(path, xml.replace(/<(drawing|legacyDrawing)\b[^>]*\/>/g, '').replace(/<tableParts\b[\s\S]*?<\/tableParts>|<tableParts\b[^>]*\/>/g, ''))
    } else if (/^xl\/workbook\.xml$/.test(path)) {
      const xml = await zip.file(path)!.async('string')
      zip.file(path, xml.replace(/<pivotCaches\b[\s\S]*?<\/pivotCaches>/g, ''))
    }
  }

  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' })
}

/** ExcelJS's reading of the package; when it fails on a part Herald does not keep, a second try without those parts. */
async function loadBook(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  // Data validation is read from the package: ExcelJS lists every cell of each rule's ranges.
  const options = { ignoreNodes: ['dataValidations'] } as never

  try {
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(bytes as unknown as ArrayBuffer, options)

    return book
  } catch (error) {
    const book = new ExcelJS.Workbook()

    try {
      await book.xlsx.load((await withoutUnkeptParts(bytes)) as unknown as ArrayBuffer, options)
    } catch {
      throw new Error(`Herald Sheets could not read this workbook: ${error instanceof Error ? error.message : String(error)}`)
    }

    return book
  }
}

export async function workbookFromXlsx(input: Uint8Array | ArrayBuffer, options: { id: string; name: string; extension?: string }): Promise<XlsxReadResult> {
  const bytes = toBytes(input)
  const pkg = await openPackage(bytes)
  const report = await inspectPackage(pkg, options.extension)
  const book = await loadBook(bytes)
  const palette: Palette = { theme: themeColors(pkg.themeXml), indexed: indexedColors(pkg.stylesXml) }
  const base = normalFont(pkg.stylesXml, palette)
  const notes = new Set<string>()
  const styles = new StyleTable(base, palette, notes, formatCodes(pkg.stylesXml))
  const worksheets = new Map(book.worksheets.map((worksheet) => [worksheet.name, worksheet]))
  const ids = pkg.sheets.map((sheet, index) => (sheet.kind === 'worksheet' && worksheets.has(sheet.name) ? `sheet-${index + 1}` : null))
  const sheetIdByName = new Map(pkg.sheets.flatMap((sheet, index) => (ids[index] ? [[sheet.name, ids[index]!] as const] : [])))
  const context: Context = { palette, base, styles, notes, date1904: pkg.date1904, sheetIdByName }
  const sheets: SheetSnapshot[] = []
  const validations: Record<string, UValidation[]> = {}
  const filters: Record<string, UAutoFilter> = {}
  const conditional: Record<string, UConditionalRule[]> = {}

  pkg.sheets.forEach((source, index) => {
    const id = ids[index]
    const worksheet = worksheets.get(source.name)

    if (!id || !worksheet) {
      return
    }

    const result = convertSheet(worksheet, source, id, context)
    sheets.push(result.sheet)

    if (result.validations.length) {
      validations[id] = result.validations
    }

    if (result.filter) {
      filters[id] = result.filter
    }

    if (result.conditional.length) {
      conditional[id] = result.conditional
    }
  })

  if (!sheets.length) {
    throw new Error('This workbook has no worksheets Herald Sheets can show (only charts or macro sheets).')
  }

  const { names, print } = definedNamesFromPackage(pkg.definedNames, ids)

  if (print.some((name) => /^(Print_Area|Print_Titles)$/i.test(name)) && !report.notes.some((note) => note.startsWith('Print areas'))) {
    notes.add('Print areas and print titles are not kept; page size, orientation, margins, scaling and headers stay.')
  }

  const resources: Resource[] = []
  const addResource = (name: string, value: object) => {
    if (Object.keys(value).length) {
      resources.push({ name, data: JSON.stringify(value) })
    }
  }
  addResource(RESOURCES.definedNames, names)
  addResource(RESOURCES.filter, filters)
  addResource(RESOURCES.validation, validations)
  addResource(RESOURCES.conditional, conditional)
  const extras = await readExtras(pkg, { unitId: options.id, ids, notes })
  resources.push(...extras.resources)

  for (const sheet of sheets) {
    const custom = sheet.custom as { herald?: Record<string, unknown> } | undefined

    if (extras.sheets[sheet.id]) {
      sheet.custom = { ...custom, herald: { ...extras.sheets[sheet.id], ...custom?.herald } }
    }
  }

  const activeTab = ids[pkg.activeTab] ? pkg.activeTab : ids.findIndex((sheetId, index) => sheetId && pkg.sheets[index].state === 'visible')
  const properties = Object.fromEntries(
    (['creator', 'title', 'subject', 'keywords', 'category', 'description', 'company', 'manager'] as const).flatMap((key) => {
      const value = (book as unknown as Record<string, unknown>)[key]

      // ExcelJS writes "Unknown" for a workbook without an author.
      return typeof value === 'string' && value && !(key === 'creator' && value === 'Unknown') ? [[key, value]] : []
    })
  )
  const created = book.created instanceof Date && !Number.isNaN(book.created.getTime()) ? book.created.toISOString() : undefined
  const workbook: WorkbookSnapshot = {
    id: options.id,
    name: options.name,
    appVersion: '1.0.3',
    locale: 'enUS',
    styles: styles.styles,
    sheetOrder: sheets.map((sheet) => sheet.id),
    sheets: Object.fromEntries(sheets.map((sheet) => [sheet.id, sheet])),
    defaultStyle: baseStyle(base),
    ...(pkg.date1904 ? { dateSystem: 'date1904' } : {}),
    ...(resources.length ? { resources } : {}),
    ...(activeTab >= 0 && ids[activeTab] ? { activeSheetId: ids[activeTab] } : {}),
    ...(Object.keys(properties).length || created ? { custom: { herald: { properties: { ...properties, ...(created ? { created } : {}) } } } } : {})
  }

  return { workbook, notes: [...report.notes, ...notes] }
}
