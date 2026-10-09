import { closeHistory } from '@tiptap/pm/history'
import { Fragment, type Mark, type Node as PMNode, type NodeType, type Schema, Slice } from '@tiptap/pm/model'
import { EditorState, Selection, type Transaction } from '@tiptap/pm/state'
import { findWrapping, liftTarget } from '@tiptap/pm/transform'
import { documentFromMarkdown } from '../../../../shared/office/doc-text.ts'
import { countCharacters, countWords, type DocJSON, type DocNode, defaultPage, pageOf, type PageSettings, PAGE_SIZES, type PageSizeName } from '../../../../shared/office/document.ts'
import { docsSchema } from './schema.ts'

/*
 * Herald Docs' document API: reading a document and changing it, on its ProseMirror state, so the
 * same operation works on the document open in a window and on a file read from disk. Each
 * operation builds one transaction: on a live editor it is one step to undo, and it never merges
 * with the person's own typing before or after it. The window's toolbar and Hermes's commands use
 * the same operations.
 */

/** An operation: the transaction it makes of a state, or null when it changes nothing. */
export type Op = (state: EditorState) => Transaction | null

export const stateOf = (json: DocJSON, schema: Schema = docsSchema()): EditorState => EditorState.create({ schema, doc: schema.nodeFromJSON(json) })

export const jsonOf = (doc: PMNode): DocJSON => doc.toJSON() as DocJSON

/** Run an operation on a document that is not open: its JSON in, the changed JSON out (null when nothing changed). */
export function applyToJSON(json: DocJSON, op: Op): DocJSON | null {
  const tr = op(stateOf(json))

  return tr && tr.steps.length ? jsonOf(tr.doc) : null
}

export interface LiveView {
  state: EditorState
  dispatch: (tr: Transaction) => void
}

/** Run an operation on an open editor as one undo step of its own. */
export function applyLive(view: LiveView, op: Op): boolean {
  const tr = op(view.state)

  if (!tr || !tr.steps.length) {
    return false
  }

  view.dispatch(closeHistory(tr))
  // Typing that follows starts a step of its own too.
  view.dispatch(closeHistory(view.state.tr))

  return true
}

// Reading.

export interface OutlineEntry {
  level: number
  text: string
  /** Where the heading starts and ends in the document. */
  from: number
  to: number
}

export function outline(doc: PMNode): OutlineEntry[] {
  const out: OutlineEntry[] = []

  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      out.push({ level: Number(node.attrs.level), text: node.textContent, from: pos, to: pos + node.nodeSize })

      return false
    }

    return !node.isTextblock
  })

  return out
}

export const documentText = (doc: PMNode): string => doc.textBetween(0, doc.content.size, '\n', (leaf) => (leaf.type.name === 'hardBreak' ? '\n' : ''))

export function counts(doc: PMNode): { words: number; characters: number } {
  const text = documentText(doc)

  return { words: countWords(text), characters: countCharacters(text) }
}

export interface SearchOptions {
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
}

