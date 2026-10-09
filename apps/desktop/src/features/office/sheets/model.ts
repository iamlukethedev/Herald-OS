import { BorderStyleTypes, BorderType, type ICellData, IUndoRedoService, type Univer } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import type { FRange, FWorkbook, FWorksheet } from '@univerjs/sheets/facade'
import { type CellSnapshot, plainTextOf } from '../../../../shared/office/workbook.ts'
import { type CellRange, columnIndex, columnName, MAX_COLUMNS, MAX_ROWS, parseRange, rangeName, splitSheet } from '../../../../shared/office/xlsx/address.ts'

/*
 * What Hermes's commands do in a workbook, on the live one in a window or on one loaded from a file
 * with nothing drawn: read a range, write values and formulas, format, add and rename sheets,
 * filter and freeze; and, from the feature folders, charts, data tools (sorting among them) and
 * summaries, named ranges, validation, comments and notes. Each change is one step to undo,
 * whatever number of Univer commands it takes. Arguments are checked here, with messages that say
 * what to give instead.
 */

export * from './charts/model.ts'
export * from './comments/model.ts'
export * from './names/model.ts'
export * from './tools/model.ts'
export * from './validation/model.ts'

export interface SheetsTarget {
  univer: Univer
  workbook: FWorkbook
}

export type CellInput = string | number | boolean | null

/** The most cells a command reads or writes at once. */
export const MAX_CELLS = 10000

const grouping = new Set<string>()
let groups = 0

/** Run `change` as one step to undo: Univer files every command it runs meanwhile under one history item. */
export async function oneStep<T>(target: SheetsTarget, change: () => T | Promise<T>): Promise<T> {
  const unitId = target.workbook.getId()

  // A change made inside another joins its step.
  if (grouping.has(unitId)) {
    return change()
  }

  const history = target.univer.__getInjector().get(IUndoRedoService)
  const scope = history.beginUndoRedoGroup(unitId, `herald-command-${++groups}`, 'append')
  grouping.add(unitId)

  try {
    return await change()
  } finally {
    grouping.delete(unitId)
    scope.dispose()
  }
}

const sheetNames = (workbook: FWorkbook) => workbook.getSheets().map((sheet) => sheet.getSheetName())

/** The sheet a command names (any case), or the one in front. */
export function sheetOf(workbook: FWorkbook, name?: unknown): FWorksheet {
  if (typeof name !== 'string' || !name.trim()) {
    return workbook.getActiveSheet()
  }

  const wanted = name.trim()
  const sheet = workbook.getSheetByName(wanted) ?? workbook.getSheets().find((entry) => entry.getSheetName().toLowerCase() === wanted.toLowerCase())

  if (!sheet) {
    throw new Error(`There is no sheet called “${wanted}”; the sheets are ${sheetNames(workbook).join(', ')}`)
  }

  return sheet
}

/** "B2:D5", "B2", "C:C", "3:3", or any of these after a sheet ("'Q1 sales'!B2"), as a sheet name and cells. */
export function parseTarget(reference: unknown): { sheet?: string; range: CellRange } {
  const text = String(reference ?? '').trim()
  const { sheet, ref } = splitSheet(text)
  const range = parseRange(ref)

  if (!text || !range) {
    throw new Error(`“${text}” is not a range: give cells like B2, B2:D9, C:C or 'Sheet 2'!A1:B5`)
  }

  return { sheet, range }
}

/** The cells a reference names on a sheet: a whole row or column ends where the sheet does. */
function cellsOn(workbook: FWorkbook, reference: unknown, sheetName?: unknown): { sheet: FWorksheet; cells: CellRange } {
  const { sheet: named, range } = parseTarget(reference)
  const sheet = sheetOf(workbook, named ?? sheetName)
  const cells = {
    ...range,
    endRow: range.endRow >= MAX_ROWS - 1 ? Math.max(range.startRow, sheet.getMaxRows() - 1) : range.endRow,
    endColumn: range.endColumn >= MAX_COLUMNS - 1 ? Math.max(range.startColumn, sheet.getMaxColumns() - 1) : range.endColumn
  }

  return { sheet, cells }
}

const rangeOn = (sheet: FWorksheet, cells: CellRange): FRange => sheet.getRange(cells.startRow, cells.startColumn, cells.endRow - cells.startRow + 1, cells.endColumn - cells.startColumn + 1)

