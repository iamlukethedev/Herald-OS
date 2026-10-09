import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import { markdownFromDocument } from '../../../../shared/office/doc-text.ts'
import { type DocJSON, type DocNode, pageOf, PAGE_SIZES, type PageMargins, type PageSizeName } from '../../../../shared/office/document.ts'
import { parseJsonArg } from '../agent-model.ts'
import { type BlockStyle, BLOCK_STYLES, counts, documentText, findHeading, findText, jsonOf, type MarkChange, type Op, outline, type PageChange, type Place, type SearchOptions, sectionOf, type Target } from './model.ts'

/*
 * Herald Docs for Hermes, without a window: where a command's content goes and what it changes,
 * read from its arguments; a document read the way Hermes wants it; and the batch of edits that
 * lands as one step. Tested directly.
 */

type Args = Record<string, unknown>

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '')

/** A heading as a command names it: its text, or its place in the outline counted from 1. */
export function headingRef(value: unknown): string | number {
  const given = text(value)

  if (!given) {
    throw new Error('Say which heading: its text, or its number in the outline (1 is the first)')
  }

  return /^\d+$/.test(given) ? Math.max(0, Number(given) - 1) : given
}

export type WhereKind = 'end' | 'start' | 'selection' | 'marked' | 'after' | 'heading'

const WHERE: readonly WhereKind[] = ['end', 'start', 'selection', 'marked', 'after', 'heading']

/** What `at` says, with a heading given alone meaning its section. */
export function whereOf(args: Args, fallback: WhereKind = 'end'): WhereKind {
  const at = text(args.at).toLowerCase()

  if (!at) {
    return args.heading !== undefined && args.heading !== '' ? 'heading' : fallback
  }

  const found = WHERE.find((kind) => kind === at) ?? (at === 'cursor' || at === 'caret' ? 'selection' : at === 'top' ? 'start' : at === 'bottom' ? 'end' : undefined)

  if (!found) {
    throw new Error(`at is one of ${WHERE.join(', ')}, not “${at}”`)
  }

  return found
}

export interface Marked {
  from: number
  to: number
}

/**
 * Where a write's content goes in a document, from `at`, `heading` and `mode`; `marked` is the text
 * Herald marked for the request, which `after` goes under too while there is one, since the person
 * may have clicked elsewhere since asking.
 */
export function placeFor(state: EditorState | null, args: Args, marked: Marked | null): Place {
  const where = whereOf(args)

  if (where === 'end' || where === 'start') {
    return where
  }

  if (where === 'heading') {
    const mode = text(args.mode).toLowerCase() || 'append'

    if (!['append', 'prepend', 'replace'].includes(mode)) {
      throw new Error(`mode is append, prepend or replace, not “${mode}”`)
    }

    return { heading: headingRef(args.heading), mode: mode as 'append' | 'prepend' | 'replace' }
  }

  if (!state) {
    throw new Error(`at=${where} needs the document open in Herald Docs, where it has a selection: open it first (docs.open)`)
  }

  const range = where === 'marked' || (where === 'after' && marked) ? marked : { from: state.selection.from, to: state.selection.to }

  if (!range) {
    throw new Error('Nothing is marked for Hermes in this document: use at=selection, a heading, or end')
  }

  if (where === 'after') {
    // After the blocks the text is in: a summary or a note goes under the paragraph, not inside it.
    const $to = state.doc.resolve(range.to)

    return { pos: $to.depth > 0 ? $to.after(1) : range.to }
  }

  return where === 'marked' ? { from: range.from, to: range.to } : 'selection'
}

/** What a format change applies to: the selection (the default), the marked text, everything, a heading or its section, or matches of some text. */
export function targetFor(state: EditorState | null, args: Args, marked: Marked | null): Target {
  const at = text(args.at).toLowerCase() || (args.text !== undefined && args.text !== '' ? 'text' : args.heading !== undefined && args.heading !== '' ? 'section' : 'selection')

  if (at === 'all') {
    return 'all'
  }

  if (at === 'heading' || at === 'section') {
    return { heading: headingRef(args.heading), part: at === 'heading' ? 'heading' : 'all' }
  }

  if (at === 'text') {
    const find = text(args.text)

    if (!find) {
      throw new Error('at=text needs text: the words to change, every place they appear')
    }

    return { text: find, all: true, options: searchOptions(args) }
  }

  if (at !== 'selection' && at !== 'marked') {
    throw new Error(`at is one of selection, marked, all, heading, section or text, not “${at}”`)
  }

  if (!state) {
    throw new Error(`at=${at} needs the document open in Herald Docs: open it first (docs.open), or say which text, heading or all`)
  }

  if (at === 'marked') {
    if (!marked) {
      throw new Error('Nothing is marked for Hermes in this document')
    }

    return { from: marked.from, to: marked.to }
  }

  return 'selection'
}

