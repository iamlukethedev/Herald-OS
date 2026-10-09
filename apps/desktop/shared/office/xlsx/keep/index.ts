import type { FinishContext } from '../finish.ts'
import { chartPart, diagramDataPart } from './charts.ts'
import { Keep } from './context.ts'
import { keepDrawings } from './drawings.ts'
import type { Refusal } from './parts.ts'
import { keepPivots, pivotCachePart, pivotTablePart } from './pivots.ts'
import { finishSheets, keepBackgrounds, keepSparklines } from './sheets.ts'
import { keepSlicers, slicerCachePart, slicersPart } from './slicers.ts'
import { keepTables, tablePart } from './tables.ts'
import { finishWorkbook, keepChartSheets, keepCustomProperties, keepExternalLinks, keepTheme } from './workbook.ts'

/*
 * The parts of the file a workbook was opened from that Herald does not model (pivot tables and
 * their caches, pictures, shapes and charts Herald does not draw, slicers, tables, sparklines, chart
 * sheets and the like), carried into the file Herald saves with their relationships and content
 * types, where that is safe. A sheet's parts come along while the sheet is there, renamed or moved;
 * the steps run in the order their decisions need (tables before the pivot caches that read them,
 * pivot tables before their slicers, slicers before their anchors).
 */

const CONTENT_TYPE = {
  chart: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  chartEx: 'application/vnd.ms-office.chartex+xml',
  diagramData: 'application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml',
  pivotTable: 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml',
  pivotCacheDefinition: 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml',
  table: 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml',
  slicer: 'application/vnd.ms-excel.slicer+xml',
  slicerCache: 'application/vnd.ms-excel.slicerCache+xml',
  timeline: 'application/vnd.ms-excel.timeline+xml',
  timelineCache: 'application/vnd.ms-excel.timelineCache+xml'
} as const

/** A kept part's XML as the written file needs it, by its content type. */
function transform(keep: Keep, xml: string, _path: string, contentType: string): string | Refusal {
  switch (contentType) {
    case CONTENT_TYPE.chart:
    case CONTENT_TYPE.chartEx:
      return chartPart(keep, xml)
    case CONTENT_TYPE.diagramData:
      return diagramDataPart(xml)
    case CONTENT_TYPE.pivotTable:
      return pivotTablePart(keep, xml)
    case CONTENT_TYPE.pivotCacheDefinition:
      return pivotCachePart(keep, xml)
    case CONTENT_TYPE.table:
      return tablePart(keep, xml)
    case CONTENT_TYPE.slicer:
    case CONTENT_TYPE.timeline:
      return slicersPart(keep, xml)
    case CONTENT_TYPE.slicerCache:
    case CONTENT_TYPE.timelineCache:
      return slicerCachePart(keep, xml)
    default:
      return xml
  }
}

/** Carry the source file's untouched parts into the package being finished. */
export async function finishKept(ctx: FinishContext): Promise<void> {
  if (!ctx.source) {
    return
  }

  const keep = await Keep.open(ctx, ctx.source, transform)
  await keepTheme(keep)
  await keepCustomProperties(keep)
  await keepExternalLinks(keep)
  await keepTables(keep)
  await keepPivots(keep)
  await keepSlicers(keep)
  keepSparklines(keep)
  await keepBackgrounds(keep)
  await keepDrawings(keep)
  await keepChartSheets(keep)
  await finishSheets(keep)
  await finishWorkbook(keep)
  await keep.styles.flush(ctx.writer)
}
