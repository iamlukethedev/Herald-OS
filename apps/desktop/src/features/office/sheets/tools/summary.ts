import { CommandType, type ICellData, ICommandService, type IMutation, IUndoRedoService, IUniverInstanceService, isNullCell, type Workbook } from '@univerjs/core'
import type { FWorkbook, FWorksheet } from '@univerjs/sheets/facade'
import { type CellRange, cellName, columnIndex, columnName, parseCell, parseRange, quoteSheet, rangeName, splitSheet } from '../../../../../shared/office/xlsx/address.ts'
import { type CellInput, checkSheetName, MAX_CELLS, oneStep, parseTarget, type SheetsTarget, sheetOf } from '../model.ts'
import { areaOf, fieldNames, flag, growTo, listOf, MOST_CELLS, rangeOn, tableAround, valuesIn } from './table.ts'

/*
 * Summaries in the style of pivot tables, made of portable formulas. The row and column labels are
 * the distinct values of their fields when the summary is made (or refreshed); each number is a
 * SUMIFS, COUNTIFS, AVERAGEIFS, MINIFS or MAXIFS over the source's whole columns, matching the
 * label cells, so the numbers follow the data as it changes and rows added with known labels count
 * at once. A refresh reads the table again from its first cell and rewrites the summary with the
 * labels it has then. How a summary was made is kept in its sheet's custom data
 * (custom.herald.summaries), which an .xlsx file keeps in Herald's part.
 */

export type SummaryFunction = 'sum' | 'count' | 'average' | 'min' | 'max'

export const SUMMARY_FUNCTIONS: readonly SummaryFunction[] = ['sum', 'count', 'average', 'min', 'max']

const FUNCTION_LABELS: Record<SummaryFunction, string> = { sum: 'Sum', count: 'Count', average: 'Average', min: 'Min', max: 'Max' }

/** What a value column of a summary is called: "Sum of Amount". */
export const valueName = (value: { field: string; fn: SummaryFunction }): string => `${FUNCTION_LABELS[value.fn]} of ${value.field}`

/** What a summary shows for an empty value. */
export const BLANK_LABEL = '(blank)'

/** The most values a filter leaves out: each is a criterion in every formula. */
const MOST_LEFT_OUT = 40

export interface SummaryDefinition {
  id: string
  /** The summary's first cell on its sheet, and its size when it was last written. */
  at: string
  size: { rows: number; columns: number }
  /** The table summarized: its sheet (by name, and by id while the workbook is open), its first cell, and its cells when last read. */
  source: { sheet: string; sheetId: string; start: string; range: string }
  rows: string[]
  columns: string[]
  values: { field: string; fn: SummaryFunction }[]
  /** The values each filter keeps (null for empty). */
  filters: { field: string; values: CellInput[] }[]
}

/** How labels group values, as SUMIFS compares them: text in any case, text holding a number with that number. */
export function labelKey(value: CellInput): string {
  if (value === null || value === '') {
    return ''
  }

  if (typeof value === 'number') {
    return `n${value}`
  }

  if (typeof value === 'boolean') {
    return `b${value}`
  }

  const text = value.trim()

  return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(text) ? `n${Number(text)}` : `t${value.toLowerCase()}`
}

const rank = (value: CellInput): number => (value === null || value === '' ? 3 : typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : 2)

/** Labels in order: numbers (and dates), text in any case, false and true, then empty. */
function compareValues(a: CellInput, b: CellInput): number {
  if (rank(a) !== rank(b)) {
    return rank(a) - rank(b)
  }

  if (typeof a === 'number' && typeof b === 'number') {
    return a - b
  }

  return typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }) : Number(a) - Number(b)
}

/** The distinct values of a list, each kept as first written, by label. */
function distinct(values: CellInput[]): Map<string, CellInput> {
  const found = new Map<string, CellInput>()

  for (const value of values) {
    const key = labelKey(value)

    if (!found.has(key)) {
      found.set(key, value === '' ? null : value)
    }
  }

  return found
}

/** A label as text, for messages and the dialog. */
export const labelText = (value: CellInput): string => (value === null || value === '' ? BLANK_LABEL : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value))

interface Source {
  sheet: FWorksheet
  cells: CellRange
  names: string[]
  /** The rows under the headers that hold anything, each a value per column, and where each is on the sheet. */
  records: CellInput[][]
  rows: number[]
  /** Each column's number format, as its first value has it ('' for General). */
  formats: string[]
}

