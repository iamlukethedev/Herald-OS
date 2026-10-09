import type { BodyStyle, Box, CellBorders, Fill, Stroke, TableCell, TableElement, TextBody } from './deck.ts'
import { newId } from './deck.ts'
import { plainText, textBody } from './text.ts'

/*
 * Tables as PowerPoint has them (a:tbl): every row has a cell for each column, and a merged cell
 * starts at its top left, the cells it covers kept in the grid and marked. Rows and columns come
 * and go with merged cells kept whole, so a table always writes as PowerPoint reads it. A new table
 * looks like PowerPoint's default one: a header row in the first accent, then rows banded in its
 * lighter shades (kept taking turns as rows come and go), lined in the background colour.
 */

/** The most rows and columns a table has, as PowerPoint's Insert Table allows. */
export const MAX_ROWS = 75
export const MAX_COLUMNS = 75

/** PowerPoint's row height for its 18 point table text, in points. */
export const ROW_HEIGHT = 29.2

export interface CellRef {
  row: number
  column: number
}

const HEADER: Fill = { color: 'accent1' }
const BANDS: [Fill, Fill] = [
  { color: 'accent1', alpha: 0.4 },
  { color: 'accent1', alpha: 0.2 }
]

const total = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0)

const whole = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, Math.round(Number.isFinite(value) ? value : low)))

/** A cell's text: the theme's body font at 18 points, as PowerPoint's table text starts. */
export const cellBody = (style: Partial<BodyStyle> = {}, text = ''): TextBody => textBody({ font: '+body', size: 18, color: 'tx1', ...style }, { text })

/** A new table of `rows` by `columns` filling `box`, with text for its cells row by row. */
export function tableElement(box: Box, rows: number, columns: number, text: readonly (readonly string[])[] = []): TableElement {
  const down = whole(rows, 1, MAX_ROWS)
  const across = whole(columns, 1, MAX_COLUMNS)
  const cells = Array.from({ length: down }, (_, row) =>
    Array.from({ length: across }, (_, column): TableCell => ({ body: cellBody(row === 0 ? { color: 'bg1', bold: true } : {}, text[row]?.[column] ?? ''), fill: row === 0 ? HEADER : BANDS[(row - 1) % 2] }))
  )

  return {
    id: newId('table'),
    kind: 'table',
    ...box,
    rotation: 0,
    columns: Array.from({ length: across }, () => box.width / across),
    rows: Array.from({ length: down }, () => box.height / down),
    cells,
    stroke: { color: 'bg1', width: 1, dash: 'solid' }
  }
}

const lines = (cell: TableCell): Pick<TableCell, 'borders'> => (cell.borders ? { borders: cell.borders } : {})

/**
 * Cells made whole for a grid `columns` wide: a merged cell reaches no further than the table nor
 * over a cell another merged cell covers, and exactly the cells merged cells cover are marked.
 */
export function settleSpans(cells: readonly (readonly TableCell[])[], columns: number): TableCell[][] {
  const covered = cells.map(() => Array.from({ length: columns }, () => false))

  return cells.map((row, r) =>
    row.map((cell, c): TableCell => {
      if (covered[r][c]) {
        return { body: cell.body, fill: cell.fill, merged: true, ...lines(cell) }
      }

      let across = whole(cell.colSpan ?? 1, 1, columns - c)
      let down = whole(cell.rowSpan ?? 1, 1, cells.length - r)

      while (across > 1 && covered[r].slice(c, c + across).some(Boolean)) {
        across--
      }

      while (down > 1 && covered.slice(r, r + down).some((line) => line.slice(c, c + across).some(Boolean))) {
        down--
      }

      for (let y = r; y < r + down; y++) {
        for (let x = c; x < c + across; x++) {
          covered[y][x] = y !== r || x !== c
        }
      }

      return { body: cell.body, fill: cell.fill, ...(across > 1 ? { colSpan: across } : {}), ...(down > 1 ? { rowSpan: down } : {}), ...lines(cell) }
    })
  )
}

/** A cell formatted as `like`, without its text. */
function blankLike(like: TableCell): TableCell {
  const first = like.body.paragraphs[0] ?? { runs: [] }

  return { body: { ...like.body, paragraphs: [{ ...first, runs: [{ ...first.runs[0], text: '' }] }] }, fill: like.fill, ...lines(like) }
}

