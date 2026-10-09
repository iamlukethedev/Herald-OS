import type { ChartKind } from '../../../../../shared/office/charts.ts'
import type { CellRange } from '../../../../../shared/office/xlsx/address.ts'
import { type CellGrid, type ChartCell, isDateCell, isEmptyCell, numberOf } from './data.ts'

/*
 * How a block of cells becomes a chart: which cells name the series, which label the categories
 * and which hold the numbers, and the kinds of chart that suit them best. Both read only the cells,
 * so the same selection always gives the same answer.
 */

export const KIND_NAMES: Record<ChartKind, string> = { column: 'Column', bar: 'Bar', line: 'Line', area: 'Area', pie: 'Pie', doughnut: 'Doughnut', scatter: 'Scatter', combo: 'Combo' }

/** What each kind of chart is for, in a line. */
export const KIND_REASONS: Record<ChartKind, string> = {
  column: 'Compares values across categories',
  bar: 'Compares values; long category names read well beside bars',
  line: 'Shows a trend over time or along ordered categories',
  area: 'Shows a trend and how much it amounts to',
  pie: 'Shows the shares of one whole (the first series)',
  doughnut: 'Shows the shares of a whole, with room in the middle',
  scatter: 'Shows how two sets of numbers relate, one point per row',
  combo: 'Columns and lines together, with a second axis for another scale'
}

export interface Recommendation {
  kind: ChartKind
  reason: string
  stacking?: 'stacked' | 'percent'
}

/** Where the parts of a chart are in a block of cells, as ranges on its sheet. */
export interface SeriesLayout {
  /** Each series is a column of the block (else a row). */
  byColumns: boolean
  categories?: CellRange
  series: { values: CellRange; name?: CellRange }[]
}

export interface Shape {
  layout: SeriesLayout
  /** What labels the categories. */
  categories: 'text' | 'date' | 'number' | 'none'
  /** How many columns (or rows) hold numbers, the x values of a scatter chart included. */
  numberLines: number
}

type CellKind = 'empty' | 'number' | 'date' | 'text'

const kindOf = (cell: ChartCell | undefined): CellKind => (isEmptyCell(cell) ? 'empty' : isDateCell(cell) ? 'date' : numberOf(cell) !== null ? 'number' : 'text')

function isYear(cell: ChartCell | undefined): boolean {
  const n = numberOf(cell)

  return n !== null && Number.isInteger(n) && n >= 1900 && n <= 2100 && !cell?.format?.includes('%')
}

/** The cells of `range` in a block of cells at `origin`, row by row. */
function cellsIn(grid: CellGrid, origin: CellRange, range: CellRange): (ChartCell | undefined)[] {
  const cells: (ChartCell | undefined)[] = []

  for (let row = range.startRow; row <= range.endRow; row++) {
    for (let column = range.startColumn; column <= range.endColumn; column++) {
      cells.push(grid[row - origin.startRow]?.[column - origin.startColumn])
    }
  }

  return cells
}

/** How a block of cells at `origin` reads as a chart; a scatter chart takes its x values from the first column of numbers. */
export function shapeOf(grid: CellGrid, origin: CellRange, kind?: ChartKind): Shape {
  const rows = grid.length
  const columns = Math.max(0, ...grid.map((row) => row.length))
  // Series run along the longer side, as Excel lays them out; a line is one column (or row) of the block.
  const byColumns = rows >= columns
  const count = byColumns ? columns : rows
  const length = byColumns ? rows : columns
  const cell = (line: number, i: number): ChartCell | undefined => (byColumns ? grid[i]?.[line] : grid[line]?.[i])
  const lineCells = (line: number, from: number) => Array.from({ length: Math.max(0, length - from) }, (_, i) => cell(line, from + i))
  const numberLines = Array.from({ length: count }, (_, line) => line).filter((line) => lineCells(line, length > 1 ? 1 : 0).some((entry) => kindOf(entry) === 'number'))
  const heads = numberLines.map((line) => cell(line, 0))
  const corner = kindOf(cell(0, 0))
  const textHeads = heads.every((head) => ['empty', 'text'].includes(kindOf(head))) && heads.some((head) => kindOf(head) === 'text')
  // Years over the columns of numbers name them too ("Product | 2023 | 2024"), when they are not all years.
  const yearHeads = count > 1 && ['empty', 'text'].includes(corner) && heads.every(isYear) && !numberLines.every((line) => lineCells(line, 0).filter((entry) => !isEmptyCell(entry)).every(isYear))
  const header = length > 1 && numberLines.length > 0 && (textHeads || yearHeads)
  const first = header ? 1 : 0
  const labels = lineCells(0, first).filter((entry) => !isEmptyCell(entry))
  const labelKinds = labels.map(kindOf)
  const words = labelKinds.filter((entry) => entry === 'text' || entry === 'date').length
  // The first line labels the categories when it holds text or dates, when an empty corner sits over the
  // series' names, or when it holds years beside other numbers.
  const labelled = count > 1 && labels.length > 0 && (words * 2 > labels.length || (header && corner === 'empty') || (labels.every(isYear) && numberLines.length > 1))
  const xValues = !labelled && kind === 'scatter' && numberLines.length >= 2
  const categoryLine = labelled || xValues ? 0 : -1
  const at = (line: number, from: number, to: number): CellRange =>
    byColumns ? { startRow: origin.startRow + from, endRow: origin.startRow + to, startColumn: origin.startColumn + line, endColumn: origin.startColumn + line } : { startRow: origin.startRow + line, endRow: origin.startRow + line, startColumn: origin.startColumn + from, endColumn: origin.startColumn + to }
  const series = numberLines.filter((line) => line !== categoryLine).map((line) => ({ values: at(line, first, length - 1), ...(header ? { name: at(line, 0, 0) } : {}) }))
  const categories = categoryLine === 0 && length > first ? at(0, first, length - 1) : undefined
  const dates = labelKinds.filter((entry) => entry === 'date').length * 2 > labelKinds.length

  return {
    layout: { byColumns, ...(categories ? { categories } : {}), series },
    categories: !categories ? 'none' : dates ? 'date' : labelKinds.every((entry) => entry === 'number') ? 'number' : 'text',
    numberLines: numberLines.length
  }
}