/** A range in a workbook, its sheet named in the reference or given apart, or the one in front; it has to be on the sheet. */
export function rangeOf(workbook: FWorkbook, reference: unknown, sheetName?: unknown): { sheet: FWorksheet; range: FRange; cells: CellRange } {
  const { sheet, cells } = cellsOn(workbook, reference, sheetName)

  if (cells.endRow >= sheet.getMaxRows() || cells.endColumn >= sheet.getMaxColumns()) {
    throw new Error(`${rangeName(cells)} is beyond the end of ${sheet.getSheetName()} (${rangeName({ startRow: 0, startColumn: 0, endRow: sheet.getMaxRows() - 1, endColumn: sheet.getMaxColumns() - 1 })})`)
  }

  return { sheet, range: rangeOn(sheet, cells), cells }
}

/** Wait until formulas a change touched have their results (or a moment, when none started working). */
export async function settled(target: SheetsTarget): Promise<void> {
  await FUniver.newAPI(target.univer).getFormula().onCalculationResultApplied(5000).catch(() => {})
}

const size = (cells: CellRange) => (cells.endRow - cells.startRow + 1) * (cells.endColumn - cells.startColumn + 1)

export interface RangeContents {
  sheet: string
  range: string
  /** Values: numbers, text, true or false; null where a cell is empty. */
  values: CellInput[][]
  /** Formulas where cells have them ("=SUM(B2:B9)"), else null. */
  formulas: (string | null)[][]
  /** What each cell shows, its number format applied. */
  text: string[][]
}

export function readRange(target: SheetsTarget, args: { range: unknown; sheet?: unknown }): RangeContents {
  const { sheet, range, cells } = rangeOf(target.workbook, args.range, args.sheet)

  if (size(cells) > MAX_CELLS) {
    throw new Error(`${rangeName(cells)} has ${size(cells).toLocaleString('en-US')} cells; read at most ${MAX_CELLS.toLocaleString('en-US')} at a time`)
  }

  const data = range.getCellDatas()

  return {
    sheet: sheet.getSheetName(),
    range: rangeName(cells),
    values: data.map((row) => row.map((cell) => (cell?.t === 3 ? cell.v === 1 || cell.v === true : cell?.v === undefined || cell?.v === null || cell?.v === '' ? plainTextOf(cell as CellSnapshot) || null : (cell.v as CellInput)))),
    formulas: range.getFormulas().map((row) => row.map((formula) => formula || null)),
    text: range.getDisplayValues()
  }
}

/** The sheets of a workbook: names, how much of each holds data, which are hidden and frozen. */
export function describeWorkbook(target: SheetsTarget): { active: string; sheets: { name: string; rows: number; columns: number; hidden: boolean; frozen: { rows: number; columns: number } }[] } {
  return {
    active: target.workbook.getActiveSheet().getSheetName(),
    sheets: target.workbook.getSheets().map((sheet) => {
      const freeze = sheet.getFreeze()
      // An empty sheet's last row and column are its first.
      const empty = sheet.getLastRow() <= 0 && sheet.getLastColumn() <= 0 && !sheet.getRange(0, 0).getCellData()

      return { name: sheet.getSheetName(), rows: empty ? 0 : sheet.getLastRow() + 1, columns: empty ? 0 : sheet.getLastColumn() + 1, hidden: sheet.isSheetHidden(), frozen: { rows: Math.max(0, freeze.ySplit), columns: Math.max(0, freeze.xSplit) } }
    })
  }
}