export interface Match {
  from: number
  to: number
  text: string
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The pattern a search runs, or null when the query is empty or not a valid expression. */
export function searchPattern(query: string, options: SearchOptions = {}): RegExp | null {
  if (!query) {
    return null
  }

  const source = options.regex ? query : escapeRegExp(query)
  const bounded = options.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source

  try {
    return new RegExp(bounded, `gu${options.caseSensitive ? '' : 'i'}`)
  } catch {
    return null
  }
}

/** Every match of `query` in the text of the document's paragraphs, in order. */
export function findText(doc: PMNode, query: string, options: SearchOptions = {}): Match[] {
  const pattern = searchPattern(query, options)
  const out: Match[] = []

  if (!pattern) {
    return out
  }

  doc.descendants((node, pos) => {
    if (!node.isTextblock) {
      return true
    }

    // Pictures and line breaks count as one character, as they take one position.
    const text = node.textBetween(0, node.content.size, undefined, '\uFFFC')

    for (const match of text.matchAll(pattern)) {
      if (match[0]) {
        out.push({ from: pos + 1 + match.index, to: pos + 1 + match.index + match[0].length, text: match[0] })
      }
    }

    return false
  })

  return out
}

const normalized = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ')

/** A heading by its text (exactly, then as part of it) or by its place in the outline. */
export function findHeading(doc: PMNode, heading: string | number): OutlineEntry | null {
  const all = outline(doc)

  if (typeof heading === 'number') {
    return all[heading] ?? null
  }

  const wanted = normalized(heading)

  return all.find((entry) => normalized(entry.text) === wanted) ?? all.find((entry) => normalized(entry.text).includes(wanted)) ?? null
}

/** What comes under a heading: up to the next heading of its level or above, among the blocks around it. */
export function sectionOf(doc: PMNode, entry: OutlineEntry): { from: number; to: number } {
  const $start = doc.resolve(entry.from)
  const parent = $start.parent
  let offset = entry.to

  for (let index = $start.index() + 1; index < parent.childCount; index++) {
    const child = parent.child(index)

    if (child.type.name === 'heading' && Number(child.attrs.level) <= entry.level) {
      return { from: entry.to, to: offset }
    }

    offset += child.nodeSize
  }

  return { from: entry.to, to: offset }
}

const headingOrThrow = (doc: PMNode, heading: string | number): OutlineEntry => {
  const entry = findHeading(doc, heading)

  if (!entry) {
    throw new Error(typeof heading === 'number' ? `The document has no heading number ${heading + 1}` : `The document has no heading “${heading}”`)
  }

  return entry
}

// Where changes go.

/** Where content goes in: the start or end, the selection, a heading's section, a position, or over a range. */
export type Place = 'start' | 'end' | 'selection' | { heading: string | number; mode?: 'append' | 'prepend' | 'replace' } | { pos: number } | { from: number; to: number }

/** What a change applies to: the selection, everything, a heading's section, matches of some text, or a range. */
export type Target = 'selection' | 'all' | { heading: string | number; part?: 'heading' | 'section' | 'all' } | { text: string; all?: boolean; options?: SearchOptions } | { from: number; to: number }

interface Range {
  from: number
  to: number
}

const isEmptyParagraph = (node: PMNode | null | undefined): boolean => Boolean(node && node.type.name === 'paragraph' && node.content.size === 0)

function placeRange(state: EditorState, place: Place): Range & { inline: boolean } {
  const { doc, selection } = state
  const size = doc.content.size

  if (place === 'start') {
    return doc.childCount === 1 && isEmptyParagraph(doc.firstChild) ? { from: 0, to: size, inline: false } : { from: 0, to: 0, inline: false }
  }

  if (place === 'end') {
    // The empty paragraph a document ends with is where new content goes.
    return isEmptyParagraph(doc.lastChild) ? { from: size - doc.lastChild!.nodeSize, to: size, inline: false } : { from: size, to: size, inline: false }
  }

  if (place === 'selection') {
    return { from: selection.from, to: selection.to, inline: selection.$from.parent.isTextblock && selection.$to.parent.isTextblock }
  }

  if ('pos' in place) {
    const pos = Math.max(0, Math.min(size, Math.round(place.pos)))

    return { from: pos, to: pos, inline: doc.resolve(pos).parent.isTextblock }
  }

  if ('from' in place) {
    const from = Math.max(0, Math.min(size, Math.round(place.from)))
    const to = Math.max(from, Math.min(size, Math.round(place.to)))

    return { from, to, inline: doc.resolve(from).parent.isTextblock && doc.resolve(to).parent.isTextblock }
  }

  const entry = headingOrThrow(doc, place.heading)
  const section = sectionOf(doc, entry)

  if (place.mode === 'prepend') {
    return { from: section.from, to: section.from, inline: false }
  }

  return place.mode === 'replace' ? { ...section, inline: false } : { from: section.to, to: section.to, inline: false }
}

function targetRanges(state: EditorState, target: Target): Range[] {
  const { doc, selection } = state

  if (target === 'selection') {
    return [{ from: selection.from, to: selection.to }]
  }

  if (target === 'all') {
    return [{ from: 0, to: doc.content.size }]
  }

  if ('heading' in target) {
    const entry = headingOrThrow(doc, target.heading)
    const section = sectionOf(doc, entry)

    return [target.part === 'heading' ? { from: entry.from, to: entry.to } : target.part === 'section' ? section : { from: entry.from, to: section.to }]
  }

  if ('text' in target) {
    const matches = findText(doc, target.text, target.options)

    return target.all ? matches : matches.slice(0, 1)
  }

  return [{ from: Math.max(0, target.from), to: Math.min(doc.content.size, target.to) }]
}

/** The paragraphs, headings and code blocks a range touches, with their positions. */
function textblocksIn(doc: PMNode, ranges: Range[]): { node: PMNode; pos: number }[] {
  const out = new Map<number, PMNode>()

  for (const { from, to } of ranges) {
    doc.nodesBetween(from, Math.max(from, to), (node, pos) => {
      if (node.isTextblock) {
        out.set(pos, node)

        return false
      }

      return true
    })

    // An empty range (a caret) still means the block it is in.
    const $from = doc.resolve(from)

    if ($from.parent.isTextblock) {
      out.set($from.before(), $from.parent)
    }
  }

  return [...out].sort(([a], [b]) => a - b).map(([pos, node]) => ({ node, pos }))
}

// Content.

/** What to put in: Markdown (a plain string is Markdown), plain text, or blocks as JSON. */
export type Content = string | { markdown: string } | { text: string } | { blocks: DocNode[] }

export function contentNodes(content: Content, schema: Schema = docsSchema()): PMNode[] {
  if (typeof content === 'string' || 'markdown' in content) {
    const markdown = typeof content === 'string' ? content : content.markdown
    const blocks = documentFromMarkdown(markdown).document.content

    return markdown.trim() ? blocks.map((block) => schema.nodeFromJSON(block)) : []
  }

  if ('text' in content) {
    return content.text.split(/\r\n?|\n/).map((line) => schema.nodes.paragraph.create(null, line ? schema.text(line) : null))
  }

  return content.blocks.map((block) => schema.nodeFromJSON(block))
}

const ENDS_IN_TEXT = new Set(['paragraph', 'heading', 'codeBlock', 'bulletList', 'orderedList', 'taskList'])

/**
 * Blocks put in between blocks. A document always ends where one can type, as Word's do; blocks
 * put in at the caret take the caret with them, into a new table's first cell or after a break.
 */
function insertBlocks(tr: Transaction, range: Range, nodes: PMNode[], place: Place): Transaction {
  tr.replaceRange(range.from, range.to, new Slice(Fragment.from(nodes), 0, 0))
  const last = tr.doc.lastChild

  if (last && !ENDS_IN_TEXT.has(last.type.name)) {
    tr.insert(tr.doc.content.size, tr.doc.type.schema.nodes.paragraph.create())
  }

  if (place === 'selection' && nodes.length) {
    const first = nodes[0]
    let found = -1

    tr.doc.nodesBetween(Math.max(0, tr.mapping.map(range.from, -1) - 1), tr.doc.content.size, (node, pos) => {
      if (found < 0 && node.type === first.type && pos + 1 >= tr.mapping.map(range.from, -1)) {
        found = pos
      }

      return found < 0
    })

    if (found >= 0) {
      tr.setSelection(Selection.near(tr.doc.resolve(Math.min(tr.doc.content.size, first.isAtom ? found + first.nodeSize : found + 1))))
    }
  }

  return tr
}

/** Put content somewhere: one paragraph into a line of text joins it, blocks go between blocks. */
export function insert(content: Content, place: Place = 'end'): Op {
  return (state) => {
    const range = placeRange(state, place)
    const nodes = contentNodes(content, state.schema)
    const tr = state.tr

    if (!nodes.length) {
      return range.to > range.from ? tr.delete(range.from, range.to) : null
    }

    if (range.inline && nodes.length === 1 && nodes[0].type.name === 'paragraph') {
      tr.replaceWith(range.from, range.to, nodes[0].content)
    } else {
      insertBlocks(tr, range, nodes, place)
    }

    return tr.docChanged ? tr : null
  }
}

/** Replace what is under a heading, keeping the heading. */
export const replaceSection = (heading: string | number, content: Content): Op => insert(content, { heading, mode: 'replace' })

/** Replace matches of `query` (all of them, or the first), each keeping the formatting where it starts. */
export function replaceText(query: string, replacement: string, options: SearchOptions & { all?: boolean } = {}): Op {
  return (state) => {
    const pattern = searchPattern(query, options)
    const matches = findText(state.doc, query, options)
    const chosen = options.all === false ? matches.slice(0, 1) : matches

    if (!pattern || !chosen.length) {
      return null
    }

    const single = new RegExp(pattern.source, pattern.flags.replace('g', ''))
    const tr = state.tr

    for (const match of [...chosen].reverse()) {
      const text = options.regex ? match.text.replace(single, replacement) : replacement
      const marks = state.doc.nodeAt(match.from)?.marks ?? []
      tr.replaceWith(match.from, match.to, text ? state.schema.text(text, marks) : Fragment.empty)
    }

    return tr
  }
}

// Styles.

export type BlockStyle = 'normal' | 'title' | 'subtitle' | 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'heading5' | 'heading6' | 'quote' | 'code'

export const BLOCK_STYLES: readonly { id: BlockStyle; label: string }[] = [
  { id: 'normal', label: 'Normal' },
  { id: 'title', label: 'Title' },
  { id: 'subtitle', label: 'Subtitle' },
  { id: 'heading1', label: 'Heading 1' },
  { id: 'heading2', label: 'Heading 2' },
  { id: 'heading3', label: 'Heading 3' },
  { id: 'quote', label: 'Quote' },
  { id: 'code', label: 'Code' }
]

/** The style of the block the selection starts in. */
export function styleAt(state: EditorState): BlockStyle {
  const { $from } = state.selection
  const block = $from.parent

  if (block.type.name === 'codeBlock') {
    return 'code'
  }

  if ($from.depth > 1 && $from.node($from.depth - 1).type.name === 'blockquote') {
    return 'quote'
  }

  if (block.type.name === 'heading') {
    return `heading${block.attrs.level}` as BlockStyle
  }

  return block.attrs.docStyle === 'title' || block.attrs.docStyle === 'subtitle' ? block.attrs.docStyle : 'normal'
}

const LAYOUT = ['textAlign', 'lineHeight', 'spaceBefore', 'spaceAfter', 'indent', 'firstLine'] as const

/** Give the blocks of a target a style: Normal, Title, Subtitle, a heading, Quote or Code. */
export function setStyle(style: BlockStyle, target: Target = 'selection'): Op {
  return (state) => {
    const { schema } = state
    const ranges = targetRanges(state, target)
    const tr = state.tr

    if (style === 'quote') {
      for (const { from, to } of [...ranges].reverse()) {
        const $from = tr.doc.resolve(from)
        const quoted = Array.from({ length: $from.depth + 1 }, (_, depth) => $from.node(depth)).some((node) => node.type.name === 'blockquote')
        const range = $from.blockRange(tr.doc.resolve(to))
        const wrapping = range && !quoted ? findWrapping(range, schema.nodes.blockquote) : null

        if (range && wrapping) {
          tr.wrap(range, wrapping)
        }
      }

      return tr.docChanged ? tr : null
    }

    for (const { node, pos } of textblocksIn(state.doc, ranges)) {
      const at = tr.mapping.map(pos)
      const layout = Object.fromEntries(LAYOUT.filter((name) => name in node.attrs).map((name) => [name, node.attrs[name]]))

      if (style === 'code') {
        if (node.type.name !== 'codeBlock') {
          tr.setBlockType(at + 1, at + 1 + node.content.size, schema.nodes.codeBlock)
        }
      } else {
        const heading = /^heading(\d)$/.exec(style)
        const type: NodeType = heading ? schema.nodes.heading : schema.nodes.paragraph
        const attrs = heading ? { ...layout, level: Number(heading[1]) } : { ...layout, docStyle: style === 'normal' ? null : style }
        tr.setBlockType(at + 1, at + 1 + node.content.size, type, attrs)
      }
    }

    // A block given another style comes out of a quote.
    if (style !== 'code') {
      for (const { from, to } of ranges) {
        const $from = tr.doc.resolve(tr.mapping.map(from))
        const $to = tr.doc.resolve(tr.mapping.map(to))
        const range = $from.blockRange($to)

        if (range && range.depth > 0 && range.parent.type.name === 'blockquote') {
          const lifted = liftTarget(range)

          if (lifted !== null) {
            tr.lift(range, lifted)
          }
        }
      }
    }

    return tr.docChanged ? tr : null
  }
}

/** Formatting to add (true or a value) or take away (false or null). Sizes are in points. */
export interface MarkChange {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
  superscript?: boolean
  subscript?: boolean
  link?: string | null
  color?: string | null
  highlight?: string | null
  fontFamily?: string | null
  fontSize?: number | null
}

const TOGGLES = ['bold', 'italic', 'underline', 'strike', 'code', 'superscript', 'subscript'] as const

export function setMarks(change: MarkChange, target: Target = 'selection'): Op {
  return (state) => {
    const { schema } = state
    const ranges = targetRanges(state, target).filter((range) => range.to > range.from)
    const tr = state.tr

    for (const { from, to } of ranges) {
      for (const name of TOGGLES) {
        if (change[name] === true) {
          tr.addMark(from, to, schema.marks[name].create())
        } else if (change[name] === false) {
          tr.removeMark(from, to, schema.marks[name])
        }
      }

      if (change.superscript) {
        tr.removeMark(from, to, schema.marks.subscript)
      } else if (change.subscript) {
        tr.removeMark(from, to, schema.marks.superscript)
      }

      if (change.link !== undefined) {
        tr.removeMark(from, to, schema.marks.link)

        if (change.link) {
          tr.addMark(from, to, schema.marks.link.create({ href: change.link }))
        }
      }

      if (change.highlight !== undefined) {
        tr.removeMark(from, to, schema.marks.highlight)

        if (change.highlight) {
          tr.addMark(from, to, schema.marks.highlight.create({ color: change.highlight }))
        }
      }

      const style: Record<string, string | null> = {}

      if (change.color !== undefined) {
        style.color = change.color
      }

      if (change.fontFamily !== undefined) {
        style.fontFamily = change.fontFamily
      }

      if (change.fontSize !== undefined) {
        style.fontSize = change.fontSize ? `${change.fontSize}pt` : null
      }

      if (Object.keys(style).length) {
        restyleText(tr, from, to, style)
      }
    }

    return tr.docChanged ? tr : null
  }
}

/** Change some of the text style's attributes over a range, keeping the others each piece of text has. */
function restyleText(tr: Transaction, from: number, to: number, style: Record<string, string | null>): void {
  const type = tr.doc.type.schema.marks.textStyle
  const pieces: { from: number; to: number; mark: Mark | undefined }[] = []

  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) {
      pieces.push({ from: Math.max(from, pos), to: Math.min(to, pos + node.nodeSize), mark: type.isInSet(node.marks) ?? undefined })
    }
  })

  for (const piece of pieces) {
    const attrs = Object.fromEntries(Object.entries({ ...(piece.mark?.attrs ?? {}), ...style }).filter(([, value]) => value !== null && value !== undefined))
    tr.removeMark(piece.from, piece.to, type)

    if (Object.keys(attrs).length) {
      tr.addMark(piece.from, piece.to, type.create(attrs))
    }
  }
}