function readSource(sheet: FWorksheet, cells: CellRange): Source {
  const count = (cells.endRow - cells.startRow + 1) * (cells.endColumn - cells.startColumn + 1)

  if (count > MOST_CELLS) {
    throw new Error(`${rangeName(cells)} has ${count.toLocaleString('en-US')} cells; a summary reads at most ${MOST_CELLS.toLocaleString('en-US')}`)
  }

  if (cells.endRow <= cells.startRow) {
    throw new Error(`${rangeName(cells)} on ${sheet.getSheetName()} has no rows under its headers to summarize`)
  }

  const values = valuesIn(rangeOn(sheet, cells).getCellDatas())
  const sample = rangeOn(sheet, { ...cells, startRow: cells.startRow + 1, endRow: Math.min(cells.endRow, cells.startRow + 50) }).getNumberFormats()
  const formats = values[0].map((_, column) => {
    const row = sample.findIndex((_line, index) => values[index + 1][column] !== null)
    const format = row >= 0 ? sample[row][column] : ''

    return format.toLowerCase() === 'general' ? '' : format
  })
  const rows = values.flatMap((row, index) => (index > 0 && row.some((value) => value !== null && value !== '') ? [cells.startRow + index] : []))

  return { sheet, cells, names: fieldNames(values[0], cells.startColumn), records: rows.map((row) => values[row - cells.startRow]), rows, formats }
}

/** A field a summary names: a header of the table, or a column letter inside it. */
function fieldOf(source: Source, by: unknown, what: string): number {
  const text = String(by ?? '').trim()
  const index = source.names.findIndex((name) => name.toLowerCase() === text.toLowerCase())

  if (text && index >= 0) {
    return index
  }

  const offset = /^[A-Za-z]{1,3}$/.test(text) ? columnIndex(text) - source.cells.startColumn : -1

  if (offset >= 0 && offset < source.names.length) {
    return offset
  }

  throw new Error(`${what}: ${text ? `“${text}” is not a column of ${rangeName(source.cells)}` : 'name a column'}; its columns are ${source.names.join(', ')}`)
}

interface Spec {
  rows: number[]
  columns: number[]
  values: { column: number; fn: SummaryFunction }[]
  filters: { column: number; values: CellInput[] }[]
}

const isNumeric = (source: Source, column: number): boolean => {
  const values = source.records.map((record) => record[column]).filter((value) => value !== null)

  return values.length > 0 && values.filter((value) => typeof value === 'number').length * 2 >= values.length
}

const entryOf = (entry: unknown): Record<string, unknown> | null => (entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null)

/** What a summary is made of, checked against its table; `strict` refuses filter values the table does not have. */
function specOf(source: Source, args: { rows?: unknown; columns?: unknown; values?: unknown; filters?: unknown }, strict: boolean): Spec {
  const rows = listOf(args.rows).map((field) => fieldOf(source, field, 'rows'))
  const columns = listOf(args.columns).map((field) => fieldOf(source, field, 'columns'))

  if (!rows.length) {
    throw new Error(`Say what goes down the summary: rows is a list of columns, like ["${source.names[0]}"]`)
  }

  if (new Set([...rows, ...columns]).size !== rows.length + columns.length) {
    throw new Error('Each column goes once in rows and columns together')
  }

  const values = listOf(args.values).map((entry) => {
    const item = typeof entry === 'string' ? { field: entry } : entryOf(entry)

    if (!item) {
      throw new Error('Each value is {"field": a column, "fn": sum, count, average, min or max}')
    }

    const column = fieldOf(source, item.field, 'values')
    const fn = (item.fn === undefined ? (isNumeric(source, column) ? 'sum' : 'count') : String(item.fn).trim().toLowerCase()) as SummaryFunction

    if (!SUMMARY_FUNCTIONS.includes(fn)) {
      throw new Error(`fn is ${SUMMARY_FUNCTIONS.join(', ')}, not “${String(item.fn)}”`)
    }

    return { column, fn }
  })

  if (!values.length) {
    throw new Error(`Say what to work out: values is a list like [{"field": "${source.names[source.names.length - 1]}", "fn": "sum"}]`)
  }

  if (new Set(values.map((value) => `${value.column} ${value.fn}`)).size !== values.length) {
    throw new Error('Each value goes once')
  }

  const filters = listOf(args.filters).map((entry) => {
    const item = entryOf(entry)

    if (!item) {
      throw new Error('Each filter is {"field": a column, "values": [the values to keep]}')
    }

    const column = fieldOf(source, item.field, 'filters')
    const wanted = listOf(item.values)
    const known = distinct(source.records.map((record) => record[column]))

    if (!wanted.length) {
      throw new Error(`Say which values of ${source.names[column]} the filter keeps`)
    }

    const kept = new Map<string, CellInput>()

    for (const value of wanted) {
      const input = value === BLANK_LABEL || value === undefined ? null : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null ? value : String(value)
      const key = labelKey(input)

      if (strict && !known.has(key)) {
        throw new Error(`${source.names[column]} has no value “${labelText(input)}”; its values include ${[...known.values()].slice(0, 8).map(labelText).join(', ')}`)
      }

      kept.set(key, known.has(key) ? known.get(key)! : input)
    }

    return { column, values: [...kept.values()] }
  })

  if (new Set(filters.map((filter) => filter.column)).size !== filters.length) {
    throw new Error('Each column has one filter')
  }

  return { rows, columns, values, filters }
}

