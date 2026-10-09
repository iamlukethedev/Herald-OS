import { numfmt } from '@univerjs/core'
import type { ChartRange, ChartSeries, ChartSpec } from '../../../../../shared/office/charts.ts'

/*
 * The numbers and labels a chart draws, read from its cells. Blanks, text and errors in a series
 * leave gaps; numbers typed as text ("1,200", "12%") count; dates along the bottom read as the cells
 * show them; and rows or columns hidden on the sheet (by hand or by a filter) stay out, as Excel
 * leaves them out of its charts.
 */

/** One cell as a chart reads it. */
export interface ChartCell {
  /** What it holds: a number (dates are numbers too), text, true or false, or null when it is empty. */
  v: number | string | boolean | null
  /** What it shows, its number format applied. */
  text: string
  /** Its number format, when it has one other than General. */
  format?: string
  /** Its row or column is hidden. */
  hidden?: boolean
}

export type CellGrid = ChartCell[][]

export interface SeriesValues {
  name: string
  values: (number | null)[]
  /** The number format of the series' cells, for its labels and its axis. */
  format?: string
}

/** What a chart draws: labels along the category axis (and their numbers, a scatter chart's x values), and each series' numbers. */
export interface ChartValues {
  categories: string[]
  x: (number | null)[]
  /** The number format of the categories' cells, for a scatter chart's x axis. */
  xFormat?: string
  /** The categories are dates. */
  dates: boolean
  series: SeriesValues[]
}

const NUMBER_TEXT = /^[+-]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?$/

/** A cell's number: a number as it is, a number written as text read, anything else none. */
export function numberOf(cell: ChartCell | undefined): number | null {
  if (typeof cell?.v === 'number') {
    return Number.isFinite(cell.v) ? cell.v : null
  }

  const text = typeof cell?.v === 'string' ? cell.v.trim() : ''

  if (!/\d/.test(text) || !NUMBER_TEXT.test(text)) {
    return null
  }

  const n = Number(text.replace(/[,%]/g, ''))

  return Number.isFinite(n) ? (text.endsWith('%') ? n / 100 : n) : null
}

export const isEmptyCell = (cell: ChartCell | undefined): boolean => !cell || cell.v === null || cell.v === '' || (typeof cell.v === 'string' && !cell.v.trim())

export function isDateCell(cell: ChartCell | undefined): boolean {
  return typeof cell?.v === 'number' && Boolean(cell.format) && numfmt.isDateFormat(cell.format!)
}

/** A row or column of cells in order; a block reads row by row. */
export const stripOf = (grid: CellGrid | null | undefined): ChartCell[] => (grid ?? []).flat()

/** The name a series shows: written out, from its cell, or its place. */
export function seriesName(series: ChartSeries, index: number, read: (range: ChartRange) => CellGrid | null): string {
  const named = series.name?.text ?? (series.name?.cell ? (stripOf(read(series.name.cell))[0]?.text ?? '') : '')

  return named.trim() || `Series ${index + 1}`
}

/** The values a chart draws, reading its cells with `read` (null for cells on a sheet that is gone). */
export function chartValues(spec: ChartSpec, read: (range: ChartRange) => CellGrid | null): ChartValues {
  const strips = spec.series.map((series) => stripOf(read(series.values)))
  const categoryRange = spec.series.find((series) => series.categories)?.categories
  const labels = categoryRange ? stripOf(read(categoryRange)) : []
  const length = Math.max(0, ...strips.map((cells) => cells.length))
  // A hidden row or column of the first series takes its place out of every series and the categories.
  const shown = Array.from({ length }, (_, i) => !strips[0]?.[i]?.hidden)
  const kept = <T>(make: (i: number) => T): T[] => Array.from({ length }, (_, i) => i).filter((i) => shown[i]).map(make)
  const filled = labels.slice(0, length).filter((cell) => !isEmptyCell(cell))
  const xFormat = filled.find((cell) => typeof cell.v === 'number' && cell.format)?.format

  return {
    categories: kept((i) => (categoryRange ? (labels[i]?.text ?? '') : String(i + 1))),
    x: kept((i) => (categoryRange ? numberOf(labels[i]) : i + 1)),
    ...(xFormat ? { xFormat } : {}),
    dates: filled.length > 0 && filled.filter(isDateCell).length * 2 > filled.length,
    series: spec.series.map((series, s) => {
      const format = strips[s].find((cell) => typeof cell.v === 'number' && cell.format)?.format

      return { name: seriesName(series, s, read), values: kept((i) => numberOf(strips[s][i])), ...(format ? { format } : {}) }
    })
  }
}

/** Whether a chart has anything to draw. */
export const hasNumbers = (values: ChartValues): boolean => values.series.some((series) => series.values.some((value) => value !== null))