/** Set an attribute of the paragraphs and headings of a target (alignment, spacing, line height, indents). */
export function setBlockAttrs(attrs: Partial<Record<(typeof LAYOUT)[number], unknown>>, target: Target = 'selection'): Op {
  return (state) => {
    const tr = state.tr

    for (const { node, pos } of textblocksIn(state.doc, targetRanges(state, target))) {
      if (node.type.name === 'paragraph' || node.type.name === 'heading') {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
      }
    }

    return tr.docChanged ? tr : null
  }
}

export const setAlignment = (align: 'left' | 'center' | 'right' | 'justify', target: Target = 'selection'): Op => setBlockAttrs({ textAlign: align === 'left' ? null : align }, target)

/** Line spacing as a multiple of single spacing (1, 1.15, 1.5, 2). */
export const setLineSpacing = (multiple: number | null, target: Target = 'selection'): Op => setBlockAttrs({ lineHeight: multiple }, target)

/** Move paragraphs' left indent by `step` points (in steps of half an inch in the toolbar), never below zero. */
export function indent(step: number, target: Target = 'selection'): Op {
  return (state) => {
    const tr = state.tr

    for (const { node, pos } of textblocksIn(state.doc, targetRanges(state, target))) {
      if (node.type.name === 'paragraph' || node.type.name === 'heading') {
        const next = Math.max(0, (Number(node.attrs.indent) || 0) + step)
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next || null })
      }
    }

    return tr.docChanged ? tr : null
  }
}

