import type { CellOffset, ChartDrawing } from '../../charts.ts'
import { child, children, find, textOf, type XmlElement } from '../../docx/xml.ts'
import { MAX_COLUMNS, MAX_ROWS } from '../address.ts'
import type { PackageSheet, XlsxPackage } from '../package.ts'
import { columnPixels, defaultColumnPixels, EXCEL_ROW_POINTS, pointsToPixels } from '../units.ts'
import { attributesOf, elementsOf, encodeXml } from '../xml.ts'
import { NS } from './drawingml.ts'

/*
 * Where a chart sits over a sheet: an anchor in the sheet's drawing (cells and offsets in EMU, or a
 * place and size), and Univer's floating object (cells and offsets in pixels, and its place and size
 * in pixels from the sheet's corner, worked out from the sheet's column widths and row heights).
 */

export const EMU_PER_PIXEL = 9525

/** Univer counts a drawing's place from the canvas corner, past the row header and the column header. */
const ROW_HEADER = 46
const COLUMN_HEADER = 20

const ANCHORS = new Set(['xdr:twoCellAnchor', 'xdr:oneCellAnchor', 'xdr:absoluteAnchor'])

const round = (value: number): number => Math.round(value * 100) / 100

/** A run of columns or rows of one size in pixels. */
interface Span {
  start: number
  end: number
  size: number
}

/** A sheet's column widths and row heights in pixels, as Herald Sheets shows them (hidden ones take none). */
export interface SheetGeometry {
  /** Pixels from the left of the sheet's first column to the left of this one. */
  left(column: number): number
  top(row: number): number
  /** The cell a point (pixels from the top-left of the sheet's first cell) is in, and how far into it. */
  at(x: number, y: number): CellOffset
}

function edgeOf(index: number, size: number, spans: Span[]): number {
  let edge = index * size

  for (const span of spans) {
    const covered = Math.min(span.end, index - 1) - span.start + 1

    if (covered > 0) {
      edge += covered * (span.size - size)
    }
  }

  return edge
}

function locate(position: number, size: number, spans: Span[], limit: number): { index: number; offset: number } {
  let edge = 0
  let index = 0
  const within = (span: number, start: number) => {
    const steps = Math.floor((position - edge) / span)

    return { index: Math.min(limit, start + steps), offset: round(position - edge - steps * span) }
  }

  for (const span of spans) {
    if (span.start > index) {
      const room = (span.start - index) * size

      if (size > 0 && position < edge + room) {
        return within(size, index)
      }

      edge += room
      index = span.start
    }

    const room = (span.end - span.start + 1) * span.size

    if (span.size > 0 && position < edge + room) {
      return within(span.size, span.start)
    }

    edge += room
    index = span.end + 1
  }

  return size > 0 ? within(size, index) : { index: Math.min(limit, index), offset: round(position - edge) }
}

/** The column widths and row heights of a worksheet in a package, converted as reading the workbook converts them. */
export async function sheetGeometry(pkg: XlsxPackage, sheet: PackageSheet): Promise<SheetGeometry> {
  const format = attributesOf(/<(?:\w+:)?sheetFormatPr\b[^>]*>/.exec(sheet.head)?.[0] ?? '')
  const columnSize = defaultColumnPixels(Number(format.defaultColWidth) || undefined, Number(format.baseColWidth) || 8)
  const rowSize = pointsToPixels(Number(format.defaultRowHeight) || EXCEL_ROW_POINTS)
  const columns: Span[] = elementsOf(sheet.head, 'col')
    .flatMap(({ attributes }) => {
      const width = Number.parseFloat(attributes.width ?? '')
      const size = attributes.hidden === '1' || attributes.hidden === 'true' ? 0 : Number.isFinite(width) && width >= 0 ? columnPixels(width) : columnSize
      const start = Number(attributes.min) - 1
      const end = Math.min(MAX_COLUMNS, Number(attributes.max) || start + 1) - 1

      return start >= 0 && end >= start ? [{ start, end, size }] : []
    })
    .sort((a, b) => a.start - b.start)
  const rows: Span[] = []
  const xml = (await pkg.read(sheet.path)) ?? ''
  let previous = -1

  for (const match of xml.matchAll(/<(?:\w+:)?row\b([^>]*)>/g)) {
    const attributes = attributesOf(match[1])
    const row = attributes.r ? Number(attributes.r) - 1 : previous + 1
    previous = row
    const height = Number.parseFloat(attributes.ht ?? '')
    const size = attributes.hidden === '1' || attributes.hidden === 'true' ? 0 : height > 0 ? pointsToPixels(height) : rowSize

    if (row >= 0 && size !== rowSize) {
      rows.push({ start: row, end: row, size })
    }
  }

  rows.sort((a, b) => a.start - b.start)

  return {
    left: (column) => edgeOf(column, columnSize, columns),
    top: (row) => edgeOf(row, rowSize, rows),
    at: (x, y) => {
      const column = locate(x, columnSize, columns, MAX_COLUMNS - 1)
      const row = locate(y, rowSize, rows, MAX_ROWS - 1)

      return { column: column.index, columnOffset: column.offset, row: row.index, rowOffset: row.offset }
    }
  }
}

/** An anchor that shows a chart: the anchor element, and the relationship id of its chart part. */
export interface ChartAnchor {
  element: XmlElement
  chart: string
}

const branches = (alternate: XmlElement): XmlElement[] => [...children(alternate, 'mc:Choice'), ...children(alternate, 'mc:Fallback')]

