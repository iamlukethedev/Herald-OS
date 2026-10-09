import { Fragment, type Mark, type Node as PMNode, type NodeType, type Schema } from '@tiptap/pm/model'
import { type EditorState, Selection, TextSelection, type Transaction } from '@tiptap/pm/state'
import { DEFAULT_HEADER_DISTANCE, defaultPage, type DocNode, type FieldKind, HEADER_KINDS, type HeaderKind, type NoteKind, noteLabel, type PageHeaders, type PageMargins, type PageSettings, PAGE_SIZES, type PageSizeName, type SectionKind } from '../../../../shared/office/document.ts'
import { fieldText } from '../../../../shared/office/fields.ts'
import { type Content, contentNodes, insertNodes, type Op, type Place, placeRange } from './model.ts'

/*
 * The document API for the page: headers and footers, fields, notes, section breaks and page setup,
 * as operations on a document like model.ts's, for the editor and for Hermes.
 */

export type PagePart = 'header' | 'footer'

const PARTS: readonly PagePart[] = ['header', 'footer']

const SECTION_KINDS: readonly SectionKind[] = ['nextPage', 'continuous', 'oddPage', 'evenPage']

/** What only the document's text holds: notes, breaks and tables of contents. */
const TEXT_ONLY = new Set(['note', 'pageBreak', 'sectionBreak', 'tableOfContents'])

/** A node without what only the document's text holds, or null when nothing of it is left. */
function withoutTextOnly(node: PMNode): PMNode | null {
  if (TEXT_ONLY.has(node.type.name)) {
    return null
  }

  if (node.isLeaf) {
    return node
  }

  const kept: PMNode[] = []
  node.forEach((child) => {
    const copy = withoutTextOnly(child)

    if (copy) {
      kept.push(copy)
    }
  })

  if (kept.length === node.childCount && kept.every((child, index) => child === node.child(index))) {
    return node
  }

  const content = Fragment.from(kept)

  return node.type.validContent(content) ? node.copy(content) : node.type.createAndFill(node.attrs, content, node.marks)
}

/** Blocks for a header, a footer or a note, as JSON. */
function storyBlocks(nodes: readonly PMNode[]): DocNode[] {
  return nodes
    .map(withoutTextOnly)
    .filter((node): node is PMNode => node !== null)
    .map((node) => node.toJSON() as DocNode)
}

const isBlank = (blocks: readonly DocNode[]): boolean => blocks.every((block) => block.type === 'paragraph' && !block.content?.length)

/** A story's text: its blocks on lines of their own, table cells apart by tabs, `{page}` and `{pages}` where those fields go. */
function storyText(blocks: readonly DocNode[]): string {
  const inline = (node: DocNode): string => {
    switch (node.type) {
      case 'text':
        return node.text ?? ''
      case 'hardBreak':
        return '\n'
      case 'field':
        return node.attrs?.kind === 'page' ? '{page}' : node.attrs?.kind === 'pages' ? '{pages}' : fieldText(node.attrs)
      default:
        return (node.content ?? []).map(inline).join('')
    }
  }
  const lines = (node: DocNode): string[] => {
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock') {
      return [inline(node)]
    }

    if (node.type === 'tableRow') {
      return [(node.content ?? []).map((cell) => (cell.content ?? []).flatMap(lines).join(' ')).join('\t')]
    }

    return (node.content ?? []).flatMap(lines)
  }

  return blocks.flatMap(lines).join('\n')
}

// Headers and footers.

function checkPart(part: PagePart, kind?: HeaderKind): void {
  if (!PARTS.includes(part)) {
    throw new Error(`A page part is a header or a footer, not “${part}”`)
  }

  if (kind !== undefined && !HEADER_KINDS.includes(kind)) {
    throw new Error(`A header or footer is the default, first or even one, not “${kind}”`)
  }
}

