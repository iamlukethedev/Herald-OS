import { generateRandomId } from '@univerjs/core'
import type { FWorksheet } from '@univerjs/sheets/facade'
import { CHART_COMPONENT, CHART_DRAWING_TYPE, type CellOffset, type ChartDrawing, type ChartKind, type ChartRange, type ChartSpec } from '../../../../../shared/office/charts.ts'
import { cellName, type CellRange } from '../../../../../shared/office/xlsx/address.ts'
import { oneStep, parseTarget, type SheetsTarget, sheetOf } from '../model.ts'
import { readGrid, workbookPalette } from './cells.ts'
import { seriesName } from './data.ts'
import { applyDrawings, cellsUnder, chartsOf, type PlacedChart, placeAt, sizeOfCells } from './drawings.ts'
import { type Recommendation, recommend } from './recommend.ts'
import { blockOf, checkKeys, isBlank, newChart, rangeText, SETTINGS, withSettings } from './spec.ts'

/*
 * What Hermes's commands and the menus do with charts: inserting one from a selection, its spec and the
 * data it shows, on a workbook (see ../model.ts). Ranges are A1 text, on the sheet in front unless they
 * name theirs ("'Q1 sales'!B2:B9"); a chart keeps them by sheet id, so renaming a sheet keeps the chart.
 * Each change is one step to undo, live in a window or on a workbook loaded with nothing drawn.
 */

export interface ChartSize {
  width: number
  height: number
}

export interface ChartSummary {
  chart: string
  sheet: string
  kind: ChartKind
  title: string
  /** The cell under its top-left corner. */
  at: string
  size: ChartSize
  series: number
}

export interface SeriesDescription {
  name: string
  /** The cell its name comes from. */
  nameCell?: string
  values: string
  categories?: string
  color?: string
  type?: 'column' | 'line' | 'area'
  secondary?: boolean
  smooth?: boolean
  markers?: boolean
}

export interface ChartDescription extends Omit<ChartSummary, 'series'> {
  series: SeriesDescription[]
  legend: ChartSpec['legend']
  labels: ChartSpec['labels']
  stacking: NonNullable<ChartSpec['stacking']>
  axes: NonNullable<ChartSpec['axes']>
  palette: string[]
  hole?: number
}

/** A new chart's size: Excel's, five inches by three. */
const DEFAULT_SIZE: ChartSize = { width: 480, height: 288 }

const sizeOf = (drawing: ChartDrawing): ChartSize => ({ width: Math.round(drawing.transform?.width ?? 0), height: Math.round(drawing.transform?.height ?? 0) })

function summaryOf({ id, sheet, drawing }: PlacedChart): ChartSummary {
  const { spec } = drawing.data

  return { chart: id, sheet: sheet.getSheetName(), kind: spec.kind, title: spec.title ?? '', at: cellName(drawing.sheetTransform.from.row, drawing.sheetTransform.from.column), size: sizeOf(drawing), series: spec.series.length }
}

function describe(target: SheetsTarget, placed: PlacedChart): ChartDescription {
  const { spec } = placed.drawing.data
  const workbook = target.workbook
  const read = (range: ChartRange) => readGrid(workbook, range)
  const { series: _count, ...summary } = summaryOf(placed)

  return {
    ...summary,
    series: spec.series.map((entry, i) => ({
      name: seriesName(entry, i, read),
      ...(entry.name?.cell ? { nameCell: rangeText(workbook, entry.name.cell) } : {}),
      values: rangeText(workbook, entry.values),
      ...(entry.categories ? { categories: rangeText(workbook, entry.categories) } : {}),
      ...(entry.color ? { color: entry.color } : {}),
      ...(entry.type ? { type: entry.type } : {}),
      ...(entry.secondary ? { secondary: true } : {}),
      ...(entry.smooth !== undefined ? { smooth: entry.smooth } : {}),
      ...(entry.markers !== undefined ? { markers: entry.markers } : {})
    })),
    legend: spec.legend,
    labels: spec.labels,
    stacking: spec.stacking ?? 'none',
    axes: spec.axes ?? {},
    palette: spec.palette ?? workbookPalette(workbook),
    ...(spec.kind === 'doughnut' ? { hole: spec.hole ?? 50 } : {})
  }
}

