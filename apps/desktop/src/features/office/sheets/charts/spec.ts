import type { FWorkbook, FWorksheet } from '@univerjs/sheets/facade'
import { CHART_KINDS, type ChartAxis, type ChartKind, type ChartRange, type ChartSeries, type ChartSpec } from '../../../../../shared/office/charts.ts'
import { isHexColor } from '../../../../../shared/theme.ts'
import { type CellRange, quoteSheet, rangeName } from '../../../../../shared/office/xlsx/address.ts'
import { rangeOf, type SheetsTarget, sheetOf } from '../model.ts'
import { hexOf, readCells, readGrid, regionAround, workbookPalette } from './cells.ts'
import { type CellGrid, chartValues, seriesName } from './data.ts'
import { layoutOf, recommend } from './recommend.ts'

/*
 * A chart's spec from what a command or a menu asks for, checked, with messages that say what to give
 * instead: a new chart's from a block of cells, and the settings that change one.
 */

export const LEGENDS = ['top', 'bottom', 'left', 'right', 'none'] as const
export const LABELS = ['none', 'value', 'percent', 'category'] as const
export const STACKINGS = ['none', 'stacked', 'percent'] as const
export const SERIES_TYPES = ['column', 'line', 'area'] as const
export const SETTINGS = ['kind', 'title', 'range', 'series', 'categories', 'legend', 'labels', 'axes', 'stacking', 'palette', 'hole'] as const
const SERIES_KEYS = ['values', 'name', 'nameCell', 'categories', 'color', 'type', 'secondary', 'smooth', 'markers'] as const
const AXIS_KEYS = ['title', 'min', 'max', 'gridlines', 'format', 'hidden', 'reverse'] as const

/** The most cells a chart is made from in one go. */
const MAX_BLOCK = 50000

export const isBlank = (value: unknown): boolean => value === undefined || value === null || (typeof value === 'string' && !value.trim())

export function checkKeys(input: object, known: readonly string[], what: string): void {
  const unknown = Object.keys(input).filter((key) => !known.includes(key) && (input as Record<string, unknown>)[key] !== undefined)

  if (unknown.length) {
    throw new Error(`${what} does not take ${unknown.join(', ')}; it takes ${known.join(', ')}`)
  }
}

export function choice<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  const text = String(value ?? '').trim().toLowerCase()

  if (!(allowed as readonly string[]).includes(text)) {
    throw new Error(`${name} is one of ${allowed.join(', ')}, not “${String(value)}”`)
  }

  return text as T
}

function flag(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${name} is true or false, not “${String(value)}”`)
  }

  return value
}

function colorOf(value: unknown, name: string): string {
  if (!isHexColor(value)) {
    throw new Error(`${name} is a colour like #4472c4, not “${String(value)}”`)
  }

  return hexOf(value)
}

/** A chart range as A1 text with its sheet's name, "'Q1 sales'!B2:B9" ("#REF!" when the sheet is gone). */
export function rangeText(workbook: FWorkbook, range: ChartRange): string {
  const name = workbook.getSheetBySheetId(range.sheet)?.getSheetName()

  return name ? `${quoteSheet(name)}!${rangeName(range)}` : '#REF!'
}

/** Cells a setting names, by their sheet's id; on `sheet` unless it names its own. */
function chartRange(target: SheetsTarget, reference: unknown, sheet: FWorksheet, what: string): ChartRange {
  try {
    const { sheet: on, cells } = rangeOf(target.workbook, reference, sheet.getSheetName())

    return { sheet: on.getSheetId(), ...cells }
  } catch (error) {
    throw new Error(`${what}: ${(error as Error).message}`)
  }
}

/** One column or one row of cells. */
function stripRange(target: SheetsTarget, reference: unknown, sheet: FWorksheet, what: string): ChartRange {
  const range = chartRange(target, reference, sheet, what)

  if (range.startRow !== range.endRow && range.startColumn !== range.endColumn) {
    throw new Error(`${what} is one column or one row of cells, not ${rangeName(range)}`)
  }

  return range
}

