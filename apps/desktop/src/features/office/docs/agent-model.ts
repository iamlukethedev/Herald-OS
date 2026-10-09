import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import { markdownFromDocument } from '../../../../shared/office/doc-text.ts'
import { type DocJSON, type DocNode, pageOf, PAGE_SIZES, type PageSizeName } from '../../../../shared/office/document.ts'
import { parseJsonArg } from '../agent-model.ts'
import { type BlockStyle, BLOCK_STYLES, counts, documentText, findHeading, findText, jsonOf, type MarkChange, type Op, outline, type Place, type SearchOptions, sectionOf, type Target } from './model.ts'

/*
 * Herald Docs for Hermes, without a window: where a command's content goes and what it changes,
 * read from its arguments; a document read the way Hermes wants it; the batch of edits that lands
 * as one step; and the templates a new document starts from. Tested directly.
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

/** Where a write's content goes in a document, from `at`, `heading` and `mode`; `marked` is the text Herald marked for the request. */
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

  const range = where === 'marked' ? marked : { from: state.selection.from, to: state.selection.to }

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

export interface ReadOptions {
  part: 'markdown' | 'text' | 'outline' | 'selection'
  heading?: string | number
  maxChars: number
}

export function readOptions(args: Args): ReadOptions {
  const part = text(args.part).toLowerCase() || 'markdown'

  if (!['markdown', 'text', 'outline', 'selection'].includes(part)) {
    throw new Error(`part is markdown, text, outline or selection, not “${part}”`)
  }

  const max = args.maxChars === undefined || args.maxChars === '' ? 20000 : Math.round(Number(args.maxChars))

  return { part: part as ReadOptions['part'], heading: args.heading === undefined || args.heading === '' ? undefined : headingRef(args.heading), maxChars: Number.isFinite(max) ? Math.max(200, Math.min(200000, max)) : 20000 }
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

  if (options.part === 'outline' || options.part === 'selection') {
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

export const EDIT_OPS = ['write', 'replace', 'format', 'table', 'image', 'pageBreak', 'page'] as const

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

export interface PageArgs {
  size?: PageSizeName
  orientation?: 'portrait' | 'landscape'
  margins?: number
}

/** Page size, orientation and margins (points, or inches as "1in", or millimetres as "20mm"). */
export function pageArgsOf(args: Args): PageArgs {
  const out: PageArgs = {}
  const size = text(args.size)

  if (size) {
    const name = (Object.keys(PAGE_SIZES) as PageSizeName[]).find((entry) => entry.toLowerCase() === size.toLowerCase())

    if (!name) {
      throw new Error(`size is one of ${Object.keys(PAGE_SIZES).join(', ')}, not “${size}”`)
    }

    out.size = name
  }

  const orientation = text(args.orientation).toLowerCase()

  if (orientation) {
    if (orientation !== 'portrait' && orientation !== 'landscape') {
      throw new Error('orientation is portrait or landscape')
    }

    out.orientation = orientation
  }

  if (args.margins !== undefined && args.margins !== '') {
    const raw = text(args.margins).toLowerCase()
    const number = Number.parseFloat(raw)
    const points = raw.endsWith('in') ? number * 72 : raw.endsWith('mm') ? (number * 72) / 25.4 : raw.endsWith('cm') ? (number * 72) / 2.54 : number

    if (!Number.isFinite(points) || points < 0 || points > 288) {
      throw new Error('margins are points from 0 to 288 (or "1in", "20mm")')
    }

    out.margins = Math.round(points * 10) / 10
  }

  return out
}

/** Markdown each template starts a document with; the person, or Hermes, fills it in. */
export const TEMPLATES: Record<string, { label: string; markdown: string }> = {
  letter: {
    label: 'Letter',
    markdown: '[Your name]  \n[Street, city]  \n[Email · phone]\n\n[Date]\n\n[Recipient name]  \n[Organisation]  \n[Street, city]\n\nDear [name],\n\n[Why you are writing, in a sentence or two.]\n\n[The details.]\n\n[What you would like to happen next.]\n\nKind regards,\n\n[Your name]\n'
  },
  'cover letter': {
    label: 'Cover letter',
    markdown: '[Your name]  \n[Email · phone · city]\n\n[Date]\n\nDear [hiring manager],\n\nI am applying for the [role] position at [company]. [One line on why this role.]\n\n[What you have done that matters for this role, with a result.]\n\n[Why this company, and what you would bring in the first months.]\n\nThank you for your time. I would welcome the chance to talk.\n\nSincerely,\n\n[Your name]\n'
  },
  report: {
    label: 'Report',
    markdown: '# [Report title]\n\n[Author] · [Date]\n\n## Summary\n\n[The findings and the recommendation, in a paragraph.]\n\n## Background\n\n[Why this report, and what it covers.]\n\n## Findings\n\n[What was found, with the evidence.]\n\n## Recommendations\n\n- [First recommendation]\n- [Second recommendation]\n\n## Next steps\n\n[Who does what, by when.]\n'
  },
  memo: {
    label: 'Memo',
    markdown: '# Memo\n\n**To:** [names]  \n**From:** [name]  \n**Date:** [date]  \n**Subject:** [subject]\n\n[The point of the memo, first.]\n\n[The details and the reasons.]\n\n[What you need from the readers, and by when.]\n'
  },
  'meeting notes': {
    label: 'Meeting notes',
    markdown: '# [Meeting] notes\n\n**Date:** [date]  \n**Attendees:** [names]\n\n## Agenda\n\n1. [Item]\n2. [Item]\n\n## Decisions\n\n- [Decision]\n\n## Action items\n\n- [ ] [Task] ([owner], [due date])\n'
  },
  resume: {
    label: 'Résumé',
    markdown: '# [Your name]\n\n[City] · [email] · [phone] · [website]\n\n## Profile\n\n[Two lines on who you are and what you are good at.]\n\n## Experience\n\n### [Role], [Company]\n\n[Start] – [End]\n\n- [What you did, with a result]\n- [What you did, with a result]\n\n## Education\n\n### [Degree], [School]\n\n[Year]\n\n## Skills\n\n[Skill], [skill], [skill]\n'
  },
  proposal: {
    label: 'Proposal',
    markdown: '# [Proposal title]\n\nPrepared for [client] by [name] · [date]\n\n## The problem\n\n[What the client needs, in their words.]\n\n## What we propose\n\n[The approach.]\n\n## Timeline\n\n| Phase | What happens | When |\n| --- | --- | --- |\n| 1 | [Work] | [Dates] |\n| 2 | [Work] | [Dates] |\n\n## Cost\n\n[The price and what it includes.]\n\n## Next steps\n\n[How to go ahead.]\n'
  },
  essay: {
    label: 'Essay',
    markdown: '# [Title]\n\n[Opening: the question and your answer to it.]\n\n## [First point]\n\n[The argument and the evidence.]\n\n## [Second point]\n\n[The argument and the evidence.]\n\n## Conclusion\n\n[What it adds up to.]\n'
  }
}

const TEMPLATE_ALIASES: Record<string, string> = { cv: 'resume', résumé: 'resume', notes: 'meeting notes', minutes: 'meeting notes', 'meeting minutes': 'meeting notes', coverletter: 'cover letter', 'cover-letter': 'cover letter', 'meeting-notes': 'meeting notes' }

/** A template by its name, any case ("Cover letter", "cv", "minutes"). */
export function templateOf(value: unknown): { id: string; label: string; markdown: string } {
  const name = text(value).toLowerCase()
  const id = TEMPLATES[name] ? name : TEMPLATE_ALIASES[name]

  if (!id || !TEMPLATES[id]) {
    throw new Error(`template is one of ${Object.keys(TEMPLATES).join(', ')}, not “${name}”`)
  }

  return { id, ...TEMPLATES[id] }
}
