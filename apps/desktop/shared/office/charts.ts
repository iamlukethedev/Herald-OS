/*
 * A Herald Sheets chart: what it shows (series of cells on the workbook's sheets), how (columns,
 * bars, lines, areas, a pie or doughnut, scattered points, or columns and lines together), and its
 * title, axes, legend and labels. A chart lives in the data of the object floating over the grid
 * that draws it (Univer's sheet drawings keep that data in the workbook), it is drawn with ECharts,
 * and an .xlsx file holds it as an Excel chart, read back the same way.
 */

/** The Univer component that draws a chart in its floating object. */
export const CHART_COMPONENT = 'herald-chart'

/** The kind of sheet drawing a chart's floating object is: Univer's DrawingTypeEnum.DRAWING_DOM. */
export const CHART_DRAWING_TYPE = 8

export const CHART_KINDS = ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter', 'combo'] as const

export type ChartKind = (typeof CHART_KINDS)[number]

/** Cells on one sheet, the sheet by its id so that renaming it keeps the chart; rows and columns count from 0. */
export interface ChartRange {
  sheet: string
  startRow: number
  startColumn: number
  endRow: number
  endColumn: number
}

export interface ChartSeries {
  /** The series' name, from a cell or written out. */
  name?: { cell?: ChartRange; text?: string }
  values: ChartRange
  /** Category labels, or the x values of a scatter chart. */
  categories?: ChartRange
  /** How a combo chart draws this series. */
  type?: 'column' | 'line' | 'area'
  /** Measured against the value axis on the right (combo charts). */
  secondary?: boolean
  /** "#rrggbb"; without one, the series takes its turn in the chart's palette. */
  color?: string
  smooth?: boolean
  markers?: boolean
}

export interface ChartAxis {
  title?: string
  min?: number
  max?: number
  gridlines?: boolean
  /** The number format of the axis labels ("0%"); the cells' own when unset. */
  format?: string
  hidden?: boolean
}

export interface ChartSpec {
  kind: ChartKind
  title?: string
  series: ChartSeries[]
  /** Columns, bars and areas side by side, on top of each other, or as shares of the whole. */
  stacking?: 'none' | 'stacked' | 'percent'
  legend: 'top' | 'bottom' | 'left' | 'right' | 'none'
  /** Labels on the points: none, the values, percentages (pie and doughnut) or the category names. */
  labels: 'none' | 'value' | 'percent' | 'category'
  /** The category axis (x), the value axis (y), and the second value axis of a combo chart. */
  axes?: { x?: ChartAxis; y?: ChartAxis; y2?: ChartAxis }
  /** Colours for the series (slices, in a pie) in turn: the workbook theme's accents when the chart was made. */
  palette?: string[]
  /** The doughnut's hole, as a percentage of its size. */
  hole?: number
}

/** What a chart's floating object keeps: the chart, and the part of the file it was read from. */
export interface ChartData {
  herald: 'chart'
  version: 1
  spec: ChartSpec
  /**
   * The chart part it was read from, with a fingerprint of the spec as read (an unchanged chart is
   * written back as the file had it) and its anchor's place in the sheet's drawing (which keeps it
   * in front of or behind the pictures and shapes around it).
   */
  source?: { part: string; fingerprint: string; anchor?: number }
}

export const isChartData = (data: unknown): data is ChartData => Boolean(data) && typeof data === 'object' && (data as ChartData).herald === 'chart' && typeof (data as ChartData).spec === 'object'
