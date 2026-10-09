import { type ICellData, type IObjectMatrixPrimitiveType, isNullCell, type Nullable } from '@univerjs/core'
import type { FRange, FWorkbook, FWorksheet } from '@univerjs/sheets/facade'
import { type CellSnapshot, plainTextOf } from '../../../../../shared/office/workbook.ts'
import { type CellRange, columnIndex, columnName, MAX_COLUMNS, MAX_ROWS, rangeName } from '../../../../../shared/office/xlsx/address.ts'
import { type CellInput, parseTarget, sheetOf } from '../model.ts'

/*
 * The cells a data tool works on: a range as given, or the table around one cell (as Excel's
 * current region finds it, cells touching at a corner included); whole rows and columns end where
 * the sheet's data does. Also what the tools read from them: values, headers, columns named by
 * letter, header or number.
 */

export interface Area {
  sheet: FWorksheet
  cells: CellRange
  range: FRange
}

/** The most cells a data tool works through at once. */
export const MOST_CELLS = 200000

export const rangeOn = (sheet: FWorksheet, cells: CellRange): FRange => sheet.getRange(cells.startRow, cells.startColumn, cells.endRow - cells.startRow + 1, cells.endColumn - cells.startColumn + 1)

/** Add rows and columns to a sheet so `cells` fit. */
export function growTo(sheet: FWorksheet, cells: CellRange): void {
  const rows = cells.endRow + 1 - sheet.getMaxRows()
  const columns = cells.endColumn + 1 - sheet.getMaxColumns()

  if (rows > 0) {
    sheet.insertRowsAfter(sheet.getMaxRows() - 1, rows)
  }

  if (columns > 0) {
    sheet.insertColumnsAfter(sheet.getMaxColumns() - 1, columns)
  }
}

export interface CellChange {
  row: number
  column: number
  cell: ICellData
}

/** Write cells where they are, in one of Univer's commands; the sheet grows for any beyond its end. */
export function writeCells(sheet: FWorksheet, changes: CellChange[]): void {
  if (!changes.length) {
    return
  }

  const box = { startRow: Infinity, startColumn: Infinity, endRow: -1, endColumn: -1 }
  const matrix: IObjectMatrixPrimitiveType<ICellData> = {}

  for (const { row, column, cell } of changes) {
    box.startRow = Math.min(box.startRow, row)
    box.startColumn = Math.min(box.startColumn, column)
    box.endRow = Math.max(box.endRow, row)
    box.endColumn = Math.max(box.endColumn, column)
    const line = matrix[row] ?? {}
    line[column] = cell
    matrix[row] = line
  }

  growTo(sheet, box)
  rangeOn(sheet, box).setValues(matrix)
}

/** The table a cell is in: every cell with something in it reachable from it through cells that touch, at most between `columns`. */
export function tableAround(sheet: FWorksheet, row: number, column: number, columns: { from: number; to: number } = { from: 0, to: sheet.getMaxColumns() - 1 }): CellRange {
  const matrix = sheet.getSheet().getCellMatrix()
  const lastRow = sheet.getMaxRows() - 1
  const filled = (r: number, c: number): boolean => r >= 0 && r <= lastRow && c >= columns.from && c <= columns.to && !isNullCell(matrix.getValue(r, c))
  const rowFilled = (r: number, from: number, to: number): boolean => {
    for (let c = from; c <= to; c++) {
      if (filled(r, c)) {
        return true
      }
    }

    return false
  }
  const columnFilled = (c: number, from: number, to: number): boolean => {
    for (let r = from; r <= to; r++) {
      if (filled(r, c)) {
        return true
      }
    }

    return false
  }
  const cells = { startRow: row, startColumn: column, endRow: row, endColumn: column }

  for (let grown = true; grown; ) {
    grown = false

    while (cells.endRow < lastRow && rowFilled(cells.endRow + 1, cells.startColumn - 1, cells.endColumn + 1)) {
      cells.endRow++
      grown = true
    }

    while (cells.startRow > 0 && rowFilled(cells.startRow - 1, cells.startColumn - 1, cells.endColumn + 1)) {
      cells.startRow--
      grown = true
    }

    while (cells.endColumn < columns.to && columnFilled(cells.endColumn + 1, cells.startRow - 1, cells.endRow + 1)) {
      cells.endColumn++
      grown = true
    }

    while (cells.startColumn > columns.from && columnFilled(cells.startColumn - 1, cells.startRow - 1, cells.endRow + 1)) {
      cells.startColumn--
      grown = true
    }
  }

  return cells
}

/**
 * The cells a reference names on its sheet (named in it, given apart, or the one in front): one
 * cell stands for the table around it (with `column`, that table's rows in the cell's column).
 */