export interface Block {
  sheet: FWorksheet
  /** The cells read, the table around a single cell included. */
  cells: CellRange
  grid: CellGrid
  series: ChartSeries[]
}

/** The series in a block of cells (or in the table around one cell), laid out as `kind` reads them. */
export function blockOf(target: SheetsTarget, reference: unknown, sheet: FWorksheet, kind?: ChartKind): Block {
  const { sheet: on, cells: picked } = rangeOf(target.workbook, reference, sheet.getSheetName())
  const single = picked.startRow === picked.endRow && picked.startColumn === picked.endColumn
  const cells = single ? (regionAround(on, picked.startRow, picked.startColumn) ?? picked) : picked
  const used = { ...cells, endRow: Math.min(cells.endRow, Math.max(cells.startRow, on.getLastRow())), endColumn: Math.min(cells.endColumn, Math.max(cells.startColumn, on.getLastColumn())) }
  const count = (used.endRow - used.startRow + 1) * (used.endColumn - used.startColumn + 1)

  if (count > MAX_BLOCK) {
    throw new Error(`${rangeName(used)} has ${count.toLocaleString('en-US')} cells; a chart is made from at most ${MAX_BLOCK.toLocaleString('en-US')}`)
  }

  const grid = readCells(on, used)
  const layout = layoutOf(grid, used, kind)

  if (!layout.series.length) {
    throw new Error(`${rangeName(used)} has no numbers to chart: give cells with numbers, or a cell in a table of them`)
  }

  const onSheet = (range: CellRange): ChartRange => ({ sheet: on.getSheetId(), ...range })
  const series = layout.series.map((entry) => ({ values: onSheet(entry.values), ...(entry.name ? { name: { cell: onSheet(entry.name) } } : {}), ...(layout.categories ? { categories: onSheet(layout.categories) } : {}) }))

  return { sheet: on, cells: used, grid, series }
}

