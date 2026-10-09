import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { blankDocument, commentsOf, DEFAULT_HEADER_DISTANCE, type DocJSON, type DocNode, type HeaderKind, type NoteKind, pageOf, type PageSettings, pageSizeName, PAGE_SIZES, type PageSizeName, type SectionKind, tocEntries } from '../../../../shared/office/document.ts'
import type { CommandContext } from '../../../store/os-commands.ts'
import type { Outcome } from '../agent.ts'
import { parseJsonArg } from '../agent-model.ts'
import { alignmentOf, chain, headingRef, type Marked, pageArgsOf, placeFor, sectionDocument } from './agent-model.ts'
import {
  addComments,
  changedPage,
  clearHeaderFooter,
  type CommentInfo,
  commentRange,
  comments,
  type CommentSpec,
  deleteAllComments,
  deleteComment,
  documentSections,
  editComment,
  type FieldChoice,
  fieldFormat,
  fieldNodes,
  findHeading,
  findText,
  headerFooterText,
  type HeaderOptions,
  headingsOf,
  insertField,
  insertNodes,
  insertNote,
  insertSectionBreak,
  insertTableOfContents,
  jsonOf,
  type NoteInfo,
  type NoteRef,
  notes,
  type Op,
  outline,
  type OutlineEntry,
  type PagePart,
  type Place,
  placeRange,
  type Range,
  removeNote,
  replyToComment,
  type SectionInfo,
  sectionOf,
  setCommentResolved,
  setHeaderFooter,
  setHeaderOptions,
  setNote,
  setPage,
  setSectionPage,
  setTableOfContents,
  updateTablesOfContents
} from './model.ts'
import { type DocumentStatistics, documentStatistics, durationLabel } from './statistics.ts'
import { documentFromTemplate, TEMPLATES, type TemplateInfo } from './templates/index.ts'
import type { SavedTemplate } from './templates/saved.ts'

/*
 * Herald Docs' page and review for Hermes, without a window: headers and footers, fields, notes,
 * sections and the page, comments, tables of contents, templates and statistics. Each command's
 * change is read from its arguments and built on the document as it is when it lands, with the
 * answer it gives after; agent-depth.ts runs them where the document lives. Tested directly.
 */

type Args = Record<string, unknown>

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '')

const given = (value: unknown): boolean => text(value) !== ''

const asked = (value: unknown): boolean => value !== undefined && value !== null && value !== ''

/** A yes or no as a command's arguments give it, or as an edit's JSON says it ("true", "no"). */
export function flag(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value
  }

  const word = text(value).toLowerCase()

  return /^(true|yes|on|1)$/.test(word) ? true : /^(false|no|off|0)$/.test(word) ? false : fallback
}

const many = (count: number, one: string, more = `${one}s`): string => `${count.toLocaleString('en-US')} ${count === 1 ? one : more}`

const capital = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1)

const lower = (value: string): string => value.charAt(0).toLowerCase() + value.slice(1)

/** Words in an answer, on one line and cut at `max` characters. */
function quoted(value: string, max = 60): string {
  const line = value.replace(/\s+/g, ' ').trim()

  return `“${line.length > max ? `${line.slice(0, max - 1)}…` : line}”`
}

/** "a, b and c". */
const listed = (items: readonly string[]): string => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? ''))

const isBlank = (blocks: readonly DocNode[]): boolean => blocks.every((block) => block.type === 'paragraph' && !block.content?.length)

// A command's change.

/** What a change came to in a document: whether it changed anything, the document's name and path, and whether text was marked for Hermes in it. */
export interface Changed {
  changed: boolean
  name: string
  path: string | null
  marked?: boolean
}

/**
 * A command's change: its operation, built on the document as it is when the change lands (with
 * the text Herald marked for Hermes, and whether it is open, where it has a selection), and the
 * answer it gives once it has landed.
 */
export interface Change {
  build: (state: EditorState, marked: Marked | null, live: boolean) => Op
  outcome: (result: Changed) => Outcome
}

/** An operation that shows `seen` the document it made, for the answer. */
function seeing(op: Op, seen: (doc: PMNode, tr: Transaction) => void): Op {
  return (state) => {
    const tr = op(state)

    if (tr && tr.steps.length) {
      seen(tr.doc, tr)
    }

    return tr
  }
}

/** More of the same transaction: `then`, run on the document `tr` made. */
function andThen(state: EditorState, tr: Transaction, then: (next: EditorState) => Transaction | null): Transaction {
  then(state.apply(tr))?.steps.forEach((step) => tr.step(step))

  return tr
}

/** Who comments and replies are by: Hermes when Hermes adds them, else the name the person gave Herald (the model's own choice). */
export const commentAuthor = (context?: Pick<CommandContext, 'source'>): string | undefined => (context?.source === 'agent' ? 'Hermes' : undefined)

// Places.

const LOOSE = /([\s\uFFFC]+)|(['‘’])|(["“”])|([-‐‑–—])|(\.\.\.|…)/g

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A pattern for `quote` that takes any spacing, straight or curly quotes, any dash and either ellipsis. */
function loosePattern(quote: string): string {
  let out = ''
  let last = 0

  for (const match of quote.matchAll(LOOSE)) {
    out += escaped(quote.slice(last, match.index))
    out += match[1] ? '[\\s\\uFFFC]+' : match[2] ? "['‘’]" : match[3] ? '["“”]' : match[4] ? '[-‐‑–—]' : '(?:\\.\\.\\.|…)'
    last = match.index + match[0].length
  }

  return out + escaped(quote.slice(last))
}

/** Where `quote` is in the document's text: as it is, else in any case, else with any spacing, quotes and dashes. */
export function quoteMatches(doc: PMNode, quote: string): Range[] {
  const wanted = quote.trim()

  if (!wanted) {
    return []
  }

  const exact = findText(doc, wanted, { caseSensitive: true })

  if (exact.length) {
    return exact
  }

  const anyCase = findText(doc, wanted)

  return anyCase.length ? anyCase : findText(doc, loosePattern(wanted), { regex: true })
}

const notQuoted = (quote: string): string => `${quoted(quote)} is not in the document: quote its words exactly, within one paragraph (docs.find finds them)`

function headingEntry(doc: PMNode, ref: string | number): OutlineEntry {
  const entry = findHeading(doc, ref)

  if (!entry) {
    throw new Error(`${typeof ref === 'number' ? `The document has no heading number ${ref + 1}` : `The document has no heading “${ref}”`} (docs.read part=outline lists them)`)
  }

  return entry
}

/**
 * Where a field, a note, a section break or a table of contents goes: right after `quote` (after
 * the paragraph it is in, for a `block`), right before a heading with mode=before, else where `at`,
 * `heading` and `mode` say, and at `fallback` when they say nothing.
 */
export function depthPlace(state: EditorState, args: Args, marked: Marked | null, live: boolean, options: { block?: boolean; fallback?: 'start' | 'end' } = {}): Place {
  if (given(args.quote)) {
    const match = quoteMatches(state.doc, text(args.quote))[0]

    if (!match) {
      throw new Error(notQuoted(text(args.quote)))
    }

    const $end = state.doc.resolve(match.to)

    return options.block && $end.depth > 0 ? { pos: $end.after(1) } : { pos: match.to }
  }

  if (given(args.heading) && text(args.mode).toLowerCase() === 'before') {
    return { pos: headingEntry(state.doc, headingRef(args.heading)).from }
  }

  return placeFor(live ? state : null, given(args.at) || given(args.heading) ? args : { ...args, at: options.fallback ?? 'end' }, marked)
}

const AT_WORDS: Record<string, string> = { start: 'at the start', top: 'at the start', end: 'at the end', bottom: 'at the end', selection: 'at the selection', cursor: 'at the selection', caret: 'at the selection', marked: 'in place of the marked text', after: 'under the selection’s paragraph' }

/** Where a command put something, in words; `marked` says text was marked for Hermes, which `after` went under. */
function placeWords(args: Args, options: { block?: boolean; fallback?: string; marked?: boolean } = {}): string {
  if (given(args.quote)) {
    return `${options.block ? 'after the paragraph with' : 'after'} ${quoted(text(args.quote), 40)}`
  }

  const at = text(args.at).toLowerCase()

  if (given(args.heading) && (!at || at === 'heading')) {
    const heading = /^\d+$/.test(text(args.heading)) ? `heading ${text(args.heading)}` : quoted(text(args.heading), 40)
    const mode = text(args.mode).toLowerCase()

    return mode === 'before' ? `before ${heading}` : mode === 'replace' ? `in place of what was under ${heading}` : mode === 'prepend' ? `under ${heading}` : `at the end of ${heading}`
  }

  return at === 'after' && options.marked ? 'under the marked text’s paragraph' : (AT_WORDS[at] ?? options.fallback ?? 'at the end')
}

// Headers and footers.

/** What a header, a footer or a note says: Markdown read in (pictures and all), or plain text. */
export type StoryContent = { blocks: DocNode[] } | { text: string }

const blankContent = (content: StoryContent): boolean => ('text' in content ? !content.text.trim() : isBlank(content.blocks))

const TOKEN = /\{(page|pages|date|time)(?::([^{}]+))?\}/g

/** A run of text with its `{page}`, `{pages}`, `{date}` and `{time}` as fields (`{date:d MMMM yyyy}` with a picture of its own), in the run's formatting. */
function withFields(node: DocNode): DocNode[] {
  if (node.type !== 'text') {
    return [node.content ? { ...node, content: node.content.flatMap(withFields) } : node]
  }

  const value = node.text ?? ''
  const marks = (node.marks ?? []).filter((mark) => mark.type !== 'link' && mark.type !== 'comment')
  const out: DocNode[] = []
  let last = 0

  for (const match of value.matchAll(TOKEN)) {
    const kind = match[1] as 'page' | 'pages' | 'date' | 'time'
    const format = kind === 'date' || kind === 'time' ? match[2]?.trim() || fieldFormat(kind) : null

    if (match.index > last) {
      out.push({ ...node, text: value.slice(last, match.index) })
    }

    out.push({ type: 'field', attrs: { kind, format, instruction: null, text: null }, ...(marks.length ? { marks } : {}) })
    last = match.index + match[0].length
  }

  if (last < value.length) {
    out.push(last ? { ...node, text: value.slice(last) } : node)
  }

  return out
}

const ALIGNED = new Set(['paragraph', 'heading'])

/** A header's or footer's content as blocks: fields for its tokens, and its lines aligned as asked. */
export function partBlocks(content: StoryContent, align: string | null = null): DocNode[] {
  const blocks: DocNode[] = 'text' in content ? content.text.split(/\r\n?|\n/).map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })) : content.blocks

  return blocks.flatMap(withFields).map((block) => (align && ALIGNED.has(block.type) ? { ...block, attrs: { ...block.attrs, textAlign: align === 'left' ? null : align } } : block))
}