/** Headers in their usual shape: kinds in order, no empty ones, options only when on, and none at all when nothing is left. */
function tidyHeaders(headers: PageHeaders): PageHeaders | null {
  const out: PageHeaders = { header: {}, footer: {} }

  for (const part of PARTS) {
    for (const kind of HEADER_KINDS) {
      const blocks = headers[part]?.[kind]

      if (blocks?.length) {
        out[part][kind] = blocks
      }
    }
  }

  if (headers.differentFirst) {
    out.differentFirst = true
  }

  if (headers.differentOddEven) {
    out.differentOddEven = true
  }

  const empty = !HEADER_KINDS.some((kind) => out.header[kind] || out.footer[kind])

  return empty && !out.differentFirst && !out.differentOddEven ? null : out
}

function changeHeaders(state: EditorState, change: (headers: PageHeaders) => void): Transaction | null {
  const current = (state.doc.attrs.headers as PageHeaders | null) ?? null
  const draft: PageHeaders = { ...current, header: { ...current?.header }, footer: { ...current?.footer } }
  change(draft)
  const next = tidyHeaders(draft)

  return JSON.stringify(next) === JSON.stringify(current && tidyHeaders(current)) ? null : state.tr.setDocAttribute('headers', next)
}

/** Put content in a header or footer, the kind that some pages show (see `headerKindFor`); empty content takes it away. Notes and breaks stay in the text. */
export function setHeaderFooter(part: PagePart, kind: HeaderKind, content: Content): Op {
  return (state) => {
    checkPart(part, kind)
    const blocks = storyBlocks(contentNodes(content, state.schema))

    return changeHeaders(state, (headers) => {
      if (isBlank(blocks)) {
        delete headers[part][kind]
      } else {
        headers[part][kind] = blocks
      }
    })
  }
}

/** Take away a header or footer of one kind, or all of them. */
export function clearHeaderFooter(part: PagePart, kind?: HeaderKind): Op {
  return (state) => {
    checkPart(part, kind)

    return changeHeaders(state, (headers) => {
      for (const each of kind ? [kind] : HEADER_KINDS) {
        delete headers[part][each]
      }
    })
  }
}

export interface HeaderOptions {
  /** The first page shows a header and footer of its own (Word's "Different first page"). */
  differentFirst?: boolean
  /** Even pages show their own, and the default ones are for odd pages. */
  differentOddEven?: boolean
}

export function setHeaderOptions(options: HeaderOptions): Op {
  return (state) =>
    changeHeaders(state, (headers) => {
      if (options.differentFirst !== undefined) {
        headers.differentFirst = Boolean(options.differentFirst)
      }

      if (options.differentOddEven !== undefined) {
        headers.differentOddEven = Boolean(options.differentOddEven)
      }
    })
}

export interface HeaderFooterText {
  part: PagePart
  kind: HeaderKind
  /** The pages that show it, in words. */
  shownOn: string
  text: string
}

function shownOn(kind: HeaderKind, first: boolean, oddEven: boolean): string {
  switch (kind) {
    case 'first':
      return first ? 'the first page' : 'no page, as Different first page is off'
    case 'even':
      return oddEven ? 'even pages' : 'no page, as Different odd and even pages is off'
    default:
      return oddEven ? (first ? 'odd pages after the first' : 'odd pages') : first ? 'every page after the first' : 'every page'
  }
}

/** What each header and footer says and which pages show it, `{page}` and `{pages}` standing for the page number and page count. */
export function headerFooterText(doc: PMNode): { differentFirst: boolean; differentOddEven: boolean; parts: HeaderFooterText[] } {
  const headers = (doc.attrs.headers as PageHeaders | null) ?? null
  const differentFirst = Boolean(headers?.differentFirst)
  const differentOddEven = Boolean(headers?.differentOddEven)
  const parts: HeaderFooterText[] = []

  for (const part of PARTS) {
    for (const kind of HEADER_KINDS) {
      const blocks = headers?.[part]?.[kind]

      if (blocks?.length) {
        parts.push({ part, kind, shownOn: shownOn(kind, differentFirst, differentOddEven), text: storyText(blocks) })
      }
    }
  }

  return { differentFirst, differentOddEven, parts }
}

