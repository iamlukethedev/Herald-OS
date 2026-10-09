import type { ChartRange, ChartSpec } from '../../../../../shared/office/charts.ts'
import type { CellGrid, ChartCell } from './data.ts'

/* Blocks of cells for the charts' tests, written as rows of values. */

/** A cell holding `v`, showing `text` (the value itself by default). */
export const cell = (v: ChartCell['v'], format?: string, text?: string): ChartCell => ({ v, text: text ?? (v === null ? '' : String(v)), ...(format ? { format } : {}) })

/** A date cell: `serial` as Excel counts days, shown as `text`. */
export const date = (serial: number, text: string): ChartCell => cell(serial, 'yyyy-mm-dd', text)

const isCell = (value: unknown): value is ChartCell => Boolean(value) && typeof value === 'object' && 'text' in (value as ChartCell)

/** Rows of values (or cells) as a block of cells. */
export const grid = (rows: unknown[][]): CellGrid => rows.map((row) => row.map((value) => (isCell(value) ? value : cell(value as ChartCell['v']))))

/** A reader of the cells of `sheet` (ranges on other sheets read as gone), from a block that starts at A1. */
export const readerOf = (cells: CellGrid, sheet = 's1') => (range: ChartRange): CellGrid | null =>
  range.sheet !== sheet ? null : Array.from({ length: range.endRow - range.startRow + 1 }, (_, r) => Array.from({ length: range.endColumn - range.startColumn + 1 }, (_, c) => cells[range.startRow + r]?.[range.startColumn + c] ?? cell(null)))

/** Cells from row `startRow` to `endRow` of one column. */
export const column = (index: number, startRow: number, endRow: number, sheet = 's1'): ChartRange => ({ sheet, startRow, endRow, startColumn: index, endColumn: index })

/** A spec with the defaults a new chart gets. */
export const specOf = (kind: ChartSpec['kind'], series: ChartSpec['series'], extra: Partial<ChartSpec> = {}): ChartSpec => ({ kind, series, legend: 'bottom', labels: 'none', ...extra })