export function searchOptions(args: Args): SearchOptions {
  return { caseSensitive: args.caseSensitive === true, wholeWord: args.wholeWord === true, regex: args.regex === true }
}

const STYLE_NAMES: Record<string, BlockStyle> = Object.fromEntries([
  ...BLOCK_STYLES.map((style) => [style.id.toLowerCase(), style.id]),
  ...BLOCK_STYLES.map((style) => [style.label.toLowerCase(), style.id]),
  ...[4, 5, 6].flatMap((level) => [[`heading${level}`, `heading${level}`], [`heading ${level}`, `heading${level}`]]),
  ['h1', 'heading1'],
  ['h2', 'heading2'],
  ['h3', 'heading3'],
  ['paragraph', 'normal'],
  ['body', 'normal']
])

/** A paragraph style by its id or label ("heading2", "Heading 2", "h2", "quote"). */
export function styleOf(value: unknown): BlockStyle {
  const name = text(value).toLowerCase()
  const style = STYLE_NAMES[name]

  if (!style) {
    throw new Error(`style is normal, title, subtitle, heading1 to heading6, quote or code, not “${name}”`)
  }

  return style
}

const off = (value: unknown): boolean => value === null || (typeof value === 'string' && /^(none|off|clear|remove|no)$/i.test(value.trim()))

/** The formatting a command asks for; "none" takes a colour, highlight, font, size or link away. Sizes are in points. */
export function markChangeOf(args: Args): MarkChange {
  const change: MarkChange = {}

  for (const name of ['bold', 'italic', 'underline', 'strike', 'superscript', 'subscript'] as const) {
    if (typeof args[name] === 'boolean') {
      change[name] = args[name] as boolean
    }
  }

  if (typeof args.code === 'boolean') {
    change.code = args.code
  }

  for (const [arg, name] of [['color', 'color'], ['highlight', 'highlight'], ['font', 'fontFamily'], ['link', 'link']] as const) {
    if (args[arg] !== undefined && args[arg] !== '') {
      change[name] = off(args[arg]) ? null : text(args[arg])
    }
  }

  if (args.size !== undefined && args.size !== '') {
    const size = Number(args.size)

    if (off(args.size) || size === 0) {
      change.fontSize = null
    } else if (!Number.isFinite(size) || size < 1 || size > 400) {
      throw new Error('size is in points, from 1 to 400')
    } else {
      change.fontSize = size
    }
  }

  return change
}

export const ALIGNMENTS = ['left', 'center', 'right', 'justify'] as const

export function alignmentOf(value: unknown): (typeof ALIGNMENTS)[number] {
  const align = text(value).toLowerCase().replace('centre', 'center')
  const found = ALIGNMENTS.find((entry) => entry === align)

  if (!found) {
    throw new Error(`align is left, center, right or justify, not “${align}”`)
  }

  return found
}

/** Rows of cell text from a list of lists (or JSON text of one); numbers and booleans become their text. */
export function cellsOf(value: unknown): string[][] {
  const parsed = parseJsonArg(value, 'cells')

  if (!Array.isArray(parsed) || !parsed.length || !parsed.every(Array.isArray)) {
    throw new Error('Give the cells as rows: [["Item", "Cost"], ["Rent", "1200"]]')
  }

  return (parsed as unknown[][]).map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))))
}

export const READ_PARTS = ['markdown', 'text', 'outline', 'selection', 'comments', 'notes', 'headers', 'sections', 'tocs'] as const

export interface ReadOptions {
  part: (typeof READ_PARTS)[number]
  heading?: string | number
  maxChars: number
}

const PART_NAMES: Record<string, ReadOptions['part']> = { footnotes: 'notes', endnotes: 'notes', footers: 'headers', 'headers and footers': 'headers', contents: 'tocs', toc: 'tocs', 'tables of contents': 'tocs' }