/** One value as Univer's cell: a formula for text starting with "=", else a number, true or false, or text. */
export function cellFor(value: CellInput): ICellData {
  if (value === null || value === undefined || value === '') {
    return { v: null, f: null, si: null, p: null }
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${value} is not a number a cell can hold`)
    }

    return { v: value, t: 2, f: null, si: null, p: null }
  }

  if (typeof value === 'boolean') {
    return { v: value ? 1 : 0, t: 3, f: null, si: null, p: null }
  }

  const text = String(value)

  return text.length > 1 && text.startsWith('=') ? { f: text, si: null, p: null } : { v: text, t: 1, f: null, si: null, p: null }
}

/** Rows of values, checked: a list of lists, as many cells as the range has when one is given whole. */
export function valuesGrid(values: unknown, cells: CellRange, whole: boolean): CellInput[][] {
  const grid = Array.isArray(values) && values.every(Array.isArray) ? (values as unknown[][]) : Array.isArray(values) ? [values as unknown[]] : [[values]]
  const width = Math.max(0, ...grid.map((row) => row.length))

  if (!grid.length || !width) {
    throw new Error('Give the values as rows: [["Item", "Cost"], ["Rent", 1200]]')
  }

  const valid = grid.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? null).map((value) => (value === null || ['string', 'number', 'boolean'].includes(typeof value) ? (value as CellInput) : String(value))))

  if (whole) {
    const rows = cells.endRow - cells.startRow + 1
    const columns = cells.endColumn - cells.startColumn + 1

    // One value fills the whole range, as typing into a selection does.
    if (grid.length === 1 && width === 1) {
      return Array.from({ length: rows }, () => Array.from({ length: columns }, () => valid[0][0]))
    }

    if (grid.length !== rows || width !== columns) {
      throw new Error(`${rangeName(cells)} is ${rows} by ${columns} cells but the values are ${grid.length} by ${width}: give the first cell alone to write them from there`)
    }
  }

  if (grid.length * width > MAX_CELLS) {
    throw new Error(`That is ${(grid.length * width).toLocaleString('en-US')} cells; write at most ${MAX_CELLS.toLocaleString('en-US')} at a time`)
  }

  return valid
}

/** Write values and formulas from a cell (as many as given) or into a whole range; one step to undo. */
export async function writeRange(target: SheetsTarget, args: { range: unknown; values: unknown; sheet?: unknown }): Promise<{ sheet: string; range: string; cells: number }> {
  const { sheet, cells } = cellsOn(target.workbook, args.range, args.sheet)
  const whole = cells.startRow !== cells.endRow || cells.startColumn !== cells.endColumn
  const grid = valuesGrid(args.values, cells, whole)
  const written = { startRow: cells.startRow, startColumn: cells.startColumn, endRow: cells.startRow + grid.length - 1, endColumn: cells.startColumn + grid[0].length - 1 }

  await oneStep(target, () => {
    growTo(sheet, written)
    rangeOn(sheet, written).setValues(grid.map((row) => row.map(cellFor)))
  })

  return { sheet: sheet.getSheetName(), range: rangeName(written), cells: grid.length * grid[0].length }
}

/** Add rows and columns to a sheet so `cells` fit. */
function growTo(sheet: FWorksheet, cells: CellRange): void {
  const rows = cells.endRow + 1 - sheet.getMaxRows()
  const columns = cells.endColumn + 1 - sheet.getMaxColumns()

  if (rows > 0) {
    sheet.insertRowsAfter(sheet.getMaxRows() - 1, rows)
  }

  if (columns > 0) {
    sheet.insertColumnsAfter(sheet.getMaxColumns() - 1, columns)
  }
}

export interface FormatInput {
  numberFormat?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  font?: string
  size?: number
  color?: string
  background?: string
  align?: 'left' | 'center' | 'right' | 'general'
  verticalAlign?: 'top' | 'middle' | 'bottom'
  wrap?: boolean
  border?: { edges?: 'all' | 'outside' | 'inside' | 'top' | 'bottom' | 'left' | 'right' | 'none'; style?: 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double'; color?: string }
}

const BORDER_EDGES = { all: BorderType.ALL, outside: BorderType.OUTSIDE, inside: BorderType.INSIDE, top: BorderType.TOP, bottom: BorderType.BOTTOM, left: BorderType.LEFT, right: BorderType.RIGHT, none: BorderType.NONE } as const
const BORDER_STYLES = { thin: BorderStyleTypes.THIN, medium: BorderStyleTypes.MEDIUM, thick: BorderStyleTypes.THICK, dashed: BorderStyleTypes.DASHED, dotted: BorderStyleTypes.DOTTED, double: BorderStyleTypes.DOUBLE } as const
const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i

const colorArg = (value: unknown, name: string): string => {
  const text = String(value ?? '').trim()

  if (!COLOR.test(text)) {
    throw new Error(`${name} is a colour like #1f6feb or rgb(31, 111, 235), not “${text}”`)
  }

  return text
}

