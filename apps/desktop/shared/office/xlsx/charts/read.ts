import type { ChartAxis, ChartKind, ChartRange, ChartSeries, ChartSpec } from '../../charts.ts'
import { child, children, textOf, type XmlElement } from '../../docx/xml.ts'
import { columnIndex, MAX_COLUMNS, MAX_ROWS, parseRange, splitSheet } from '../address.ts'
import { fillIn, flag, numberIn, type Paint, parsePart } from './drawingml.ts'

/*
 * An Excel chart part (c:chartSpace) read into the chart Herald draws: columns, bars, lines, areas,
 * pies, doughnuts, scatter charts, and columns with lines or areas on one or two value axes. A chart
 * Herald cannot read faithfully (another workbook's cells, defined names, literal data, several
 * areas in one reference, 3D and other kinds) is not read at all: it stays in the file as it is.
 */

/** A sheet of the file as chart formulas name it, with its snapshot id; null for a sheet Herald does not read (a chart sheet). */
export interface SheetRef {
  name: string
  id: string | null
}

/** The last row and column with a value on a sheet, which references to whole columns or rows end at; -1 for none. */
export interface DataExtent {
  lastRow: (startColumn: number, endColumn: number) => number
  lastColumn: (startRow: number, endRow: number) => number
}

export interface ReadingContext {
  sheets: SheetRef[]
  /** The file's theme colours, in theme index order (themeColors). */
  theme: string[]
  extent: (sheet: number) => Promise<DataExtent>
}

export interface ChartReading {
  spec: ChartSpec
  /** What Herald Sheets shows differently from the file, for the fidelity report. */
  notes: string[]
}

export const NOTES = {
  fills: 'Chart gradient, pattern and picture fills are shown as plain colours; the file keeps them while the chart is unchanged.',
  extras: 'Chart trendlines, error bars, drop lines, up/down bars and data tables are not drawn; the file keeps them while the chart is unchanged.',
  axes: 'Chart axes with logarithmic scales, reversed order or display units are shown plainly; the file keeps them while the chart is unchanged.',
  labels: 'Chart data labels show one thing each (the value, the percentage or the category); the file keeps the rest while the chart is unchanged.',
  points: 'Single bars, points or slices coloured apart from their series are shown in the series colour; the file keeps them while the chart is unchanged.',
  stackedLines: 'Stacked line charts are shown with their lines unstacked; the file keeps them stacked while the chart is unchanged.',
  scatterLines: 'Lines joining the points of scatter charts are not drawn; the file keeps them while the chart is unchanged.',
  levels: 'Charts with several levels of category labels show the innermost level; the file keeps the others while the chart is unchanged.',
  shapes: 'Shapes and pictures drawn over charts are not shown; the file keeps them while the chart is unchanged.'
} as const

const KINDS: Record<string, ChartKind> = { 'c:barChart': 'column', 'c:lineChart': 'line', 'c:areaChart': 'area', 'c:pieChart': 'pie', 'c:doughnutChart': 'doughnut', 'c:scatterChart': 'scatter' }
const SINGLE_ONLY = new Set(['c:pieChart', 'c:doughnutChart', 'c:scatterChart'])
const AXES = new Set(['c:catAx', 'c:valAx', 'c:dateAx', 'c:serAx'])
const LEGEND: Record<string, ChartSpec['legend']> = { r: 'right', l: 'left', t: 'top', b: 'bottom', tr: 'right' }
const EXTRAS = ['c:trendline', 'c:errBars', 'c:dropLines', 'c:hiLowLines', 'c:upDownBars', 'c:serLines']

class Unreadable extends Error {}

const unreadable = (): never => {
  throw new Unreadable('This chart uses what Herald Sheets does not read.')
}

/** Every line of a rich text body (c:rich), its runs joined. */
function richText(rich: XmlElement): string {
  const lines = children(rich, 'a:p').map((paragraph) =>
    children(paragraph)
      .map((run) => (run.name === 'a:r' || run.name === 'a:fld' ? textOf(child(run, 'a:t')) : run.name === 'a:br' ? '\n' : ''))
      .join('')
  )

  while (lines.length && !lines[lines.length - 1]) {
    lines.pop()
  }

  return lines.join('\n')
}

