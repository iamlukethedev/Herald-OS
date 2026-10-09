import { fieldFromCell, type NumberFormatter, patternOf } from '../../../../shared/office/sheet-csv.ts'
import { type CellSnapshot, cellsOf, type SheetSnapshot, type WorkbookSnapshot } from '../../../../shared/office/workbook.ts'
import type { UStyle } from '../../../../shared/office/xlsx/styles.ts'
import { escapeHtml, printPage } from '../print.ts'

/*
 * The print view of the sheet in front: its used range as a table, with the fonts, fills, borders,
 * alignment, merged cells, sizes and number formats it shows; hidden rows and columns left out.
 * It follows the page setup the sheet brought from its file: the paper, which way it is turned,
 * the margins, the scale or fitting to so many pages, centring across the page, and the header
 * and footer (page numbers and all). Without one it is landscape when wider than the paper.
 */

/** The sheet the window has in front, kept on the snapshot it hands over for saving and printing. */
export const activeSheetOf = (workbook: WorkbookSnapshot): string | undefined => (typeof workbook.activeSheetId === 'string' ? workbook.activeSheetId : undefined)

/** Excel's paper sizes that CSS can name, in inches; any other prints on A4. */
const PAPERS: Record<number, { name: string; width: number; height: number }> = {
  1: { name: 'letter', width: 8.5, height: 11 },
  5: { name: 'legal', width: 8.5, height: 14 },
  8: { name: 'A3', width: 11.69, height: 16.54 },
  9: { name: 'A4', width: 8.27, height: 11.69 },
  11: { name: 'A5', width: 5.83, height: 8.27 }
}

interface Margins {
  left: number
  right: number
  top: number
  bottom: number
  header: number
  footer: number
}

/** Herald's margins for a sheet without a page setup, and Excel's for one whose file left them as they come. */
const HERALD_MARGINS: Margins = { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 }
const EXCEL_MARGINS: Margins = { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 }

// The page's size, turn and margins come from its CSS (main prints with the page's own size); `boxes` are its header and footer.
const pageCss = (paper: string, landscape: boolean, margins: Margins, boxes = '') => `@page { size: ${paper} ${landscape ? 'landscape' : 'portrait'}; margin: ${margins.top}in ${margins.right}in ${margins.bottom}in ${margins.left}in;${boxes ? ` ${boxes}` : ''} }`

interface PageSetup {
  orientation?: string
  paperSize?: number
  scale?: number
  fitToPage?: boolean
  fitToWidth?: number
  fitToHeight?: number
  horizontalCentered?: boolean
}

/** What the sheet brought from its file: page setup, margins (inches) and header and footer, as read kept them. */
const pageOf = (sheet: SheetSnapshot): { pageSetup?: PageSetup; margins?: Partial<Margins>; headerFooter?: { oddHeader?: string; oddFooter?: string } } | null => (sheet.custom as { herald?: { page?: object } } | undefined)?.herald?.page ?? null

/** Excel's header and footer codes for the page number, the page count, the date and so on, as CSS content. */
function headerContent(text: string, fields: { file: string; sheet: string; now: Date }): string {
  const parts: string[] = []
  let literal = ''
  const flush = () => {
    if (literal) {
      // The CSS sits in a <style> element, so a < in the text is escaped too.
      parts.push(`"${literal.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\3C ').replace(/\r?\n/g, '\\A ')}"`)
      literal = ''
    }
  }

  // Fonts (&"Arial,Bold"), sizes (&12), colours (&KFF0000) and toggles (&B, &I, &U, &S, &X, &Y) are dropped; pictures (&G) too.
  const pattern = /&"[^"]*"|&K[0-9A-Fa-f]{6}|&K\d{2}[+-]\d{3}|&\d+|&([PNDTFAZGBIUSXY&])|([^&]+)|&/g

  for (const [, code, plain] of text.matchAll(pattern)) {
    if (plain) {
      literal += plain
    } else if (code === '&') {
      literal += '&'
    } else if (code === 'P' || code === 'N') {
      flush()
      parts.push(code === 'P' ? 'counter(page)' : 'counter(pages)')
    } else if (code === 'D') {
      literal += fields.now.toLocaleDateString()
    } else if (code === 'T') {
      literal += fields.now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    } else if (code === 'F') {
      literal += fields.file
    } else if (code === 'A') {
      literal += fields.sheet
    }
  }

  flush()

  return parts.join(' ')
}