/** A format as the Facade calls that make it, checked; each step changes one thing over the whole range. */
export function formatSteps(format: unknown): { label: string; apply: (range: FRange) => void }[] {
  if (!format || typeof format !== 'object') {
    throw new Error('Give a format: {"bold": true, "numberFormat": "#,##0.00", "background": "#fff3bf"}')
  }

  const input = format as Record<string, unknown>
  const steps: { label: string; apply: (range: FRange) => void }[] = []
  const known = new Set(['numberFormat', 'bold', 'italic', 'underline', 'strikethrough', 'font', 'size', 'color', 'background', 'align', 'verticalAlign', 'wrap', 'border'])
  const unknown = Object.keys(input).filter((key) => !known.has(key))

  if (unknown.length) {
    throw new Error(`Formats do not have ${unknown.join(', ')}; they have ${[...known].join(', ')}`)
  }

  if (typeof input.numberFormat === 'string') {
    const pattern = input.numberFormat.trim() || 'General'
    steps.push({ label: `number format ${pattern}`, apply: (range) => range.setNumberFormat(pattern) })
  }

  for (const [key, on, off, apply] of [
    ['bold', 'bold', 'not bold', (range: FRange, value: boolean) => range.setFontWeight(value ? 'bold' : 'normal')],
    ['italic', 'italic', 'not italic', (range: FRange, value: boolean) => range.setFontStyle(value ? 'italic' : 'normal')],
    ['underline', 'underlined', 'not underlined', (range: FRange, value: boolean) => range.setFontLine(value ? 'underline' : 'none')],
    ['strikethrough', 'struck through', 'not struck through', (range: FRange, value: boolean) => range.setFontLine(value ? 'line-through' : 'none')]
  ] as const) {
    if (typeof input[key] === 'boolean') {
      const value = input[key] as boolean
      steps.push({ label: value ? on : off, apply: (range) => apply(range, value) })
    }
  }

  if (typeof input.font === 'string' && input.font.trim()) {
    const font = input.font.trim()
    steps.push({ label: `font ${font}`, apply: (range) => range.setFontFamily(font) })
  }

  if (input.size !== undefined) {
    const points = Number(input.size)

    if (!Number.isFinite(points) || points < 6 || points > 400) {
      throw new Error(`size is a font size in points, from 6 to 400 (it was ${String(input.size)})`)
    }

    steps.push({ label: `${points} pt`, apply: (range) => range.setFontSize(points) })
  }

  if (input.color !== undefined) {
    const color = colorArg(input.color, 'color')
    steps.push({ label: `text ${color}`, apply: (range) => range.setFontColor(color) })
  }

  if (input.background !== undefined) {
    const color = input.background === null || input.background === 'none' ? null : colorArg(input.background, 'background')
    // No colour is how Univer's own "no fill" resets a fill.
    steps.push({ label: color ? `fill ${color}` : 'no fill', apply: (range) => range.setBackgroundColor(color as string) })
  }

  if (input.align !== undefined) {
    const align = String(input.align)

    if (!['left', 'center', 'right', 'general'].includes(align)) {
      throw new Error('align is left, center, right or general')
    }

    steps.push({ label: `aligned ${align}`, apply: (range) => range.setHorizontalAlignment(align === 'general' ? 'normal' : (align as 'left' | 'center')) })
  }

  if (input.verticalAlign !== undefined) {
    const align = String(input.verticalAlign)

    if (!['top', 'middle', 'bottom'].includes(align)) {
      throw new Error('verticalAlign is top, middle or bottom')
    }

    steps.push({ label: `aligned ${align}`, apply: (range) => range.setVerticalAlignment(align as 'top' | 'middle' | 'bottom') })
  }

  if (typeof input.wrap === 'boolean') {
    const wrap = input.wrap
    steps.push({ label: wrap ? 'wrapped' : 'not wrapped', apply: (range) => range.setWrap(wrap) })
  }

  if (input.border !== undefined) {
    const border = (input.border && typeof input.border === 'object' ? input.border : { edges: input.border === false || input.border === 'none' ? 'none' : 'all' }) as Record<string, unknown>
    const edges = String(border.edges ?? 'all') as keyof typeof BORDER_EDGES
    const style = String(border.style ?? 'thin') as keyof typeof BORDER_STYLES

    if (!(edges in BORDER_EDGES)) {
      throw new Error(`border edges are ${Object.keys(BORDER_EDGES).join(', ')}`)
    }

    if (!(style in BORDER_STYLES)) {
      throw new Error(`border styles are ${Object.keys(BORDER_STYLES).join(', ')}`)
    }

    const color = border.color === undefined ? '#000000' : colorArg(border.color, 'border color')
    steps.push({ label: edges === 'none' ? 'no borders' : `${style} borders (${edges})`, apply: (range) => range.setBorder(BORDER_EDGES[edges], BORDER_STYLES[style], color) })
  }

  if (!steps.length) {
    throw new Error('That format changes nothing: give numberFormat, bold, italic, underline, strikethrough, font, size, color, background, align, verticalAlign, wrap or border')
  }

  return steps
}