const KIND_NAMES: Record<string, HeaderKind> = {
  default: 'default',
  all: 'default',
  every: 'default',
  'every page': 'default',
  'all pages': 'default',
  odd: 'default',
  'odd pages': 'default',
  primary: 'default',
  first: 'first',
  'first page': 'first',
  'title page': 'first',
  even: 'even',
  'even pages': 'even'
}

export function headerKindOf(value: unknown): HeaderKind {
  const name = text(value).toLowerCase().replace(/[\s_-]+/g, ' ')
  const kind = name ? KIND_NAMES[name] : 'default'

  if (!kind) {
    throw new Error(`kind is default (every page, or the odd pages when even pages have their own), first (the first page) or even (even pages), not “${text(value)}”`)
  }

  return kind
}

const partName = (part: PagePart, kind: HeaderKind): string => (kind === 'default' ? part : `${kind === 'first' ? 'first-page' : 'even-page'} ${part}`)

const CLEAR_COMMAND: Record<PagePart, string> = { header: 'docs.clearHeader', footer: 'docs.clearFooter' }

/** Put content in a header or footer; a first-page or even-page one turns on the option that shows it. */
export function setPartChange(part: PagePart, args: Args, content: StoryContent): Change {
  const kind = headerKindOf(args.kind)
  const blocks = partBlocks(content, given(args.align) ? alignmentOf(args.align) : null)

  if (blankContent(content) || isBlank(blocks)) {
    throw new Error(`Say what the ${part} says (content, in Markdown: {page} is the page number, {pages} the page count); ${CLEAR_COMMAND[part]} takes one away`)
  }

  const option: HeaderOptions | null = kind === 'first' ? { differentFirst: true } : kind === 'even' ? { differentOddEven: true } : null
  const seen = { shownOn: '', text: '', turnedOn: false }

  return {
    build: (state) => {
      const before = headerFooterText(state.doc)
      seen.turnedOn = (kind === 'first' && !before.differentFirst) || (kind === 'even' && !before.differentOddEven)

      return seeing(chain([setHeaderFooter(part, kind, { blocks }), ...(option ? [setHeaderOptions(option)] : [])]), (doc) => {
        const entry = headerFooterText(doc).parts.find((each) => each.part === part && each.kind === kind)
        seen.shownOn = entry?.shownOn ?? ''
        seen.text = entry?.text ?? ''
      })
    },
    outcome: ({ changed, name, path }) => ({
      summary: changed
        ? `Set the ${partName(part, kind)} of ${name}, on ${seen.shownOn}: ${quoted(seen.text, 80)}${seen.turnedOn ? ` (${kind === 'first' ? 'Different first page' : 'Different odd and even pages'} is on now)` : ''}`
        : `The ${partName(part, kind)} of ${name} already says that`,
      data: { name, path, changed, part, kind, ...(changed ? { shownOn: seen.shownOn, text: seen.text } : {}) }
    })
  }
}

/** Take a header or footer away: one kind, or every kind when `kind` is not given. */
export function clearPartChange(part: PagePart, args: Args): Change {
  const kind = given(args.kind) ? headerKindOf(args.kind) : undefined
  let had = 0

  return {
    build: (state) => {
      had = headerFooterText(state.doc).parts.filter((each) => each.part === part && (!kind || each.kind === kind)).length

      return clearHeaderFooter(part, kind)
    },
    outcome: ({ changed, name, path }) => ({
      summary: changed ? `Took ${kind ? `the ${partName(part, kind)}` : had > 1 ? `every ${part}` : `the ${part}`} away from ${name}` : `${name} has no ${kind ? partName(part, kind) : part}`,
      data: { name, path, changed, part, ...(kind ? { kind } : {}), removed: changed ? had : 0 }
    })
  }
}

const OPTION_WORDS: Record<keyof HeaderOptions, string> = { differentFirst: 'Different first page', differentOddEven: 'Different odd and even pages' }

/** Turn Different first page, or Different odd and even pages, on or off. */
export function headerOptionsChange(args: Args): Change {
  const options: HeaderOptions = {}

  for (const option of ['differentFirst', 'differentOddEven'] as const) {
    if (asked(args[option])) {
      options[option] = flag(args[option], true)
    }
  }

  if (!Object.keys(options).length) {
    throw new Error('Say which option: differentFirst (the first page shows a header and footer of its own) or differentOddEven (even pages show their own), true or false')
  }

  const words = listed(Object.entries(options).map(([option, on]) => `${OPTION_WORDS[option as keyof HeaderOptions]} ${on ? 'on' : 'off'}`))

  return {
    build: () => setHeaderOptions(options),
    outcome: ({ changed, name, path }) => ({ summary: changed ? `Turned ${words} in ${name}` : `${name} already has ${words}`, data: { name, path, changed, ...options } })
  }
}

// Fields.

const FIELD_NAMES: Record<string, FieldChoice> = {
  page: 'page',
  pagenumber: 'page',
  number: 'page',
  pageofpages: 'pageOfPages',
  pagexofy: 'pageOfPages',
  pages: 'pages',
  pagecount: 'pages',
  numpages: 'pages',
  numberofpages: 'pages',
  totalpages: 'pages',
  date: 'date',
  today: 'date',
  time: 'time',
  now: 'time'
}