/** The cached text of a reference's points (c:strCache or c:numCache), in order. */
function cachedText(reference: XmlElement | undefined): string[] {
  const cache = child(reference, 'c:strCache') ?? child(reference, 'c:numCache')

  return children(cache, 'c:pt')
    .sort((a, b) => Number(a.attrs.idx) - Number(b.attrs.idx))
    .map((point) => textOf(child(point, 'c:v')))
}

/** A title's text: its rich text, or the text of the cell it shows; `fallback` for a title that has neither (Excel makes one up). */
function titleText(title: XmlElement | undefined, fallback: string | undefined): string | undefined {
  if (!title) {
    return undefined
  }

  const tx = child(title, 'c:tx')
  const rich = child(tx, 'c:rich')
  const reference = child(tx, 'c:strRef')
  const text = rich ? richText(rich) : reference ? cachedText(reference).join(' ') : fallback

  return text || undefined
}

class Reader {
  readonly notes = new Set<string>()

  constructor(private readonly ctx: ReadingContext) {}

  /** One range on a sheet of this workbook; anything else makes the chart unreadable. */
  async range(formula: string): Promise<ChartRange> {
    let text = formula.trim()

    if (text.startsWith('(') && text.endsWith(')')) {
      text = text.slice(1, -1).trim()
    }

    const { sheet, ref } = splitSheet(text)
    const index = sheet && !/[[\]]/.test(sheet) ? this.ctx.sheets.findIndex((entry) => entry.name.toLowerCase() === sheet.toLowerCase()) : -1
    const id = index >= 0 ? this.ctx.sheets[index].id : null
    const range = id ? parseRange(ref) : null

    if (!id || !range) {
      return unreadable()
    }

    if (range.startRow === 0 && range.endRow >= MAX_ROWS - 1) {
      range.endRow = Math.max(0, (await this.ctx.extent(index)).lastRow(range.startColumn, range.endColumn))
    } else if (range.startColumn === 0 && range.endColumn >= MAX_COLUMNS - 1) {
      range.endColumn = Math.max(0, (await this.ctx.extent(index)).lastColumn(range.startRow, range.endRow))
    }

    return { sheet: id, ...range }
  }

  /** The cells a data source (c:cat, c:val, c:xVal, c:yVal, or a series' c:tx) refers to, with their cached text. */
  async cells(source: XmlElement | undefined): Promise<{ range: ChartRange; cache: string[] } | undefined> {
    for (const element of children(source)) {
      if (element.name === 'c:strRef' || element.name === 'c:numRef') {
        return { range: await this.range(textOf(child(element, 'c:f'))), cache: cachedText(element) }
      }

      if (element.name === 'c:multiLvlStrRef') {
        const range = await this.range(textOf(child(element, 'c:f')))
        this.notes.add(NOTES.levels)
        const vertical = range.endRow - range.startRow >= range.endColumn - range.startColumn

        return { range: vertical ? { ...range, startColumn: range.endColumn } : { ...range, startRow: range.endRow }, cache: [] }
      }

      if (element.name === 'c:numLit' || element.name === 'c:strLit') {
        return unreadable()
      }
    }

    return undefined
  }

  paint(paint: Paint | undefined): string | undefined {
    if (paint?.approximate) {
      this.notes.add(NOTES.fills)
    }

    return paint?.none ? undefined : paint?.color
  }

  axis(element: XmlElement | undefined, values: boolean): ChartAxis {
    const axis: ChartAxis = { gridlines: Boolean(child(element, 'c:majorGridlines')) }
    const title = titleText(child(element, 'c:title'), 'Axis Title')
    const scaling = child(element, 'c:scaling')
    const format = child(element, 'c:numFmt')

    if (title) {
      axis.title = title
    }

    if (values) {
      const [min, max] = [numberIn(child(scaling, 'c:min')), numberIn(child(scaling, 'c:max'))]

      if (min !== undefined) {
        axis.min = min
      }

      if (max !== undefined) {
        axis.max = max
      }
    }

    if (format && !['1', 'true'].includes(format.attrs.sourceLinked ?? '') && format.attrs.formatCode && format.attrs.formatCode !== 'General') {
      axis.format = format.attrs.formatCode
    }

    if (flag(child(element, 'c:delete'))) {
      axis.hidden = true
    }

    if (child(scaling, 'c:logBase') || child(scaling, 'c:orientation')?.attrs.val === 'maxMin' || child(element, 'c:dispUnits')) {
      this.notes.add(NOTES.axes)
    }

    return axis
  }
}

