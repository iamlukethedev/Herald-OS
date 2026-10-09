import type { SlideElement, Stroke, TableCell, TableElement, TextBody } from '../deck.ts'
import { EMU_PER_POINT } from '../deck.ts'
import { describeElement } from '../elements.ts'
import { type CellRef, cellUnder } from '../tables.ts'
import type { PlaceholderSlot } from './placeholders.ts'
import { bodyPropertiesXml, customGeometryXml, emu, fillXml, lineXml, paragraphXml, presetGeometryXml, setFill, setGeometry, setLine, setTransform } from './write-drawingml.ts'
import { connectorShape, glueConnectors, groupShapes, type Placed, uniqueIds } from './write-groups.ts'
import { keptFrame } from './write-objects.ts'
import type { PackageWriter, Relationships } from './write-package.ts'
import { child, childrenNamed, elements, find, xml, type XmlElement, type XmlNode } from './xml.ts'

/*
 * A shape tree as PptxGenJS wrote it (a slide's, or a master's or layout's drawn on a slide of
 * their own), finished from the deck: each element's shape found by the name PptxGenJS gave it (its
 * id), its paragraph and text box settings, position, geometry, fill and outline written as the deck
 * has them, tables cell by cell, placeholders marked, kept objects put back in place of the shapes
 * standing for them, connectors made, groups nested, and every shape given an id of its own.
 */

/** How much a text body's text was shrunk to fit when last drawn, when the window knows. */
export type ShrinkOf = (body: TextBody) => number | undefined

export interface TreeContext {
  /** The part the tree is in, and its relationships, which kept objects add to. */
  part: string
  rels: Relationships
  pkg: PackageWriter
  /** The placeholder each element fills, by element id. */
  slots: ReadonlyMap<string, PlaceholderSlot>
  shrink?: ShrinkOf
  /** A shape of its own for an element in place of PptxGenJS's (null leaves the element out, undefined finishes PptxGenJS's). */
  replace?: (element: SlideElement, slot: PlaceholderSlot | undefined, names: Map<string, number>) => XmlElement | null | undefined
  /** Shapes drawn over the elements (a slide's date, footer and slide number). */
  extra?: XmlElement[]
}

/** The name PowerPoint's selection pane shows: the element's own, or what it is and a number (Herald's ids stay in Herald's own copy). */
export function nameOf(element: SlideElement, names: Map<string, number>, base = element.name ?? describeElement(element)): string {
  const n = (names.get(base) ?? 0) + 1
  names.set(base, n)

  return element.name ?? `${base} ${n}`
}

/** A placeholder's `p:ph`: its type (none for `obj`), size, index and whether its prompt is its own. */
export function placeholderXml(slot: PlaceholderSlot, options: { size?: string; customPrompt?: boolean } = {}): XmlElement {
  return xml('p:ph', { type: slot.type === 'obj' ? undefined : slot.type, sz: options.size, idx: slot.idx, hasCustomPrompt: options.customPrompt ? '1' : undefined })
}

/** A shape made the placeholder it fills: grouping locked, as PowerPoint has placeholders, and named by type and index. */
function markPlaceholder(node: XmlElement, slot: PlaceholderSlot): void {
  const picture = node.name === 'p:pic'
  const nv = child(node, picture ? 'p:nvPicPr' : 'p:nvSpPr')

  if (!nv) {
    return
  }

  const props = child(nv, picture ? 'p:cNvPicPr' : 'p:cNvSpPr')
  const locks = child(props, picture ? 'a:picLocks' : 'a:spLocks')
  let nvPr = child(nv, 'p:nvPr')

  if (props) {
    delete props.attrs.txBox
  }

  if (locks) {
    locks.attrs.noGrp = '1'
  } else {
    props?.children.unshift(xml(picture ? 'a:picLocks' : 'a:spLocks', { noGrp: '1' }))
  }

  if (!nvPr) {
    nvPr = xml('p:nvPr')
    nv.children.push(nvPr)
  }

  nvPr.children = [placeholderXml(slot), ...nvPr.children.filter((entry) => typeof entry === 'string' || entry.name !== 'p:ph')]
}

/** A text body's paragraphs with their own settings, and the body's settings, in place of PptxGenJS's. */
function finishText(txBody: XmlElement, body: TextBody, shrink?: number): void {
  txBody.children = txBody.children.map((node) => (typeof node !== 'string' && node.name === 'a:bodyPr' ? bodyPropertiesXml(body, shrink) : node))

  childrenNamed(txBody, 'a:p').forEach((p, index) => {
    const model = body.paragraphs[Math.min(index, body.paragraphs.length - 1)]
    p.children = [paragraphXml(model), ...p.children.filter((node) => typeof node === 'string' || node.name !== 'a:pPr')]
  })
}