/** Take away all formatting: marks, and paragraph styles back to Normal. */
export function clearFormatting(target: Target = 'selection'): Op {
  return (state) => {
    const ranges = targetRanges(state, target)
    const tr = state.tr

    for (const { from, to } of ranges) {
      if (to > from) {
        for (const type of Object.values(state.schema.marks)) {
          if (type.name !== 'link') {
            tr.removeMark(from, to, type)
          }
        }
      }
    }

    for (const { node, pos } of textblocksIn(state.doc, ranges)) {
      if (node.type.name === 'paragraph' || node.type.name === 'heading') {
        tr.setBlockType(tr.mapping.map(pos) + 1, tr.mapping.map(pos) + 1 + node.content.size, state.schema.nodes.paragraph, {})
      }
    }

    return tr.docChanged ? tr : null
  }
}

// Blocks.

export interface TableSpec {
  rows: number
  cols: number
  /** The first row as a header row (on by default). */
  header?: boolean
  /** Text for the cells, row by row. */
  cells?: string[][]
  /** Column widths in CSS pixels. */
  widths?: number[]
}

export function tableNode(spec: TableSpec, schema: Schema = docsSchema()): PMNode {
  const rows = Math.max(1, Math.min(200, Math.round(spec.rows)))
  const cols = Math.max(1, Math.min(40, Math.round(spec.cols)))
  const header = spec.header !== false

  return schema.nodes.table.create(
    null,
    Array.from({ length: rows }, (_, row) =>
      schema.nodes.tableRow.create(
        null,
        Array.from({ length: cols }, (_, col) => {
          const text = spec.cells?.[row]?.[col] ?? ''
          const width = spec.widths?.[col]

          return (header && row === 0 ? schema.nodes.tableHeader : schema.nodes.tableCell).create(width ? { colwidth: [width] } : null, schema.nodes.paragraph.create(null, text ? schema.text(text) : null))
        })
      )
    )
  )
}

