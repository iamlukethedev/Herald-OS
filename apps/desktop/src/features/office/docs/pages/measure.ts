import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import type { Section } from './geometry.ts'
import type { FlowBox, Force } from './layout.ts'

/*
 * The text as it lies without pages, read off the editor: every top-level block's box, and for a
 * block that crosses a page end, its lines, table rows or inner blocks, read only then. Positions
 * are CSS pixels from the top of the text whatever the zoom.
 */

/** Where a page that starts at a box puts its spacer. */
export type Ref =
  | { kind: 'block'; pos: number }
  | { kind: 'line'; element: HTMLElement; pos: number; boundary: number }
  | { kind: 'row'; pos: number; columns: number }
  | { kind: 'endnote'; element: HTMLElement }
  | { kind: 'end'; pos: number }

export interface MeasureContext {
  view: EditorView
  /** Where the text starts on screen, and the zoom it is shown at. */
  origin: number
  zoom: number
  /** Footnote references by where they sit in the column, in document order. */
  notes: readonly { y: number; note: number }[]
}

type Box = FlowBox<Ref>

const SPLIT_BLOCKS = new Set(['bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'blockquote', 'callout', 'textBox'])

const toY = (context: MeasureContext, screen: number): number => (screen - context.origin) / context.zoom

/** The element a node's children are drawn in. */
function contentOf(dom: HTMLElement): HTMLElement {
  const desc = (dom as HTMLElement & { pmViewDesc?: { contentDOM?: HTMLElement | null } }).pmViewDesc

  return desc?.contentDOM ?? dom
}

const isWidget = (element: Element): boolean => element.classList.contains('ProseMirror-widget')

/** The elements drawing a node's children, one each, in order. */
function childElements(view: EditorView, node: PMNode, pos: number, dom: HTMLElement): (HTMLElement | undefined)[] {
  const shown = [...contentOf(dom).children].filter((element): element is HTMLElement => element instanceof HTMLElement && !isWidget(element))

  if (shown.length === node.childCount) {
    return shown
  }

  const out: (HTMLElement | undefined)[] = []
  node.forEach((_child, offset) => {
    const found = view.nodeDOM(pos + 1 + offset)
    out.push(found instanceof HTMLElement ? found : undefined)
  })

  return out
}

/** The footnotes referred to between two heights. */
function notesBetween(context: MeasureContext, top: number, bottom: number): number[] | undefined {
  const { notes } = context

  if (!notes.length) {
    return undefined
  }

  let low = 0
  let high = notes.length

  while (low < high) {
    const middle = (low + high) >> 1

    if (notes[middle].y < top) {
      low = middle + 1
    } else {
      high = middle
    }
  }

  const out: number[] = []

  for (let index = low; index < notes.length && notes[index].y < bottom; index++) {
    out.push(notes[index].note)
  }

  return out.length ? out : undefined
}

/** A box for a block and, read when asked, what it splits into. */
function blockBox(context: MeasureContext, node: PMNode, pos: number, dom: HTMLElement | undefined, after: number, section: number): Box {
  const rect = dom?.getBoundingClientRect()
  const top = rect ? toY(context, rect.top) : after
  const bottom = rect ? toY(context, rect.bottom) : after
  const box: Box = { top, bottom, kind: 'block', ref: { kind: 'block', pos }, notes: notesBetween(context, top, bottom) }
  const name = node.type.name

  if (!dom || !rect) {
    return { ...box, keepTogether: true }
  }

  if (name === 'heading') {
    return { ...box, keepWithNext: true, keepTogether: true }
  }

  if (node.isTextblock) {
    return { ...box, split: 'lines', parts: () => lineBoxes(context, pos, dom, name === 'codeBlock') }
  }

  if (name === 'table') {
    return { ...box, split: 'rows', parts: () => rowBoxes(context, node, pos, dom) }
  }

  if (SPLIT_BLOCKS.has(name) && !(name === 'textBox' && (node.attrs.align === 'left' || node.attrs.align === 'right'))) {
    return { ...box, split: 'blocks', parts: () => blockBoxes(context, node, pos, dom, section) }
  }

  return { ...box, keepTogether: true }
}

/** Boxes for a node's child blocks; a page break starts a page at the block after it. */
function blockBoxes(context: MeasureContext, node: PMNode, pos: number, dom: HTMLElement, section: number): Box[] {
  const elements = childElements(context.view, node, pos, dom)
  const out: Box[] = []
  let force: Force | undefined

  for (let index = 0, offset = 0; index < node.childCount; offset += node.child(index).nodeSize, index++) {
    const child = node.child(index)
    const box = blockBox(context, child, pos + 1 + offset, elements[index], out[out.length - 1]?.bottom ?? 0, section)

    if (force) {
      box.force = force
      force = undefined
    }

    out.push(box)

    if (child.type.name === 'pageBreak') {
      force = { kind: 'page', section }
    }
  }

  return out
}

/** A table's rows, those a cell spans down over kept together. */
function rowBoxes(context: MeasureContext, table: PMNode, pos: number, dom: HTMLElement): Box[] {
  const elements = childElements(context.view, table, pos, dom)
  let columns = 0
  table.firstChild?.forEach((cell) => {
    columns += Math.max(1, Number(cell.attrs.colspan) || 1)
  })
  const out: Box[] = []
  let group: Box | null = null
  let reach = -1

  for (let index = 0, offset = 0; index < table.childCount; offset += table.child(index).nodeSize, index++) {
    const rect = elements[index]?.getBoundingClientRect()
    const top: number = rect ? toY(context, rect.top) : (group?.bottom ?? 0)
    const bottom: number = rect ? toY(context, rect.bottom) : top

    if (group && index > reach) {
      out.push(group)
      group = null
    }

    group ??= { top, bottom, kind: 'row', ref: { kind: 'row', pos: pos + 1 + offset, columns } }
    group.bottom = Math.max(group.bottom, bottom)
    table.child(index).forEach((cell) => {
      reach = Math.max(reach, index + Math.max(1, Number(cell.attrs.rowspan) || 1) - 1)
    })
  }

  if (group) {
    out.push(group)
  }

  return out.map((box) => ({ ...box, notes: notesBetween(context, box.top, box.bottom) }))
}

/** What a text block's lines are drawn with: its text, and its inline atoms (pictures, fields, notes) whole. */
function inlineRects(element: Element, range: Range, out: DOMRect[]): void {
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.TEXT_NODE) {
      range.selectNodeContents(child)
      out.push(...range.getClientRects())
    } else if (child instanceof HTMLElement && !isWidget(child)) {
      if (child.contentEditable === 'false' || child.tagName === 'BR') {
        out.push(...child.getClientRects())
      } else {
        inlineRects(child, range, out)
      }
    }
  }
}