/** A table with a blank row at `at` formatted as row `like`; a merged cell across `at` reaches over it. */
function addRow(table: TableElement, at: number, like: number, most: number): TableElement {
  if (table.rows.length >= most) {
    return table
  }

  const index = whole(at, 0, table.rows.length)
  const source = whole(like, 0, table.rows.length - 1)
  const cells = table.cells.map((row, r) => row.map((cell) => (!cell.merged && r < index && r + (cell.rowSpan ?? 1) > index ? { ...cell, rowSpan: (cell.rowSpan ?? 1) + 1 } : cell)))
  cells.splice(index, 0, table.cells[source].map(blankLike))
  const rows = [...table.rows]
  rows.splice(index, 0, table.rows[source])

  return { ...table, rows, height: total(rows), cells: settleSpans(cells, table.columns.length) }
}

/** A table without some rows: a merged cell whose top row goes starts at its first row left. Null when no row would be left. */
function dropRows(table: TableElement, which: readonly number[]): TableElement | null {
  const gone = new Set(which.filter((row) => Number.isInteger(row) && row >= 0 && row < table.rows.length))

  if (!gone.size) {
    return table
  }

  if (gone.size >= table.rows.length) {
    return null
  }

  const cells = table.cells.map((row) => [...row])

  table.cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      const span = cell.rowSpan ?? 1
      const left = Array.from({ length: span }, (_, k) => r + k).filter((y) => !gone.has(y))

      if (!cell.merged && span > 1 && left.length) {
        cells[left[0]][c] = { ...cell, rowSpan: left.length }
      }
    })
  )

  const rows = table.rows.filter((_, r) => !gone.has(r))

  return { ...table, rows, height: total(rows), cells: settleSpans(cells.filter((_, r) => !gone.has(r)), table.columns.length) }
}

const ACROSS: Record<keyof CellBorders, keyof CellBorders> = { left: 'top', top: 'left', right: 'bottom', bottom: 'right' }

function crossCell(cell: TableCell): TableCell {
  const borders = cell.borders && (Object.fromEntries(Object.entries(cell.borders).map(([side, line]) => [ACROSS[side as keyof CellBorders], line])) as CellBorders)

  return {
    body: cell.body,
    fill: cell.fill,
    ...(cell.rowSpan ? { colSpan: cell.rowSpan } : {}),
    ...(cell.colSpan ? { rowSpan: cell.colSpan } : {}),
    ...(cell.merged ? { merged: true } : {}),
    ...(borders ? { borders } : {})
  }
}

/** Rows as columns and columns as rows, so what is done to rows can be done to columns. */
const transpose = (table: TableElement): TableElement => ({
  ...table,
  width: table.height,
  height: table.width,
  columns: table.rows,
  rows: table.columns,
  cells: table.columns.map((_, c) => table.cells.map((row) => crossCell(row[c])))
})

const sameFill = (a: Fill | null, b: Fill | null): boolean => (a && b ? a.color === b.color && (a.alpha ?? 1) === (b.alpha ?? 1) : a === b)

/** The fill all of a row's cells have, or undefined when they differ. */
function rowFill(row: readonly TableCell[]): Fill | null | undefined {
  const first = row[0]?.fill ?? null

  return row.every((cell) => sameFill(cell.fill, first)) ? first : undefined
}

type Bands = [Fill | null, Fill | null]

/** The two fills a table's rows take turns in, from the first row or from under a header row, when they do (as a new table's rows do). */
function bandsOf(table: TableElement): Bands | null {
  const fills = table.cells.map(rowFill)

  for (const start of [0, 1]) {
    const banded = fills.slice(start)
    const [a, b] = banded

    if (banded.length >= 3 - start && a !== undefined && b !== undefined && !sameFill(a, b) && banded.every((fill, index) => fill !== undefined && sameFill(fill, index % 2 ? b : a))) {
      return [a, b]
    }
  }

  return fills.length === 2 && fills[1] !== undefined && sameFill(fills[1], BANDS[0]) ? BANDS : null
}

