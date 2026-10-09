import { CHART_COMPONENT, CHART_DRAWING_TYPE, CHART_KINDS, type ChartData, type ChartDrawing, type ChartSpec, DRAWING_RESOURCE, isChartData } from '../../charts.ts'
import type { XmlElement } from '../../docx/xml.ts'
import type { CellSnapshot } from '../../workbook.ts'
import { OFFICE_THEME, themeColors } from '../colors.ts'
import { drawingOf } from '../drawing.ts'
import type { ReadContext } from '../extras.ts'
import type { FinishContext } from '../finish.ts'
import { fingerprint, readHeraldPart, stableJson } from '../herald-part.ts'
import { CONTENT_TYPE, REL } from '../opc.ts'
import type { PackageSheet, XlsxPackage } from '../package.ts'
import { readResource, type Resource } from '../rules.ts'
import type { UStyle } from '../styles.ts'
import { decodeXml } from '../xml.ts'
import { anchorXml, chartAnchor, placementOf, sheetGeometry } from './anchor.ts'
import { copyChartPart } from './copy.ts'
import { parseFragment } from './drawingml.ts'
import { type ChartReading, dataExtent, type DataExtent, readChartXml, type ReadingContext } from './read.ts'
import { type ChartCells, chartXml, hasSeries } from './write.ts'

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
    // A chart Herald fails to read stays in the file as it is, like one it does not draw.
    const reading = chartXml ? await readChartXml(chartXml, context).catch(() => null) : null

    if (anchor && part && chartXml && reading) {
      charts.push({ index, anchor: anchor.element, part, xml: chartXml, reading })
    }
  }

  return charts
}

function cacheOf(pkg: XlsxPackage): { context: ReadingContext; sheets: Map<string, Promise<FoundChart[]>> } {
  let entry = found.get(pkg)

  if (!entry) {
    entry = { context: readingContext(pkg), sheets: new Map() }
    found.set(pkg, entry)
  }

  return entry
}

const chartsContext = (pkg: XlsxPackage): ReadingContext => cacheOf(pkg).context

