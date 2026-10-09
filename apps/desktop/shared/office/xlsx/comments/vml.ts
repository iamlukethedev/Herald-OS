import type { SheetSnapshot } from '../../workbook.ts'
import { pixelsToPoints, pointsToPixels } from '../units.ts'
import { attributesOf, elementsOf, textOf } from '../xml.ts'

/*
 * The VML drawing Excel draws a sheet's notes from (a yellow box per note, placed against the
 * cells), written for each note and for the note older versions of Excel show for a comment
 * thread; and the boxes' sizes and whether they show, read back.
 */

export interface NoteBox {
  row: number
  col: number
  /** Pixels. */
  width: number
  height: number
  shown: boolean
}

/** A sheet's column widths and row heights in pixels; hidden ones have none. */
function sizesOf(sheet: SheetSnapshot | undefined): { column: (index: number) => number; row: (index: number) => number } {
  const columns = (sheet?.columnData ?? {}) as Record<string, { w?: number; hd?: number }>
  const rows = (sheet?.rowData ?? {}) as Record<string, { h?: number; hd?: number }>
  const defaultColumn = typeof sheet?.defaultColumnWidth === 'number' ? sheet.defaultColumnWidth : 64
  const defaultRow = typeof sheet?.defaultRowHeight === 'number' ? sheet.defaultRowHeight : 20

  return {
    column: (index) => (columns[index]?.hd ? 0 : (columns[index]?.w ?? defaultColumn)),
    row: (index) => (rows[index]?.hd ? 0 : (rows[index]?.h ?? defaultRow))
  }
}

/** Where `span` pixels from the start of line `from` end: the line and the pixels into it. */
function walk(size: (index: number) => number, from: number, span: number): { index: number; offset: number } {
  let index = from
  let left = span

  // A sheet of hidden lines would never end the walk.
  for (let guard = 0; left > size(index) && guard < 20000; guard++) {
    left -= size(index)
    index++
  }

  return { index, offset: Math.round(left) }
}

const sum = (size: (index: number) => number, count: number): number => {
  let total = 0

  for (let index = 0; index < count; index++) {
    total += size(index)
  }

  return total
}

/** A box's place as Excel puts a new note's: right of its cell and a little above it. */
function placed(sheet: SheetSnapshot | undefined, box: NoteBox): { anchor: string; left: number; top: number } {
  const sizes = sizesOf(sheet)
  const start = { column: box.col + 1, columnOffset: 15, row: Math.max(0, box.row - 1), rowOffset: box.row ? 10 : 2 }
  const right = walk(sizes.column, start.column, start.columnOffset + box.width)
  const bottom = walk(sizes.row, start.row, start.rowOffset + box.height)

  return {
    anchor: [start.column, start.columnOffset, start.row, start.rowOffset, right.index, right.offset, bottom.index, bottom.offset].join(', '),
    left: sum(sizes.column, start.column) + start.columnOffset,
    top: sum(sizes.row, start.row) + start.rowOffset
  }
}

/** A sheet's VML drawing with a box for each note; shape ids are in the 1024-id blocks from `firstBlock`, one block per 1023 boxes. */
export function vmlDrawing(sheet: SheetSnapshot | undefined, boxes: NoteBox[], firstBlock: number): { xml: string; blocks: number } {
  const blocks = Math.max(1, Math.ceil((boxes.length + 1) / 1024))
  const shapes = boxes.map((box, index) => {
    const { anchor, left, top } = placed(sheet, box)
    const style = `position:absolute;margin-left:${pixelsToPoints(left)}pt;margin-top:${pixelsToPoints(top)}pt;width:${pixelsToPoints(box.width)}pt;height:${pixelsToPoints(box.height)}pt;z-index:${index + 1};visibility:${box.shown ? 'visible' : 'hidden'}`

    return `<v:shape id="_x0000_s${firstBlock * 1024 + 1 + index}" type="#_x0000_t202" style="${style}" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${anchor}</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${box.row}</x:Row><x:Column>${box.col}</x:Column>${box.shown ? '<x:Visible/>' : ''}</x:ClientData></v:shape>`
  })
  const idmap = Array.from({ length: blocks }, (_, n) => firstBlock + n).join(',')

  return {
    xml: `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${idmap}"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>${shapes.join('')}</xml>`,
    blocks
  }
}

/** A length in a VML style ("108pt", "144px", "1.5in") as pixels. */
function pixelsOf(length: string | undefined): number | null {
  const match = /^([\d.]+)\s*(pt|px|in|cm|mm)?$/.exec(length?.trim() ?? '')

  if (!match) {
    return null
  }

  const value = Number(match[1])
  const unit = match[2] ?? 'pt'

  return unit === 'px' ? Math.round(value) : pointsToPixels(unit === 'in' ? value * 72 : unit === 'cm' ? (value * 72) / 2.54 : unit === 'mm' ? (value * 72) / 25.4 : value)
}

/** The note boxes of a VML drawing, by their cells ("row:col"). */
export function noteBoxes(vml: string): Map<string, NoteBox> {
  const boxes = new Map<string, NoteBox>()

  for (const shape of elementsOf(vml, 'shape')) {
    const data = elementsOf(shape.inner, 'ClientData').find((element) => element.attributes.ObjectType === 'Note')

    if (!data) {
      continue
    }

    const row = Number(textOf(data.inner, 'Row'))
    const col = Number(textOf(data.inner, 'Column'))
    const style = Object.fromEntries((attributesOf(shape.outer.slice(0, shape.outer.indexOf('>') + 1)).style ?? '').split(';').map((part) => part.split(':').map((side) => side.trim()) as [string, string]))

    if (Number.isInteger(row) && Number.isInteger(col)) {
      boxes.set(`${row}:${col}`, { row, col, width: pixelsOf(style.width) ?? 0, height: pixelsOf(style.height) ?? 0, shown: /<(?:\w+:)?Visible\b/.test(data.inner) || style.visibility === 'visible' })
    }
  }

  return boxes
}