/** A table whose rows in either band take turns again, after rows came or went. */
function restripe(table: TableElement, bands: Bands | null): TableElement {
  if (!bands) {
    return table
  }

  let turn = 0
  const cells = table.cells.map((row) => {
    const fill = rowFill(row)

    if (fill === undefined || !bands.some((band) => sameFill(band, fill))) {
      return row
    }

    const band = bands[turn++ % 2]

    return row.map((cell) => (sameFill(cell.fill, band) ? cell : { ...cell, fill: band }))
  })

  return { ...table, cells }
}

/** A table with a new row above or below `row`, formatted as the rows about it; the table grows by the row. */
export function insertRow(table: TableElement, row: number, where: 'above' | 'below'): TableElement {
  const at = whole(row, 0, table.rows.length - 1)
  // A row under the header looks like the rows under it, not like the header.
  const like = where === 'below' && at === 0 && table.rows.length > 1 ? 1 : at

  return restripe(addRow(table, where === 'above' ? at : at + 1, like, MAX_ROWS), bandsOf(table))
}

/** A table with a new column left or right of `column`, formatted as that column; the table grows by the column. */
export function insertColumn(table: TableElement, column: number, where: 'left' | 'right'): TableElement {
  const at = whole(column, 0, table.columns.length - 1)

  return transpose(addRow(transpose(table), where === 'left' ? at : at + 1, at, MAX_COLUMNS))
}

/** A table without some rows, shorter by them; null when none would be left. */
export function removeRows(table: TableElement, rows: readonly number[]): TableElement | null {
  const next = dropRows(table, rows)

  return next && restripe(next, bandsOf(table))
}

/** A table without some columns, narrower by them; null when none would be left. */
export function removeColumns(table: TableElement, columns: readonly number[]): TableElement | null {
  const next = dropRows(transpose(table), columns)

  return next && transpose(next)
}

/** A table with one cell changed (the table as it was when there is no such cell). */
export function withCell(table: TableElement, at: CellRef, change: (cell: TableCell) => TableCell): TableElement {
  return table.cells[at.row]?.[at.column] ? { ...table, cells: table.cells.map((row, r) => (r === at.row ? row.map((cell, c) => (c === at.column ? change(cell) : cell)) : row)) } : table
}

/** A table with some of its cells, or all, filled (null for no fill). */
export function fillCells(table: TableElement, cells: readonly CellRef[] | 'all', fill: Fill | null): TableElement {
  const wanted = cells === 'all' ? null : new Set(cells.map((cell) => `${cell.row}:${cell.column}`))

  return { ...table, cells: table.cells.map((row, r) => row.map((cell, c) => (!wanted || wanted.has(`${r}:${c}`) ? { ...cell, fill } : cell))) }
}

/**
 * Which lines of some cells a border goes on, as PowerPoint's Borders menu offers them: a side of
 * the cells together (`left` is the left edge of what is picked), all of their outside, the lines
 * between them, or both.
 */
export type BorderSide = 'left' | 'top' | 'right' | 'bottom' | 'outer' | 'inner' | 'all'

const sameStroke = (a: Stroke | null | undefined, b: Stroke | null | undefined): boolean =>
  a && b ? a.color === b.color && a.width === b.width && a.dash === b.dash && (a.alpha ?? 1) === (b.alpha ?? 1) : a === b

/**
 * A table with a line (null for none) on some sides of some of its cells, or all of them. A line
 * between two cells is set on both, so either cell says the same; the line around a merged cell is
 * its own, and a covered cell picked stands for the merged cell over it.
 */