/** The width a page gives text, in CSS pixels. */
export function textWidthOf(doc: PMNode): number {
  const page = pageOf({ type: 'doc', attrs: doc.attrs })

  return Math.round(((page.width - page.margins.left - page.margins.right) * 96) / 72)
}

/** A table: on the page itself its columns share the text's width, as in Word; in a list or a box they fit what is there. */
export function insertTable(spec: TableSpec, place: Place = 'end'): Op {
  return (state) => {
    const range = placeRange(state, place)
    const topLevel = state.doc.resolve(range.from).depth <= 1
    const cols = Math.max(1, Math.min(40, Math.round(spec.cols)))
    const widths = spec.widths ?? (topLevel ? Array.from({ length: cols }, () => Math.floor(textWidthOf(state.doc) / cols)) : undefined)
    const tr = insertBlocks(state.tr, range, [tableNode({ ...spec, widths }, state.schema)], place)

    return tr.docChanged ? tr : null
  }
}

export interface ImageSpec {
  src: string
  alt?: string
  title?: string
  width?: number
  height?: number
}

/** A picture: in the line of text at a caret, or in a paragraph of its own between blocks. */
export function insertImage(spec: ImageSpec, place: Place = 'end'): Op {
  return (state) => {
    const image = state.schema.nodes.image.create({ src: spec.src, alt: spec.alt ?? null, title: spec.title ?? null, width: spec.width ?? null, height: spec.height ?? null })
    const range = placeRange(state, place)
    const tr = state.tr

    if (range.inline) {
      tr.replaceRangeWith(range.from, range.to, image)
    } else {
      insertBlocks(tr, range, [state.schema.nodes.paragraph.create(null, image)], place)
    }

    return tr
  }
}