const literal = (text: string): string => `"${text.replace(/"/g, '""')}"`
const escaped = (text: string): string => text.replace(/[~*?]/g, '~$&')
/** Text a criterion would read as a comparison or a pattern rather than itself. */
const special = (text: string): boolean => /^[=<>]/.test(text) || /[~*?]/.test(text)

/** The criterion that matches a label: its cell, where SUMIFS compares that exactly; else the label written out. */
function criterion(value: CellInput, cell: string): string {
  if (value === null || value === '') {
    return '""'
  }

  return typeof value === 'string' && special(value) ? literal(`=${escaped(value)}`) : cell
}

/** The criterion that keeps only `value`. */
function keeping(value: CellInput): string {
  if (value === null || value === '') {
    return '""'
  }

  if (typeof value !== 'string') {
    return typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value)
  }

  return special(value) ? literal(`=${escaped(value)}`) : literal(value)
}

/** The criterion that leaves `value` out. */
function leavingOut(value: CellInput): string {
  if (value === null || value === '') {
    return '"<>"'
  }

  return literal(`<>${typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : typeof value === 'number' ? value : escaped(value)}`)
}

interface Plan {
  rowLabels: CellInput[][]
  columnLabels: CellInput[][]
  /** The filters as criteria: a column of the table and what it has to match. */
  criteria: [number, string][]
  /** Rows of the table the filters keep. */
  kept: number
}

/** The labels a summary has from its table now, and its filters as criteria. */
function planOf(source: Source, spec: Spec): Plan {
  const criteria: [number, string][] = []
  const keeps = spec.filters.map((filter) => {
    const keep = new Set(filter.values.map(labelKey))
    const present = distinct(source.records.map((record) => record[filter.column]))
    const kept = [...present.keys()].filter((key) => keep.has(key))
    const leftOut = [...present].filter(([key]) => !keep.has(key))

    // A filter that keeps one value matches it; one that keeps more leaves the others out.
    if (kept.length <= 1 && leftOut.length) {
      criteria.push([filter.column, keeping(kept.length ? present.get(kept[0])! : (filter.values[0] ?? null))])
    } else if (leftOut.length > MOST_LEFT_OUT) {
      throw new Error(`The filter on ${source.names[filter.column]} keeps ${kept.length} of ${present.size} values: keep one, or leave out at most ${MOST_LEFT_OUT}`)
    } else {
      leftOut.forEach(([, value]) => criteria.push([filter.column, leavingOut(value)]))
    }

    return { column: filter.column, keep }
  })
  const passing = source.records.filter((record) => keeps.every(({ column, keep }) => keep.has(labelKey(record[column]))))
  const combinations = (columns: number[]): CellInput[][] => {
    const found = new Map<string, CellInput[]>()

    for (const record of passing) {
      const labels = columns.map((column) => (record[column] === '' ? null : record[column]))
      const key = labels.map(labelKey).join('\u0000')

      if (!found.has(key)) {
        found.set(key, labels)
      }
    }

    return [...found.values()].sort((a, b) => a.reduce<number>((order, value, index) => order || compareValues(value, b[index]), 0))
  }

  return { rowLabels: combinations(spec.rows), columnLabels: spec.columns.length ? combinations(spec.columns) : [], criteria, kept: passing.length }
}

const EMPTY: ICellData = { v: null, f: null, si: null, p: null }

const heading = (text: string): ICellData => ({ v: text, t: 1, f: null, si: null, p: null, s: { bl: 1, n: null } as ICellData['s'] })

/** A label's cell: the value with its column's number format, or "(blank)". */
function labelCell(value: CellInput, format: string, bold: boolean): ICellData {
  const s = { bl: bold ? 1 : 0, n: format && typeof value === 'number' ? { pattern: format } : null } as ICellData['s']

  if (value === null || value === '') {
    return { v: BLANK_LABEL, t: 1, f: null, si: null, p: null, s }
  }

  return typeof value === 'boolean' ? { v: value ? 1 : 0, t: 3, f: null, si: null, p: null, s } : { v: value, t: typeof value === 'number' ? 2 : 1, f: null, si: null, p: null, s }
}

interface Layout {
  cells: ICellData[][]
  height: number
  width: number
  /** Rows of headers above the labels. */
  headers: number
}

/**
 * A summary's cells from its first cell at `top`, `left`: header rows (each column field's labels,
 * then the row fields' and values' names), a row per row label, a grand total row, and with column
 * fields a grand total column per value. The value cells are formulas over the table's columns.
 */
