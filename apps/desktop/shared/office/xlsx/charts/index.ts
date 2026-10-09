import { CHART_COMPONENT, CHART_DRAWING_TYPE, CHART_KINDS, type ChartDrawing, type ChartSpec, DRAWING_RESOURCE } from '../../charts.ts'
import type { XmlElement } from '../../docx/xml.ts'
import { themeColors } from '../colors.ts'
import { drawingOf } from '../drawing.ts'
import type { ReadContext } from '../extras.ts'
import type { FinishContext } from '../finish.ts'
import { fingerprint, stableJson } from '../herald-part.ts'
import type { PackageSheet, XlsxPackage } from '../package.ts'
import type { Resource } from '../rules.ts'
import { chartAnchor, placementOf, sheetGeometry } from './anchor.ts'
import { parseFragment } from './drawingml.ts'
import { type ChartReading, dataExtent, type DataExtent, readChartXml, type ReadingContext } from './read.ts'

/*
 * Herald Sheets' charts in .xlsx files: each chart floating over a sheet written as an Excel chart
 * (a DrawingML chart part and an anchor in the sheet's drawing), and charts of the common kinds read
 * back from any file into charts Herald draws.
 */

/** A chart a sheet's drawing shows that Herald reads. */
interface FoundChart {
  /** The anchor's place in the sheet's drawing (see drawingOf). */
  index: number
  anchor: XmlElement
  part: string
  xml: string
  reading: ChartReading
}

/** A chart as Herald's part keeps it: its exact spec (ranges naming their sheets as the file does), the chart part written for it, and that part's fingerprint. */
export interface FiledChart {
  spec: ChartSpec
  part: string
  fingerprint: string
}

/** Herald's part's charts: sheet name in the file → drawing id → chart. */
export type FiledCharts = Record<string, Record<string, FiledChart>>

/** The section of Herald's part with the charts. */
export const HERALD_SECTION = 'charts'

/** How the charts of a package are read: its sheets as formulas name them, its theme, and where its sheets hold values. */
function readingContext(pkg: XlsxPackage): ReadingContext {
  const extents = new Map<number, Promise<DataExtent>>()

  return {
    // Reading names each worksheet by its place in the file.
    sheets: pkg.sheets.map((sheet, index) => ({ name: sheet.name, id: sheet.kind === 'worksheet' ? `sheet-${index + 1}` : null })),
    theme: themeColors(pkg.themeXml),
    extent: (index) => {
      let extent = extents.get(index)

      if (!extent) {
        extent = pkg.read(pkg.sheets[index]?.path ?? '').then((xml) => dataExtent(xml ?? ''))
        extents.set(index, extent)
      }

      return extent
    }
  }
}

const found = new WeakMap<XlsxPackage, { context: ReadingContext; sheets: Map<string, Promise<FoundChart[]>> }>()

async function findCharts(pkg: XlsxPackage, sheet: PackageSheet, context: ReadingContext): Promise<FoundChart[]> {
  const drawing = sheet.kind === 'worksheet' ? await drawingOf(pkg, sheet) : null
  const charts: FoundChart[] = []

  for (const [index, xml] of (drawing?.anchors ?? []).entries()) {
    const element = parseFragment(xml, drawing!.namespaces)
    const anchor = element ? chartAnchor(element) : null
    const related = anchor ? drawing!.relationships.get(anchor.chart) : undefined
    const part = related && !related.external && related.type.endsWith('/chart') ? related.target : undefined
    const chartXml = part ? await pkg.read(part) : undefined
    const reading = chartXml ? await readChartXml(chartXml, context) : null

    if (anchor && part && chartXml && reading) {
      charts.push({ index, anchor: anchor.element, part, xml: chartXml, reading })
    }
  }

  return charts
}

/** The charts Herald reads from a sheet's drawing; readCharts and shownAnchors both go through here, so they agree. */
function chartsOf(pkg: XlsxPackage, sheet: PackageSheet): Promise<FoundChart[]> {
  let entry = found.get(pkg)

  if (!entry) {
    entry = { context: readingContext(pkg), sheets: new Map() }
    found.set(pkg, entry)
  }

  let charts = entry.sheets.get(sheet.path)

  if (!charts) {
    charts = findCharts(pkg, sheet, entry.context)
    entry.sheets.set(sheet.path, charts)
  }

  return charts
}

const isRange = (value: Record<string, unknown>): boolean => typeof value.sheet === 'string' && ['startRow', 'startColumn', 'endRow', 'endColumn'].every((key) => typeof value[key] === 'number')