export async function setFormat(target: SheetsTarget, args: { range: unknown; format: unknown; sheet?: unknown }): Promise<{ sheet: string; range: string; changes: string[] }> {
  const { sheet, range, cells } = rangeOf(target.workbook, args.range, args.sheet)
  const steps = formatSteps(args.format)
  await oneStep(target, () => steps.forEach((step) => step.apply(range)))

  return { sheet: sheet.getSheetName(), range: rangeName(cells), changes: steps.map((step) => step.label) }
}

/** A sheet name Excel accepts, not taken by another sheet. */
export function checkSheetName(name: unknown, taken: string[], current?: string): string {
  const text = String(name ?? '').trim()

  if (!text) {
    throw new Error('Give the sheet a name')
  }

  if (text.length > 31 || /[[\]:*?/\\]/.test(text) || /^'|'$/.test(text)) {
    throw new Error(`“${text}” cannot name a sheet: at most 31 characters, none of [ ] : * ? / \\, and no quote at either end`)
  }

  if (taken.some((other) => other.toLowerCase() === text.toLowerCase() && other !== current)) {
    throw new Error(`There is a sheet called “${text}” already`)
  }

  return text
}

export async function addSheet(target: SheetsTarget, args: { name?: unknown; index?: unknown } = {}): Promise<{ sheet: string; index: number }> {
  const names = sheetNames(target.workbook)
  let name = args.name === undefined || args.name === '' ? '' : checkSheetName(args.name, names)

  for (let n = names.length + 1; !name; n++) {
    name = names.some((other) => other.toLowerCase() === `sheet${n}`) ? '' : `Sheet${n}`
  }

  const index = args.index === undefined ? names.length : Math.max(0, Math.min(names.length, Math.round(Number(args.index))))
  const sheet = await oneStep(target, () => target.workbook.insertSheet(name, { index }))

  return { sheet: sheet.getSheetName(), index }
}

export async function renameSheet(target: SheetsTarget, args: { sheet?: unknown; name: unknown }): Promise<{ from: string; to: string }> {
  const sheet = sheetOf(target.workbook, args.sheet)
  const from = sheet.getSheetName()
  const to = checkSheetName(args.name, sheetNames(target.workbook), from)
  await oneStep(target, () => sheet.setName(to))

  return { from, to }
}

export async function removeSheet(target: SheetsTarget, args: { sheet?: unknown }): Promise<{ sheet: string }> {
  const sheet = sheetOf(target.workbook, args.sheet)

  if (target.workbook.getSheets().filter((entry) => !entry.isSheetHidden()).length <= 1 && !sheet.isSheetHidden()) {
    throw new Error('A workbook keeps at least one visible sheet')
  }

  const name = sheet.getSheetName()
  await oneStep(target, () => target.workbook.deleteSheet(sheet))

  return { sheet: name }
}