function layoutOf(source: Source, spec: Spec, plan: Plan, top: number, left: number, sameSheet: boolean): Layout {
  const p = spec.rows.length
  const m = spec.values.length
  const k = spec.columns.length
  const headers = k + 1
  const body = plan.rowLabels.length
  const groups = k ? plan.columnLabels.length + 1 : 1
  const width = p + groups * m
  const height = headers + body + 1
  const prefix = sameSheet ? '' : `${quoteSheet(source.sheet.getSheetName())}!`
  const whole = (column: number): string => {
    const letter = columnName(source.cells.startColumn + column)

    return `${prefix}$${letter}:$${letter}`
  }
  // With column fields, the last group is the grand totals: no column labels to match.
  const slots = Array.from({ length: groups }, (_, group) => spec.values.map((value, index) => ({ column: p + group * m + index, value, labels: k && group < groups - 1 ? plan.columnLabels[group] : null }))).flat()
  const cells = Array.from({ length: height }, () => Array.from({ length: width }, () => EMPTY))

  spec.columns.forEach((column, j) => {
    cells[j][p - 1] = heading(source.names[column])
  })
  spec.rows.forEach((column, q) => {
    cells[headers - 1][q] = heading(source.names[column])
  })
  cells[height - 1][0] = heading('Grand total')

  const valueCell = (slot: (typeof slots)[number], row: number | null): ICellData => {
    const pairs: string[] = []

    if (row !== null) {
      plan.rowLabels[row].forEach((value, q) => pairs.push(`${whole(spec.rows[q])},${criterion(value, `$${columnName(left + q)}${top + headers + row + 1}`)}`))
    }

    slot.labels?.forEach((value, j) => pairs.push(`${whole(spec.columns[j])},${criterion(value, `${columnName(left + slot.column)}$${top + j + 1}`)}`))
    const labelled = pairs.length > 0
    plan.criteria.forEach(([column, match]) => pairs.push(`${whole(column)},${match}`))
    const range = whole(slot.value.column)
    const list = pairs.join(',')
    const above = rangeName({ startRow: top + headers, endRow: top + headers + body - 1, startColumn: left + slot.column, endColumn: left + slot.column })
    const fn = slot.value.fn
    const format = fn === 'count' ? '' : source.formats[slot.value.column]
    let formula: string

    if (fn === 'sum') {
      formula = pairs.length ? `=SUMIFS(${range},${list})` : `=SUM(${range})`
    } else if (fn === 'count') {
      // A count over the whole column takes in its header: without labels to match, the total adds up the counts above.
      formula = labelled ? `=COUNTIFS(${range},"<>",${list})` : body ? `=SUM(${above})` : '=0'
    } else {
      const name = fn.toUpperCase()
      formula = pairs.length ? `=IF(COUNTIFS(${list})=0,"",${name}IFS(${range},${list}))` : `=${name}(${range})`
    }

    return { f: formula, si: null, p: null, s: { bl: row === null ? 1 : 0, n: format ? { pattern: format } : null } as ICellData['s'] }
  }

  for (const slot of slots) {
    if (k && !slot.labels) {
      cells[0][slot.column] = heading('Grand total')
    }

    slot.labels?.forEach((value, j) => {
      cells[j][slot.column] = labelCell(value, source.formats[spec.columns[j]], true)
    })
    cells[headers - 1][slot.column] = heading(valueName({ field: source.names[slot.value.column], fn: slot.value.fn }))
    cells[height - 1][slot.column] = valueCell(slot, null)
  }

  plan.rowLabels.forEach((labels, row) => {
    labels.forEach((value, q) => {
      cells[headers + row][q] = labelCell(value, source.formats[spec.rows[q]], false)
    })
    slots.forEach((slot) => {
      cells[headers + row][slot.column] = valueCell(slot, row)
    })
  })

  return { cells, height, width, headers }
}

const SET_SUMMARIES = 'herald.mutation.set-sheet-summaries'

interface SummariesParams {
  unitId: string
  subUnitId: string
  summaries: SummaryDefinition[]
}

/** A sheet's summaries in its custom data, as a mutation: undo and redo take them back and forth with the cells. */
const SetSummariesMutation: IMutation<SummariesParams> = {
  id: SET_SUMMARIES,
  type: CommandType.MUTATION,
  handler: (accessor, params) => {
    const sheet = accessor.get(IUniverInstanceService).getUnit<Workbook>(params.unitId)?.getSheetBySheetId(params.subUnitId)

    if (!sheet) {
      return false
    }

    const { herald, ...custom } = (sheet.getCustomMetadata() ?? {}) as { herald?: Record<string, unknown> }
    const { summaries: _summaries, ...rest } = herald ?? {}
    const next = params.summaries.length ? { ...rest, summaries: structuredClone(params.summaries) } : rest
    sheet.setCustomMetadata(Object.keys(next).length ? { ...custom, herald: next } : Object.keys(custom).length ? custom : undefined)

    return true
  }
}

