import { type ICellData, isNullCell, type Nullable } from '@univerjs/core'
import { type CellRange, cellName, columnName, rangeName } from '../../../../../shared/office/xlsx/address.ts'
import { slideFormula } from '../../../../../shared/office/xlsx/formula.ts'
import { type CellInput, oneStep, parseTarget, type SheetsTarget, sheetOf } from '../model.ts'
import { type Area, areaOf, type CellChange, columnIn, fieldNames, flag, isFormula, listOf, looksLikeHeader, MOST_CELLS, rangeOn, textIn, valuesIn, writeCells } from './table.ts'
import { changeCaseOf, cleanText, DATE_ORDERS, type DateOrder, type Delimiter, DELIMITERS, parseDateText, parseNumberText, splitParts, TEXT_CASES, type TextCase, typedPart } from './text.ts'

/*
 * What Hermes's commands and the menus do with data tools (removing duplicates, splitting text,
 * cleaning, converting, filling, sorting by several columns) and summaries in the style of pivot
 * tables, on a workbook (see ../model.ts). A range is A1 text on the sheet in front unless it
 * names another; one cell stands for the table around it. Each change is one step to undo; with
 * `preview`, nothing changes and the result says what would. Text tools leave formulas, numbers
 * and linked text alone.
 */

export * from './summary.ts'
export { MOST_CELLS } from './table.ts'

/** An area's cells as Univer keeps them, row by row; too large an area is refused. */
function cellsIn(area: Area): Nullable<ICellData>[][] {
  const count = (area.cells.endRow - area.cells.startRow + 1) * (area.cells.endColumn - area.cells.startColumn + 1)

  if (count > MOST_CELLS) {
    throw new Error(`${rangeName(area.cells)} has ${count.toLocaleString('en-US')} cells; a data tool works on at most ${MOST_CELLS.toLocaleString('en-US')} at a time`)
  }

  return area.range.getCellDatas()
}

const textCell = (text: string): ICellData => (text ? { v: text, t: 1, p: null } : { v: null, p: null })

/** How a value compares for duplicates: text in any case is the same text, numbers by value; an empty cell is empty. */
const sameKey = (value: CellInput): string => (value === null || value === '' ? '' : typeof value === 'string' ? `t${value.toLowerCase()}` : typeof value === 'number' ? `n${value}` : `b${value}`)

/** An area's headers, when it has them (given, or as its first row reads), and a name for each column. */
function headersOf(area: Area, values: CellInput[][], header: unknown): { header: boolean; names: string[] | null } {
  const has = flag(header, 'header', looksLikeHeader(values))

  return { header: has, names: has ? fieldNames(values[0] ?? [], area.cells.startColumn) : null }
}

export interface DuplicatesResult {
  sheet: string
  range: string
  header: boolean
  /** The columns compared, as letters. */
  columns: string[]
  /** Rows that repeat an earlier one in the compared columns: the ones taken out. */
  duplicates: number
  /** Rows left, each different from the others. */
  kept: number
  /** The sheet's numbers of the rows taken out, as they were before (the first 1,000). */
  removed: number[]
  preview: boolean
}

/**
 * Take out the rows of a range that repeat an earlier row in `columns` (all of them when none are
 * named), keeping the first of each. The rows under them in the range move up, formulas with
 * them, and the range ends in empty rows; nothing outside it moves, as in Excel. Text compares in
 * any case; empty rows are not counted.
 */