const brief = ({ id, sheet, drawing }: PlacedChart) => `${id} (${drawing.data.spec.title ? `“${drawing.data.spec.title}”` : `a ${drawing.data.spec.kind} chart`} on ${sheet.getSheetName()})`

/** The chart a command names: by its id, its title, or its number in listCharts (1 is the first). */
function chartOf(target: SheetsTarget, chart: unknown): PlacedChart {
  const charts = chartsOf(target)

  if (!charts.length) {
    throw new Error('This workbook has no charts yet: insertChart makes one')
  }

  if (typeof chart === 'number' && Number.isInteger(chart) && chart >= 1 && chart <= charts.length) {
    return charts[chart - 1]
  }

  const wanted = String(chart ?? '').trim()
  const byId = charts.find((entry) => entry.id === wanted)

  if (byId) {
    return byId
  }

  const titled = charts.filter((entry) => wanted && entry.drawing.data.spec.title?.trim().toLowerCase() === wanted.toLowerCase())

  if (titled.length > 1) {
    throw new Error(`Several charts are titled “${wanted}”: say which by its id (${titled.map(brief).join('; ')})`)
  }

  if (!titled.length) {
    throw new Error(`There is no chart “${wanted}”: give a chart’s id, title or number (${charts.map(brief).join('; ')})`)
  }

  return titled[0]
}

function sizeFrom(value: unknown, base: ChartSize): ChartSize {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('size is {"width": 480, "height": 288}, in pixels')
  }

  checkKeys(value, ['width', 'height'], 'size')
  const { width = base.width, height = base.height } = value as { width?: unknown; height?: unknown }
  const pixels = (n: unknown, name: string) => {
    const v = Number(n)

    if (typeof n === 'boolean' || !Number.isFinite(v) || v < 80 || v > 4000) {
      throw new Error(`size.${name} is a number of pixels from 80 to 4000 (it was ${String(n)})`)
    }

    return Math.round(v)
  }

  return { width: pixels(width, 'width'), height: pixels(height, 'height') }
}

/** Where a chart goes on `sheet` and how big it is: `at` a cell for its corner (or cells for it to cover), and `size` in pixels. */
function whereFrom(target: SheetsTarget, sheet: FWorksheet, at: unknown, size: unknown, current: { corner: CellOffset; size: ChartSize }): { corner: CellOffset; size: ChartSize } {
  let corner = current.corner
  let measured = current.size

  if (!isBlank(at)) {
    const { sheet: named, range } = parseTarget(at)

    if (named && named.toLowerCase() !== sheet.getSheetName().toLowerCase()) {
      throw new Error(`at is a cell on ${sheet.getSheetName()}, where the chart is: give it without a sheet name, like "H2"`)
    }

    if (range.endRow >= sheet.getMaxRows() || range.endColumn >= sheet.getMaxColumns() || range.endRow - range.startRow >= 500 || range.endColumn - range.startColumn >= 100) {
      throw new Error(`at is a cell on ${sheet.getSheetName()} like "H2", or cells for the chart to cover like "H2:N18"`)
    }

    corner = { column: range.startColumn, columnOffset: 0, row: range.startRow, rowOffset: 0 }

    if (range.startRow !== range.endRow || range.startColumn !== range.endColumn) {
      measured = sizeOfCells(target, sheet, range)
    }
  }

  if (size !== undefined && size !== null) {
    measured = sizeFrom(size, measured)
  }

  return { corner, size: measured }
}