/** Rectangles on screen grouped into lines: those that share most of their height are on one line. */
function clusterLines(rects: readonly DOMRect[]): { top: number; bottom: number }[] {
  const sorted = rects.filter((rect) => rect.height > 0).sort((a, b) => a.top - b.top)
  const lines: { top: number; bottom: number }[] = []

  for (const rect of sorted) {
    const last = lines[lines.length - 1]

    if (last && Math.min(last.bottom, rect.bottom) - Math.max(last.top, rect.top) > Math.min(rect.height, last.bottom - last.top) / 2) {
      last.top = Math.min(last.top, rect.top)
      last.bottom = Math.max(last.bottom, rect.bottom)
    } else {
      lines.push({ top: rect.top, bottom: rect.bottom })
    }
  }

  return lines
}

/** A text block's lines: each runs from the middle of the gap above it to the middle of the gap below. */
function lineBoxes(context: MeasureContext, pos: number, element: HTMLElement, padded: boolean): Box[] {
  const rect = element.getBoundingClientRect()
  const style = padded ? getComputedStyle(element) : null
  const inset = (side: 'Top' | 'Bottom') => (style ? Number.parseFloat(style[`padding${side}`]) + Number.parseFloat(style[`border${side}Width`]) : 0) || 0
  const rects: DOMRect[] = []
  inlineRects(element, document.createRange(), rects)
  const lines = clusterLines(rects)
  const first = toY(context, rect.top) + inset('Top')
  const last = toY(context, rect.bottom) - inset('Bottom')

  if (lines.length < 2) {
    return [{ top: first, bottom: last, kind: 'line', ref: { kind: 'line', element, pos, boundary: Number.NEGATIVE_INFINITY }, notes: notesBetween(context, first, last) }]
  }

  return lines.map((line, index) => {
    const above = index ? (lines[index - 1].bottom + line.top) / 2 : Number.NEGATIVE_INFINITY
    const below = index + 1 < lines.length ? (line.bottom + lines[index + 1].top) / 2 : Number.POSITIVE_INFINITY
    const top = index ? toY(context, above) : first
    const bottom = below === Number.POSITIVE_INFINITY ? last : toY(context, below)

    return { top, bottom, kind: 'line' as const, ref: { kind: 'line' as const, element, pos, boundary: above }, notes: notesBetween(context, top, bottom) }
  })
}