export type ImageChange = Partial<Record<'alt' | 'title', string | null> & Record<'width' | 'height', number | null>>

/** Change the picture at `pos`: its description, title or size. A selected picture stays selected. */
export function setImageAttrs(pos: number, change: ImageChange): Op {
  return (state) => {
    const node = state.doc.nodeAt(pos)

    if (node?.type.name !== 'image') {
      return null
    }

    const tr = state.tr

    // Attribute steps, because replacing the picture with a changed copy would drop its selection.
    for (const [name, value] of Object.entries(change)) {
      if (value !== undefined && node.attrs[name] !== value) {
        tr.setNodeAttribute(pos, name, value)
      }
    }

    return tr.docChanged ? tr : null
  }
}

export interface ListSpec {
  items: string[]
  kind?: 'bullet' | 'ordered' | 'task'
  /** For a checklist: which items are done. */
  checked?: boolean[]
  start?: number
}

export function listNode(spec: ListSpec, schema: Schema = docsSchema()): PMNode {
  const kind = spec.kind ?? 'bullet'
  const item = kind === 'task' ? schema.nodes.taskItem : schema.nodes.listItem
  const list = kind === 'task' ? schema.nodes.taskList : kind === 'ordered' ? schema.nodes.orderedList : schema.nodes.bulletList
  const items = (spec.items.length ? spec.items : ['']).map((text, index) => item.create(kind === 'task' ? { checked: Boolean(spec.checked?.[index]) } : null, schema.nodes.paragraph.create(null, text ? schema.text(text) : null)))

  return list.create(kind === 'ordered' && spec.start && spec.start !== 1 ? { start: spec.start } : null, items)
}