const overlaps = (a: CellRange, b: CellRange) => a.startRow <= b.endRow && b.startRow <= a.endRow && a.startColumn <= b.endColumn && b.startColumn <= a.endColumn

/** A corner for a new chart beside the data (below it when the sheet ends to its right), clear of the data and the sheet's other charts. */
function cornerBeside(target: SheetsTarget, sheet: FWorksheet, data: CellRange | null, size: ChartSize): CellOffset {
  const room = Math.ceil(size.width / 64) + 2
  let corner: CellOffset = !data ? { column: 1, columnOffset: 0, row: 1, rowOffset: 0 } : data.endColumn + room < sheet.getMaxColumns() ? { column: data.endColumn + 2, columnOffset: 0, row: data.startRow, rowOffset: 0 } : { column: data.startColumn, columnOffset: 0, row: data.endRow + 2, rowOffset: 0 }
  const taken = [...(data ? [data] : []), ...chartsOf(target, sheet.getSheetId()).map(({ drawing }) => cellsUnder(drawing))]

  for (let tries = 0; tries < 50; tries++) {
    const covered = cellsUnder(placeAt(target, sheet, corner, size))
    const blocking = taken.filter((other) => overlaps(other, covered))

    if (!blocking.length || corner.row + 2 >= sheet.getMaxRows()) {
      break
    }

    corner = { ...corner, row: Math.min(sheet.getMaxRows() - 1, Math.max(...blocking.map((other) => other.endRow)) + 2) }
  }

  return corner
}

/**
 * Insert a chart of `range` (a block, or a cell in a table): of `kind` (else the best for the data), titled
 * from the data when it names one series; on `sheet` (else the data's), `at` a cell or over cells (else
 * beside the data) and `size` pixels big; the other settings as updateChart takes them. One step to undo.
 */
export async function insertChart(target: SheetsTarget, args: { range: unknown; at?: unknown; size?: unknown; sheet?: unknown; [setting: string]: unknown }): Promise<{ chart: string; sheet: string; kind: ChartKind; series: SeriesDescription[] }> {
  checkKeys(args, ['range', 'at', 'size', 'sheet', ...SETTINGS.filter((key) => key !== 'range')], 'insertChart')
  const { range, at, size, sheet: on, kind, ...settings } = args
  const { spec, block, front } = newChart(target, { range, kind, sheet: on, settings })
  const sheet = isBlank(on) ? block.sheet : front
  const where = whereFrom(target, sheet, at, size, { corner: { column: 0, columnOffset: 0, row: 0, rowOffset: 0 }, size: DEFAULT_SIZE })
  const corner = isBlank(at) ? cornerBeside(target, sheet, sheet.getSheetId() === block.sheet.getSheetId() ? block.cells : null, where.size) : where.corner
  const drawing: ChartDrawing = {
    unitId: target.workbook.getId(),
    subUnitId: sheet.getSheetId(),
    drawingId: `chart-${generateRandomId(8)}`,
    drawingType: CHART_DRAWING_TYPE,
    componentKey: CHART_COMPONENT,
    ...placeAt(target, sheet, corner, where.size),
    anchorType: '1',
    data: { herald: 'chart', version: 1, spec },
    allowTransform: true
  }

  await oneStep(target, () => applyDrawings(target, 'insert', [drawing]))
  const placed = chartOf(target, drawing.drawingId)

  return { chart: placed.id, sheet: placed.sheet.getSheetName(), kind: spec.kind, series: describe(target, placed).series }
}

/** The charts of a workbook, or of one sheet. */
export function listCharts(target: SheetsTarget, args: { sheet?: unknown } = {}): ChartSummary[] {
  checkKeys(args, ['sheet'], 'listCharts')
  const sheet = isBlank(args.sheet) ? undefined : sheetOf(target.workbook, args.sheet)

  return chartsOf(target, sheet?.getSheetId()).map(summaryOf)
}