export async function removeDuplicates(target: SheetsTarget, args: { range: unknown; columns?: unknown; header?: unknown; preview?: unknown; sheet?: unknown }): Promise<DuplicatesResult> {
  const area = areaOf(target.workbook, args.range, args.sheet)
  const cells = cellsIn(area)
  const values = valuesIn(cells)
  const { header, names } = headersOf(area, values, args.header)
  const preview = flag(args.preview, 'preview', false)
  const all = Array.from({ length: area.cells.endColumn - area.cells.startColumn + 1 }, (_, i) => area.cells.startColumn + i)
  const columns = args.columns === undefined || args.columns === null || (Array.isArray(args.columns) && !args.columns.length) ? all : listOf(args.columns).map((by) => columnIn(area.cells, names, by))

  if (new Set(columns).size !== columns.length) {
    throw new Error('Name each column to compare once')
  }

  const seen = new Set<string>()
  const removed: number[] = []
  let kept = 0

  values.forEach((row, index) => {
    if ((header && index === 0) || row.every((value) => value === null || value === '')) {
      return
    }

    const key = columns.map((column) => sameKey(row[column - area.cells.startColumn])).join('\u0000')

    if (seen.has(key)) {
      removed.push(area.cells.startRow + index)
    } else {
      seen.add(key)
      kept++
    }
  })

  if (!preview && removed.length) {
    const gone = new Set(removed.map((row) => row - area.cells.startRow))
    const kept = cells.map((_, index) => index).filter((index) => !gone.has(index))
    const first = Math.min(...gone)
    const formulas = area.range.getFormulas()
    const emptied: CellChange[] = []
    const moved: CellChange[] = []

    for (let index = first; index < cells.length; index++) {
      const from = kept[index]

      cells[index].forEach((_, j) => {
        const position = { row: area.cells.startRow + index, column: area.cells.startColumn + j }
        const cell = from === undefined ? null : cells[from][j]
        emptied.push({ ...position, cell: { v: null, f: null, si: null, p: null, s: null } })

        if (cell) {
          const formula = formulas[from][j]
          moved.push({ ...position, cell: formula ? { ...cell, f: slideFormula(formula, index - from, 0), si: null } : { ...cell, f: null, si: null } })
        }
      })
    }

    // Emptied first, so that a moved cell takes its own format rather than one mixed with the format there.
    await oneStep(target, () => {
      writeCells(area.sheet, emptied)
      writeCells(area.sheet, moved)
    })
  }

  return { sheet: area.sheet.getSheetName(), range: rangeName(area.cells), header, columns: columns.map(columnName), duplicates: removed.length, kept, removed: removed.slice(0, 1000).map((row) => row + 1), preview }
}

const DELIMITER_NAMES = [...Object.keys(DELIMITERS), 'other'] as Delimiter[]

export interface SplitResult {
  sheet: string
  range: string
  /** Where the parts go (or would): the first column is the range's own unless a destination is given. */
  destination: string
  /** The most parts a cell splits into. */
  columns: number
  /** Cells split into more than one part. */
  rows: number
  /** Cells with data outside the range that the parts write over. */
  overwrites: number
  /** The first rows' parts. */
  preview: CellInput[][]
}

/**
 * Split the text of one column at a delimiter into the columns to its right (or from
 * `destination`). Numbers become numbers (not ones with leading zeros); formulas, numbers and
 * linked text stay as they are. Cells with data in the way are not written over unless `overwrite`.
 */