/** The charts Herald reads from a sheet's drawing; readCharts and shownAnchors both go through here, so they agree. */
function chartsOf(pkg: XlsxPackage, sheet: PackageSheet): Promise<FoundChart[]> {
  const entry = cacheOf(pkg)
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

const heralds = new WeakMap<XlsxPackage, Promise<Record<string, unknown> | null>>()

const heraldOf = (pkg: XlsxPackage): Promise<Record<string, unknown> | null> => {
  let herald = heralds.get(pkg)

  if (!herald) {
    herald = readHeraldPart(pkg)
    heralds.set(pkg, herald)
  }

  return herald
}

/** The chart a part of a file holds as Herald reads it: the spec Herald's part keeps for it, else its XML read. */
async function specOfPart(pkg: XlsxPackage, part: string, xml: string): Promise<ChartSpec | null> {
  const herald = await heraldOf(pkg)
  const print = fingerprint(xml)
  const section = (herald?.[HERALD_SECTION] ?? {}) as FiledCharts
  const filed = Object.values(section && typeof section === 'object' ? section : {})
    .flatMap((sheet) => Object.values(sheet && typeof sheet === 'object' ? sheet : {}))
    .find((chart) => chart?.part === part && chart.fingerprint === print && isSpec(chart.spec))

  if (filed) {
    const idOfName = new Map(pkg.sheets.map((sheet, index) => [sheet.name.toLowerCase(), `sheet-${index + 1}`]))

    return withSheets(filed.spec, (name) => idOfName.get(name.toLowerCase()) ?? name)
  }

  return (await readChartXml(xml, chartsContext(pkg)))?.spec ?? null
}

/** Whether every sheet a chart part's formulas name has that name still in the file being written. */
function sheetsKeepNames(xml: string, pkg: XlsxPackage, written: FinishContext['sheets']): boolean {
  for (const formula of xml.matchAll(/<(?:[\w-]+:)?(?:f|sqref)>([^<]*)<\//g)) {
    for (const match of decodeXml(formula[1]).matchAll(/(?:'((?:[^']|'')+)'|([^\s'!(),:;=+\-*/&^<>[\]{}"]+))!/g)) {
      const name = (match[1]?.replace(/''/g, "'") ?? match[2]).toLowerCase()
      const index = pkg.sheets.findIndex((sheet) => sheet.name.toLowerCase() === name)
      const now = written.find((sheet) => sheet.id === `sheet-${index + 1}`)

      if (index >= 0 && now?.name.toLowerCase() !== name) {
        return false
      }
    }
  }

  return true
}

/** The source file's part of a chart that has not changed since it was read, copied with what it relates to; null to write the chart anew. */
async function unchangedChart(ctx: FinishContext, data: ChartData): Promise<{ path: string; xml: string } | null> {
  const source = ctx.source

  if (!source || !data.source || fingerprint(stableJson(data.spec)) !== data.source.fingerprint) {
    return null
  }

  const xml = await source.pkg.read(data.source.part)
  const read = xml ? await specOfPart(source.pkg, data.source.part, xml) : null

  // The part must still hold the chart as it was read, and its formulas name the sheets they did.
  if (!xml || !read || fingerprint(stableJson(read)) !== data.source.fingerprint || !sheetsKeepNames(xml, source.pkg, ctx.sheets)) {
    return null
  }

  return copyChartPart(ctx.writer, source.pkg, data.source.part)
}

const OFFICE_ACCENTS = OFFICE_THEME.slice(4, 10).map((hex) => `#${hex.toLowerCase()}`)

const LOSSES = {
  percent: 'Excel labels columns, bars, lines and areas with their values where Herald Sheets shows each one’s share of its category.',
  gone: 'Charts whose cells were all on sheets since deleted are left out of the file.',
  failed: (title: string | undefined, error: unknown) => `The chart ${title?.trim() ? `“${title.trim()}” ` : ''}could not be saved, so the file leaves it out (${error instanceof Error ? error.message : String(error)}).`
}

/** A chart part for a chart that changed or is new: its path and XML; null for a chart with nothing left to show. */
async function writeChart(ctx: FinishContext, spec: ChartSpec, cells: ChartCells): Promise<{ path: string; xml: string } | null> {
  if (!hasSeries(spec, cells)) {
    ctx.losses.add(LOSSES.gone)

    return null
  }

  const xml = chartXml(spec, cells, spec.palette?.length ? spec.palette : OFFICE_ACCENTS)
  const path = ctx.writer.freshName((n) => `xl/charts/chart${n}.xml`)
  await ctx.writer.put(path, xml, CONTENT_TYPE.chart)

  if (spec.labels === 'percent' && !['pie', 'doughnut', 'scatter'].includes(spec.kind)) {
    ctx.losses.add(LOSSES.percent)
  }

  return { path, xml }
}

/** The number format a cell shows its value with. */
function formatOf(workbook: FinishContext['workbook'], cell: CellSnapshot): string | undefined {
  const style = (typeof cell.s === 'string' ? workbook.styles?.[cell.s] : cell.s) as UStyle | null | undefined

  return style?.n?.pattern || undefined
}

/** Add the workbook's charts to the package being finished. */
export async function finishCharts(ctx: FinishContext): Promise<void> {
  const resource = readResource<Record<string, { data?: Record<string, ChartDrawing>; order?: string[] }>>(ctx.workbook.resources, DRAWING_RESOURCE)

  if (!resource || typeof resource !== 'object') {
    return
  }

  const names = new Map(ctx.sheets.map((sheet) => [sheet.id, sheet.name]))
  const cells: ChartCells = {
    sheetName: (id) => names.get(id),
    cells: (id) => ctx.workbook.sheets[id]?.cellData,
    format: (cell) => formatOf(ctx.workbook, cell),
    date1904: ctx.workbook.dateSystem === 'date1904'
  }
  const filed: FiledCharts = {}

  for (const sheet of ctx.sheets) {
    const entry = resource[sheet.id]
    const data = entry?.data && typeof entry.data === 'object' ? entry.data : {}
    const order = Array.isArray(entry?.order) ? entry.order.filter((id) => data[id]) : []
    let count = 0

    for (const id of [...order, ...Object.keys(data).filter((key) => !order.includes(key))]) {
      const drawing = data[id]

      if (drawing?.componentKey !== CHART_COMPONENT || !isChartData(drawing.data) || !drawing.sheetTransform?.from || !drawing.sheetTransform.to) {
        continue
      }

      const { spec } = drawing.data
      let written: { path: string; xml: string } | null

      // One chart that cannot be written leaves the rest of the workbook to save.
      try {
        written = (await unchangedChart(ctx, drawing.data)) ?? (await writeChart(ctx, spec, cells))
      } catch (error) {
        ctx.losses.add(LOSSES.failed(spec.title, error))
        continue
      }

      if (!written) {
        continue
      }

      count++
      ctx.drawings.add(sheet.id, { xml: anchorXml(drawing, `Chart ${count}`), relationships: [{ type: REL.chart, target: written.path }], order: drawing.data.source?.anchor })
      filed[sheet.name] ??= {}
      filed[sheet.name][id] = { spec: withSheets(spec, (sheetId) => names.get(sheetId) ?? sheetId), part: written.path, fingerprint: fingerprint(written.xml) }
    }
  }

  if (Object.keys(filed).length) {
    ctx.herald[HERALD_SECTION] = filed
  }
}

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
      const base = saved?.id ?? `chart-${sheetId}-${chart.index + 1}`
      let drawingId = base

      for (let n = 2; taken.has(drawingId); n++) {
        drawingId = `${base}-${n}`
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