function finishElement(node: XmlElement, element: SlideElement, names: Map<string, number>, shrink?: ShrinkOf): void {
  const cNvPr = child(child(node, node.name === 'p:pic' ? 'p:nvPicPr' : 'p:nvSpPr'), 'p:cNvPr')
  const spPr = child(node, 'p:spPr')

  if (cNvPr) {
    cNvPr.attrs.name = nameOf(element, names)
  }

  if (spPr) {
    setTransform(spPr, element)
  }

  if (element.kind === 'shape' && spPr) {
    setGeometry(spPr, element.paths?.length ? customGeometryXml(element.paths) : presetGeometryXml(element.shape, element.adjust))
  }

  if ((element.kind === 'text' || element.kind === 'shape') && spPr) {
    setFill(spPr, fillXml(element.fill))
    setLine(spPr, lineXml(element.stroke))
  }

  if (element.kind === 'image') {
    if (spPr && element.stroke) {
      setLine(spPr, lineXml(element.stroke))
    }

    const fill = child(node, 'p:blipFill')

    if (fill && element.crop) {
      const crop = element.crop
      const rect = xml('a:srcRect', { l: Math.round(crop.left * 100000), t: Math.round(crop.top * 100000), r: Math.round(crop.right * 100000), b: Math.round(crop.bottom * 100000) })
      fill.children = fill.children.filter((entry) => typeof entry === 'string' || entry.name !== 'a:srcRect')
      const blip = fill.children.findIndex((entry) => typeof entry !== 'string' && entry.name === 'a:blip')
      fill.children.splice(blip + 1, 0, rect)
    }
  }

  const txBody = child(node, 'p:txBody')

  if (txBody && (element.kind === 'text' || element.kind === 'shape')) {
    finishText(txBody, element.body, shrink?.(element.body))
  }
}

/** Lengths in EMU, each rounded where it ends, so together they are their total rounded. */
function emuSpans(lengths: readonly number[]): number[] {
  let at = 0
  let written = 0

  return lengths.map((length) => {
    at += length
    const end = Math.round(at * EMU_PER_POINT)
    const span = end - written
    written = end

    return span
  })
}

type Side = 'left' | 'right' | 'top' | 'bottom'

/**
 * The line on each side of a cell. An edge two cells share takes the first cell's own line for it
 * (the one left of it or above it), else the other's, else the table's, so both cells write the
 * same; a merged cell's lines are its top left cell's, and inside it the table's.
 */
function cellSides(table: TableElement, row: number, column: number): Record<Side, Stroke | null> {
  const origin = (r: number, c: number): CellRef => (table.cells[r][c].merged ? cellUnder(table, { row: r, column: c }) : { row: r, column: c })
  const own = (at: CellRef | null, side: Side): Stroke | null | undefined => (at ? table.cells[at.row][at.column].borders?.[side] : undefined)
  const edge = (first: CellRef | null, second: CellRef | null, sides: [Side, Side]): Stroke | null => {
    if (first && second && first.row === second.row && first.column === second.column) {
      return table.stroke
    }

    const line = own(first, sides[0])

    if (line !== undefined) {
      return line
    }

    const other = own(second, sides[1])

    return other !== undefined ? other : table.stroke
  }
  const here = origin(row, column)

  return {
    left: edge(column > 0 ? origin(row, column - 1) : null, here, ['right', 'left']),
    right: edge(here, column < table.columns.length - 1 ? origin(row, column + 1) : null, ['right', 'left']),
    top: edge(row > 0 ? origin(row - 1, column) : null, here, ['bottom', 'top']),
    bottom: edge(here, row < table.cells.length - 1 ? origin(row + 1, column) : null, ['bottom', 'top'])
  }
}

const ANCHOR = { top: 't', middle: 'ctr', bottom: 'b' } as const

const SIDE = { cap: 'flat', cmpd: 'sng', algn: 'ctr' }

/** A cell's settings as PowerPoint reads them: its margins and anchor, its lines and its fill. */
function cellPropertiesXml(cell: TableCell, sides: Record<Side, Stroke | null>): XmlElement {
  const [left, top, right, bottom] = cell.body.inset

  return xml('a:tcPr', { marL: emu(left), marR: emu(right), marT: emu(top), marB: emu(bottom), anchor: ANCHOR[cell.body.anchor] }, [
    lineXml(sides.left, 'a:lnL', SIDE),
    lineXml(sides.right, 'a:lnR', SIDE),
    lineXml(sides.top, 'a:lnT', SIDE),
    lineXml(sides.bottom, 'a:lnB', SIDE),
    fillXml(cell.fill)
  ])
}