export async function splitText(target: SheetsTarget, args: { range: unknown; delimiter: unknown; other?: unknown; consecutive?: unknown; destination?: unknown; overwrite?: unknown; preview?: unknown; sheet?: unknown }): Promise<SplitResult & { changed: boolean }> {
  const area = areaOf(target.workbook, args.range, args.sheet, { column: true })

  if (area.cells.startColumn !== area.cells.endColumn) {
    throw new Error(`${rangeName(area.cells)} is ${area.cells.endColumn - area.cells.startColumn + 1} columns wide: split one column at a time, like ${rangeName({ ...area.cells, endColumn: area.cells.startColumn })}`)
  }

  const delimiterName = String(args.delimiter ?? '').trim().toLowerCase() as Delimiter

  if (!DELIMITER_NAMES.includes(delimiterName)) {
    throw new Error(`Say how to split: delimiter is ${DELIMITER_NAMES.join(', ')} (with other, the text to split at in "other")`)
  }

  const delimiter = delimiterName === 'other' ? String(args.other ?? '') : DELIMITERS[delimiterName]

  if (!delimiter) {
    throw new Error('Give the text to split at in "other", like "|" or " - "')
  }

  const consecutive = flag(args.consecutive, 'consecutive', false)
  const overwrite = flag(args.overwrite, 'overwrite', false)
  const preview = flag(args.preview, 'preview', false)
  let to = { row: area.cells.startRow, column: area.cells.startColumn }
  let sheet = area.sheet

  if (args.destination !== undefined && args.destination !== null && args.destination !== '') {
    const parsed = parseTarget(args.destination)
    sheet = sheetOf(target.workbook, parsed.sheet ?? area.sheet.getSheetName())
    to = { row: parsed.range.startRow, column: parsed.range.startColumn }
  }

  const cells = cellsIn(area)
  const elsewhere = sheet.getSheetId() !== area.sheet.getSheetId() || to.row !== area.cells.startRow || to.column !== area.cells.startColumn
  const changes: CellChange[] = []
  const rows: CellInput[][] = []
  let width = 0
  let split = 0

  cells.forEach(([cell], index) => {
    const text = textIn(cell)
    const parts = text === null ? null : splitParts(text, delimiter, consecutive).map(typedPart)
    const row = to.row + index

    if (parts) {
      width = Math.max(width, parts.length)
      split += parts.length > 1 ? 1 : 0
      rows.push(parts)
      parts.forEach((part, offset) => changes.push({ row, column: to.column + offset, cell: typeof part === 'number' ? { v: part, t: 2, p: null } : textCell(part ?? '') }))

      return
    }

    const value = isFormula(cell) ? null : valuesIn([[cell]])[0][0]
    rows.push([value])

    // A value that does not split still goes to a destination of its own.
    if (cell && value !== null && elsewhere) {
      changes.push({ row, column: to.column, cell: { ...cell, f: null, si: null } })
    }
  })

  const matrix = sheet.getSheet().getCellMatrix()
  const own = (change: CellChange) => sheet.getSheetId() === area.sheet.getSheetId() && change.column === area.cells.startColumn && change.row >= area.cells.startRow && change.row <= area.cells.endRow
  const overwrites = changes.filter((change) => !own(change) && !isNullCell(matrix.getValue(change.row, change.column))).length
  const destination = rangeName({ startRow: to.row, startColumn: to.column, endRow: to.row + cells.length - 1, endColumn: to.column + Math.max(1, width) - 1 })
  const result = { sheet: sheet.getSheetName(), range: rangeName(area.cells), destination, columns: width, rows: split, overwrites, preview: rows.slice(0, 5) }

  if (preview || !split) {
    return { ...result, changed: false }
  }

  if (overwrites && !overwrite) {
    throw new Error(`Splitting writes over ${overwrites === 1 ? 'a cell' : `${overwrites} cells`} with data in ${destination}: give overwrite: true, or another destination`)
  }

  await oneStep(target, () => writeCells(sheet, changes))

  return { ...result, changed: true }
}

/** Rewrite the text cells of an area through `change`; one step to undo, none when nothing changes. */
async function rewriteText(target: SheetsTarget, args: { range: unknown; sheet?: unknown }, change: (text: string) => string): Promise<{ sheet: string; range: string; cells: number; changed: number }> {
  const area = areaOf(target.workbook, args.range, args.sheet)
  const changes: CellChange[] = []
  let cells = 0

  cellsIn(area).forEach((row, i) =>
    row.forEach((cell, j) => {
      const text = textIn(cell)

      if (text === null) {
        return
      }

      cells++
      const next = change(text)

      if (next !== text) {
        changes.push({ row: area.cells.startRow + i, column: area.cells.startColumn + j, cell: textCell(next) })
      }
    })
  )

  if (changes.length) {
    await oneStep(target, () => writeCells(area.sheet, changes))
  }

  return { sheet: area.sheet.getSheetName(), range: rangeName(area.cells), cells, changed: changes.length }
}

/** Trim the text in a range, make runs of spaces inside it one, and take out characters that print nothing. */
export function trimText(target: SheetsTarget, args: { range: unknown; sheet?: unknown }): Promise<{ sheet: string; range: string; cells: number; changed: number }> {
  return rewriteText(target, args, cleanText)
}

/** Put the text in a range in UPPER, lower, Title or Sentence case. */
export function changeCase(target: SheetsTarget, args: { range: unknown; to: unknown; sheet?: unknown }): Promise<{ sheet: string; range: string; cells: number; changed: number; to: TextCase }> {
  const to = String(args.to ?? '').trim().toLowerCase() as TextCase

  if (!TEXT_CASES.includes(to)) {
    throw new Error(`Say which case: to is ${TEXT_CASES.join(', ')}`)
  }

  return rewriteText(target, args, (text) => changeCaseOf(text, to)).then((result) => ({ ...result, to }))
}