// Fields and notes.

/** What Insert > Page Number puts in: the page number, "Page X of Y", the page count, the date or the time. */
export type FieldChoice = 'page' | 'pageOfPages' | 'pages' | 'date' | 'time'

const FIELD_CHOICES: readonly FieldChoice[] = ['page', 'pageOfPages', 'pages', 'date', 'time']

export interface FieldOptions {
  /** A date or time picture in Word's terms (`d MMMM yyyy`, `HH:mm`); the usual one for `locale` when missing. */
  format?: string | null
  locale?: string
}

/** The date or time picture people where `locale` is used write by default, so that Word shows the field the same. */
export function fieldFormat(kind: 'date' | 'time', locale = typeof navigator === 'undefined' ? 'en-GB' : navigator.language): string {
  const monthFirst = /^en-US$/i.test(locale)

  if (kind === 'date') {
    return monthFirst ? 'MMMM d, yyyy' : 'd MMMM yyyy'
  }

  return monthFirst ? 'h:mm AM/PM' : 'HH:mm'
}

/** The inline nodes a field choice puts in: its field, and the words around them for "Page X of Y". */
export function fieldNodes(choice: FieldChoice, schema: Schema, options: FieldOptions, marks: readonly Mark[]): PMNode[] {
  const field = (kind: FieldKind, format: string | null = null) => schema.nodes.field.create({ kind, format, instruction: null, text: null }, null, marks)

  switch (choice) {
    case 'pageOfPages':
      return [schema.text('Page ', marks), field('page'), schema.text(' of ', marks), field('pages')]
    case 'date':
    case 'time':
      return [field(choice, options.format ?? fieldFormat(choice, options.locale))]
    default:
      return [field(choice)]
  }
}

/**
 * Where inline content of `type` goes for a place: in the line of text there (after a selection
 * when `collapse`), or between blocks, at the end of the text before, else the start of the text after.
 */
function inlineRange(state: EditorState, place: Place, type: NodeType, collapse: boolean): { from: number; to: number } | null {
  const { doc } = state
  const range = placeRange(state, place)
  const fits = (pos: number) => {
    const $pos = doc.resolve(pos)

    return $pos.parent.isTextblock && $pos.parent.canReplaceWith($pos.index(), $pos.index(), type)
  }

  if (range.inline && fits(range.from) && fits(range.to)) {
    return collapse ? { from: range.to, to: range.to } : { from: range.from, to: range.to }
  }

  let before = null as number | null
  let after = null as number | null

  doc.descendants((node, pos) => {
    if (after !== null) {
      return false
    }

    if (!node.isTextblock) {
      return true
    }

    const end = pos + node.nodeSize - 1

    if (fits(pos + 1)) {
      if (end <= range.from) {
        before = end
      } else if (pos >= range.from) {
        after = pos + 1
      }
    }

    return false
  })

  const at = before ?? after

  return at === null ? null : { from: at, to: at }
}

const carriedMark = (mark: Mark): boolean => mark.type.name !== 'link' && mark.type.name !== 'comment'

/** Fields in a line of text: a page number, "Page X of Y", the page count, the date or the time, with the formatting where they go. */
export function insertField(choice: FieldChoice, options: FieldOptions = {}, place: Place = 'selection'): Op {
  return (state) => {
    if (!FIELD_CHOICES.includes(choice)) {
      throw new Error(`Herald Docs has no “${choice}” field: it has ${FIELD_CHOICES.join(', ')}`)
    }

    const { schema } = state
    const range = inlineRange(state, place, schema.nodes.field, false)

    if (!range) {
      return insertNodes((own) => [own.nodes.paragraph.create(null, fieldNodes(choice, own, options, []))], place)(state)
    }

    const marks = ((place === 'selection' && state.selection.empty ? state.storedMarks : null) ?? state.doc.resolve(range.from).marks()).filter(carriedMark)
    const nodes = fieldNodes(choice, schema, options, marks)
    const tr = state.tr.replaceWith(range.from, range.to, nodes)

    if (place === 'selection') {
      tr.setSelection(TextSelection.create(tr.doc, range.from + Fragment.from(nodes).size))
    }

    return tr
  }
}