/** A column a command names: a letter ("C"), a header in the range's first row ("Cost"), or a number counted from the range's first column (1 is the first). */
export function columnOf(range: FRange, cells: CellRange, by: unknown): number {
  if (typeof by === 'number' && Number.isInteger(by)) {
    const column = cells.startColumn + by - 1

    if (column < cells.startColumn || column > cells.endColumn) {
      throw new Error(`Column ${by} is outside ${rangeName(cells)}`)
    }

    return column
  }

  const text = String(by ?? '').trim()

  if (/^[A-Za-z]{1,3}$/.test(text) && columnIndex(text) >= cells.startColumn && columnIndex(text) <= cells.endColumn) {
    return columnIndex(text)
  }

  const headers = range.getDisplayValues()[0] ?? []
  const found = headers.findIndex((header) => header.trim().toLowerCase() === text.toLowerCase())

  if (!text || found < 0) {
    throw new Error(`Say which column: a letter inside ${rangeName(cells)}, or a header (${headers.filter(Boolean).join(', ') || 'none in its first row'})`)
  }

  return cells.startColumn + found
}

const FILTER_OPERATORS = ['equal', 'notEqual', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual'] as const

/**
 * Filter a range by one column: keep rows whose cell shows one of `values`, or meets `condition`
 * ({"operator": "greaterThan", "value": 100}). `clear` takes the sheet's filter away.
 */
export async function filterRange(target: SheetsTarget, args: { range?: unknown; by?: unknown; values?: unknown; condition?: unknown; clear?: unknown; sheet?: unknown }): Promise<{ sheet: string; range?: string; column?: string; hidden: number }> {
  if (args.clear === true) {
    const sheet = sheetOf(target.workbook, args.sheet ?? (args.range ? parseTarget(args.range).sheet : undefined))
    const filter = sheet.getFilter()

    if (filter) {
      await oneStep(target, () => filter.remove())
    }

    return { sheet: sheet.getSheetName(), hidden: 0 }
  }

  const { sheet, range, cells } = rangeOf(target.workbook, args.range, args.sheet)
  const column = columnOf(range, cells, args.by)
  let criteria: Record<string, unknown>

  if (Array.isArray(args.values)) {
    criteria = { colId: column, filters: { filters: args.values.map((value) => String(value)) } }
  } else if (args.condition && typeof args.condition === 'object') {
    const { operator = 'equal', value } = args.condition as { operator?: string; value?: unknown }

    if (!FILTER_OPERATORS.includes(operator as (typeof FILTER_OPERATORS)[number]) || value === undefined) {
      throw new Error(`A condition is {"operator": one of ${FILTER_OPERATORS.join(', ')}, "value": …}`)
    }

    criteria = { colId: column, customFilters: { customFilters: [{ val: typeof value === 'number' ? value : String(value), ...(operator === 'equal' ? {} : { operator }) }] } }
  } else {
    throw new Error('Say what to keep: values (a list of what the cells show) or condition ({"operator": "greaterThan", "value": 100})')
  }

  await oneStep(target, () => {
    let filter = sheet.getFilter()

    // A sheet has one filter: one on other cells gives way to this one.
    if (filter && rangeName(filter.getRange().getRange()) !== rangeName(cells)) {
      filter.remove()
      filter = null
    }

    filter ??= range.createFilter()

    if (!filter) {
      throw new Error(`${rangeName(cells)} cannot be filtered`)
    }

    filter.setColumnFilterCriteria(column, criteria as never)
  })

  return { sheet: sheet.getSheetName(), range: rangeName(cells), column: columnName(column), hidden: sheet.getFilter()?.getFilteredOutRows().length ?? 0 }
}

/** Keep the first `rows` rows and `columns` columns in view; zero for both unfreezes. */
export async function freeze(target: SheetsTarget, args: { rows?: unknown; columns?: unknown; sheet?: unknown }): Promise<{ sheet: string; rows: number; columns: number }> {
  const sheet = sheetOf(target.workbook, args.sheet)
  const count = (value: unknown, name: string, limit: number): number => {
    const n = value === undefined || value === null || value === '' ? 0 : Number(value)

    if (!Number.isInteger(n) || n < 0 || n >= limit) {
      throw new Error(`${name} is a whole number from 0 to ${limit - 1}`)
    }

    return n
  }
  const rows = count(args.rows, 'rows', Math.min(sheet.getMaxRows(), 1000))
  const columns = count(args.columns, 'columns', Math.min(sheet.getMaxColumns(), 100))
  await oneStep(target, () => (rows || columns ? sheet.setFreeze({ xSplit: columns, ySplit: rows, startRow: rows || -1, startColumn: columns || -1 }) : sheet.cancelFreeze()))

  return { sheet: sheet.getSheetName(), rows, columns }
}