export interface ConvertResult {
  sheet: string
  range: string
  converted: number
  /** Text cells that do not read as numbers (or dates), and the first of them. */
  failed: number
  notConverted: { cell: string; text: string }[]
  preview: boolean
}

/** Convert the text cells of an area that `read` reads, in one step; what it cannot read is reported. */
async function convertText(target: SheetsTarget, area: Area, preview: boolean, read: (text: string, format: string) => ICellData | null): Promise<ConvertResult> {
  const formats = area.range.getNumberFormats()
  const changes: CellChange[] = []
  const notConverted: { cell: string; text: string }[] = []
  let failed = 0

  cellsIn(area).forEach((row, i) =>
    row.forEach((cell, j) => {
      const text = textIn(cell)
      const position = { row: area.cells.startRow + i, column: area.cells.startColumn + j }

      if (text === null || !text.trim()) {
        return
      }

      const made = read(text, formats[i]?.[j] ?? '')

      if (made) {
        changes.push({ ...position, cell: made })
      } else if (++failed <= 20) {
        notConverted.push({ cell: cellName(position.row, position.column), text })
      }
    })
  )

  if (changes.length && !preview) {
    await oneStep(target, () => writeCells(area.sheet, changes))
  }

  return { sheet: area.sheet.getSheetName(), range: rangeName(area.cells), converted: changes.length, failed, notConverted, preview }
}

const isGeneral = (format: string) => !format || format.toLowerCase() === 'general'

/**
 * Convert text holding numbers into numbers: thousands separators, currency symbols, percentages,
 * and negatives in parentheses or with a trailing minus. A cell without a number format of its own
 * gets one that shows the number as the text did ("12.5%" as 0.0%).
 */
export function convertToNumbers(target: SheetsTarget, args: { range: unknown; preview?: unknown; sheet?: unknown }): Promise<ConvertResult> {
  const area = areaOf(target.workbook, args.range, args.sheet)

  return convertText(target, area, flag(args.preview, 'preview', false), (text, format) => {
    const number = parseNumberText(text)

    if (!number) {
      return null
    }

    // A text format would keep showing the number as text.
    const style = (isGeneral(format) || format === '@') && number.format ? { n: { pattern: number.format } } : format === '@' ? { n: null } : null

    return { v: number.value, t: 2, p: null, ...(style ? { s: style as ICellData['s'] } : {}) }
  })
}

export const DATE_FORMATS = ['yyyy-mm-dd', 'd mmm yyyy', 'dd/mm/yyyy', 'mm/dd/yyyy', 'mmmm d, yyyy'] as const

/**
 * Convert text dates into dates: numbers in `order` ("31/12/2025" in DMY), or with the month's
 * name; a time may follow. They get the date format `format` (yyyy-mm-dd unless given; with the
 * time when the text has one).
 */
export function convertToDates(target: SheetsTarget, args: { range: unknown; order: unknown; format?: unknown; preview?: unknown; sheet?: unknown }): Promise<ConvertResult & { order: DateOrder }> {
  const order = String(args.order ?? '').trim().toUpperCase() as DateOrder

  if (!DATE_ORDERS.includes(order)) {
    throw new Error(`Say how the dates are written: order is DMY (31/12/2025), MDY (12/31/2025) or YMD (2025/12/31)`)
  }

  if (args.format !== undefined && (typeof args.format !== 'string' || !/[dmy]/i.test(args.format))) {
    throw new Error(`format is a date format like ${DATE_FORMATS.join(', ')}`)
  }

  const area = areaOf(target.workbook, args.range, args.sheet)
  const format = typeof args.format === 'string' ? args.format.trim() : null

  return convertText(target, area, flag(args.preview, 'preview', false), (text) => {
    const date = parseDateText(text, order)

    if (!date) {
      return null
    }

    return { v: date.serial, t: 2, p: null, s: { n: { pattern: format ?? `yyyy-mm-dd${date.time ? ` ${date.time}` : ''}` } } }
  }).then((result) => ({ ...result, order }))
}