/** A chart's spec with its ranges as A1 text, where it is and how big. */
export function describeChart(target: SheetsTarget, args: { chart: unknown }): ChartDescription {
  checkKeys(args, ['chart'], 'describeChart')

  return describe(target, chartOf(target, args.chart))
}

/**
 * Change a chart: kind, title, series (the whole list, each {values, name or nameCell, categories, color,
 * type, secondary, smooth, markers}), categories (for every series), range (series laid out again from a
 * block), legend, labels, axes ({x, y, y2}, each {title, min, max, gridlines, format, hidden}, and x also
 * reverse: bars from the bottom up, columns from right to left; null clears),
 * stacking, palette (colours, or "workbook") or hole. One step to undo.
 */
export async function updateChart(target: SheetsTarget, args: { chart: unknown; [setting: string]: unknown }): Promise<ChartDescription> {
  checkKeys(args, ['chart', ...SETTINGS], 'updateChart')
  const placed = chartOf(target, args.chart)
  const { chart: _chart, ...changes } = args

  if (!Object.values(changes).some((value) => value !== undefined)) {
    throw new Error(`Say what to change: ${SETTINGS.join(', ')}`)
  }

  const current = placed.drawing.data
  const spec = withSettings(target, changes, current.spec, placed.sheet)

  if (JSON.stringify(spec) !== JSON.stringify(current.spec)) {
    await oneStep(target, () => applyDrawings(target, 'update', [{ unitId: placed.drawing.unitId, subUnitId: placed.drawing.subUnitId, drawingId: placed.id, data: { ...current, spec } }]))
  }

  return describe(target, chartOf(target, placed.id))
}

/** Move a chart `at` a cell (or over cells, sizing it to them) on its sheet, and size it; one step to undo. */
export async function moveChart(target: SheetsTarget, args: { chart: unknown; at?: unknown; size?: unknown }): Promise<{ chart: string; sheet: string; at: string; size: ChartSize }> {
  checkKeys(args, ['chart', 'at', 'size'], 'moveChart')
  const placed = chartOf(target, args.chart)

  if (isBlank(args.at) && (args.size === undefined || args.size === null)) {
    throw new Error('Say where to: at (a cell like "H2", or cells to cover like "H2:N18"), size ({"width": 480, "height": 288}) or both')
  }

  const where = whereFrom(target, placed.sheet, args.at, args.size, { corner: placed.drawing.sheetTransform.from, size: sizeOf(placed.drawing) })
  const placement = placeAt(target, placed.sheet, where.corner, where.size)
  await oneStep(target, () => applyDrawings(target, 'update', [{ unitId: placed.drawing.unitId, subUnitId: placed.drawing.subUnitId, drawingId: placed.id, ...placement }]))
  const moved = summaryOf(chartOf(target, placed.id))

  return { chart: moved.chart, sheet: moved.sheet, at: moved.at, size: moved.size }
}

/** Take a chart away; one step to undo. */
export async function removeChart(target: SheetsTarget, args: { chart: unknown }): Promise<{ chart: string; sheet: string }> {
  checkKeys(args, ['chart'], 'removeChart')
  const placed = chartOf(target, args.chart)
  await oneStep(target, () => applyDrawings(target, 'remove', [{ unitId: placed.drawing.unitId, subUnitId: placed.drawing.subUnitId, drawingId: placed.id, drawingType: placed.drawing.drawingType }]))

  return { chart: placed.id, sheet: placed.sheet.getSheetName() }
}

/** The kinds of chart that suit a block of cells (or the table around a cell), the best first, each with why. */
export function recommendCharts(target: SheetsTarget, args: { range: unknown; sheet?: unknown }): Recommendation[] {
  checkKeys(args, ['range', 'sheet'], 'recommendCharts')

  if (isBlank(args.range)) {
    throw new Error('Say which cells: range, like "A1:C9" or a cell in a table')
  }

  return recommend(blockOf(target, args.range, sheetOf(target.workbook, args.sheet)).grid)
}