/** Where the series, their names and the categories are in a block of cells at `origin`. */
export const layoutOf = (grid: CellGrid, origin: CellRange, kind?: ChartKind): SeriesLayout => shapeOf(grid, origin, kind).layout

const near = (value: number, target: number) => Math.abs(value - target) <= target * 0.005

/** The kinds of chart that suit a block of cells, the best first, each with why; none when it holds no numbers. */
export function recommend(grid: CellGrid): Recommendation[] {
  const origin = { startRow: 0, startColumn: 0, endRow: Math.max(0, grid.length - 1), endColumn: Math.max(0, ...grid.map((row) => row.length - 1)) }
  const shape = shapeOf(grid, origin)
  const { layout } = shape
  const numbers = layout.series.map(({ values }) => cellsIn(grid, origin, values).map(numberOf))
  const present = numbers.flat().filter((value): value is number => value !== null)

  if (!present.length) {
    return []
  }

  const count = layout.series.length
  const points = Math.max(0, ...numbers.map((values) => values.length))
  const nonNegative = present.every((value) => value >= 0)
  const labels = layout.categories ? cellsIn(grid, origin, layout.categories) : []
  const longLabels = labels.length > 0 && labels.reduce((sum, cell) => sum + (cell?.text.length ?? 0), 0) / labels.length > 12
  const sum = present.reduce((total, value) => total + value, 0)
  const percentages = layout.series.some(({ values }) => cellsIn(grid, origin, values).some((cell) => typeof cell?.v === 'number' && cell.format?.includes('%')))
  const shares = count === 1 && nonNegative && points >= 2 && points <= 12 && (near(sum, 100) || near(sum, 1) || percentages)
  const scales = numbers.map((values) => Math.max(0, ...values.map((value) => Math.abs(value ?? 0)))).filter((scale) => scale > 0)
  const apart = count >= 2 && scales.length >= 2 && Math.max(...scales) / Math.min(...scales) >= 10
  const list: Recommendation[] = []
  const add = (kind: ChartKind, reason: string, stacking?: 'stacked' | 'percent') => {
    if (!list.some((entry) => entry.kind === kind && entry.stacking === stacking)) {
      list.push({ kind, reason, ...(stacking ? { stacking } : {}) })
    }
  }

  if (shape.categories === 'none' && shape.numberLines === 2) {
    add('scatter', 'Two columns of numbers: each row is a point, the first number across and the second up')
  }

  if (shape.categories === 'date') {
    add('line', 'Dates along the bottom: a line shows how the values move over time')
  }

  if (count === 1) {
    if (shares) {
      add('pie', 'The values are shares of a whole: each one is a slice')
      add('doughnut', 'Shares of a whole, as a ring')
    }

    if (points > 20) {
      add('line', 'Many points: a line shows their shape')
    }

    if (longLabels) {
      add('bar', 'Long category names read well beside bars')
    }

    add('column', 'Columns compare the values side by side')
    add('bar', 'Bars compare the values, one below the other')

    if (nonNegative && points >= 2 && points <= 12) {
      add('pie', 'Each value as a slice of the total')
    }

    add('line', 'A line shows how the values change from one to the next')
  } else {
    if (apart) {
      add('combo', 'The series are on very different scales: the smaller ones get an axis of their own on the right')
    }

    if (points > 20) {
      add('line', 'Many points: lines show how each series moves')
    }

    if (longLabels) {
      add('bar', 'Long category names read well beside bars')
    }

    add('column', 'Columns compare the series category by category')
    add('line', 'Lines show how each series changes')

    if (nonNegative) {
      add('column', 'Stacked columns show each category’s total and its parts', 'stacked')
      add('area', 'Stacked areas show how the parts add up along the way', 'stacked')
    }

    add('bar', 'Bars compare the series, one category below the other')
  }

  return list.slice(0, 5)
}