/**
 * Fill each empty cell of a range with the cell above it, down each column: values with their
 * formats, formulas with their relative references moved as filling moves them. Empty cells above
 * a column's first value stay empty.
 */
export async function fillDown(target: SheetsTarget, args: { range: unknown; sheet?: unknown }): Promise<{ sheet: string; range: string; filled: number }> {
  const area = areaOf(target.workbook, args.range, args.sheet)
  const cells = cellsIn(area)
  const formulas = area.range.getFormulas()
  const changes: CellChange[] = []

  for (let j = 0; j <= area.cells.endColumn - area.cells.startColumn; j++) {
    let above: { index: number; cell: ICellData; formula: string } | null = null

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i][j]

      if (cell && (isFormula(cell) || valuesIn([[cell]])[0][0] !== null)) {
        above = { index: i, cell, formula: formulas[i]?.[j] ?? '' }
      } else if (above) {
        const { v, t, s, p } = above.cell
        const style = s ? { s } : {}
        const copy: ICellData = above.formula ? { f: slideFormula(above.formula, i - above.index, 0), si: null, p: null, ...style } : { v, t, p: p ?? null, f: null, si: null, ...style }
        changes.push({ row: area.cells.startRow + i, column: area.cells.startColumn + j, cell: copy })
      }
    }
  }

  if (changes.length) {
    await oneStep(target, () => writeCells(area.sheet, changes))
  }

  return { sheet: area.sheet.getSheetName(), range: rangeName(area.cells), filled: changes.length }
}

/** Excel's "light red fill with dark red text". */
const DUPLICATE_FILL = '#ffc7ce'
const DUPLICATE_TEXT = '#9c0006'

const intersects = (a: CellRange, b: CellRange) => a.startRow <= b.endRow && b.startRow <= a.endRow && a.startColumn <= b.endColumn && b.startColumn <= a.endColumn

/** Whether a conditional format highlights duplicates: Univer's rule, or the COUNTIF formula an .xlsx file brings it back as. */
function isDuplicateRule(config: unknown): boolean {
  const rule = config as { type?: string; subType?: string; value?: unknown }

  return rule.type === 'highlightCell' && (rule.subType === 'duplicateValues' || (rule.subType === 'formula' && /^=?COUNTIF\([^)]*\)>1$/i.test(String(rule.value ?? '').replace(/\s/g, ''))))
}

/**
 * Highlight the cells of a range whose value appears more than once in it, as a conditional
 * format that follows the data (in one column when a single cell is given: the table's column).
 * `color` is the fill; `clear` takes the highlight off the range's duplicates instead.
 */
export async function highlightDuplicates(target: SheetsTarget, args: { range: unknown; color?: unknown; clear?: unknown; sheet?: unknown }): Promise<{ sheet: string; range: string; duplicates: number; cleared: number; color: string | null }> {
  const area = areaOf(target.workbook, args.range, args.sheet, { column: true })
  const clear = flag(args.clear, 'clear', false)
  const existing = area.sheet.getConditionalFormattingRules().filter((rule) => isDuplicateRule(rule.rule) && rule.ranges.some((range) => intersects(range, area.cells)))
  const result = { sheet: area.sheet.getSheetName(), range: rangeName(area.cells) }

  if (clear) {
    if (existing.length) {
      await oneStep(target, () => existing.forEach((rule) => area.sheet.deleteConditionalFormattingRule(rule.cfId)))
    }

    return { ...result, duplicates: 0, cleared: existing.length, color: null }
  }

  let color: string | null = null

  if (args.color !== undefined && args.color !== null) {
    color = String(args.color).trim()

    if (!/^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i.test(color)) {
      throw new Error(`color is a colour like #ffc7ce or rgb(255, 199, 206), not “${color}”`)
    }
  }

  const counts = new Map<string, number>()
  const keys = valuesIn(cellsIn(area)).flat().map(sameKey)
  keys.forEach((key) => key && counts.set(key, (counts.get(key) ?? 0) + 1))
  const same = existing.filter((rule) => rule.ranges.length === 1 && rangeName(rule.ranges[0]) === rangeName(area.cells))

  await oneStep(target, () => {
    // Highlighting the same cells again changes the colour rather than adding a second rule.
    same.forEach((rule) => area.sheet.deleteConditionalFormattingRule(rule.cfId))
    const builder = area.sheet.newConditionalFormattingRule().setDuplicateValues().setRanges([{ ...area.cells }]).setBackground(color ?? DUPLICATE_FILL)
    const made = (color ? builder : builder.setFontColor(DUPLICATE_TEXT)).build()
    // The builder starts from a text rule; a duplicates rule has no operator or value of its own.
    const { operator: _operator, value: _value, ...rule } = made.rule as unknown as Record<string, unknown>
    area.sheet.addConditionalFormattingRule({ ...made, rule: rule as unknown as typeof made.rule })
  })

  return { ...result, duplicates: keys.filter((key) => key && counts.get(key)! > 1).length, cleared: same.length, color: color ?? DUPLICATE_FILL }
}