export function readOptions(args: Args): ReadOptions {
  const asked = text(args.part).toLowerCase() || 'markdown'
  const part = READ_PARTS.find((name) => name === asked) ?? PART_NAMES[asked]

  if (!part) {
    throw new Error(`part is ${READ_PARTS.slice(0, -1).join(', ')} or ${READ_PARTS[READ_PARTS.length - 1]}, not “${asked}”`)
  }

  const max = args.maxChars === undefined || args.maxChars === '' ? 20000 : Math.round(Number(args.maxChars))

  return { part, heading: args.heading === undefined || args.heading === '' ? undefined : headingRef(args.heading), maxChars: Number.isFinite(max) ? Math.max(200, Math.min(200000, max)) : 20000 }
}

/** The blocks a heading's section holds, the heading first, as a document of their own. */
export function sectionDocument(doc: PMNode, heading: string | number): DocJSON {
  const entry = findHeading(doc, heading)

  if (!entry) {
    throw new Error(typeof heading === 'number' ? `The document has no heading number ${heading + 1}` : `The document has no heading “${heading}”`)
  }

  const section = sectionOf(doc, entry)
  const content = doc.slice(entry.from, section.to).content.toJSON() as DocNode[] | null

  return { type: 'doc', attrs: doc.attrs, content: content ?? [] } as DocJSON
}

export interface DocumentReading {
  outline: { level: number; text: string }[]
  words: number
  characters: number
  page: { width: number; height: number; orientation: 'portrait' | 'landscape' }
  content?: string
  truncated?: boolean
}

/** A document as Hermes reads it: its outline and counts, and its content as Markdown or text (a section of it with `heading`). */
export function readDocument(doc: PMNode, options: ReadOptions): DocumentReading {
  const page = pageOf({ type: 'doc', attrs: doc.attrs })
  const reading: DocumentReading = {
    outline: outline(doc).map((entry) => ({ level: entry.level, text: entry.text })),
    ...counts(doc),
    page: { width: page.width, height: page.height, orientation: page.width > page.height ? 'landscape' : 'portrait' }
  }

  if (options.part !== 'markdown' && options.part !== 'text') {
    return reading
  }

  const json = options.heading === undefined ? jsonOf(doc) : sectionDocument(doc, options.heading)
  const full = options.part === 'markdown' ? markdownFromDocument(json).text : documentText(doc.type.schema.nodeFromJSON(json))

  return full.length > options.maxChars ? { ...reading, content: full.slice(0, options.maxChars), truncated: true } : { ...reading, content: full }
}

/** Each match of `query` with the words around it, at most `limit` of them. */
export function findWithContext(doc: PMNode, query: string, options: SearchOptions, limit = 50): { count: number; matches: { text: string; context: string; heading?: string }[] } {
  const matches = findText(doc, query, options)
  const headings = outline(doc)

  return {
    count: matches.length,
    matches: matches.slice(0, limit).map((match) => {
      const before = doc.textBetween(Math.max(0, match.from - 60), match.from, ' ', ' ')
      const after = doc.textBetween(match.to, Math.min(doc.content.size, match.to + 60), ' ', ' ')
      const heading = [...headings].reverse().find((entry) => entry.from < match.from)

      return { text: match.text, context: `${before}[${match.text}]${after}`.replace(/\s+/g, ' ').trim(), ...(heading ? { heading: heading.text } : {}) }
    })
  }
}

/** Operations built one after another, each on the document as the ones before left it, as one transaction: one step to undo. */
export function chainBuilt(builders: readonly ((state: EditorState) => Op)[]): Op {
  return (state) => {
    const tr = state.tr
    let current = state

    for (const build of builders) {
      const step = build(current)(current)

      if (!step || !step.steps.length) {
        continue
      }

      step.steps.forEach((entry) => tr.step(entry))
      current = current.apply(step)
    }

    return tr.steps.length ? tr : null
  }
}

export const chain = (ops: readonly Op[]): Op => chainBuilt(ops.map((op) => () => op))

/** A batch's ops; one named after a command (`docs.<op>`) makes that command's change, and asks as it does. */
export const EDIT_OPS = [
  'write',
  'replace',
  'format',
  'table',
  'image',
  'pageBreak',
  'page',
  'setPage',
  'setHeader',
  'setFooter',
  'clearHeader',
  'clearFooter',
  'setHeaderOptions',
  'insertField',
  'insertNote',
  'setNote',
  'removeNote',
  'insertSectionBreak',
  'removeSectionBreak',
  'addComment',
  'addComments',
  'replyToComment',
  'editComment',
  'resolveComment',
  'deleteComment',
  'insertToc',
  'setToc',
  'updateTocs',
  'removeToc'
] as const