export function fieldOf(value: unknown): FieldChoice {
  const found = FIELD_NAMES[text(value).toLowerCase().replace(/[^a-z]/g, '')]

  if (!found) {
    throw new Error(`field is page (the page number), pageOfPages (“Page 2 of 9”), pages (the page count), date or time${given(value) ? `, not “${text(value)}”` : ''}`)
  }

  return found
}

const FIELD_WORDS: Record<FieldChoice, string> = { page: 'the page number', pageOfPages: '“Page X of Y”', pages: 'the page count', date: 'the date', time: 'the time' }

/** A field in a line of text (after a quote, at the caret, in place of the marked text), or on a line of its own between blocks. */
export function insertFieldChange(args: Args): Change {
  const choice = fieldOf(args.field)
  const options = given(args.format) ? { format: text(args.format) } : {}

  return {
    build: (state, marked, live) => {
      const place = depthPlace(state, args, marked, live)

      return placeRange(state, place).inline ? insertField(choice, options, place) : insertNodes((schema) => [schema.nodes.paragraph.create(null, fieldNodes(choice, schema, options, []))], place)
    },
    outcome: ({ changed, name, path, marked }) => ({ summary: changed ? `Put ${FIELD_WORDS[choice]} in ${name}, ${placeWords(args, { marked })}` : `Nothing changed in ${name}`, data: { name, path, changed, field: choice } })
  }
}

// Notes.

export function noteKindOf(value: unknown): NoteKind {
  const kind = text(value).toLowerCase().replace(/s$/, '')

  if (!kind || kind === 'footnote' || kind === 'foot') {
    return 'footnote'
  }

  if (kind === 'endnote' || kind === 'end') {
    return 'endnote'
  }

  throw new Error(`kind is footnote (at the foot of its page, the default) or endnote (at the end of the document), not “${text(value)}”`)
}

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 }

function romanValue(letters: string): number {
  let total = 0

  for (let index = 0; index < letters.length; index++) {
    const value = ROMAN[letters[index]]
    total += value < (ROMAN[letters[index + 1]] ?? 0) ? -value : value
  }

  return total
}