interface ReadSeries {
  order: number
  series: ChartSeries
  element: XmlElement
  /** The name's text, which a chart of one series without a title of its own is titled with. */
  nameText?: string
  points: number
}

const BAR_TYPES: Record<string, ChartSeries['type']> = { 'c:barChart': 'column', 'c:lineChart': 'line', 'c:areaChart': 'area' }

/** The ids of the two axes a chart group is drawn against. */
const axisIds = (group: XmlElement): string[] => children(group, 'c:axId').map((axis) => axis.attrs.val ?? '')

async function readSeries(reader: Reader, element: XmlElement, group: XmlElement, theme: string[]): Promise<ReadSeries | null> {
  const scatter = group.name === 'c:scatterChart'
  const values = await reader.cells(child(element, scatter ? 'c:yVal' : 'c:val'))

  if (!values) {
    return null
  }

  const categories = await reader.cells(child(element, scatter ? 'c:xVal' : 'c:cat'))
  const tx = child(element, 'c:tx')
  const literal = child(tx, 'c:v')
  const named = literal ? undefined : await reader.cells(tx)
  const series: ChartSeries = { values: values.range }
  const spPr = child(element, 'c:spPr')
  const marker = child(element, 'c:marker')
  const symbol = child(marker, 'c:symbol')?.attrs.val

  if (literal) {
    series.name = { text: textOf(literal) }
  } else if (named) {
    series.name = { cell: named.range }
  }

  if (categories) {
    series.categories = categories.range
  }

  if (group.name === 'c:lineChart' || scatter) {
    const line = fillIn(child(spPr, 'a:ln'), theme)
    const markerFill = fillIn(child(marker, 'c:spPr'), theme)
    const smooth = flag(child(element, 'c:smooth')) ?? flag(child(group, 'c:smooth'))
    const color = reader.paint(line?.color ? line : markerFill)

    if (color) {
      series.color = color
    }

    if (scatter) {
      const style = child(group, 'c:scatterStyle')?.attrs.val ?? 'marker'
      const lines = !line?.none && style !== 'marker' && style !== 'none'
      const markers = symbol !== 'none'

      if (lines && markers && !smooth) {
        reader.notes.add(NOTES.scatterLines)
      } else if (lines && smooth) {
        series.smooth = true
      }

      if (!markers) {
        series.markers = false
      }
    } else {
      series.markers = symbol === 'none' ? false : flag(child(group, 'c:marker')) !== false

      if (smooth) {
        series.smooth = true
      }
    }
  } else if (group.name !== 'c:pieChart' && group.name !== 'c:doughnutChart') {
    const color = reader.paint(fillIn(spPr, theme))

    if (color) {
      series.color = color
    }
  }

  if (group.name !== 'c:pieChart' && group.name !== 'c:doughnutChart' && children(element, 'c:dPt').some((point) => child(point, 'c:spPr'))) {
    reader.notes.add(NOTES.points)
  }

  if (EXTRAS.some((name) => child(element, name))) {
    reader.notes.add(NOTES.extras)
  }

  const size = (values.range.endRow - values.range.startRow + 1) * (values.range.endColumn - values.range.startColumn + 1)

  return {
    order: numberIn(child(element, 'c:order')) ?? 0,
    series,
    element,
    nameText: literal ? textOf(literal) : named?.cache[0],
    points: size
  }
}