export type EditOp = (typeof EDIT_OPS)[number]

/** The edits of a batch: a list of objects, each with an `op` and that op's arguments. */
export function editsOf(value: unknown): (Args & { op: EditOp })[] {
  const parsed = parseJsonArg(value, 'edits')

  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error('edits is a list: [{"op": "write", "content": "## Summary", "at": "end"}, {"op": "replace", "find": "draft", "replacement": "final"}]')
  }

  if (parsed.length > 100) {
    throw new Error('At most 100 edits in one batch')
  }

  return parsed.map((edit, index) => {
    const op = edit && typeof edit === 'object' ? text((edit as Args).op) : ''
    const found = EDIT_OPS.find((name) => name.toLowerCase() === op.toLowerCase())

    if (!found) {
      throw new Error(`Edit ${index + 1}: op is one of ${EDIT_OPS.join(', ')}, not “${op}”`)
    }

    return { ...(edit as Args), op: found }
  })
}

/** A page change as a command gives it: all four margins as a number, or some of them and the header and footer distances. */
export type PageArgs = PageChange

/** A length in points from points, inches ("1in"), centimetres ("2cm") or millimetres ("20mm"). */
function pointsOf(value: string): number {
  const raw = value.toLowerCase().replace(/\s+/g, '')
  const number = Number.parseFloat(raw)

  return raw.endsWith('in') ? number * 72 : raw.endsWith('mm') ? (number * 72) / 25.4 : raw.endsWith('cm') ? (number * 72) / 2.54 : number
}

const CUSTOM_SIZE = /^(\d+(?:\.\d+)?)\s*(in|mm|cm|pt)?\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(in|mm|cm|pt)?$/i

const MARGIN_ARGS = [
  ['top', 'top'],
  ['right', 'right'],
  ['bottom', 'bottom'],
  ['left', 'left'],
  ['headerDistance', 'header'],
  ['footerDistance', 'footer']
] as const

function marginOf(value: unknown, name: string): number {
  const points = pointsOf(text(value))

  if (!Number.isFinite(points) || points < 0 || points > 288) {
    throw new Error(`${name} ${name === 'margins' ? 'are' : 'is'} points from 0 to 288 (or "1in", "20mm")`)
  }

  return Math.round(points * 10) / 10
}

/**
 * Page size (a named one, or width by height: "8.5x11in", "210 x 297 mm"), orientation, all four
 * margins, each margin (top, right, bottom, left) and the header and footer distances from the
 * edges (headerDistance, footerDistance), in points or as "1in", "2cm", "20mm".
 */
export function pageArgsOf(args: Args): PageArgs {
  const out: PageArgs = {}
  const size = text(args.size)

  if (size) {
    const name = (Object.keys(PAGE_SIZES) as PageSizeName[]).find((entry) => entry.toLowerCase() === size.toLowerCase())
    const custom = CUSTOM_SIZE.exec(size)

    if (name) {
      out.size = name
    } else if (custom) {
      const width = pointsOf(`${custom[1]}${custom[2] ?? custom[4] ?? ''}`)
      const height = pointsOf(`${custom[3]}${custom[4] ?? custom[2] ?? ''}`)
      out.size = { width: Math.round(width * 10) / 10, height: Math.round(height * 10) / 10 }
    } else {
      throw new Error(`size is one of ${Object.keys(PAGE_SIZES).join(', ')}, or width by height ("8.5x11in", "210x297mm"), not “${size}”`)
    }
  }

  const orientation = text(args.orientation).toLowerCase()

  if (orientation) {
    if (orientation !== 'portrait' && orientation !== 'landscape') {
      throw new Error('orientation is portrait or landscape')
    }

    out.orientation = orientation
  }

  const all = args.margins !== undefined && args.margins !== '' ? marginOf(args.margins, 'margins') : undefined
  const sides: Partial<PageMargins> = {}

  for (const [arg, side] of MARGIN_ARGS) {
    if (args[arg] !== undefined && args[arg] !== '') {
      sides[side] = marginOf(args[arg], arg)
    }
  }

  if (Object.keys(sides).length) {
    out.margins = { ...(all === undefined ? {} : { top: all, right: all, bottom: all, left: all }), ...sides }
  } else if (all !== undefined) {
    out.margins = all
  }

  return out
}