function seriesFrom(target: SheetsTarget, value: unknown, index: number, sheet: FWorksheet): ChartSeries {
  const what = `series ${index + 1}`

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${what} is an object like {"values": "B2:B9", "name": "Sales", "categories": "A2:A9"}`)
  }

  const input = value as Record<string, unknown>
  checkKeys(input, SERIES_KEYS, what)

  if (isBlank(input.values)) {
    throw new Error(`${what} needs values: one column or row of numbers, like "B2:B9"`)
  }

  const series: ChartSeries = { values: stripRange(target, input.values, sheet, `${what} values`) }
  const nameRef = !isBlank(input.nameCell) ? input.nameCell : typeof input.name === 'string' && /^=\S/.test(input.name.trim()) ? input.name.trim().slice(1) : undefined

  if (nameRef !== undefined) {
    const cell = chartRange(target, nameRef, sheet, `${what} nameCell`)

    if (cell.startRow !== cell.endRow || cell.startColumn !== cell.endColumn) {
      throw new Error(`${what} nameCell is one cell, like B1, not ${rangeName(cell)}`)
    }

    series.name = { cell }
  } else if (typeof input.name === 'string' && input.name.trim()) {
    series.name = { text: input.name.trim() }
  } else if (!isBlank(input.name)) {
    throw new Error(`${what} name is text, or a cell like "=B1"`)
  }

  if (!isBlank(input.categories)) {
    series.categories = stripRange(target, input.categories, sheet, `${what} categories`)
  }

  if (!isBlank(input.color)) {
    series.color = colorOf(input.color, `${what} color`)
  }

  if (!isBlank(input.type)) {
    series.type = choice(input.type, SERIES_TYPES, `${what} type`)
  }

  for (const key of ['secondary', 'smooth', 'markers'] as const) {
    if (input[key] !== undefined && input[key] !== null) {
      series[key] = flag(input[key], `${what} ${key}`)
    }
  }

  return series
}

function axisFrom(value: unknown, base: ChartAxis | undefined, name: string): ChartAxis | undefined {
  if (value === null) {
    return undefined
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`axes.${name} is an object like {"title": "Sales", "min": 0, "max": 100, "gridlines": true, "format": "#,##0", "hidden": false, "reverse": false}`)
  }

  const input = value as Record<string, unknown>
  checkKeys(input, AXIS_KEYS, `axes.${name}`)
  const axis: ChartAxis = { ...base }

  for (const key of AXIS_KEYS) {
    const entry = input[key]

    if (entry === undefined) {
      continue
    }

    if (entry === null || (typeof entry === 'string' && !entry.trim() && (key === 'title' || key === 'format'))) {
      delete axis[key]
    } else if (key === 'title' || key === 'format') {
      axis[key] = String(entry).trim()
    } else if (key === 'min' || key === 'max') {
      const n = Number(entry)

      if (typeof entry === 'boolean' || (typeof entry === 'string' && !entry.trim()) || !Number.isFinite(n)) {
        throw new Error(`axes.${name}.${key} is a number, not “${String(entry)}”`)
      }

      axis[key] = n
    } else {
      axis[key] = flag(entry, `axes.${name}.${key}`)
    }
  }

  if (axis.min !== undefined && axis.max !== undefined && axis.min >= axis.max) {
    throw new Error(`axes.${name}: min (${axis.min}) has to be below max (${axis.max})`)
  }

  return Object.keys(axis).length ? axis : undefined
}

function axesFrom(value: unknown, base: ChartSpec['axes']): ChartSpec['axes'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('axes is {"x": {…}, "y": {…}, "y2": {…}} (the category axis, the value axis, a combo chart’s second value axis), each with title, min, max, gridlines, format, hidden or reverse (the axis the other way round)')
  }

  checkKeys(value, ['x', 'y', 'y2'], 'axes')
  const axes = { ...base }

  for (const key of ['x', 'y', 'y2'] as const) {
    if (key in value) {
      const axis = axisFrom((value as Record<string, unknown>)[key], axes[key], key)

      if (axis) {
        axes[key] = axis
      } else {
        delete axes[key]
      }
    }
  }

  return axes
}

/** A combo chart's series as Excel starts one: the first as columns, the rest as lines, those on a much smaller scale on the second axis. */
function comboSeries(target: SheetsTarget, spec: ChartSpec): ChartSeries[] {
  const scales = chartValues(spec, (range) => readGrid(target.workbook, range)).series.map((series) => Math.max(0, ...series.values.map((value) => Math.abs(value ?? 0))))
  const largest = Math.max(0, ...scales)

  return spec.series.map((series, i) => ({ ...series, type: series.type ?? (i === 0 ? 'column' : 'line'), ...(series.secondary === undefined && i > 0 && largest > 0 && scales[i] > 0 && scales[i] * 10 <= largest ? { secondary: true } : {}) }))
}

/** `spec` with the settings `args` change, checked; ranges without a sheet name are on `sheet`. */
export function withSettings(target: SheetsTarget, args: Record<string, unknown>, spec: ChartSpec, sheet: FWorksheet): ChartSpec {
  const next: ChartSpec = { ...spec, series: [...spec.series] }

  if (args.kind !== undefined) {
    next.kind = choice(args.kind, CHART_KINDS, 'kind')
  }

  if (args.title !== undefined) {
    if (args.title !== null && typeof args.title !== 'string') {
      throw new Error('title is text (empty for none)')
    }

    const title = (args.title ?? '').trim()

    if (title.length > 255) {
      throw new Error('title is at most 255 characters')
    }

    if (title) {
      next.title = title
    } else {
      delete next.title
    }
  }

  if (args.range !== undefined) {
    next.series = blockOf(target, args.range, sheet, next.kind).series
  }

  if (args.series !== undefined) {
    if (!Array.isArray(args.series) || !args.series.length) {
      throw new Error('series is a list of at least one series: [{"values": "B2:B9", "name": "Sales"}]')
    }

    next.series = args.series.map((entry, i) => seriesFrom(target, entry, i, sheet))
  }

  if (args.categories !== undefined) {
    const categories = isBlank(args.categories) ? undefined : stripRange(target, args.categories, sheet, 'categories')
    next.series = next.series.map(({ categories: _old, ...series }) => (categories ? { ...series, categories } : series))
  }

  if (args.legend !== undefined) {
    next.legend = choice(args.legend, LEGENDS, 'legend')
  }

  if (args.labels !== undefined) {
    next.labels = choice(args.labels, LABELS, 'labels')
  }

  if (args.stacking !== undefined) {
    next.stacking = choice(args.stacking, STACKINGS, 'stacking')
  }

  if (args.axes !== undefined) {
    next.axes = axesFrom(args.axes, next.axes)
  }

  if (args.palette !== undefined) {
    if (args.palette === 'workbook') {
      next.palette = workbookPalette(target.workbook)
    } else if (Array.isArray(args.palette) && args.palette.length > 0 && args.palette.length <= 24) {
      next.palette = args.palette.map((color, i) => colorOf(color, `palette colour ${i + 1}`))
    } else {
      throw new Error('palette is a list of colours, like ["#4472c4", "#ed7d31"], or "workbook" for the workbook theme’s')
    }
  }

  if (args.hole !== undefined) {
    const hole = Number(args.hole)

    if (typeof args.hole === 'boolean' || !Number.isFinite(hole) || hole < 0 || hole > 90) {
      throw new Error(`hole is the doughnut’s hole as a percentage of its size, from 0 to 90 (it was ${String(args.hole)})`)
    }

    next.hole = Math.round(hole)
  }

  if (next.kind === 'doughnut' && next.hole === undefined) {
    next.hole = 50
  }

  if (next.kind === 'combo' && spec.kind !== 'combo') {
    next.series = comboSeries(target, next)
  }

  // Univer keeps the spec as JSON: nothing in it may be undefined.
  return JSON.parse(JSON.stringify(next)) as ChartSpec
}

/**
 * A new chart's spec from a block of cells (or the table around a cell): of `kind`, else the kind that
 * suits the data best, titled from the data when it names one series, with `settings` on top.
 */
export function newChart(target: SheetsTarget, args: { range: unknown; kind?: unknown; sheet?: unknown; settings?: Record<string, unknown> }): { spec: ChartSpec; block: Block; front: FWorksheet } {
  if (isBlank(args.range)) {
    throw new Error('Say which cells to chart: range, like "A1:C9", "\'Q1 sales\'!A1:C9", or a cell in a table')
  }

  const front = sheetOf(target.workbook, args.sheet)
  const kind = isBlank(args.kind) ? undefined : choice(args.kind, CHART_KINDS, 'kind')
  const first = blockOf(target, args.range, front, kind)
  const best = recommend(first.grid)[0]
  const chosen = kind ?? best?.kind ?? 'column'
  const block = chosen === 'scatter' && !kind ? blockOf(target, args.range, front, 'scatter') : first
  const one = block.series.length === 1 && block.series[0].name ? seriesName(block.series[0], 0, (range) => readGrid(target.workbook, range)) : ''
  // A new chart starts as columns and the settings make it the kind chosen, as changing a chart's kind does.
  const base: ChartSpec = {
    kind: 'column',
    ...(one ? { title: one } : {}),
    series: block.series,
    legend: block.series.length > 1 || chosen === 'pie' || chosen === 'doughnut' ? 'bottom' : 'none',
    labels: 'none',
    stacking: kind ? 'none' : (best?.stacking ?? 'none'),
    palette: workbookPalette(target.workbook)
  }

  return { spec: withSettings(target, { ...args.settings, kind: chosen }, base, front), block, front }
}