/** The labels a chart shows on its points, from its first series that sets them (else its chart groups). */
function labelsOf(reader: Reader, series: ReadSeries[], groups: XmlElement[]): ChartSpec['labels'] {
  const own = series.map((entry) => child(entry.element, 'c:dLbls')).filter((labels): labels is XmlElement => Boolean(labels))
  const all = [...own, ...groups.flatMap((group) => children(group, 'c:dLbls'))]
  const showing = (labels: XmlElement) => !flag(child(labels, 'c:delete')) && ['c:showVal', 'c:showPercent', 'c:showCatName', 'c:showSerName'].some((name) => flag(child(labels, name)))
  const labels = all.find(showing)

  if (!labels) {
    return 'none'
  }

  const shown = (
    [
      ['percent', 'c:showPercent'],
      ['value', 'c:showVal'],
      ['category', 'c:showCatName']
    ] as const
  ).flatMap(([mode, name]) => (flag(child(labels, name)) ? [mode] : []))

  if (shown.length > 1 || flag(child(labels, 'c:showSerName')) || (own.length && own.length < series.length) || own.some((other) => !showing(other))) {
    reader.notes.add(NOTES.labels)
  }

  return shown[0] ?? 'none'
}

const groupingOf = (group: XmlElement | undefined): ChartSpec['stacking'] => {
  const grouping = child(group, 'c:grouping')?.attrs.val

  return grouping === 'stacked' ? 'stacked' : grouping === 'percentStacked' ? 'percent' : 'none'
}

/** A chart part's chart as Herald draws it; null when Herald cannot read it faithfully, or it is not a chart. */
export async function readChartXml(xml: string, ctx: ReadingContext): Promise<ChartReading | null> {
  const root = parsePart(xml)
  const chart = root?.name === 'c:chartSpace' ? child(root, 'c:chart') : undefined
  const plot = child(chart, 'c:plotArea')

  if (!chart || !plot) {
    return null
  }

  try {
    const reading = await readChart(chart, plot, ctx)

    return reading && child(root!, 'c:userShapes') ? { ...reading, notes: [...reading.notes, NOTES.shapes] } : reading
  } catch (error) {
    if (error instanceof Unreadable) {
      return null
    }

    throw error
  }
}