export function areaOf(workbook: FWorkbook, reference: unknown, sheetName?: unknown, options: { column?: boolean } = {}): Area {
  if (reference === undefined || reference === null || String(reference).trim() === '') {
    throw new Error('Give a range: cells like A1:D20, or one cell inside a table')
  }

  const { sheet: named, range } = parseTarget(reference)
  const sheet = sheetOf(workbook, named ?? sheetName)
  const maxRow = sheet.getMaxRows() - 1
  const maxColumn = sheet.getMaxColumns() - 1

  if (range.startRow === range.endRow && range.startColumn === range.endColumn) {
    if (range.startRow > maxRow || range.startColumn > maxColumn) {
      throw new Error(`${rangeName(range)} is beyond the end of ${sheet.getSheetName()}`)
    }

    const table = tableAround(sheet, range.startRow, range.startColumn)

    if (isNullCell(sheet.getSheet().getCellMatrix().getValue(range.startRow, range.startColumn)) && table.startRow === table.endRow && table.startColumn === table.endColumn) {
      throw new Error(`There is no table at ${rangeName(range)} on ${sheet.getSheetName()}: give its cells (like A1:D20), or a cell inside it`)
    }

    const cells = options.column ? { ...table, startColumn: range.startColumn, endColumn: range.startColumn } : table

    return { sheet, cells, range: rangeOn(sheet, cells) }
  }

  // Whole rows and columns stop where the data does.
  const cells = {
    ...range,
    endRow: range.endRow >= MAX_ROWS - 1 ? Math.min(maxRow, Math.max(range.startRow, sheet.getLastRow())) : range.endRow,
    endColumn: range.endColumn >= MAX_COLUMNS - 1 ? Math.min(maxColumn, Math.max(range.startColumn, sheet.getLastColumn())) : range.endColumn
  }

  if (cells.endRow > maxRow || cells.endColumn > maxColumn) {
    throw new Error(`${rangeName(range)} is beyond the end of ${sheet.getSheetName()} (${rangeName({ startRow: 0, startColumn: 0, endRow: maxRow, endColumn: maxColumn })})`)
  }

  return { sheet, cells, range: rangeOn(sheet, cells) }
}

/** A cell's value as a command reads it: a number, text, true or false; null when it is empty. */
export function valueOf(cell: Nullable<ICellData>): CellInput {
  if (!cell) {
    return null
  }

  if (cell.t === 3) {
    return cell.v === 1 || cell.v === true || cell.v === 'TRUE'
  }

  if (cell.v === undefined || cell.v === null || cell.v === '') {
    return plainTextOf(cell as CellSnapshot) || null
  }

  if (cell.t === 2 && typeof cell.v === 'string' && Number.isFinite(Number(cell.v))) {
    return Number(cell.v)
  }

  return cell.v as CellInput
}

export const isFormula = (cell: Nullable<ICellData>): boolean => Boolean(cell?.f) || Boolean(cell?.si)

/** Text a cell holds as text (not a formula's result), and whether a link makes it rich text a plain value would lose. */
export function textIn(cell: Nullable<ICellData>): string | null {
  if (!cell || isFormula(cell) || cell.t === 2 || cell.t === 3) {
    return null
  }

  const ranges = (cell.p as { body?: { customRanges?: unknown[] } } | null | undefined)?.body?.customRanges

  if (ranges?.length) {
    return null
  }

  const value = cell.v === undefined || cell.v === null || cell.v === '' ? plainTextOf(cell as CellSnapshot) : typeof cell.v === 'string' ? cell.v : null

  return value || null
}

/** The values of an area, row by row. */
export const valuesIn = (cells: Nullable<ICellData>[][]): CellInput[][] => cells.map((row) => row.map(valueOf))

const isNumericText = (text: string): boolean => text.trim() !== '' && Number.isFinite(Number(text))

/** Whether an area's first row reads as its headers: all text, none of it repeated as data under it, unlike what is under it. */
export function looksLikeHeader(values: CellInput[][]): boolean {
  const [first, ...rest] = values

  if (!first || !rest.length || !first.every((value) => typeof value === 'string' && value.trim() !== '' && !isNumericText(value))) {
    return false
  }

  const texts = first.map((value) => String(value).trim().toLowerCase())
  const appears = (column: number) => rest.some((row) => typeof row[column] === 'string' && String(row[column]).trim().toLowerCase() === texts[column])

  if (rest.some((row) => row.every((value, column) => typeof value === 'string' && value.trim().toLowerCase() === texts[column]))) {
    return false
  }

  return first.some((_, column) => rest.some((row) => row[column] !== null && typeof row[column] !== 'string')) || texts.every((_, column) => !appears(column))
}

/** A name for each column of an area: its header (made unique), or "Column C" without one. */
export function fieldNames(header: CellInput[], startColumn: number): string[] {
  const names: string[] = []

  header.forEach((value, index) => {
    const base = value === null || String(value).trim() === '' ? `Column ${columnName(startColumn + index)}` : String(value).trim()
    let name = base

    for (let n = 2; names.some((other) => other.toLowerCase() === name.toLowerCase()); n++) {
      name = `${base} (${n})`
    }

    names.push(name)
  })

  return names
}

/** A column a command names, inside `cells`: a header in `names`, a letter, or a number counted from the first column (1). */
export function columnIn(cells: CellRange, names: string[] | null, by: unknown, what = 'column'): number {
  const width = cells.endColumn - cells.startColumn + 1

  if (typeof by === 'number') {
    if (!Number.isInteger(by) || by < 1 || by > width) {
      throw new Error(`Column ${by} is outside ${rangeName(cells)}: count from 1 to ${width}`)
    }

    return cells.startColumn + by - 1
  }

  const text = String(by ?? '').trim()
  const named = names?.findIndex((name) => name.toLowerCase() === text.toLowerCase()) ?? -1

  if (text && named >= 0) {
    return cells.startColumn + named
  }

  if (/^[A-Za-z]{1,3}$/.test(text) && columnIndex(text) >= cells.startColumn && columnIndex(text) <= cells.endColumn) {
    return columnIndex(text)
  }

  const headers = names?.length ? `, or a header (${names.join(', ')})` : ''

  throw new Error(`Say which ${what}: a letter from ${columnName(cells.startColumn)} to ${columnName(cells.endColumn)}, a number from 1 to ${width}${headers}${text ? `; “${text}” is none of these` : ''}`)
}

/** A yes or no argument; `fallback` when it is not given. */
export function flag(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined || value === null) {
    return fallback
  }

  if (typeof value === 'boolean') {
    return value
  }

  if (value === 'true' || value === 'false') {
    return value === 'true'
  }

  throw new Error(`${name} is true or false, not ${JSON.stringify(value)}`)
}

/** A list argument: a list, or one item alone. */
export const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