function noteBlocks(content: Content, schema: Schema): DocNode[] {
  const blocks = storyBlocks(contentNodes(content, schema))

  return blocks.length ? blocks : [{ type: 'paragraph' }]
}

function checkNoteKind(kind: NoteKind): void {
  if (kind !== 'footnote' && kind !== 'endnote') {
    throw new Error(`A note is a footnote or an endnote, not “${kind}”`)
  }
}

/** A footnote or endnote: its reference in the text (after a selection), holding its content. */
export function insertNote(kind: NoteKind, content: Content = '', place: Place = 'selection'): Op {
  return (state) => {
    checkNoteKind(kind)
    const { schema } = state
    const note = schema.nodes.note.create({ kind, content: noteBlocks(content, schema) })
    const range = inlineRange(state, place, schema.nodes.note, true)

    if (!range) {
      return insertNodes((own) => [own.nodes.paragraph.create(null, note)], place)(state)
    }

    const tr = state.tr.insert(range.from, note)

    if (place === 'selection') {
      tr.setSelection(TextSelection.create(tr.doc, range.from + note.nodeSize))
    }

    return tr
  }
}

export interface NoteInfo {
  kind: NoteKind
  /** From 1 for each kind, in the order the references come. */
  number: number
  /** As the page shows it: footnotes 1, 2, 3 and endnotes i, ii, iii. */
  label: string
  text: string
  /** Where its reference is in the document. */
  pos: number
  content: DocNode[]
}

/** The document's footnotes and endnotes in the order their references come. */
export function notes(doc: PMNode): NoteInfo[] {
  const out: NoteInfo[] = []
  const counts: Record<NoteKind, number> = { footnote: 0, endnote: 0 }

  doc.descendants((node, pos) => {
    if (node.type.name === 'note') {
      const kind: NoteKind = node.attrs.kind === 'endnote' ? 'endnote' : 'footnote'
      const number = ++counts[kind]
      const content = (node.attrs.content as DocNode[] | null) ?? []
      out.push({ kind, number, label: noteLabel(kind, number), text: storyText(content), pos, content })
    }
  })

  return out
}

/** A note by its place among all of them (from 0, as `notes` lists them), by where its reference is, or by its kind and number. */
export type NoteRef = number | { pos: number } | { kind: NoteKind; number: number }

function noteOrThrow(doc: PMNode, ref: NoteRef): NoteInfo {
  const all = notes(doc)
  const found = typeof ref === 'number' ? all[ref] : 'pos' in ref ? all.find((note) => note.pos === ref.pos) : all.find((note) => note.kind === ref.kind && note.number === ref.number)

  if (!found) {
    throw new Error(typeof ref === 'number' ? `The document has no note number ${ref + 1}` : 'pos' in ref ? `The document has no note at ${ref.pos}` : `The document has no ${ref.kind} ${ref.number}`)
  }

  return found
}

/** Replace what a note says. */
export function setNote(ref: NoteRef, content: Content): Op {
  return (state) => {
    const note = noteOrThrow(state.doc, ref)
    const blocks = noteBlocks(content, state.schema)

    return JSON.stringify(blocks) === JSON.stringify(note.content) ? null : state.tr.setNodeAttribute(note.pos, 'content', blocks)
  }
}