/** A header or footer's left, centre and right parts (&L, &C, &R), as page margin boxes. */
function marginBoxes(text: string | undefined, edge: 'top' | 'bottom', offset: number, fields: { file: string; sheet: string; now: Date }): string {
  if (!text) {
    return ''
  }

  const sections: Record<string, string> = { L: '', C: '', R: '' }
  let current = 'C'

  for (const [, section, rest] of text.matchAll(/&([LCR])|((?:[^&]|&(?![LCR]))+)/g)) {
    if (section) {
      current = section
    } else {
      sections[current] += rest
    }
  }

  const align = { L: 'left', C: 'center', R: 'right' } as Record<string, string>
  const boxes = Object.entries(sections).filter(([, content]) => content).map(([section, content]) => {
    const box = `${edge}-${align[section]}`
    const place = edge === 'top' ? `vertical-align: top; padding-top: ${offset}in` : `vertical-align: bottom; padding-bottom: ${offset}in`

    return `@${box} { content: ${headerContent(content, fields) || '""'}; text-align: ${align[section]}; ${place}; font: 9pt Arial, Helvetica, sans-serif; white-space: pre; }`
  })

  return boxes.join(' ')
}

const CSS = `
body { font: 9pt Arial, Helvetica, sans-serif; color: #000; margin: 0; }
h1 { font-size: 11pt; margin: 0 0 6pt; }
table { border-collapse: collapse; table-layout: fixed; }
td { border: 0.5pt solid #c8ccd4; padding: 1pt 3pt; white-space: nowrap; overflow: hidden; vertical-align: bottom; }
td.n { text-align: right; }
`

const BORDER_CSS = ['none', '1px solid', '1px solid', '1px dotted', '1px dashed', '1px dashed', '1px dotted', '3px double', '2px solid', '2px dashed', '2px dashed', '2px dotted', '2px dashed', '3px solid']
const ALIGN = ['', 'left', 'center', 'right', 'justify', 'justify', 'center']
const VALIGN = ['', 'top', 'middle', 'bottom']

const styleOf = (workbook: WorkbookSnapshot, style: unknown): UStyle | null => (typeof style === 'string' ? ((workbook.styles?.[style] as UStyle | undefined) ?? null) : ((style as UStyle | null) ?? null))

/** A cell's style (over its row's and column's) as CSS. */
function cellCss(style: UStyle | null): string {
  if (!style) {
    return ''
  }

  const css: string[] = []
  const color = (value: { rgb?: string | null } | null | undefined) => (value?.rgb ? value.rgb : null)

  if (style.ff) {
    css.push(`font-family:'${style.ff.replace(/'/g, '')}',sans-serif`)
  }

  if (style.fs) {
    css.push(`font-size:${style.fs}pt`)
  }

  if (style.bl) {
    css.push('font-weight:bold')
  }

  if (style.it) {
    css.push('font-style:italic')
  }

  const lines = [style.ul?.s ? 'underline' : '', style.st?.s ? 'line-through' : ''].filter(Boolean)

  if (lines.length) {
    css.push(`text-decoration:${lines.join(' ')}`)
  }

  if (color(style.cl)) {
    css.push(`color:${color(style.cl)}`)
  }

  if (color(style.bg)) {
    css.push(`background:${color(style.bg)}`)
  }

  for (const [side, name] of [['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left']] as const) {
    const border = style.bd?.[side]

    if (border && border.s > 0) {
      css.push(`border-${name}:${BORDER_CSS[border.s] ?? '1px solid'} ${color(border.cl) ?? '#000'}`)
    }
  }

  if (style.ht && ALIGN[style.ht]) {
    css.push(`text-align:${ALIGN[style.ht]}`)
  }

  if (style.vt && VALIGN[style.vt]) {
    css.push(`vertical-align:${VALIGN[style.vt]}`)
  }

  if (style.tb === 3) {
    css.push('white-space:normal;overflow-wrap:anywhere')
  }

  if (style.pd?.l) {
    css.push(`padding-left:${style.pd.l}px`)
  }

  return css.join(';')
}