const isDefinition = (entry: unknown): entry is SummaryDefinition => {
  const item = entryOf(entry)
  const source = entryOf(item?.source)

  return Boolean(item && source && typeof item.id === 'string' && typeof item.at === 'string' && entryOf(item.size) && typeof source.sheet === 'string' && typeof source.start === 'string' && Array.isArray(item.rows) && Array.isArray(item.values))
}

/** The summaries kept on a sheet. */
export function summariesOf(sheet: FWorksheet): SummaryDefinition[] {
  const list = (sheet.getSheet().getCustomMetadata() as { herald?: { summaries?: unknown } } | undefined)?.herald?.summaries

  return Array.isArray(list) ? list.filter(isDefinition).map((entry) => ({ ...entry, columns: Array.isArray(entry.columns) ? entry.columns : [], filters: Array.isArray(entry.filters) ? entry.filters : [] })) : []
}

function storeSummaries(target: SheetsTarget, sheet: FWorksheet, summaries: SummaryDefinition[]): void {
  const injector = target.univer.__getInjector()
  const commands = injector.get(ICommandService)
  const params = (list: SummaryDefinition[]): SummariesParams => ({ unitId: target.workbook.getId(), subUnitId: sheet.getSheetId(), summaries: list })
  const before = summariesOf(sheet)

  if (!commands.hasCommand(SET_SUMMARIES)) {
    commands.registerCommand(SetSummariesMutation)
  }

  commands.syncExecuteCommand(SET_SUMMARIES, params(summaries))
  injector.get(IUndoRedoService).pushUndoRedo({ unitID: target.workbook.getId(), undoMutations: [{ id: SET_SUMMARIES, params: params(before) }], redoMutations: [{ id: SET_SUMMARIES, params: params(summaries) }] })
}

const areaAt = (row: number, column: number, size: { rows: number; columns: number }): CellRange => ({ startRow: row, startColumn: column, endRow: row + size.rows - 1, endColumn: column + size.columns - 1 })

const inside = (cells: CellRange, row: number, column: number): boolean => row >= cells.startRow && row <= cells.endRow && column >= cells.startColumn && column <= cells.endColumn

/** How many cells of `area` hold something, but those in `except`. */
function occupied(sheet: FWorksheet, area: CellRange, except?: CellRange): number {
  const matrix = sheet.getSheet().getCellMatrix()
  let count = 0

  for (let row = area.startRow; row <= Math.min(area.endRow, sheet.getMaxRows() - 1); row++) {
    for (let column = area.startColumn; column <= Math.min(area.endColumn, sheet.getMaxColumns() - 1); column++) {
      count += (!except || !inside(except, row, column)) && !isNullCell(matrix.getValue(row, column)) ? 1 : 0
    }
  }

  return count
}

/** A summary on the table's own sheet stays in columns of its own, an empty one between, so the table can grow down. */
function checkBeside(source: Source, area: CellRange): void {
  if (area.endColumn >= source.cells.startColumn - 1 && area.startColumn <= source.cells.endColumn + 1) {
    throw new Error(`On ${source.sheet.getSheetName()}, put the summary in columns of its own with an empty one between it and the table (from ${cellName(source.cells.startRow, source.cells.endColumn + 2)}), or on a new sheet`)
  }
}

/** A width for each of a summary's columns that shows its longest text, as Excel fits a pivot table's: about 7 pixels a character at 11 points. */
function fittedWidths(layout: Layout): number[] {
  // A number is worked out later; most show in about ten characters.
  const length = (cell: ICellData) => (cell.f ? 10 : typeof cell.v === 'string' ? cell.v.length : cell.v === null || cell.v === undefined ? 0 : String(cell.v).length + 3)

  return Array.from({ length: layout.width }, (_, column) => Math.min(280, Math.round(Math.max(...layout.cells.map((row) => length(row[column]))) * 7 + 16)))
}

function checkSize(layout: Layout): void {
  if (layout.height * layout.width > MAX_CELLS) {
    throw new Error(`That summary is ${layout.height.toLocaleString('en-US')} rows by ${layout.width} columns; a summary has at most ${MAX_CELLS.toLocaleString('en-US')} cells: put fewer columns in rows or columns, or filter`)
  }
}

interface Place {
  /** The sheet it goes on; null for a new one called `name`. */
  sheet: FWorksheet | null
  name: string
  row: number
  column: number
}

const sheetNamed = (workbook: FWorkbook, name: string): FWorksheet | null => workbook.getSheets().find((sheet) => sheet.getSheetName().toLowerCase() === name.trim().toLowerCase()) ?? null