/** A spec with the sheet of every range in it renamed (snapshot ids to names in the file, and back), whatever fields hold ranges. */
export function withSheets(spec: ChartSpec, rename: (sheet: string) => string): ChartSpec {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(walk)
    }

    if (!value || typeof value !== 'object') {
      return value
    }

    const copy = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]))

    return isRange(value as Record<string, unknown>) ? { ...copy, sheet: rename((value as { sheet: string }).sheet) } : copy
  }

  return walk(spec) as ChartSpec
}

const isSpec = (value: unknown): value is ChartSpec =>
  Boolean(value) && typeof value === 'object' && (CHART_KINDS as readonly string[]).includes((value as ChartSpec).kind) && Array.isArray((value as ChartSpec).series)

/** The charts Herald's part keeps for a sheet, each matched once: by its part and fingerprint, else by its fingerprint alone. */
function filedFor(herald: Record<string, unknown> | null, sheetName: string): (part: string, xml: string) => { id: string; spec: ChartSpec } | null {
  const section = (herald?.[HERALD_SECTION] ?? {}) as FiledCharts
  const sheet = section && typeof section === 'object' ? section[sheetName] : undefined
  const entries = Object.entries(sheet && typeof sheet === 'object' ? sheet : {}).filter(([, chart]) => chart && typeof chart.fingerprint === 'string' && isSpec(chart.spec))
  const used = new Set<string>()

  return (part, xml) => {
    const print = fingerprint(xml)
    const match = entries.find(([id, chart]) => !used.has(id) && chart.fingerprint === print && chart.part === part) ?? entries.find(([id, chart]) => !used.has(id) && chart.fingerprint === print)

    if (!match) {
      return null
    }

    used.add(match[0])

    return { id: match[0], spec: match[1].spec }
  }
}

/** Add the workbook's charts to the package being finished. */
export async function finishCharts(_ctx: FinishContext): Promise<void> {}

/** The sheet drawings resource with the charts of a file, when it has any Herald can draw. */
export async function readCharts(ctx: ReadContext): Promise<Resource[]> {
  const resource: Record<string, { data: Record<string, ChartDrawing>; order: string[] }> = {}
  const taken = new Set<string>()
  const idOfName = new Map(ctx.pkg.sheets.flatMap((sheet, index) => (ctx.ids[index] ? [[sheet.name.toLowerCase(), ctx.ids[index]!] as const] : [])))

  for (const [index, sheet] of ctx.pkg.sheets.entries()) {
    const sheetId = ctx.ids[index]
    const charts = sheetId ? await chartsOf(ctx.pkg, sheet) : []

    if (!sheetId || !charts.length) {
      continue
    }

    const geometry = await sheetGeometry(ctx.pkg, sheet)
    const filed = filedFor(ctx.herald, sheet.name)
    const data: Record<string, ChartDrawing> = {}
    const order: string[] = []

    for (const chart of charts) {
      const saved = filed(chart.part, chart.xml)
      const spec = saved ? withSheets(saved.spec, (name) => idOfName.get(name.toLowerCase()) ?? name) : chart.reading.spec
      let drawingId = saved?.id ?? `chart-${sheetId}-${chart.index + 1}`

      for (let n = 2; taken.has(drawingId); n++) {
        drawingId = `${saved?.id ?? `chart-${sheetId}-${chart.index + 1}`}-${n}`
      }

      taken.add(drawingId)

      if (!saved) {
        chart.reading.notes.forEach((note) => ctx.notes.add(note))
      }

      const { anchorType, from, to, transform } = placementOf(chart.anchor, geometry)
      data[drawingId] = {
        unitId: ctx.unitId,
        subUnitId: sheetId,
        drawingId,
        drawingType: CHART_DRAWING_TYPE,
        componentKey: CHART_COMPONENT,
        sheetTransform: { from: { ...from }, to: { ...to } },
        axisAlignSheetTransform: { from: { ...from }, to: { ...to } },
        transform,
        anchorType,
        allowTransform: true,
        data: { herald: 'chart', version: 1, spec, source: { part: chart.part, fingerprint: fingerprint(stableJson(spec)), anchor: chart.index } }
      }
      order.push(drawingId)
    }

    resource[sheetId] = { data, order }
  }

  return Object.keys(resource).length ? [{ name: DRAWING_RESOURCE, data: JSON.stringify(resource) }] : []
}

/**
 * Which anchors of a sheet's drawing in a file Herald reads as charts, by their place in the drawing
 * (see drawingOf): those come back from the workbook's charts, and every other anchor is kept as it is.
 */
export async function shownAnchors(pkg: XlsxPackage, sheet: PackageSheet): Promise<Set<number>> {
  return new Set((await chartsOf(pkg, sheet)).map((chart) => chart.index))
}