/**
 * Sort a range by several columns in turn: `keys` lists them, first first, each `{ column,
 * ascending }` (a column alone sorts ascending). With headers (given, or as the first row reads),
 * the first row stays on top.
 */
export async function sortBy(target: SheetsTarget, args: { range: unknown; keys: unknown; header?: unknown; sheet?: unknown }): Promise<{ sheet: string; range: string; header: boolean; keys: { column: string; ascending: boolean }[] }> {
  const area = areaOf(target.workbook, args.range, args.sheet)
  const keys = listOf(args.keys)

  if (!keys.length) {
    throw new Error('Say what to sort by: keys is a list like [{"column": "Region", "ascending": true}, {"column": "C", "ascending": false}]')
  }

  const values = valuesIn(area.sheet.getRange(area.cells.startRow, area.cells.startColumn, Math.min(area.cells.endRow - area.cells.startRow + 1, 50), area.cells.endColumn - area.cells.startColumn + 1).getCellDatas())
  const { header, names } = headersOf(area, values, args.header)
  const order = keys.map((key) => {
    const entry = key && typeof key === 'object' && !Array.isArray(key) ? (key as { column?: unknown; ascending?: unknown }) : { column: key }
    const ascending = entry.ascending === undefined ? true : entry.ascending === 'descending' ? false : entry.ascending === 'ascending' ? true : flag(entry.ascending, 'ascending', true)

    return { column: columnIn(area.cells, names, entry.column, 'column to sort by'), ascending }
  })

  if (new Set(order.map((key) => key.column)).size !== order.length) {
    throw new Error('Sort by each column once')
  }

  const body = header ? { ...area.cells, startRow: area.cells.startRow + 1 } : area.cells

  if (body.startRow > body.endRow) {
    throw new Error(`${rangeName(area.cells)} has no rows under its header to sort`)
  }

  await oneStep(target, () => rangeOn(area.sheet, body).sort(order.map((key) => ({ column: key.column - body.startColumn, ascending: key.ascending }))))

  return { sheet: area.sheet.getSheetName(), range: rangeName(body), header, keys: order.map((key) => ({ column: columnName(key.column), ascending: key.ascending })) }
}

/** What a range holds as a table, for the dialogs: its headers (as its first row reads), a name for each column, how many rows. */
export function describeTable(target: SheetsTarget, args: { range: unknown; sheet?: unknown }): { sheet: string; range: string; header: boolean; columns: { name: string; letter: string }[]; rows: number } {
  const area = areaOf(target.workbook, args.range, args.sheet)
  const height = area.cells.endRow - area.cells.startRow + 1
  const values = valuesIn(area.sheet.getRange(area.cells.startRow, area.cells.startColumn, Math.min(height, 50), area.cells.endColumn - area.cells.startColumn + 1).getCellDatas())
  const header = looksLikeHeader(values)
  const names = fieldNames(values[0] ?? [], area.cells.startColumn)

  return {
    sheet: area.sheet.getSheetName(),
    range: rangeName(area.cells),
    header,
    columns: names.map((name, index) => ({ name, letter: columnName(area.cells.startColumn + index) })),
    rows: header ? height - 1 : height
  }
}