interface Line {
  size: number
  hidden: boolean
}

function lines(data: unknown, count: number, fallback: number, key: 'h' | 'w'): Line[] {
  const meta = (data ?? {}) as Record<number, { h?: number; w?: number; hd?: number }>

  return Array.from({ length: count }, (_, i) => ({ size: meta[i]?.[key] ?? fallback, hidden: Boolean(meta[i]?.hd) }))
}

/** The part of a sheet with something in it, merged cells included. */
function usedRange(sheet: SheetSnapshot): { rows: number; columns: number } {
  let rows = 0
  let columns = 0

  for (const { row, column, cell } of cellsOf(sheet)) {
    if (fieldFromCell(cell) !== '' || cell.p) {
      rows = Math.max(rows, row + 1)
      columns = Math.max(columns, column + 1)
    }
  }

  for (const merge of (sheet.mergeData ?? []) as { endRow: number; endColumn: number }[]) {
    rows = Math.max(rows, merge.endRow + 1)
    columns = Math.max(columns, merge.endColumn + 1)
  }

  return { rows, columns }
}

const textOf = (cell: CellSnapshot | undefined, pattern: string | null, format: NumberFormatter | undefined): string => {
  const stream = (cell?.p as { body?: { dataStream?: string } } | undefined)?.body?.dataStream

  return stream && cell?.v === undefined ? stream.replace(/\r?\n$/, '').replace(/\r/g, '\n') : fieldFromCell(cell, pattern, format)
}