/**
 * The chart an anchor of a drawing shows; an mc:AlternateContent (around the anchor or around what
 * it holds) is read by its first Choice that holds a chart, else its Fallback. Null for anything
 * else, a chartEx part (cx:chart) included.
 */
export function chartAnchor(anchor: XmlElement): ChartAnchor | null {
  const candidates = anchor.name === 'mc:AlternateContent' ? branches(anchor).flatMap((branch) => children(branch)) : [anchor]

  for (const element of candidates) {
    if (!ANCHORS.has(element.name)) {
      continue
    }

    const objects = children(element).flatMap((object) => (object.name === 'mc:AlternateContent' ? branches(object).flatMap((branch) => children(branch)) : [object]))

    for (const frame of objects) {
      const id = frame.name === 'xdr:graphicFrame' ? find(frame, 'c:chart')?.attrs['r:id'] : undefined

      if (id) {
        return { element, chart: id }
      }
    }
  }

  return null
}

export interface Placement {
  anchorType: '0' | '1' | '2'
  from: CellOffset
  to: CellOffset
  transform: { left: number; top: number; width: number; height: number }
}

const numberIn = (element: XmlElement | undefined, name: string): number => Number(textOf(child(element, name)).trim()) || 0

function markerOf(element: XmlElement | undefined): CellOffset {
  return {
    column: numberIn(element, 'xdr:col'),
    columnOffset: round(numberIn(element, 'xdr:colOff') / EMU_PER_PIXEL),
    row: numberIn(element, 'xdr:row'),
    rowOffset: round(numberIn(element, 'xdr:rowOff') / EMU_PER_PIXEL)
  }
}

const emuAttribute = (element: XmlElement | undefined, name: string): number => (Number(element?.attrs[name]) || 0) / EMU_PER_PIXEL

/** Where an anchor puts its chart, as Univer places a floating object. */
export function placementOf(anchor: XmlElement, geometry: SheetGeometry): Placement {
  const point = (cell: CellOffset) => ({ x: geometry.left(cell.column) + cell.columnOffset, y: geometry.top(cell.row) + cell.rowOffset })
  let anchorType: Placement['anchorType'] = '1'
  let from: CellOffset
  let to: CellOffset

  if (anchor.name === 'xdr:absoluteAnchor') {
    const position = child(anchor, 'xdr:pos')
    const size = child(anchor, 'xdr:ext')
    const [x, y] = [emuAttribute(position, 'x'), emuAttribute(position, 'y')]
    anchorType = '2'
    from = geometry.at(x, y)
    to = geometry.at(x + emuAttribute(size, 'cx'), y + emuAttribute(size, 'cy'))
  } else if (anchor.name === 'xdr:oneCellAnchor') {
    const size = child(anchor, 'xdr:ext')
    anchorType = '0'
    from = markerOf(child(anchor, 'xdr:from'))
    const start = point(from)
    to = geometry.at(start.x + emuAttribute(size, 'cx'), start.y + emuAttribute(size, 'cy'))
  } else {
    const editAs = anchor.attrs.editAs
    anchorType = editAs === 'oneCell' ? '0' : editAs === 'absolute' ? '2' : '1'
    from = markerOf(child(anchor, 'xdr:from'))
    to = markerOf(child(anchor, 'xdr:to'))
  }

  const [start, end] = [point(from), point(to)]

  return {
    anchorType,
    from,
    to,
    transform: { left: round(ROW_HEADER + start.x), top: round(COLUMN_HEADER + start.y), width: round(Math.max(0, end.x - start.x)), height: round(Math.max(0, end.y - start.y)) }
  }
}

const emu = (pixels: number): number => Math.max(0, Math.round(pixels * EMU_PER_PIXEL))

const index = (value: number): number => Math.max(0, Math.floor(Number(value) || 0))

/**
 * A chart's anchor for a sheet's drawing, from its floating object's cells: an xdr:twoCellAnchor
 * whose editAs follows how the object moves with the cells. The drawing builder fills in
 * `{{id}}` and `{{rel:0}}` (the chart part).
 */
export function anchorXml(drawing: Pick<ChartDrawing, 'sheetTransform' | 'anchorType'>, name: string): string {
  const editAs = drawing.anchorType === '0' ? 'oneCell' : drawing.anchorType === '2' ? 'absolute' : undefined
  const from = drawing.sheetTransform.from
  let to = drawing.sheetTransform.to

  // The far corner never comes before the near one, which Excel would not open.
  if (index(to.column) < index(from.column) || (index(to.column) === index(from.column) && emu(to.columnOffset) < emu(from.columnOffset))) {
    to = { ...to, column: from.column, columnOffset: from.columnOffset }
  }

  if (index(to.row) < index(from.row) || (index(to.row) === index(from.row) && emu(to.rowOffset) < emu(from.rowOffset))) {
    to = { ...to, row: from.row, rowOffset: from.rowOffset }
  }

  const marker = (tag: string, cell: CellOffset) =>
    `<xdr:${tag}><xdr:col>${index(cell.column)}</xdr:col><xdr:colOff>${emu(cell.columnOffset)}</xdr:colOff><xdr:row>${index(cell.row)}</xdr:row><xdr:rowOff>${emu(cell.rowOffset)}</xdr:rowOff></xdr:${tag}>`

  return (
    `<xdr:twoCellAnchor${editAs ? ` editAs="${editAs}"` : ''}>${marker('from', from)}${marker('to', to)}` +
    `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="{{id}}" name="${encodeXml(name)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
    `<a:graphic><a:graphicData uri="${NS.c}"><c:chart xmlns:c="${NS.c}" r:id="{{rel:0}}"/></a:graphicData></a:graphic>` +
    `</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
  )
}