async function readChart(chart: XmlElement, plot: XmlElement, ctx: ReadingContext): Promise<ChartReading | null> {
  const reader = new Reader(ctx)
  const groups = children(plot).filter((element) => element.name.endsWith('Chart'))

  if (!groups.length || groups.some((group) => !KINDS[group.name]) || (groups.length > 1 && groups.some((group) => SINGLE_ONLY.has(group.name)))) {
    return null
  }

  const barDirection = (group: XmlElement) => child(group, 'c:barDir')?.attrs.val ?? 'col'

  // Herald draws columns, not horizontal bars, beside lines and areas.
  if (groups.length > 1 && groups.some((group) => group.name === 'c:barChart' && barDirection(group) === 'bar')) {
    return null
  }

  const axes = new Map(
    children(plot)
      .filter((element) => AXES.has(element.name))
      .map((element) => [child(element, 'c:axId')?.attrs.val ?? '', element])
  )
  const valueAxisOf = (group: XmlElement) => axisIds(group).find((id) => axes.get(id)?.name === 'c:valAx')
  const used = new Set(groups.map(valueAxisOf))
  // The primary axes come first in the plot area.
  const primary = [...axes.keys()].find((id) => used.has(id))
  const first = groups[0]
  const kind: ChartKind = groups.length > 1 ? 'combo' : first.name === 'c:barChart' && barDirection(first) === 'bar' ? 'bar' : KINDS[first.name]
  const read: ReadSeries[] = []

  for (const group of groups) {
    const secondary = kind === 'combo' && valueAxisOf(group) !== primary

    for (const element of children(group, 'c:ser')) {
      const entry = await readSeries(reader, element, group, ctx.theme)

      if (entry) {
        if (kind === 'combo') {
          entry.series.type = BAR_TYPES[group.name]

          if (secondary) {
            entry.series.secondary = true
          }
        }

        read.push(entry)
      }
    }

    if (group.name === 'c:lineChart' && groupingOf(group) !== 'none') {
      reader.notes.add(NOTES.stackedLines)
    }

    if (EXTRAS.some((name) => child(group, name))) {
      reader.notes.add(NOTES.extras)
    }
  }

  if (!read.length) {
    return null
  }

  if (child(plot, 'c:dTable')) {
    reader.notes.add(NOTES.extras)
  }

  read.sort((a, b) => a.order - b.order)
  const single = read.length === 1 ? read[0] : null
  const titleElement = child(chart, 'c:title')
  // Excel titles a chart of one series without a title of its own after the series, unless that title was deleted.
  const title = titleElement ? titleText(titleElement, single?.nameText ?? 'Chart Title') : flag(child(chart, 'c:autoTitleDeleted')) ? undefined : single?.nameText || undefined
  const legend = child(chart, 'c:legend')
  const spec: ChartSpec = {
    kind,
    ...(title ? { title } : {}),
    series: read.map((entry) => entry.series),
    legend: legend ? (LEGEND[child(legend, 'c:legendPos')?.attrs.val ?? 'r'] ?? 'right') : 'none',
    labels: labelsOf(reader, read, groups)
  }
  const stackingGroup = groups.find((group) => group.name === 'c:barChart') ?? groups.find((group) => group.name === 'c:areaChart')
  const stacking = groupingOf(stackingGroup)

  if (stackingGroup && stacking !== 'none') {
    spec.stacking = stacking
  }

  if (kind === 'pie' || kind === 'doughnut') {
    const points = new Map(children(read[0].element, 'c:dPt').map((point) => [numberIn(child(point, 'c:idx')) ?? -1, reader.paint(fillIn(child(point, 'c:spPr'), ctx.theme))]))
    const own = reader.paint(fillIn(child(read[0].element, 'c:spPr'), ctx.theme))

    if ([...points.values()].some(Boolean)) {
      spec.palette = Array.from({ length: Math.max(read[0].points, ...[...points.keys()].map((index) => index + 1)) }, (_, index) => points.get(index) ?? `#${(ctx.theme[4 + (index % 6)] ?? '4472C4').toLowerCase()}`)
    } else if (own && flag(child(first, 'c:varyColors')) === false) {
      spec.palette = [own]
    }

    if (kind === 'doughnut') {
      spec.hole = numberIn(child(first, 'c:holeSize')) ?? 10
    }
  } else if (kind === 'scatter') {
    const [x, y] = axisIds(first)
      .map((id) => axes.get(id))
      .sort((a, b) => Number(['l', 'r'].includes(child(a, 'c:axPos')?.attrs.val ?? '')) - Number(['l', 'r'].includes(child(b, 'c:axPos')?.attrs.val ?? '')))
    spec.axes = { x: reader.axis(x, true), y: reader.axis(y, true) }
  } else {
    const ids = axisIds(first)
    const category = axes.get(ids.find((id) => axes.get(id)?.name !== 'c:valAx') ?? '')
    spec.axes = { x: reader.axis(category, false), y: reader.axis(axes.get(primary ?? ''), true) }
    const secondary = groups.map(valueAxisOf).find((id) => id !== primary)

    if (kind === 'combo' && secondary && read.some((entry) => entry.series.secondary)) {
      spec.axes.y2 = reader.axis(axes.get(secondary), true)
    }
  }

  return { spec, notes: [...reader.notes] }
}

/** Where a sheet's cells hold values, from its XML, for references to whole columns or rows. */
export function dataExtent(sheetXml: string): DataExtent {
  const lastRow = new Map<number, number>()
  const lastColumn = new Map<number, number>()

  for (const match of sheetXml.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
    const at = /\br="([A-Za-z]{1,3})(\d+)"/.exec(match[1])

    if (!at || !match[2] || !/<(?:\w+:)?(?:v|is|f)\b/.test(match[2])) {
      continue
    }

    const [row, column] = [Number(at[2]) - 1, columnIndex(at[1])]
    lastRow.set(column, Math.max(lastRow.get(column) ?? -1, row))
    lastColumn.set(row, Math.max(lastColumn.get(row) ?? -1, column))
  }

  const last = (map: Map<number, number>, start: number, end: number) => {
    let found = -1

    for (const [key, value] of map) {
      if (key >= start && key <= end) {
        found = Math.max(found, value)
      }
    }

    return found
  }

  return { lastRow: (start, end) => last(lastRow, start, end), lastColumn: (start, end) => last(lastColumn, start, end) }
}