/** Take a note away with its reference. */
export function removeNote(ref: NoteRef): Op {
  return (state) => {
    const note = noteOrThrow(state.doc, ref)

    return state.tr.delete(note.pos, note.pos + 1)
  }
}

// Sections and the page.

export interface SectionInfo {
  /** From 0; the first section has the document's page. */
  index: number
  /** How it starts; the first starts the document. */
  kind: SectionKind
  page: PageSettings
  /** Whether its break gives it a page of its own, rather than the one before it. */
  own: boolean
  /** Where its section break is (null for the first), and where its text starts and ends. */
  breakPos: number | null
  from: number
  to: number
}

/** The document's sections, each with its page. */
export function documentSections(doc: PMNode): SectionInfo[] {
  const out: SectionInfo[] = [{ index: 0, kind: 'nextPage', page: (doc.attrs.page as PageSettings | null) ?? defaultPage(), own: Boolean(doc.attrs.page), breakPos: null, from: 0, to: doc.content.size }]

  doc.forEach((node, offset) => {
    if (node.type.name !== 'sectionBreak') {
      return
    }

    const before = out[out.length - 1]
    const page = node.attrs.page as PageSettings | null
    before.to = offset
    out.push({ index: out.length, kind: SECTION_KINDS.includes(node.attrs.kind) ? node.attrs.kind : 'nextPage', page: page ?? before.page, own: Boolean(page), breakPos: offset, from: offset + node.nodeSize, to: doc.content.size })
  })

  return out
}

/** A section break: the section after it starts on the next page, the same page, or the next odd or even page, with the page of the section it is in. */
export function insertSectionBreak(kind: SectionKind = 'nextPage', place: Place = 'selection'): Op {
  return (state) => {
    if (!SECTION_KINDS.includes(kind)) {
      throw new Error(`A section starts on the next page, continuous, or on an odd or even page, not “${kind}”`)
    }

    const range = placeRange(state, place)
    const $from = state.doc.resolve(range.from)
    const sections = documentSections(state.doc)
    const top = $from.depth ? $from.before(1) : range.from
    const section = sections.filter((entry) => entry.from <= top).pop() ?? sections[0]
    const node = state.schema.nodes.sectionBreak.create({ kind, page: section.page })

    // Sections are made of the document's own blocks: in a list or a table, the break goes after it.
    if ($from.depth <= 1) {
      return insertNodes(() => [node], place)(state)
    }

    const after = $from.after(1)
    const tr = insertNodes(() => [node], { pos: after })(state)

    if (tr && place === 'selection') {
      tr.setSelection(Selection.near(tr.doc.resolve(Math.min(tr.doc.content.size, after + node.nodeSize))))
    }

    return tr
  }
}

/** The smallest and largest page Herald Docs lays out, and the least room for text it leaves each way, in points. */
export const PAGE_LIMITS = { smallest: 72, largest: 1584, text: 36 } as const

/** What is wrong with a page, or null when it can be laid out: margins that leave room for text, and sensible sizes. */
export function pageProblem(page: PageSettings): string | null {
  const { width, height, margins } = page
  const header = margins.header ?? DEFAULT_HEADER_DISTANCE
  const footer = margins.footer ?? DEFAULT_HEADER_DISTANCE
  const values = [width, height, margins.top, margins.right, margins.bottom, margins.left, header, footer]

  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return 'Every size needs to be a number'
  }

  if (Math.min(width, height) < PAGE_LIMITS.smallest || Math.max(width, height) > PAGE_LIMITS.largest) {
    return 'A page is from 1 to 22 inches (2.54 to 55.88 cm) each way'
  }

  if (Math.min(margins.top, margins.right, margins.bottom, margins.left, header, footer) < 0) {
    return 'Margins and distances cannot be below zero'
  }

  if (margins.left + margins.right > width - PAGE_LIMITS.text) {
    return 'The left and right margins leave too little room for text'
  }

  if (margins.top + margins.bottom > height - PAGE_LIMITS.text) {
    return 'The top and bottom margins leave too little room for text'
  }

  if (header > height / 2 || footer > height / 2) {
    return 'The header and the footer each need to be in their half of the page'
  }

  return null
}