/** The endnotes after the text: the rule goes with the first note. */
function endnoteBoxes(context: MeasureContext, element: HTMLElement): Box | null {
  const rect = element.getBoundingClientRect()
  const children = [...element.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.classList.contains('docs-page-spacer'))

  if (!children.length || !rect.height) {
    return null
  }

  const parts: Box[] = children.map((child) => {
    const box = child.getBoundingClientRect()

    return { top: toY(context, box.top), bottom: toY(context, box.bottom), kind: 'block', ref: { kind: 'endnote', element: child }, keepTogether: true, keepWithNext: child.classList.contains('doc-notes-rule') }
  })

  return { top: toY(context, rect.top), bottom: toY(context, rect.bottom), kind: 'block', ref: parts[0].ref, split: 'blocks', parts: () => parts }
}

/** The column's boxes: its top-level blocks, page and section breaks starting pages, and the endnotes. */
export function measureFlow(context: MeasureContext, sections: readonly Section[]): Box[] {
  const { view } = context
  const { doc } = view.state
  const elements = childElements(view, doc, -1, view.dom)
  const out: Box[] = []
  let force: Force | undefined
  let section = 0

  for (let index = 0, offset = 0; index < doc.childCount; offset += doc.child(index).nodeSize, index++) {
    const node = doc.child(index)

    if (sections[section + 1]?.start === index) {
      section++
      force = { kind: sections[section].kind, section }
    }

    const box = blockBox(context, node, offset, elements[index], out[out.length - 1]?.bottom ?? 0, section)

    if (force) {
      box.force = force
      force = undefined
    }

    out.push(box)

    if (node.type.name === 'pageBreak') {
      force = { kind: 'page', section }
    }
  }

  const end = out[out.length - 1]?.bottom ?? 0

  if (sections[section + 1]?.start === doc.childCount) {
    section++
    force = { kind: sections[section].kind, section }
  }

  // A page or section break at the very end starts one more page.
  if (force) {
    out.push({ top: end, bottom: end, kind: 'block', ref: { kind: 'end', pos: doc.content.size }, force, keepTogether: true })
  }

  const endnotes = view.dom.querySelector(':scope > .doc-endnotes')
  const notes = endnotes instanceof HTMLElement ? endnoteBoxes(context, endnotes) : null

  if (notes) {
    out.push(notes)
  }

  return out
}

/** The first character or inline atom of a text block at or below a height on screen, as a document position. */
export function lineStart(view: EditorView, element: HTMLElement, boundary: number): number | null {
  const range = document.createRange()
  const center = (rect: DOMRect) => (rect.top + rect.bottom) / 2

  const visit = (parent: Element): number | null => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child as Text
        range.selectNodeContents(text)
        const rects = range.getClientRects()

        if (!rects.length || center(rects[rects.length - 1]) < boundary) {
          continue
        }

        let low = 0
        let high = text.length - 1

        while (low < high) {
          const middle = (low + high) >> 1
          range.setStart(text, middle)
          range.setEnd(text, middle + 1)
          const box = range.getBoundingClientRect()

          if (box.height && center(box) < boundary) {
            low = middle + 1
          } else {
            high = middle
          }
        }

        const code = text.data.charCodeAt(low)
        const at = code >= 0xdc00 && code <= 0xdfff && low > 0 ? low - 1 : low

        return view.posAtDOM(text, at)
      }

      if (child instanceof HTMLElement && !isWidget(child)) {
        if (child.contentEditable === 'false' || child.tagName === 'BR') {
          const rects = child.getClientRects()

          if (rects.length && center(rects[rects.length - 1]) >= boundary) {
            return view.posAtDOM(parent, [...parent.childNodes].indexOf(child))
          }
        } else {
          const found = visit(child)

          if (found !== null) {
            return found
          }
        }
      }
    }

    return null
  }

  return visit(element)
}