/** Where a summary goes: `{ sheet, cell }`, with sheet a name or "new" (a new sheet, the default), cell its first cell (A1 unless given). */
function placeOf(workbook: FWorkbook, destination: unknown): Place {
  const fresh = (name?: string): string => {
    const names = workbook.getSheets().map((sheet) => sheet.getSheetName())

    if (name) {
      return checkSheetName(name, names)
    }

    let next = 'Summary'

    for (let n = 2; names.some((other) => other.toLowerCase() === next.toLowerCase()); n++) {
      next = `Summary ${n}`
    }

    return next
  }
  if (destination !== undefined && destination !== null && destination !== '' && typeof destination !== 'string' && !entryOf(destination)) {
    throw new Error('destination is {"sheet": a sheet’s name or "new", "cell": its first cell, like "B2"}')
  }

  // Text is a cell (with its sheet or not), or else a sheet's name.
  const text = typeof destination === 'string' ? destination.trim() : null
  const given = text === null ? (entryOf(destination) ?? {}) : parseRange(splitSheet(text).ref) && !sheetNamed(workbook, text) ? { cell: text } : { sheet: text }

  const sheetArg = typeof given.sheet === 'string' && given.sheet.trim() ? given.sheet.trim() : null
  const cellArg = given.cell === undefined || given.cell === null || given.cell === '' ? null : parseTarget(given.cell)
  const row = cellArg?.range.startRow ?? 0
  const column = cellArg?.range.startColumn ?? 0

  if (!sheetArg && !cellArg) {
    return { sheet: null, name: fresh(), row, column }
  }

  if (sheetArg && /^new$/i.test(sheetArg)) {
    return { sheet: null, name: fresh(), row, column }
  }

  const name = sheetArg ?? cellArg?.sheet
  const sheet = name ? sheetNamed(workbook, name) : workbook.getActiveSheet()

  return sheet ? { sheet, name: sheet.getSheetName(), row, column } : { sheet: null, name: fresh(name), row, column }
}

export interface SummaryResult {
  preview: boolean
  id: string
  sheet: string
  /** Whether the summary goes on a sheet of its own made for it. */
  newSheet: boolean
  range: string
  source: string
  /** Row labels (and column labels) it has. */
  rows: number
  columns: number
  values: string[]
  /** Its header rows, and its first rows of labels. */
  headers: string[][]
  labels: string[][]
}

const sourceName = (source: Source): string => `${quoteSheet(source.sheet.getSheetName())}!${rangeName(source.cells)}`

function resultOf(source: Source, spec: Spec, plan: Plan, layout: Layout, place: { sheet: string; newSheet: boolean; row: number; column: number; id: string; preview: boolean }): SummaryResult {
  return {
    preview: place.preview,
    id: place.id,
    sheet: place.sheet,
    newSheet: place.newSheet,
    range: rangeName(areaAt(place.row, place.column, { rows: layout.height, columns: layout.width })),
    source: sourceName(source),
    rows: plan.rowLabels.length,
    columns: plan.columnLabels.length,
    values: spec.values.map((value) => valueName({ field: source.names[value.column], fn: value.fn })),
    headers: layout.cells.slice(0, layout.headers).map((row) => row.map((cell) => String(cell.v ?? ''))),
    labels: plan.rowLabels.slice(0, 5).map((labels) => labels.map(labelText))
  }
}

const nextId = (summaries: SummaryDefinition[]): string => {
  let n = summaries.length + 1

  while (summaries.some((summary) => summary.id === `summary-${n}`)) {
    n++
  }

  return `summary-${n}`
}

/**
 * Summarize a table as a pivot table does, in formulas that stay live: `rows` (and `columns`) are
 * the fields whose values label the summary, `values` what is worked out for each ({ field, fn }
 * with fn sum, count, average, min or max), `filters` the values of fields to keep. The table is
 * `source` (one cell for the table around it), its first row the headers. It goes on a new sheet
 * unless `destination` says where ({ sheet: a name or "new", cell }). With `preview`, nothing
 * changes and the result gives the summary's shape.
 */