/** A cell's text as a table holds it: empty body properties (the cell's own give its margins), a list style, and at least one paragraph with its settings. */
function cellTextXml(txBody: XmlElement | undefined, body: TextBody): XmlElement {
  const written = childrenNamed(txBody, 'a:p')
  const paragraphs = written.length ? written : [xml('a:p', {}, [xml('a:endParaRPr', { lang: 'en-US', dirty: '0' })])]

  paragraphs.forEach((p, index) => {
    const model = body.paragraphs[Math.min(index, body.paragraphs.length - 1)]
    p.children = [paragraphXml(model), ...p.children.filter((node) => typeof node === 'string' || node.name !== 'a:pPr')]
  })

  return xml('a:txBody', {}, [xml('a:bodyPr'), xml('a:lstStyle'), ...paragraphs])
}

/**
 * A table as the deck has it: its place, a grid column for each column, and each row with a cell
 * for every column, each cell its text and then its settings, a merged cell's reach as gridSpan and
 * rowSpan where it starts and the cells it covers marked hMerge and vMerge, as PowerPoint writes them.
 * PptxGenJS wrote every cell as one of its own, so its cells are the deck's one for one.
 */
function finishTable(frame: XmlElement, table: TableElement): void {
  const widths = emuSpans(table.columns)
  const heights = emuSpans(table.rows)
  const transform = child(frame, 'p:xfrm')
  const tbl = find(frame, 'a:graphic/a:graphicData/a:tbl')

  if (transform) {
    transform.attrs = {}
    transform.children = [xml('a:off', { x: emu(table.x), y: emu(table.y) }), xml('a:ext', { cx: widths.reduce((sum, width) => sum + width, 0), cy: heights.reduce((sum, height) => sum + height, 0) })]
  }

  if (!tbl) {
    return
  }

  const rows = childrenNamed(tbl, 'a:tr')
  tbl.children = [
    child(tbl, 'a:tblPr') ?? xml('a:tblPr'),
    xml(
      'a:tblGrid',
      {},
      widths.map((width) => xml('a:gridCol', { w: width }))
    ),
    ...table.cells.map((row, r) => {
      const written = childrenNamed(rows[r], 'a:tc')

      return xml(
        'a:tr',
        { h: heights[r] },
        row.map((cell, c) => {
          const under = cell.merged ? cellUnder(table, { row: r, column: c }) : null
          const reach = under ? { hMerge: c > under.column ? '1' : undefined, vMerge: r > under.row ? '1' : undefined } : { gridSpan: cell.colSpan, rowSpan: cell.rowSpan }

          return xml('a:tc', reach, [cellTextXml(child(written[c], 'a:txBody'), cell.body), cellPropertiesXml(cell, cellSides(table, r, c))])
        })
      )
    })
  ]
}

/** The name PptxGenJS gave a shape: the id of the element it drew. */
const writtenName = (node: XmlElement): string | undefined => child(elements(node).find((entry) => entry.name.startsWith('p:nv')), 'p:cNvPr')?.attrs.name

function finishNode(node: XmlElement, element: SlideElement, ctx: TreeContext, names: Map<string, number>): XmlElement | null {
  const slot = ctx.slots.get(element.id)
  const replaced = ctx.replace?.(element, slot, names)

  if (replaced !== undefined) {
    return replaced
  }

  if (element.kind === 'object') {
    return keptFrame(element, nameOf(element, names), ctx.part, ctx.rels, ctx.pkg)
  }

  if (element.kind === 'image' && !element.src) {
    return null
  }

  if (element.kind === 'table') {
    const cNvPr = find(node, 'p:nvGraphicFramePr/p:cNvPr')

    if (cNvPr) {
      cNvPr.attrs.name = nameOf(element, names)
    }

    finishTable(node, element)

    return node
  }

  finishElement(node, element, names, ctx.shrink)

  if (slot) {
    markPlaceholder(node, slot)
  }

  return element.kind === 'line' && element.connector ? connectorShape(node, element) : node
}

/** Finish a shape tree for its elements (see above); returns each element's shape in drawing order. */
export function finishTree(tree: XmlElement, elementsOfTree: readonly SlideElement[], ctx: TreeContext): Placed[] {
  const byId = new Map(elementsOfTree.map((element) => [element.id, element]))
  const names = new Map<string, number>()
  const header: XmlNode[] = []
  const placed: Placed[] = []

  for (const node of elements(tree)) {
    if (node.name === 'p:nvGrpSpPr' || node.name === 'p:grpSpPr') {
      header.push(node)

      continue
    }

    const element = byId.get(writtenName(node) ?? '')

    if (!element) {
      placed.push({ element: null, node })

      continue
    }

    const finished = finishNode(node, element, ctx, names)

    if (finished) {
      placed.push({ element, node: finished })
    }
  }

  tree.children = [...header, ...groupShapes(placed, names), ...(ctx.extra ?? [])]
  uniqueIds(tree)
  glueConnectors(placed)

  return placed
}