export function borderCells(table: TableElement, cells: readonly CellRef[] | 'all', sides: readonly BorderSide[], stroke: Stroke | null): TableElement {
  const down = table.rows.length
  const across = table.columns.length
  const key = (at: CellRef) => `${at.row}:${at.column}`
  const inside = (at: CellRef) => Number.isInteger(at.row) && Number.isInteger(at.column) && at.row >= 0 && at.row < down && at.column >= 0 && at.column < across
  const grid = table.cells.map((row, r) => row.map((_, c) => cellUnder(table, { row: r, column: c })))
  const picked = new Set(cells === 'all' ? grid.flat().map(key) : cells.filter(inside).map((at) => key(cellUnder(table, at))))
  const wanted = new Set(sides.flatMap((side) => (side === 'all' ? ['left', 'top', 'right', 'bottom', 'inner'] : side === 'outer' ? ['left', 'top', 'right', 'bottom'] : [side])))
  const changes = new Map<string, CellBorders>()
  const mark = (at: CellRef | undefined, side: keyof CellBorders) => at && changes.set(key(at), { ...changes.get(key(at)), [side]: stroke })
  const edge = (before: CellRef | undefined, after: CellRef | undefined, sideOf: { before: keyof CellBorders; after: keyof CellBorders }) => {
    if (before && after && key(before) === key(after)) {
      return
    }

    const first = before !== undefined && picked.has(key(before))
    const second = after !== undefined && picked.has(key(after))
    const kind = first && second ? 'inner' : first ? sideOf.before : second ? sideOf.after : null

    if (kind && wanted.has(kind)) {
      mark(before, sideOf.before)
      mark(after, sideOf.after)
    }
  }

  for (let r = 0; r < down; r++) {
    for (let c = 0; c <= across; c++) {
      edge(grid[r][c - 1], grid[r][c], { before: 'right', after: 'left' })
    }
  }

  for (let c = 0; c < across; c++) {
    for (let r = 0; r <= down; r++) {
      edge(grid[r - 1]?.[c], grid[r]?.[c], { before: 'bottom', after: 'top' })
    }
  }

  let changed = false
  const next = table.cells.map((row, r) =>
    row.map((cell, c) => {
      const change = changes.get(key({ row: r, column: c }))

      if (!change || Object.entries(change).every(([side, line]) => cell.borders && side in cell.borders && sameStroke(cell.borders[side as keyof CellBorders], line))) {
        return cell
      }

      changed = true

      return { ...cell, borders: { ...cell.borders, ...change } }
    })
  )

  return changed ? { ...table, cells: next } : table
}

/** The cell after `at` in reading order (or before it), past the cells merged cells cover; null past either end. */
export function nextCell(table: TableElement, at: CellRef, by: 1 | -1): CellRef | null {
  const across = table.columns.length

  for (let index = at.row * across + at.column + by; index >= 0 && index < table.rows.length * across; index += by) {
    const cell = { row: Math.floor(index / across), column: index % across }

    if (!table.cells[cell.row]?.[cell.column]?.merged) {
      return cell
    }
  }

  return null
}

/** The drawn cell at `at` (the merged cell covering it, if any), with `at` brought inside the table first. */
export function cellUnder(table: TableElement, at: CellRef): CellRef {
  const row = whole(at.row, 0, table.rows.length - 1)
  const column = whole(at.column, 0, table.columns.length - 1)

  for (let r = row; r >= 0; r--) {
    for (let c = column; c >= 0; c--) {
      const cell = table.cells[r][c]

      if (!cell.merged && r + (cell.rowSpan ?? 1) > row && c + (cell.colSpan ?? 1) > column) {
        return { row: r, column: c }
      }
    }
  }

  return { row, column }
}

/** A table stretched to a size, its columns and rows in proportion. */
export function scaleTable(table: TableElement, width: number, height: number): TableElement {
  const across = total(table.columns) || 1
  const down = total(table.rows) || 1

  return { ...table, width, height, columns: table.columns.map((column) => (column * width) / across), rows: table.rows.map((row) => (row * height) / down) }
}

/** A table whose rows under a cell are together at least `needed` points tall, the last of them grown. */
export function fitRow(table: TableElement, at: CellRef, needed: number): TableElement {
  const cell = table.cells[at.row]?.[at.column]

  if (!cell) {
    return table
  }

  const last = Math.min(table.rows.length, at.row + (cell.rowSpan ?? 1)) - 1
  const have = total(table.rows.slice(at.row, last + 1))

  if (needed <= have + 0.5) {
    return table
  }

  const rows = table.rows.map((height, r) => (r === last ? height + needed - have : height))

  return { ...table, rows, height: total(rows) }
}

/** The table's words: a line a row, its cells apart by tabs (a cell's own lines joined by spaces). */
export const tableText = (table: TableElement): string =>
  table.cells
    .map((row) =>
      row
        .filter((cell) => !cell.merged)
        .map((cell) => plainText(cell.body).replace(/\n/g, ' '))
        .join('\t')
    )
    .join('\n')