export async function summarize(target: SheetsTarget, args: { source: unknown; rows: unknown; columns?: unknown; values: unknown; filters?: unknown; destination?: unknown; preview?: unknown; sheet?: unknown }): Promise<SummaryResult> {
  const area = areaOf(target.workbook, args.source, args.sheet)
  const source = readSource(area.sheet, area.cells)
  const spec = specOf(source, args, true)
  const plan = planOf(source, spec)
  const place = placeOf(target.workbook, args.destination)
  const preview = flag(args.preview, 'preview', false)
  const sameSheet = place.sheet?.getSheetId() === source.sheet.getSheetId()
  const layout = layoutOf(source, spec, plan, place.row, place.column, sameSheet)
  const cells = areaAt(place.row, place.column, { rows: layout.height, columns: layout.width })
  const existing = place.sheet ? summariesOf(place.sheet) : []
  const id = nextId(existing)

  if (!plan.kept) {
    throw new Error(`No rows of ${sourceName(source)} pass the filters`)
  }

  checkSize(layout)

  if (sameSheet) {
    checkBeside(source, cells)
  }

  if (place.sheet && occupied(place.sheet, cells)) {
    throw new Error(`The summary needs ${rangeName(cells)} on ${place.name}, which has data: give an empty cell, or a new sheet`)
  }

  const result = resultOf(source, spec, plan, layout, { sheet: place.name, newSheet: !place.sheet, row: place.row, column: place.column, id, preview })

  if (preview) {
    return result
  }

  const definition: SummaryDefinition = {
    id,
    at: cellName(place.row, place.column),
    size: { rows: layout.height, columns: layout.width },
    source: { sheet: source.sheet.getSheetName(), sheetId: source.sheet.getSheetId(), start: cellName(source.cells.startRow, source.cells.startColumn), range: rangeName(source.cells) },
    rows: spec.rows.map((column) => source.names[column]),
    columns: spec.columns.map((column) => source.names[column]),
    values: spec.values.map((value) => ({ field: source.names[value.column], fn: value.fn })),
    filters: spec.filters.map((filter) => ({ field: source.names[filter.column], values: filter.values }))
  }

  await oneStep(target, () => {
    const index = target.workbook.getSheets().findIndex((sheet) => sheet.getSheetId() === source.sheet.getSheetId()) + 1
    const sheet = place.sheet ?? target.workbook.insertSheet(place.name, { index })
    growTo(sheet, cells)
    rangeOn(sheet, cells).setValues(layout.cells)

    // Columns of a sheet made for the summary fit it; on another sheet, they are the person's.
    if (!place.sheet) {
      fittedWidths(layout).forEach((width, offset) => {
        if (width > sheet.getColumnWidth(place.column + offset)) {
          sheet.setColumnWidth(place.column + offset, width)
        }
      })
    }

    storeSummaries(target, sheet, [...existing, definition])
    target.workbook.setActiveSheet(sheet)
  })

  return result
}

/** The sheet a summary's table is on: by id while the workbook is open, by name once it went through a file. */
function sourceSheetOf(workbook: FWorkbook, source: SummaryDefinition['source']): FWorksheet {
  const byId = source.sheetId ? workbook.getSheetBySheetId(source.sheetId) : null
  const byName = sheetNamed(workbook, source.sheet)
  const sheet = byId && byId.getSheetName() === source.sheet ? byId : (byName ?? byId)

  if (!sheet) {
    throw new Error(`The table this summary reads was on a sheet called “${source.sheet}”, which is gone`)
  }

  return sheet
}

/** Which of a sheet's summaries `which` names: its id, its number (1 is the first), a cell inside it; all of them when none. */
function chosen(summaries: SummaryDefinition[], which: unknown): SummaryDefinition[] {
  if (which === undefined || which === null || which === '') {
    return summaries
  }

  if (typeof which === 'number' && summaries[which - 1]) {
    return [summaries[which - 1]]
  }

  const text = String(which).trim()
  const byId = summaries.find((summary) => summary.id === text)
  const cell = parseCell(text)
  const at = cell ? summaries.find((summary) => {
    const start = parseCell(summary.at)

    return start && inside(areaAt(start.row, start.column, summary.size), cell.row, cell.column)
  }) : undefined

  if (byId ?? at) {
    return [(byId ?? at)!]
  }

  throw new Error(`There is no summary “${text}” here: name one by its id (${summaries.map((summary) => summary.id).join(', ')}), its number, or a cell inside it`)
}

/**
 * Refresh summaries on a sheet (the one in front unless named; all of its summaries unless
 * `summary` names one by id, number or a cell inside it): read each table again from its first
 * cell, as it has grown or shrunk, and rewrite the summary in place with the labels it has now.
 */