/** A note as a command names it: its kind and number ("footnote 2", "endnote ii"), or its place among all the notes from 1 ("3"). */
export function noteRefOf(value: unknown, kind?: unknown): NoteRef {
  const ref = text(value).toLowerCase().replace(/\s+/g, ' ')
  const named = /^(footnote|endnote)s? ?(?:no\.? ?|#)?(\d+|[ivxlcdm]+)$/.exec(ref)

  if (named) {
    return { kind: named[1] as NoteKind, number: /^\d+$/.test(named[2]) ? Number(named[2]) : romanValue(named[2]) }
  }

  if (/^\d+$/.test(ref)) {
    return given(kind) ? { kind: noteKindOf(kind), number: Number(ref) } : Number(ref) - 1
  }

  throw new Error(
    ref
      ? `note is a note’s kind and number (footnote 2, endnote 1), or its place among the notes from 1, as docs.listNotes gives them; not “${text(value)}”`
      : 'Say which note (note: "footnote 2", "endnote 1", or its place among the notes from 1, as docs.listNotes gives them)'
  )
}

const noteName = (note: Pick<NoteInfo, 'kind' | 'number'>): string => `${note.kind} ${note.number}`

/** The note `ref` names, or an error that says which notes there are. */
function noteOf(doc: PMNode, ref: NoteRef): NoteInfo {
  const all = notes(doc)
  const found = typeof ref === 'number' ? all[ref] : 'pos' in ref ? all.find((note) => note.pos === ref.pos) : all.find((note) => note.kind === ref.kind && note.number === ref.number)

  if (!found) {
    const footnotes = all.filter((note) => note.kind === 'footnote').length
    const have = all.length ? `it has ${many(footnotes, 'footnote')} and ${many(all.length - footnotes, 'endnote')}` : 'it has none'

    throw new Error(`The document has no ${typeof ref === 'number' ? `note ${ref + 1}` : 'pos' in ref ? 'note there' : noteName(ref)} (${have}; docs.listNotes lists them)`)
  }

  return found
}

/** The words a note's reference follows in its paragraph. */
function wordsBefore(doc: PMNode, pos: number): string {
  const $pos = doc.resolve(pos)
  const before = $pos.parent.textBetween(Math.max(0, $pos.parentOffset - 80), $pos.parentOffset, ' ', ' ').replace(/\s+/g, ' ').trim()

  return $pos.parentOffset > 80 ? `…${before}` : before
}

/** A document's notes (those in a section, `within`), as Hermes names and reads them. */
export function notesList(doc: PMNode, within: Range | null = null) {
  return notes(doc)
    .filter((note) => !within || (note.pos >= within.from && note.pos < within.to))
    .map((note) => ({ note: noteName(note), kind: note.kind, number: note.number, label: note.label, text: note.text, after: wordsBefore(doc, note.pos) }))
}

/** A footnote or endnote, its reference after a quote, at the caret or at the end of the text at a place. */
export function insertNoteChange(args: Args, content: StoryContent): Change {
  const kind = noteKindOf(args.kind)

  if (blankContent(content)) {
    throw new Error(`Say what the ${kind} says (content, in Markdown)`)
  }

  let added: NoteInfo | null = null

  return {
    build: (state, marked, live) => {
      const before = notes(state.doc)

      return seeing(insertNote(kind, content, depthPlace(state, args, marked, live)), (doc, tr) => {
        const old = new Set(before.map((note) => tr.mapping.map(note.pos)))
        added = notes(doc).find((note) => !old.has(note.pos)) ?? null
      })
    },
    outcome: ({ changed, name, path, marked }) => ({
      summary: changed && added ? `Put ${noteName(added)} in ${name}, ${placeWords(args, { marked })}` : `Nothing changed in ${name}`,
      data: { name, path, changed, ...(changed && added ? { note: noteName(added), kind: added.kind, number: added.number, label: added.label } : {}) }
    })
  }
}

export function setNoteChange(args: Args, content: StoryContent): Change {
  const ref = noteRefOf(args.note, args.kind)

  if (blankContent(content)) {
    throw new Error('Say what the note says (content, in Markdown); docs.removeNote takes one away')
  }

  let note: NoteInfo | null = null

  return {
    build: (state) => {
      note = noteOf(state.doc, ref)

      return setNote(ref, content)
    },
    outcome: ({ changed, name, path }) => {
      const called = note ? noteName(note) : 'the note'

      return { summary: changed ? `Changed what ${called} says in ${name}` : `${capital(called)} of ${name} already says that`, data: { name, path, changed, note: called } }
    }
  }
}

/** Take a note out with its reference; the notes after it are numbered again. */
export function removeNoteChange(args: Args): Change {
  const ref = noteRefOf(args.note, args.kind)
  let note: NoteInfo | null = null

  return {
    build: (state) => {
      note = noteOf(state.doc, ref)

      return removeNote(ref)
    },
    outcome: ({ changed, name, path }) => ({
      summary: changed && note ? `Took ${noteName(note)} and its reference out of ${name}` : `Nothing changed in ${name}`,
      data: { name, path, changed, ...(note ? { note: noteName(note) } : {}) }
    })
  }
}

// Sections and the page.

const SECTION_NAMES: Record<string, SectionKind> = { nextpage: 'nextPage', newpage: 'nextPage', page: 'nextPage', next: 'nextPage', continuous: 'continuous', samepage: 'continuous', oddpage: 'oddPage', odd: 'oddPage', evenpage: 'evenPage', even: 'evenPage' }

export function sectionKindOf(value: unknown): SectionKind {
  const name = text(value).toLowerCase().replace(/[^a-z]/g, '')
  const kind = name ? SECTION_NAMES[name] : 'nextPage'

  if (!kind) {
    throw new Error(`kind is nextPage (the section starts on a new page, the default), continuous (on the same page), oddPage or evenPage, not “${text(value)}”`)
  }

  return kind
}

const STARTS: Record<SectionKind, string> = { nextPage: 'on a new page', continuous: 'on the same page', oddPage: 'on the next odd page', evenPage: 'on the next even page' }

const tenth = (value: number): number => Math.round(value * 10) / 10

export interface PageInfo {
  size: PageSizeName | 'custom'
  orientation: 'portrait' | 'landscape'
  width: number
  height: number
  margins: { top: number; right: number; bottom: number; left: number; header: number; footer: number }
}

/** A page as Hermes reads it, in points. */
export function pageInfo(page: PageSettings): PageInfo {
  const { margins } = page

  return {
    size: pageSizeName(page) ?? 'custom',
    orientation: page.width > page.height ? 'landscape' : 'portrait',
    width: tenth(page.width),
    height: tenth(page.height),
    margins: { top: tenth(margins.top), right: tenth(margins.right), bottom: tenth(margins.bottom), left: tenth(margins.left), header: tenth(margins.header ?? DEFAULT_HEADER_DISTANCE), footer: tenth(margins.footer ?? DEFAULT_HEADER_DISTANCE) }
  }
}

/** A page in a few words: "A4 portrait, margins 72 pt". */
export function pageWords(info: PageInfo): string {
  const size = info.size === 'custom' ? `${info.width} × ${info.height} pt` : PAGE_SIZES[info.size].label
  const { top, right, bottom, left } = info.margins
  const margins = top === right && top === bottom && top === left ? `margins ${top} pt` : `margins ${top}, ${right}, ${bottom} and ${left} pt (top, right, bottom, left)`

  return `${size} ${info.orientation}, ${margins}`
}

function firstWords(doc: PMNode, from: number, to: number): string {
  const words = doc.textBetween(from, Math.min(to, from + 400), ' ', ' ').replace(/\s+/g, ' ').trim()

  return words.length > 80 ? `${words.slice(0, 79)}…` : words
}

/** A document's sections as Hermes reads them: how each starts, its page and its first words. */
export function sectionsList(doc: PMNode) {
  return documentSections(doc).map((section) => ({
    section: section.index + 1,
    ...(section.index ? { kind: section.kind, starts: STARTS[section.kind] } : {}),
    page: pageInfo(section.page),
    text: firstWords(doc, section.from, section.to)
  }))
}

/** A section as a command names it ("2", "section 2"), from 0. */
function sectionNumberOf(value: unknown, orAll = false): number {
  const found = /^(?:section\s*)?(\d+)$/i.exec(text(value))

  if (!found || Number(found[1]) < 1) {
    throw new Error(`section is a section’s number from 1, as docs.listSections gives them${orAll ? ', or all' : ''}; not “${text(value)}”`)
  }

  return Number(found[1]) - 1
}

/** A section break where a place says, the new section on `size`, `orientation` and `margins` when they are given. */
export function insertSectionBreakChange(args: Args): Change {
  const kind = sectionKindOf(args.kind)
  const page = pageArgsOf({ size: args.size, orientation: args.orientation, margins: args.margins })
  let made: SectionInfo | null = null

  return {
    build: (state, marked, live) => {
      const place = depthPlace(state, args, marked, live, { block: true })

      return (current) => {
        const tr = insertSectionBreak(kind, place)(current)

        if (!tr) {
          return null
        }

        const old = new Set(documentSections(current.doc).flatMap((section) => (section.breakPos === null ? [] : [tr.mapping.map(section.breakPos)])))
        const index = documentSections(tr.doc).findIndex((section) => section.breakPos !== null && !old.has(section.breakPos))

        if (index > 0 && Object.keys(page).length) {
          andThen(current, tr, (next) => setSectionPage(index, page)(next))
        }

        made = documentSections(tr.doc)[index] ?? null

        return tr
      }
    },
    outcome: ({ changed, name, path, marked }) => ({
      summary: changed && made ? `Put a section break in ${name}, ${placeWords(args, { block: true, marked })}: section ${made.index + 1} starts ${STARTS[kind]}, ${pageWords(pageInfo(made.page))}` : `Nothing changed in ${name}`,
      data: { name, path, changed, ...(made ? { section: made.index + 1, kind, page: pageInfo(made.page) } : {}) }
    })
  }
}

const ENDS_IN_TEXT = new Set(['paragraph', 'heading', 'codeBlock', 'bulletList', 'orderedList', 'taskList'])

/** Take a block out (as more of `tr`), leaving an empty paragraph where it was alone, and the document ending where one can type. */
function removeBlock(state: EditorState, pos: number, tr: Transaction = state.tr): Transaction | null {
  const node = tr.doc.nodeAt(pos)

  if (!node) {
    return null
  }

  const paragraph = state.schema.nodes.paragraph

  if (tr.doc.resolve(pos).parent.childCount === 1) {
    tr.replaceWith(pos, pos + node.nodeSize, paragraph.create())
  } else {
    tr.delete(pos, pos + node.nodeSize)
  }

  if (tr.doc.lastChild && !ENDS_IN_TEXT.has(tr.doc.lastChild.type.name)) {
    tr.insert(tr.doc.content.size, paragraph.create())
  }

  return tr
}

/** Take a section break out: the section it starts joins the one before, and takes its page; the sections after it that kept its page keep that page. */
export function removeSectionBreakChange(args: Args): Change {
  const wanted = given(args.section) ? sectionNumberOf(args.section) : null
  let removed = 0

  return {
    build: (state) => {
      const sections = documentSections(state.doc)

      if (sections.length < 2) {
        throw new Error('The document has one section, so there is no section break to take out')
      }

      const index = wanted ?? (sections.length === 2 ? 1 : null)

      if (index === null) {
        throw new Error(`Say which section break (section: the section it starts, from 2 to ${sections.length}; docs.listSections lists them)`)
      }

      if (index < 1 || index >= sections.length) {
        throw new Error(`section is the section a break starts, from 2 to ${sections.length} (section 1 starts the document)`)
      }

      const pos = sections[index].breakPos ?? 0
      removed = index + 1

      return (current) => {
        const tr = current.tr

        for (let next = index + 1; next < sections.length && !sections[next].own; next++) {
          tr.setNodeAttribute(sections[next].breakPos ?? 0, 'page', sections[index].page)
        }

        return removeBlock(current, pos, tr)
      }
    },
    outcome: ({ changed, name, path }) => ({
      summary: changed ? `Took out the section break that started section ${removed} of ${name}: its pages join section ${removed - 1}` : `Nothing changed in ${name}`,
      data: { name, path, changed, section: removed }
    })
  }
}

/** Which page a page change is to: the document's (the first section's, and those keeping it), every section's, or one section's from 0. */
export function pageSectionOf(value: unknown): 'document' | 'all' | number {
  const wanted = text(value).toLowerCase()

  if (!wanted) {
    return 'document'
  }

  return /^(all|every|all sections|every section)$/.test(wanted) ? 'all' : sectionNumberOf(wanted, true)
}

/** A page change, to the document's page, every section's or one section's; the page it leaves is in the answer. */
export function setPageChange(args: Args): Change {
  const change = pageArgsOf(args)
  const section = pageSectionOf(args.section)

  if (!Object.keys(change).length) {
    throw new Error('Say what to change: size (a4, letter, legal, a5, or width by height: "8.5x11in"), orientation (portrait or landscape), margins (all four), top, right, bottom, left, headerDistance or footerDistance (points, or "1in", "20mm")')
  }

  const seen: { page: PageSettings | null; others: boolean } = { page: null, others: false }

  return {
    build: (state) => {
      seen.others = section === 'document' && documentSections(state.doc).some((entry) => entry.index > 0 && entry.own)

      return seeing(typeof section === 'number' ? setSectionPage(section, change) : setPage(change, section), (doc) => {
        seen.page = documentSections(doc)[typeof section === 'number' ? section : 0]?.page ?? null
      })
    },
    outcome: ({ changed, name, path }) => {
      const which = section === 'all' ? 'every section’s page' : typeof section === 'number' ? `the page of section ${section + 1}` : 'the page'
      const page = changed && seen.page ? pageInfo(seen.page) : null

      return {
        summary: changed ? `Set up ${which} of ${name}${page ? `: ${pageWords(page)}` : ''}${seen.others ? '; the sections with a page of their own keep it (section=all changes them too)' : ''}` : `${name} already has that page setup`,
        data: { name, path, changed, ...change, ...(section === 'document' ? {} : { section: typeof section === 'number' ? section + 1 : 'all' }), ...(page ? { page } : {}) }
      }
    }
  }
}

// Comments.

/** A comment to add: what it says, and the text it is on. */
export interface CommentItem {
  text: string
  quote?: string
  /** A heading's text, or its place in the outline from 0. */
  heading?: string | number
  at?: 'selection' | 'marked'
  /** Every match of the quote, not only the first. */
  all?: boolean
}

const AT_CHOICES: Record<string, 'selection' | 'marked'> = { selection: 'selection', cursor: 'selection', caret: 'selection', marked: 'marked' }

function commentItem(value: unknown, label: string, fallback: 'selection' | null): CommentItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is an object: {"text": "the comment", "quote": "exact text in the document it is on"}`)
  }

  const entry = value as Args
  const said = text(entry.text) || text(entry.comment)

  if (!said) {
    throw new Error(`${label} needs text: what it says`)
  }

  if (given(entry.quote)) {
    return { text: said, quote: text(entry.quote), all: flag(entry.all, false) }
  }

  if (given(entry.heading)) {
    return { text: said, heading: headingRef(entry.heading) }
  }

  const at = given(entry.at) ? AT_CHOICES[text(entry.at).toLowerCase()] : fallback

  if (!at) {
    throw new Error(given(entry.at) ? `${label}: at is selection or marked, not “${text(entry.at)}” (quote puts a comment on text anywhere)` : `${label} says what it is on: quote (exact text in the document), heading or at (selection or marked)`)
  }

  return { text: said, at }
}

/** The comment docs.addComment adds: on a quote, a heading's line, or the selection or marked text (the selection when none is given). */
export const commentItemOf = (args: Args): CommentItem => commentItem(args, 'The comment', 'selection')

/** The comments of docs.addComments: a JSON list of objects, each with its text and what it is on. */
export function commentItemsOf(value: unknown): CommentItem[] {
  const parsed = parseJsonArg(value, 'comments')
  const list = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? [parsed] : parsed

  if (!Array.isArray(list) || !list.length) {
    throw new Error('comments is a JSON list: [{"text": "Source?", "quote": "grew by a third"}, {"text": "Shorter?", "heading": "Summary"}]')
  }

  if (list.length > 200) {
    throw new Error('At most 200 comments at once')
  }

  return list.map((entry, index) => commentItem(entry, `Comment ${index + 1}`, null))
}

/** A comment that was not added: its place in the list from 1, what it was to say and be on, and why. */
export interface MissingComment {
  item: number
  /** Its edit in a batch, from 1. */
  edit?: number
  text: string
  quote?: string
  heading?: string | number
  at?: string
  reason: string
}

const itemPlace = (item: CommentItem): Pick<MissingComment, 'quote' | 'heading' | 'at'> =>
  item.quote !== undefined ? { quote: item.quote } : item.heading !== undefined ? { heading: typeof item.heading === 'number' ? item.heading + 1 : item.heading } : { at: item.at }

/** The text a comment goes on, or why there is none. */
function commentRanges(state: EditorState, item: CommentItem, marked: Marked | null, live: boolean): Range[] | string {
  const { doc } = state

  if (item.quote !== undefined) {
    const found = quoteMatches(doc, item.quote)

    return found.length ? (item.all ? found : found.slice(0, 1)) : 'not found'
  }

  if (item.heading !== undefined) {
    const entry = findHeading(doc, item.heading)

    if (!entry) {
      return 'no such heading'
    }

    return entry.to - entry.from > 2 ? [{ from: entry.from + 1, to: entry.to - 1 }] : 'the heading is empty'
  }

  if (!live) {
    return 'only an open document has a selection: give a quote'
  }

  const range = item.at === 'marked' ? marked : commentRange(state)

  return range && range.to > range.from ? [range] : item.at === 'marked' ? 'nothing is marked for Hermes' : 'nothing is selected'
}

/** The comments not added, in words. */
export function missingWords(missing: readonly MissingComment[]): string {
  const each = missing.slice(0, 5).map((entry) => `${entry.quote !== undefined ? quoted(entry.quote, 40) : entry.heading !== undefined ? `heading ${quoted(String(entry.heading), 40)}` : `at=${entry.at}`} (${entry.reason})`)
  const quotes = missing.some((entry) => entry.reason === 'not found')

  return `${each.join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}${quotes ? '; quote the document’s words exactly, within one paragraph (docs.find finds them)' : ''}`
}

/**
 * Comments on quotes, heading lines, the selection or the marked text, all of them one step by
 * one author (the model's own when `author` is not given); those whose text is not found are
 * listed in the answer, which gives the new comments' ids.
 */
export function addCommentsChange(items: readonly CommentItem[], author?: string, single = false): Change {
  const seen: { missing: MissingComment[]; ids: string[]; quotes: string[] } = { missing: [], ids: [], quotes: [] }

  return {
    build: (state, marked, live) => {
      const specs: CommentSpec[] = []
      const before = new Set(commentsOf({ type: 'doc', attrs: state.doc.attrs }).map((thread) => thread.id))
      seen.missing = []
      seen.ids = []
      seen.quotes = []
      items.forEach((item, index) => {
        const ranges = commentRanges(state, item, marked, live)

        if (typeof ranges === 'string') {
          seen.missing.push({ item: index + 1, text: item.text, ...itemPlace(item), reason: ranges })
        } else {
          ranges.forEach((range) => specs.push({ target: { from: range.from, to: range.to }, text: item.text }))
        }
      })

      return seeing(addComments(specs, author), (doc) => {
        const added = comments(doc).filter((thread) => !before.has(thread.id))
        seen.ids = added.map((thread) => thread.id)
        seen.quotes = added.map((thread) => thread.quote)
      })
    },
    outcome: ({ changed, name, path }) => {
      const added = changed ? seen.ids.length : 0
      const missed = seen.missing.length ? missingWords(seen.missing) : ''
      const none = `Added no comment${single ? '' : 's'} to ${name}${missed ? `: ${missed}` : ''}`
      const summary = !added
        ? none
        : single
          ? `Put a comment on ${quoted(seen.quotes[0] ?? '', 40)}${added > 1 ? ` at each of its ${added} places` : ''} in ${name}`
          : `Added ${many(added, 'comment')} to ${name} as one step${missed ? `; not added: ${missed}` : ''}`

      return { summary, data: { name, path, changed, added, missing: seen.missing, ids: added ? seen.ids : [] } }
    }
  }
}

/** The comment an id names (its thread, for a reply's id), or an error that says which there are. */
function threadOf(doc: PMNode, id: string): CommentInfo {
  const all = comments(doc)
  const thread = all.find((entry) => entry.id === id) ?? all.find((entry) => entry.replies.some((reply) => reply.id === id))

  if (!thread) {
    const ids = all.slice(0, 12).map((entry) => entry.id)

    throw new Error(`The document has no comment “${id}” (${all.length ? `its comments are ${ids.join(', ')}${all.length > 12 ? ', …' : ''}; docs.listComments says what each says` : 'it has none'})`)
  }

  return thread
}

function commentIdOf(value: unknown, missing = 'Say which comment (comment: its id, as docs.listComments gives them)'): string {
  const id = text(value).replace(/^#/, '')

  if (!id) {
    throw new Error(missing)
  }

  return id
}

function required(value: unknown, missing: string): string {
  const said = text(value)

  if (!said) {
    throw new Error(missing)
  }

  return said
}

const whose = (entry: { author: string }): string => (entry.author ? `${entry.author}’s` : 'the')

/** A comment as an answer names it: whose it is and what it is on. */
const commentWords = (thread: CommentInfo): string => `${whose(thread)} comment on ${thread.quote ? quoted(thread.quote, 40) : 'text that was taken out'}`

/** A reply to a comment (a reply's id answers its thread), by `author` or the model's own. */
export function replyChange(args: Args, author?: string): Change {
  const id = commentIdOf(args.comment)
  const said = required(args.text, 'Say what the reply says (text)')
  const seen: { thread: CommentInfo | null; reply: string | null } = { thread: null, reply: null }

  return {
    build: (state) => {
      const thread = threadOf(state.doc, id)
      const before = new Set(thread.replies.map((reply) => reply.id))
      seen.thread = thread

      return seeing(replyToComment(thread.id, said, author), (doc) => {
        seen.reply = commentsOf({ type: 'doc', attrs: doc.attrs }).find((entry) => entry.id === thread.id)?.replies?.find((reply) => !before.has(reply.id))?.id ?? null
      })
    },
    outcome: ({ changed, name, path }) => ({
      summary: changed && seen.thread ? `Replied to ${commentWords(seen.thread)} in ${name}` : `Nothing changed in ${name}`,
      data: { name, path, changed, comment: seen.thread?.id ?? id, ...(changed && seen.reply ? { reply: seen.reply } : {}) }
    })
  }
}

/** Change what a comment or a reply says. */
export function editCommentChange(args: Args): Change {
  const id = commentIdOf(args.comment)
  const said = required(args.text, 'Say what the comment says now (text)')
  let thread: CommentInfo | null = null

  return {
    build: (state) => {
      thread = threadOf(state.doc, id)

      return editComment(id, said)
    },
    outcome: ({ changed, name, path }) => {
      const reply = thread && thread.id !== id ? thread.replies.find((entry) => entry.id === id) : null
      const called = !thread ? 'the comment' : reply ? `${whose(reply)} reply to ${commentWords(thread)}` : commentWords(thread)

      return { summary: changed ? `Changed what ${called} says in ${name}` : `${capital(called)} already says that`, data: { name, path, changed, comment: id } }
    }
  }
}

/** Mark a comment resolved, or open it again. */
export function resolveChange(args: Args): Change {
  const id = commentIdOf(args.comment)
  const resolved = flag(args.resolved, true)
  let thread: CommentInfo | null = null

  return {
    build: (state) => {
      thread = threadOf(state.doc, id)

      return setCommentResolved(thread.id, resolved)
    },
    outcome: ({ changed, name, path }) => {
      const called = thread ? commentWords(thread) : 'the comment'

      return {
        summary: changed ? `${resolved ? 'Resolved' : 'Opened again'} ${called} in ${name}` : `${capital(called)} is ${resolved ? 'resolved' : 'open'} already`,
        data: { name, path, changed, comment: thread?.id ?? id, resolved }
      }
    }
  }
}

/** Delete a comment with its replies, one reply, or (all) every comment. */
export function deleteCommentChange(args: Args): Change {
  const all = flag(args.all, false)
  const id = all ? null : commentIdOf(args.comment, 'Say which comment (comment: its id, as docs.listComments gives them), or all=true for every comment')
  const seen: { thread: CommentInfo | null; count: number } = { thread: null, count: 0 }

  return {
    build: (state) => {
      if (id === null) {
        seen.count = comments(state.doc).length

        return deleteAllComments()
      }

      seen.thread = threadOf(state.doc, id)

      return deleteComment(id)
    },
    outcome: ({ changed, name, path }) => {
      const data = { name, path, changed, ...(id === null ? { deleted: changed ? seen.count : 0 } : { comment: id }) }
      const { thread } = seen

      if (!changed) {
        return { summary: id === null ? `${name} has no comments` : `Nothing changed in ${name}`, data }
      }

      if (id === null || !thread) {
        return { summary: `Deleted ${many(seen.count, 'comment')} from ${name}`, data }
      }

      const reply = thread.id === id ? null : thread.replies.find((entry) => entry.id === id)
      const replies = thread.replies.length

      return {
        summary: reply ? `Deleted ${whose(reply)} reply to ${commentWords(thread)} in ${name}` : `Deleted ${commentWords(thread)}${replies ? ` and ${replies === 1 ? 'its reply' : `its ${replies} replies`}` : ''} from ${name}`,
        data
      }
    }
  }
}

/** A document's comments (those in a section, `within`) as Hermes reads them, in the order of their text. */
export function commentsList(doc: PMNode, within: Range | null = null) {
  const headings = outline(doc)

  return comments(doc)
    .filter((thread) => !within || (thread.from !== null && thread.from >= within.from && thread.from < within.to))
    .map((thread) => {
      const at = thread.from
      const heading = at === null ? undefined : headings.filter((entry) => entry.from < at).pop()?.text

      return {
        id: thread.id,
        author: thread.author,
        date: thread.date,
        text: thread.text,
        quote: thread.quote,
        ...(heading ? { heading } : {}),
        resolved: thread.resolved,
        replies: thread.replies.map((reply) => ({ id: reply.id, author: reply.author, date: reply.date, text: reply.text }))
      }
    })
}

// Tables of contents.

/** Where the document's tables of contents are, in order. */
function tocPositions(doc: PMNode): number[] {
  const out: number[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'tableOfContents') {
      out.push(pos)

      return false
    }

    return !node.isTextblock
  })

  return out
}

export interface TocInfo {
  /** Its place among the document's tables of contents, from 1. */
  toc: number
  levels: number
  title: string | null
  entries: number
}

/** A document's tables of contents as Hermes reads them: the levels each lists, its title and how many entries it has. */
export function tocsList(doc: PMNode): TocInfo[] {
  const headings = headingsOf(doc)

  return tocPositions(doc).map((pos, index) => {
    const attrs: Record<string, unknown> = doc.nodeAt(pos)?.attrs ?? {}
    const levels = Number(attrs.levels) || 3

    return { toc: index + 1, levels, title: typeof attrs.title === 'string' && attrs.title ? attrs.title : null, entries: tocEntries(headings, levels).length }
  })
}

function levelsOf(value: unknown): number | undefined {
  if (!given(value)) {
    return undefined
  }

  const levels = Number(text(value))

  if (!Number.isInteger(levels) || levels < 1 || levels > 6) {
    throw new Error('levels is how many heading levels it lists, from 1 to 6 (3 lists headings 1 to 3)')
  }

  return levels
}

/** A title as a command gives it, none for no title. */
function titleOf(value: unknown): string | null | undefined {
  const title = text(value)

  return !title ? undefined : /^(none|no|off|null)$/i.test(title) ? null : title
}

/** The table of contents a command names, from 1 (the first, or the only one where `needed`, when it is not given). */
function tocIndex(doc: PMNode, value: unknown, needed: boolean): number {
  const count = tocPositions(doc).length

  if (!count) {
    throw new Error('The document has no table of contents (docs.insertToc puts one in)')
  }

  if (!given(value)) {
    if (needed && count > 1) {
      throw new Error(`Say which table of contents (toc: from 1 to ${count}; docs.read part=tocs lists them)`)
    }

    return 0
  }

  const index = Number(text(value)) - 1

  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`toc is a table of contents’ place from 1 to ${count}, not “${text(value)}”`)
  }

  return index
}

const levelWords = (levels: number): string => (levels === 1 ? 'Heading 1' : `Headings 1 to ${levels}`)

const tocWords = (toc: TocInfo): string => `${toc.entries ? `${many(toc.entries, 'entry', 'entries')} from ${levelWords(toc.levels)}` : `no entries yet, as the document has no ${levelWords(toc.levels).toLowerCase()}`}${toc.title ? `, under ${quoted(toc.title)}` : ', with no title'}`

/** A table of contents of `levels` levels under `title`, at the start unless a place says otherwise. */
export function insertTocChange(args: Args): Change {
  const levels = levelsOf(args.levels) ?? 3
  const title = titleOf(args.title)
  let made: TocInfo | null = null

  return {
    build: (state, marked, live) => {
      const place = depthPlace(state, args, marked, live, { block: true, fallback: 'start' })
      const before = tocPositions(state.doc)

      return seeing(insertTableOfContents({ levels, ...(title === undefined ? {} : { title }) }, place), (doc, tr) => {
        const old = new Set(before.map((pos) => tr.mapping.map(pos)))
        made = tocsList(doc)[tocPositions(doc).findIndex((pos) => !old.has(pos))] ?? null
      })
    },
    outcome: ({ changed, name, path, marked }) => ({
      summary: changed && made ? `Put a table of contents in ${name}, ${placeWords(args, { block: true, fallback: 'at the start', marked })}: ${tocWords(made)}` : `Nothing changed in ${name}`,
      data: { name, path, changed, ...(made ?? {}) }
    })
  }
}

/** Change a table of contents' levels or title. */
export function setTocChange(args: Args): Change {
  const levels = levelsOf(args.levels)
  const title = titleOf(args.title)

  if (levels === undefined && title === undefined) {
    throw new Error('Say what to change: levels (1 to 6) or title (none for no title)')
  }

  let index = 0
  let made: TocInfo | null = null

  return {
    build: (state) => {
      index = tocIndex(state.doc, args.toc, false)

      return seeing(setTableOfContents({ index }, { ...(levels === undefined ? {} : { levels }), ...(title === undefined ? {} : { title }) }), (doc) => {
        made = tocsList(doc)[index] ?? null
      })
    },
    outcome: ({ changed, name, path }) => ({
      summary: changed && made ? `Changed table of contents ${index + 1} of ${name}: ${tocWords(made)}` : `Table of contents ${index + 1} of ${name} already looks that way`,
      data: { name, path, changed, ...(made ?? { toc: index + 1 }) }
    })
  }
}

/** Bring the page numbers of every table of contents up to date, from the page each heading is on where the pages are laid out. */
export function updateTocsChange(headingPages: readonly (number | null | undefined)[] | null): Change {
  let count = 0

  return {
    build: (state) => {
      count = tocPositions(state.doc).length

      return updateTablesOfContents(headingPages)
    },
    outcome: ({ changed, name, path }) => {
      const them = count === 1 ? 'the table of contents' : `${count} tables of contents`
      const summary = !count
        ? `${name} has no table of contents (docs.insertToc puts one in)`
        : changed
          ? `Updated the page numbers of ${them} in ${name}`
          : `${capital(them)} in ${name} ${count === 1 ? 'is' : 'are'} up to date${headingPages ? '' : ' (its page numbers come from the pages of an open document: docs.open lays them out)'}`

      return { summary, data: { name, path, changed, tocs: count } }
    }
  }
}

/** Take a table of contents out. */
export function removeTocChange(args: Args): Change {
  let index = 0
  let count = 0

  return {
    build: (state) => {
      const positions = tocPositions(state.doc)
      index = tocIndex(state.doc, args.toc, true)
      count = positions.length

      return (current) => removeBlock(current, positions[index])
    },
    outcome: ({ changed, name, path }) => ({
      summary: changed ? `Took ${count > 1 ? `table of contents ${index + 1}` : 'the table of contents'} out of ${name}` : `Nothing changed in ${name}`,
      data: { name, path, changed, toc: index + 1 }
    })
  }
}

// Templates.

/** A template a new document starts from: one of Herald Docs' own, or one the person saved. */
export type TemplateChoice = { saved: false; id: string; name: string } | { saved: true; id: string; name: string; doc: DocJSON }

/** Names besides their own that the built-in templates answer to, by id. */
const TEMPLATE_NAMES: Record<string, string> = {
  'blank document': 'blank',
  empty: 'blank',
  coverletter: 'cover-letter',
  resume: 'cv',
  résumé: 'cv',
  'curriculum vitae': 'cv',
  proposal: 'project-proposal',
  notes: 'meeting-notes',
  minutes: 'meeting-notes',
  'meeting minutes': 'meeting-notes',
  'thank you': 'thank-you-note',
  'thank-you': 'thank-you-note',
  'thank you card': 'thank-you-note'
}

const templateKey = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ')

/** A built-in template by its id, its name or another name for it ("Cover letter", "resume", "minutes"), any case. */
export function builtInTemplate(value: unknown): TemplateInfo | null {
  const key = templateKey(text(value))
  const id = TEMPLATES.find((entry) => entry.id === key || entry.id === key.replace(/ /g, '-') || entry.name.toLowerCase() === key)?.id ?? TEMPLATE_NAMES[key] ?? TEMPLATE_NAMES[key.replace(/-/g, ' ')]

  return TEMPLATES.find((entry) => entry.id === id) ?? null
}

/** The template a new document starts from: a built-in one, else one of the person's by its id or name. */
export function templateChoice(value: unknown, saved: readonly SavedTemplate[]): TemplateChoice {
  const builtIn = builtInTemplate(value)

  if (builtIn) {
    return { saved: false, id: builtIn.id, name: builtIn.name }
  }

  const key = templateKey(text(value))
  const own = saved.find((entry) => entry.id === text(value)) ?? saved.find((entry) => templateKey(entry.name) === key)

  if (!own) {
    throw new Error(`Herald Docs has no template “${text(value)}”: its own are ${TEMPLATES.map((entry) => entry.id).join(', ')}${saved.length ? `, and the person’s ${saved.map((entry) => `“${entry.name}”`).join(', ')}` : ''} (docs.listTemplates says what each holds)`)
  }

  return { saved: true, id: own.id, name: own.name, doc: own.doc }
}

/** A template as an answer names it: "the cover letter template". */
export const templateLabel = (choice: TemplateChoice): string => (choice.saved ? `the person’s template “${choice.name}”` : `the ${choice.name.replace(/\b(\p{Lu})(?=\p{Ll})/gu, (letter) => letter.toLowerCase())} template`)

function paperOf(value: string): PageSizeName {
  const name = (Object.keys(PAGE_SIZES) as PageSizeName[]).find((entry) => entry === value.trim().toLowerCase())

  if (!name) {
    throw new Error(`size is one of ${Object.keys(PAGE_SIZES).join(', ')}, not “${value}”`)
  }

  return name
}

/** A new document's model: from a template, on the paper `size` names, else blank. */
export function newDocumentModel(choice: TemplateChoice | null, size?: string): DocJSON {
  if (choice?.saved) {
    const doc = structuredClone(choice.doc)

    return size ? { ...doc, attrs: { ...doc.attrs, page: changedPage(pageOf(doc), { size: paperOf(size) }) } } : doc
  }

  return choice || size ? documentFromTemplate(choice?.id ?? 'blank', size ? { size: paperOf(size) } : {}) : blankDocument()
}

/** A document with `blocks` in place of its body: a template's page, styles, headers and footers around new content. */
export function withBody(model: DocJSON, blocks: readonly DocNode[]): DocJSON {
  return blocks.length ? { ...model, attrs: { ...model.attrs, comments: null }, content: [...blocks] } : model
}

/** Herald Docs' templates and the person's, as Hermes reads them. */
export function templatesOutcome(saved: readonly SavedTemplate[]): Outcome {
  return {
    summary: `Herald Docs has ${many(TEMPLATES.length, 'template')} (${TEMPLATES.map((entry) => entry.id).join(', ')})${saved.length ? `, and the person saved ${many(saved.length, 'more', 'more')}: ${saved.map((entry) => `“${entry.name}”`).join(', ')}` : ''}`,
    data: { builtIn: TEMPLATES.map(({ id, name, description }) => ({ id, name, description })), saved: saved.map(({ id, name, savedAt }) => ({ id, name, savedAt })) }
  }
}

// Statistics.

/** A document's statistics as Hermes reads them: the whole of it (with its pages where it is laid out), a heading's section or the selection. */
export function statisticsOutcome(state: EditorState, args: Args, live: boolean, about: { name: string; path: string | null; pages?: number }): Outcome {
  let stats: DocumentStatistics
  let scope: Record<string, unknown> = { scope: 'document' }
  let words = ''

  if (flag(args.selection, false)) {
    if (!live) {
      throw new Error('Only a document open in Herald Docs has a selection: open it first (docs.open)')
    }

    if (state.selection.empty) {
      throw new Error('Nothing is selected in the document')
    }

    stats = documentStatistics({ type: 'doc', content: (state.selection.content().content.toJSON() as DocNode[] | null) ?? [] })
    scope = { scope: 'selection' }
    words = ' (the selection)'
  } else if (given(args.heading)) {
    const ref = headingRef(args.heading)
    const heading = headingEntry(state.doc, ref).text
    stats = documentStatistics(sectionDocument(state.doc, ref))
    scope = { scope: 'section', heading }
    words = ` (the section ${quoted(heading, 40)})`
  } else {
    stats = documentStatistics(jsonOf(state.doc), { pages: about.pages })
  }

  const ease = stats.readability ? `; reading ease ${stats.readability.score} (${stats.readability.label}), US school grade ${stats.readability.grade}` : ''

  return {
    summary: `${about.name}${words}: ${many(stats.words, 'word')}, ${many(stats.characters, 'character')} (${stats.charactersNoSpaces.toLocaleString('en-US')} without spaces), ${many(stats.paragraphs, 'paragraph')}, ${many(stats.sentences, 'sentence')}${stats.pages ? `, ${many(stats.pages, 'page')}` : ''}; ${lower(durationLabel(stats.readingMinutes))} to read and ${lower(durationLabel(stats.speakingMinutes))} to say aloud${ease}`,
    data: { name: about.name, path: about.path, ...scope, ...stats, readingTime: durationLabel(stats.readingMinutes), speakingTime: durationLabel(stats.speakingMinutes) }
  }
}

// Reading.

/** The parts of a document docs.read gives beyond its text. */
export const DEPTH_PARTS = ['comments', 'notes', 'headers', 'sections', 'tocs'] as const

export type DepthPart = (typeof DEPTH_PARTS)[number]

export const isDepthPart = (part: string): part is DepthPart => (DEPTH_PARTS as readonly string[]).includes(part)

export interface PartReading {
  summary: (name: string) => string
  data: Record<string, unknown>
}

/** What docs.read gives for comments, notes, headers and footers, sections and tables of contents; comments and notes in a heading's section with `heading`. */
export function partReading(doc: PMNode, part: DepthPart, heading?: string | number): PartReading {
  const entry = heading === undefined ? null : headingEntry(doc, heading)
  const within = entry ? { from: entry.from, to: sectionOf(doc, entry).to } : null
  const under = entry ? ` under ${quoted(entry.text, 40)}` : ''

  switch (part) {
    case 'comments': {
      const list = commentsList(doc, within)
      const resolved = list.filter((thread) => thread.resolved).length

      return { summary: (name) => `${name}: ${list.length ? many(list.length, 'comment') : 'no comments'}${under}${resolved ? ` (${resolved} resolved)` : ''}`, data: { comments: list } }
    }
    case 'notes': {
      const list = notesList(doc, within)
      const footnotes = list.filter((note) => note.kind === 'footnote').length

      return { summary: (name) => `${name}: ${list.length ? `${many(footnotes, 'footnote')} and ${many(list.length - footnotes, 'endnote')}` : 'no footnotes or endnotes'}${under}`, data: { notes: list } }
    }
    case 'headers': {
      const headers = headerFooterText(doc)
      const each = headers.parts.map((one) => `the ${partName(one.part, one.kind)} on ${one.shownOn}: ${quoted(one.text, 50)}`)

      return { summary: (name) => `${name}: ${each.length ? each.join('; ') : 'no headers or footers'}`, data: { headers } }
    }
    case 'sections': {
      const list = sectionsList(doc)

      return { summary: (name) => `${name}: ${many(list.length, 'section')} (${list.map((section) => `${list.length > 1 ? `${section.section}: ` : ''}${pageWords(section.page)}`).join('; ')})`, data: { sections: list } }
    }
    default: {
      const list = tocsList(doc)

      return { summary: (name) => `${name}: ${list.length ? `${many(list.length, 'table of contents', 'tables of contents')} (${list.map(tocWords).join('; ')})` : 'no table of contents'}`, data: { tocs: list } }
    }
  }
}

/** What a document has beyond its text, for docs.read to say, or null when it has none of it. */
export function extrasOf(doc: PMNode): { also: Record<string, number>; words: string } | null {
  const threads = comments(doc).length
  const all = notes(doc)
  const footnotes = all.filter((note) => note.kind === 'footnote').length
  const parts = headerFooterText(doc).parts
  const headers = parts.filter((entry) => entry.part === 'header').length
  const footers = parts.length - headers
  const sections = documentSections(doc).length
  const tocs = tocPositions(doc).length
  const counts: [string, number, string, string][] = [
    ['comments', threads, 'comment', 'comments'],
    ['footnotes', footnotes, 'footnote', 'notes'],
    ['endnotes', all.length - footnotes, 'endnote', 'notes'],
    ['headers', headers, 'header', 'headers'],
    ['footers', footers, 'footer', 'headers'],
    ['sections', sections > 1 ? sections : 0, 'section', 'sections'],
    ['tablesOfContents', tocs, 'table of contents', 'tocs']
  ]
  const present = counts.filter(([, count]) => count > 0)

  if (!present.length) {
    return null
  }

  const words = present.map(([, count, one]) => (count === 1 ? `${/^[aeiou]/.test(one) ? 'an' : 'a'} ${one}` : many(count, one, one === 'table of contents' ? 'tables of contents' : `${one}s`)))
  const reads = [...new Set(present.map(([, , , part]) => `part=${part}`))]

  return { also: Object.fromEntries(present.map(([key, count]) => [key, count])), words: `it also has ${listed(words)} (${reads.length > 1 ? `${reads.slice(0, -1).join(', ')} or ${reads[reads.length - 1]}` : reads[0]} reads them)` }
}

// Batches.

/** What a batch's edit needs read in before the change: its content (pictures and all), who comments are by, and the page each heading is on. */
export interface EditPrepared {
  content: StoryContent | null
  author?: string
  headingPages?: readonly (number | null | undefined)[] | null
}

/** The ops of docs.edit with content of their own to read in before the change. */
export const CONTENT_OPS: ReadonlySet<string> = new Set(['setHeader', 'setFooter', 'insertNote', 'setNote'])

/** The ops of docs.edit that add comments or replies, after which an open document shows its comments. */
export const COMMENT_OPS: ReadonlySet<string> = new Set(['addComment', 'addComments', 'replyToComment'])

/** An edit of a batch made as the command it is named after makes it, or null for docs.edit's own ops (write, replace, format, table, image, pageBreak). */
export function depthEdit(entry: Args & { op: string }, prepared: EditPrepared): Change | null {
  const content = prepared.content ?? { text: '' }

  switch (entry.op) {
    case 'page':
    case 'setPage':
      return setPageChange(entry)
    case 'setHeader':
      return setPartChange('header', entry, content)
    case 'setFooter':
      return setPartChange('footer', entry, content)
    case 'clearHeader':
      return clearPartChange('header', entry)
    case 'clearFooter':
      return clearPartChange('footer', entry)
    case 'setHeaderOptions':
      return headerOptionsChange(entry)
    case 'insertField':
      return insertFieldChange(entry)
    case 'insertNote':
      return insertNoteChange(entry, content)
    case 'setNote':
      return setNoteChange(entry, content)
    case 'removeNote':
      return removeNoteChange(entry)
    case 'insertSectionBreak':
      return insertSectionBreakChange(entry)
    case 'removeSectionBreak':
      return removeSectionBreakChange(entry)
    case 'addComment':
      return addCommentsChange([commentItemOf(entry)], prepared.author, true)
    case 'addComments':
      return addCommentsChange(commentItemsOf(entry.comments), prepared.author)
    case 'replyToComment':
      return replyChange(entry, prepared.author)
    case 'editComment':
      return editCommentChange(entry)
    case 'resolveComment':
      return resolveChange(entry)
    case 'deleteComment':
      return deleteCommentChange(entry)
    case 'insertToc':
      return insertTocChange(entry)
    case 'setToc':
      return setTocChange(entry)
    case 'updateTocs':
      return updateTocsChange(prepared.headingPages ?? null)
    case 'removeToc':
      return removeTocChange(entry)
    default:
      return null
  }
}

/** The answer to a batch of edits: how many landed as one step, and the comments that found no text. */
export function batchOutcome(count: number, changes: readonly (Change | null)[], result: Changed): Outcome {
  const missing = changes.flatMap((made, index) => {
    const found = made?.outcome(result).data?.missing

    return Array.isArray(found) ? (found as MissingComment[]).map((entry) => ({ ...entry, edit: index + 1 })) : []
  })

  return {
    summary: `${result.changed ? `Made ${many(count, 'edit')} to ${result.name} as one step` : `Nothing changed in ${result.name}`}${missing.length ? `; comments not added: ${missingWords(missing)}` : ''}`,
    data: { name: result.name, path: result.path, edits: count, changed: result.changed, ...(missing.length ? { missing } : {}) }
  }
}