export interface PageChange {
  /** A named size, or a custom one in points (width by height, turned when `orientation` says otherwise). */
  size?: PageSizeName | { width: number; height: number }
  orientation?: 'portrait' | 'landscape'
  /** Margins in points, all four or each side, and how far the header and footer sit from the edges. */
  margins?: number | Partial<PageMargins>
}

function sizeOf(current: PageSettings, change: PageChange): { width: number; height: number } {
  const { size, orientation } = change

  if (size && typeof size === 'object') {
    const turn = orientation !== undefined && (orientation === 'landscape') !== (size.width > size.height)

    return turn ? { width: size.height, height: size.width } : { width: size.width, height: size.height }
  }

  const named = size ? PAGE_SIZES[size] : null

  if (size && !named) {
    throw new Error(`Herald Docs has no “${size}” page size: it has ${Object.keys(PAGE_SIZES).join(', ')}, or a size of your own`)
  }

  const short = named ? named.width : Math.min(current.width, current.height)
  const long = named ? named.height : Math.max(current.width, current.height)
  const landscape = orientation ? orientation === 'landscape' : current.width > current.height

  return landscape ? { width: long, height: short } : { width: short, height: long }
}

/** A page with a change made to it; throws when the result could not be laid out. */
export function changedPage(current: PageSettings, change: PageChange): PageSettings {
  const all = change.margins
  const given = typeof all === 'number' ? { top: all, right: all, bottom: all, left: all } : (all ?? {})
  const margins = Object.fromEntries(Object.entries({ ...current.margins, ...given }).filter(([, value]) => value !== undefined)) as unknown as PageMargins
  const page: PageSettings = { ...sizeOf(current, change), margins }
  const problem = pageProblem(page)

  if (problem) {
    throw new Error(problem)
  }

  return page
}

const samePage = (a: PageSettings, b: PageSettings): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Change the document's page: its size, orientation, margins and header and footer distances. The
 * document's page is the first section's and that of sections that keep the page before them;
 * `sections: 'all'` makes the change to every section's page.
 */
export function setPage(change: PageChange, sections: 'document' | 'all' = 'document'): Op {
  return (state) => {
    const current = (state.doc.attrs.page as PageSettings | null) ?? defaultPage()
    const page = changedPage(current, change)
    const tr = state.tr

    if (!samePage(page, current) || !state.doc.attrs.page) {
      tr.setDocAttribute('page', page)
    }

    if (sections === 'all') {
      for (const section of documentSections(state.doc)) {
        if (section.own && section.breakPos !== null) {
          const next = changedPage(section.page, change)

          if (!samePage(next, section.page)) {
            tr.setNodeAttribute(section.breakPos, 'page', next)
          }
        }
      }
    }

    return tr.docChanged ? tr : null
  }
}

/** Change one section's page (0 is the document's); the sections after it that kept its page keep the page it had. */
export function setSectionPage(index: number, change: PageChange): Op {
  return (state) => {
    const sections = documentSections(state.doc)
    const section = Number.isInteger(index) ? sections[index] : undefined

    if (!section) {
      throw new Error(`The document has no section ${index + 1}: it has ${sections.length}`)
    }

    const page = changedPage(section.page, change)

    if (samePage(page, section.page) && section.own) {
      return null
    }

    const tr = state.tr

    for (let next = index + 1; next < sections.length && !sections[next].own; next++) {
      tr.setNodeAttribute(sections[next].breakPos!, 'page', section.page)
    }

    if (section.breakPos === null) {
      tr.setDocAttribute('page', page)
    } else {
      tr.setNodeAttribute(section.breakPos, 'page', page)
    }

    return tr
  }
}