export function printHtml(workbook: WorkbookSnapshot, title: string, format?: NumberFormatter, now = new Date()): { html: string; landscape: boolean } {
  const sheet = workbook.sheets[activeSheetOf(workbook) ?? ''] ?? workbook.sheets[workbook.sheetOrder[0]]

  if (!sheet) {
    return { html: printPage(title, `${pageCss('A4', false, HERALD_MARGINS)}${CSS}`, ''), landscape: false }
  }

  const { rows, columns } = usedRange(sheet)
  const rowLines = lines(sheet.rowData, rows, typeof sheet.defaultRowHeight === 'number' ? sheet.defaultRowHeight : 24, 'h')
  const columnLines = lines(sheet.columnData, columns, typeof sheet.defaultColumnWidth === 'number' ? sheet.defaultColumnWidth : 88, 'w')
  const covered = new Set<string>()
  const spans = new Map<string, { rows: number; columns: number }>()

  for (const merge of (sheet.mergeData ?? []) as { startRow: number; startColumn: number; endRow: number; endColumn: number }[]) {
    const visible = (from: number, to: number, list: Line[]) => list.slice(from, to + 1).filter((line) => !line.hidden).length
    spans.set(`${merge.startRow}:${merge.startColumn}`, { rows: visible(merge.startRow, merge.endRow, rowLines), columns: visible(merge.startColumn, merge.endColumn, columnLines) })

    for (let row = merge.startRow; row <= merge.endRow; row++) {
      for (let column = merge.startColumn; column <= merge.endColumn; column++) {
        if (row !== merge.startRow || column !== merge.startColumn) {
          covered.add(`${row}:${column}`)
        }
      }
    }
  }

  const rowStyles = (sheet.rowData ?? {}) as Record<number, { s?: unknown }>
  const columnStyles = (sheet.columnData ?? {}) as Record<number, { s?: unknown }>
  const body: string[] = []

  for (let row = 0; row < rows; row++) {
    if (rowLines[row].hidden) {
      continue
    }

    const cells: string[] = []

    for (let column = 0; column < columns; column++) {
      if (columnLines[column].hidden || covered.has(`${row}:${column}`)) {
        continue
      }

      const cell = sheet.cellData[row]?.[column]
      const style = { ...styleOf(workbook, rowStyles[row]?.s), ...styleOf(workbook, columnStyles[column]?.s), ...styleOf(workbook, cell?.s) } as UStyle
      const css = cellCss(Object.keys(style).length ? style : null)
      const span = spans.get(`${row}:${column}`)
      const attributes = [typeof cell?.v === 'number' && cell.t !== 3 ? ' class="n"' : '', span && span.rows > 1 ? ` rowspan="${span.rows}"` : '', span && span.columns > 1 ? ` colspan="${span.columns}"` : '', css ? ` style="${escapeHtml(css)}"` : '']
      cells.push(`<td${attributes.join('')}>${escapeHtml(textOf(cell, patternOf(workbook, sheet, row, column, cell), format)).replace(/\n/g, '<br>')}</td>`)
    }

    const height = rowLines[row].size
    body.push(height && height !== 24 ? `<tr style="height:${height}px">${cells.join('')}</tr>` : `<tr>${cells.join('')}</tr>`)
  }

  const shownColumns = columnLines.filter((line) => !line.hidden)
  const width = shownColumns.reduce((sum, line) => sum + line.size, 0)
  const colgroup = shownColumns.length ? `<colgroup>${shownColumns.map((line) => `<col style="width:${line.size}px">`).join('')}</colgroup>` : ''
  const base = styleOf(workbook, workbook.defaultStyle)
  const bodyCss = base?.ff || base?.fs ? `body { font-family: '${String(base.ff ?? 'Arial').replace(/'/g, '')}', Arial, sans-serif; font-size: ${base.fs ?? 9}pt; }` : ''

  const page = pageOf(sheet)
  const setup = page?.pageSetup ?? {}
  const margins: Margins = { ...(page ? EXCEL_MARGINS : HERALD_MARGINS), ...page?.margins }
  const paper = PAPERS[setup.paperSize ?? 9] ?? PAPERS[9]
  const scale = setup.scale ?? 100
  const landscape = setup.orientation === 'landscape' || (!setup.fitToPage && scale === 100 && width > (paper.width - margins.left - margins.right) * 96)
  const fields = { file: title, sheet: sheet.name, now }
  const { oddHeader, oddFooter } = page?.headerFooter ?? {}
  const boxes = `${marginBoxes(oddHeader, 'top', margins.header, fields)}${marginBoxes(oddFooter, 'bottom', margins.footer, fields)}`
  // The sheet's name heads the page unless its file gives the page a header or footer of its own.
  const heading = boxes ? '' : `<h1>${escapeHtml(sheet.name)}</h1>`

  // Fitting to so many pages across and down (0 for as many as it takes) scales down, never up, and not below 10%, as Excel does.
  const across = ((landscape ? paper.height : paper.width) - margins.left - margins.right) * 96
  const down = ((landscape ? paper.width : paper.height) - margins.top - margins.bottom) * 96
  const height = rowLines.filter((line) => !line.hidden).reduce((sum, line) => sum + line.size, heading ? 24 : 0)
  const [wide, tall] = [setup.fitToWidth ?? 1, setup.fitToHeight ?? 1]
  const zoom = setup.fitToPage ? Math.max(0.1, Math.min(1, wide && width ? (across * wide) / width : 1, tall && height ? (down * tall) / height : 1)) : Math.min(4, Math.max(0.1, scale / 100))
  const tableCss = [`width:${width}px`, zoom !== 1 ? `zoom:${Number(zoom.toFixed(4))}` : '', setup.horizontalCentered ? 'margin:0 auto' : ''].filter(Boolean).join(';')

  return {
    html: printPage(title, `${pageCss(paper.name, landscape, margins, boxes)}${CSS}${bodyCss}`, `${heading}<table style="${tableCss}">${colgroup}${body.join('')}</table>`),
    landscape
  }
}