export const insertList = (spec: ListSpec, place: Place = 'end'): Op => insertNodes((schema) => [listNode(spec, schema)], place)

export const insertPageBreak = (place: Place = 'selection'): Op => insertNodes((schema) => [schema.nodes.pageBreak.create()], place)

/** Blocks between blocks: at a caret in a paragraph, the paragraph is split around them. */
function insertNodes(build: (schema: Schema) => PMNode[], place: Place): Op {
  return (state) => {
    const tr = insertBlocks(state.tr, placeRange(state, place), build(state.schema), place)

    return tr.docChanged ? tr : null
  }
}

// The page.

export interface PageChange {
  size?: PageSizeName
  orientation?: 'portrait' | 'landscape'
  /** Margins in points, all of them or each side. */
  margins?: number | Partial<PageSettings['margins']>
}

export function setPage(change: PageChange): Op {
  return (state) => {
    const current = (state.doc.attrs.page as PageSettings | null) ?? defaultPage()
    const named = change.size ? PAGE_SIZES[change.size] : null
    const [short, long] = named ? [named.width, named.height] : [Math.min(current.width, current.height), Math.max(current.width, current.height)]
    const landscape = change.orientation ? change.orientation === 'landscape' : current.width > current.height
    const margins = typeof change.margins === 'number' ? { top: change.margins, right: change.margins, bottom: change.margins, left: change.margins } : { ...current.margins, ...change.margins }
    const page: PageSettings = { width: landscape ? long : short, height: landscape ? short : long, margins }

    return JSON.stringify(page) === JSON.stringify(current) && state.doc.attrs.page ? null : state.tr.setDocAttribute('page', page)
  }
}