export async function refreshSummary(target: SheetsTarget, args: { sheet?: unknown; summary?: unknown } = {}): Promise<{ sheet: string; summaries: (SummaryResult & { before: number })[] }> {
  const sheet = sheetOf(target.workbook, args.sheet)
  const all = summariesOf(sheet)

  if (!all.length) {
    throw new Error(`There is no summary on ${sheet.getSheetName()} to refresh: make one with summarize`)
  }

  const updates = chosen(all, args.summary).map((definition) => {
    const start = parseCell(definition.source.start)
    const at = parseCell(definition.at)

    if (!start || !at) {
      throw new Error(`Summary ${definition.id} does not say where it is`)
    }

    const from = sourceSheetOf(target.workbook, definition.source)
    const sameSheet = from.getSheetId() === sheet.getSheetId()
    const old = areaAt(at.row, at.column, definition.size)
    const corner = (row: number) => String(sheet.getRange(row, at.column).getValue() ?? '').trim().toLowerCase()

    // Rows or columns put in or taken out around a summary move it: what is at its old place now is not to be cleared.
    if (corner(old.startRow + definition.columns.length) !== String(definition.rows[0] ?? '').toLowerCase() || corner(old.endRow) !== 'grand total') {
      throw new Error(`The summary that was at ${rangeName(old)} is not there as it was made: summarize the table again`)
    }

    if (isNullCell(from.getSheet().getCellMatrix().getValue(start.row, start.column))) {
      throw new Error(`The table this summary reads started at ${definition.source.start} on ${from.getSheetName()}, which is empty now`)
    }

    // On the summary's own sheet, the table is found without reaching into the summary.
    const columns = !sameSheet ? undefined : old.startColumn > start.column ? { from: 0, to: old.startColumn - 2 } : { from: old.endColumn + 2, to: from.getMaxColumns() - 1 }
    const found = tableAround(from, start.row, start.column, columns)
    const source = readSource(from, { ...found, startRow: start.row, startColumn: start.column })
    const spec = specOf(source, definition, false)
    const plan = planOf(source, spec)
    const layout = layoutOf(source, spec, plan, at.row, at.column, sameSheet)
    const cells = areaAt(at.row, at.column, { rows: layout.height, columns: layout.width })
    checkSize(layout)

    if (sameSheet) {
      checkBeside(source, cells)
    }

    if (occupied(sheet, cells, old)) {
      throw new Error(`The refreshed summary needs ${rangeName(cells)}, and cells beyond the old one have data: make room for it, or summarize again elsewhere`)
    }

    const next: SummaryDefinition = { ...definition, size: { rows: layout.height, columns: layout.width }, source: { sheet: from.getSheetName(), sheetId: from.getSheetId(), start: definition.source.start, range: rangeName(source.cells) } }
    const before = Math.max(0, definition.size.rows - definition.columns.length - 2)

    return { old, cells, layout, next, result: { ...resultOf(source, spec, plan, layout, { sheet: sheet.getSheetName(), newSheet: false, row: at.row, column: at.column, id: definition.id, preview: false }), before } }
  })

  await oneStep(target, () => {
    for (const update of updates) {
      rangeOn(sheet, { ...update.old, endRow: Math.min(update.old.endRow, sheet.getMaxRows() - 1), endColumn: Math.min(update.old.endColumn, sheet.getMaxColumns() - 1) }).clear()
      growTo(sheet, update.cells)
      rangeOn(sheet, update.cells).setValues(update.layout.cells)
    }

    storeSummaries(target, sheet, all.map((definition) => updates.find((update) => update.next.id === definition.id)?.next ?? definition))
  })

  return { sheet: sheet.getSheetName(), summaries: updates.map((update) => update.result) }
}

/** The summaries on a sheet (the one in front unless named): where each is, what it reads, and how it is made. */
export function listSummaries(target: SheetsTarget, args: { sheet?: unknown } = {}): { sheet: string; summaries: { id: string; range: string; source: string; rows: string[]; columns: string[]; values: string[]; filters: { field: string; values: string[] }[] }[] } {
  const sheet = sheetOf(target.workbook, args.sheet)

  return {
    sheet: sheet.getSheetName(),
    summaries: summariesOf(sheet).map((summary) => {
      const at = parseCell(summary.at) ?? { row: 0, column: 0 }

      return {
        id: summary.id,
        range: rangeName(areaAt(at.row, at.column, summary.size)),
        source: `${quoteSheet(summary.source.sheet)}!${summary.source.range}`,
        rows: summary.rows,
        columns: summary.columns,
        values: summary.values.map(valueName),
        filters: summary.filters.map((filter) => ({ field: filter.field, values: filter.values.map(labelText) }))
      }
    })
  }
}

/** A table as the Summarize dialog shows it: its fields, whether each holds numbers, and its values to filter by (the first 500, as cells show them). */
export function summarySource(target: SheetsTarget, args: { source: unknown; sheet?: unknown }): { sheet: string; range: string; rows: number; fields: { name: string; letter: string; numeric: boolean; distinct: number; values: { value: CellInput; text: string }[] }[] } {
  const area = areaOf(target.workbook, args.source, args.sheet)
  const source = readSource(area.sheet, area.cells)

  return {
    sheet: area.sheet.getSheetName(),
    range: rangeName(area.cells),
    rows: source.records.length,
    fields: source.names.map((name, column) => {
      const values = [...distinct(source.records.map((record) => record[column])).values()].sort(compareValues)
      const shown = values.slice(0, 500).map((value) => {
        const index = typeof value === 'number' && source.formats[column] ? source.records.findIndex((record) => labelKey(record[column]) === labelKey(value)) : -1
        const text = index >= 0 ? area.sheet.getRange(source.rows[index], source.cells.startColumn + column).getDisplayValue() : labelText(value)

        return { value, text }
      })

      return { name, letter: columnName(source.cells.startColumn + column), numeric: isNumeric(source, column), distinct: values.length, values: shown }
    })
  }
}
