import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { type CommentReply, type CommentThread, commentsOf, type DocJSON, type DocNode, type TocAttrs, tocEntries } from '../../../../shared/office/document.ts'
import { $author, initialsOf } from './comment-author.ts'
import { insertNodes, type Op, type Place, type Range, type Target, targetRanges } from './model.ts'

/*
 * The document API for reviewing: comments and their replies, and tables of contents, as operations
 * on a document like model.ts's, for the editor and for Hermes. A comment is a thread in the
 * document's `comments` attr whose text carries a `comment` mark with the thread's id; a change to
 * comments is one transaction, marks and threads together, so one step to undo. A table of
 * contents lists the headings as they are and keeps only the page each entry was last on.
 */

// Comments: reading.

/** A thread with where its text is: the text quoted, and its first and last positions (null when the text was removed). */
export interface CommentInfo {
  id: string
  author: string
  initials: string | null
  date: string | null
  text: string
  resolved: boolean
  replies: CommentReply[]
  /** Its pieces in different blocks on lines of their own; empty when the text was removed. */
  quote: string
  from: number | null
  to: number | null
}

export interface CommentSpan {
  from: number
  to: number
  quote: string
}

const spanCache = new WeakMap<PMNode, Map<string, CommentSpan>>()

const commentId = (mark: { type: { name: string }; attrs: Record<string, unknown> }): string | null => (mark.type.name === 'comment' && typeof mark.attrs.id === 'string' ? mark.attrs.id : null)

/** Where the text each comment mark is on runs, by the mark's id, in the order the texts start. */
export function commentSpans(doc: PMNode): ReadonlyMap<string, Readonly<CommentSpan>> {
  const cached = spanCache.get(doc)

  if (cached) {
    return cached
  }

  const spans = new Map<string, CommentSpan>()
  const blockOf = new Map<string, number>()
  let block = -1

  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      block = pos

      return true
    }

    if (!node.isInline) {
      return true
    }

    const text = node.isText ? (node.text ?? '') : node.type.name === 'hardBreak' ? '\n' : ''

    for (const mark of node.marks) {
      const id = commentId(mark)

      if (!id) {
        continue
      }

      const span = spans.get(id)

      if (span) {
        span.quote += (span.to === pos ? '' : blockOf.get(id) === block ? ' … ' : '\n') + text
        span.to = pos + node.nodeSize
      } else {
        spans.set(id, { from: pos, to: pos + node.nodeSize, quote: text })
      }

      blockOf.set(id, block)
    }

    return false
  })
  spanCache.set(doc, spans)

  return spans
}

const threadsOf = (doc: PMNode): CommentThread[] => commentsOf({ type: 'doc', attrs: doc.attrs }).filter((thread) => typeof thread?.id === 'string')

/** The document's comment threads in the order of their text, threads whose text was removed last. */
export function comments(doc: PMNode): CommentInfo[] {
  const spans = commentSpans(doc)
  const out = threadsOf(doc).map((thread): CommentInfo => {
    const span = spans.get(thread.id)

    return {
      id: thread.id,
      author: thread.author ?? '',
      initials: thread.initials ?? null,
      date: thread.date ?? null,
      text: thread.text ?? '',
      resolved: thread.resolved === true,
      replies: thread.replies ?? [],
      quote: span?.quote ?? '',
      from: span?.from ?? null,
      to: span?.to ?? null
    }
  })

  return out.sort((a, b) => (a.from === null ? (b.from === null ? 0 : 1) : b.from === null ? -1 : a.from - b.from))
}

// Comments: changes.

const WORD = /[\p{L}\p{N}_'’]/u

/** The word a position is in or beside, or null where there is none. */
export function wordAt(doc: PMNode, pos: number): Range | null {
  const $pos = doc.resolve(pos)
  const block = $pos.parent

  if (!block.isTextblock) {
    return null
  }

  // Pictures and other inline nodes count as one character, as they take one position.
  const text = block.textBetween(0, block.content.size, undefined, '\uFFFC')
  let start = $pos.parentOffset
  let end = start

  while (start > 0 && WORD.test(text[start - 1])) {
    start--
  }

  while (end < text.length && WORD.test(text[end])) {
    end++
  }

  return end > start ? { from: $pos.start() + start, to: $pos.start() + end } : null
}

/** What a new comment is on: the selection, or the word at the caret when nothing is selected. */
export function commentRange(state: EditorState): Range | null {
  const { from, to, empty } = state.selection

  return empty ? wordAt(state.doc, from) : { from, to }
}

function rangesFor(state: EditorState, target: Target): Range[] {
  if (target === 'selection') {
    const range = commentRange(state)

    return range ? [range] : []
  }

  return targetRanges(state, target).filter((range) => range.to > range.from)
}

function hasInline(doc: PMNode, { from, to }: Range): boolean {
  let found = false
  doc.nodesBetween(from, to, (node) => {
    found ||= node.isInline

    return !found
  })

  return found
}

/** Comment marks' ids in JSON (a note's text, headers and footers). */
function jsonIds(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => jsonIds(item, out))
  } else if (value && typeof value === 'object') {
    const node = value as { type?: unknown; attrs?: { id?: unknown } }

    if (node.type === 'comment' && typeof node.attrs?.id === 'string') {
      out.add(node.attrs.id)
    }

    Object.values(value).forEach((item) => jsonIds(item, out))
  }
}

/** Every id comments use in a document (threads', replies' and marks', in its text, notes and headers), so that a new one is none of them. */
function usedIds(doc: PMNode): Set<string> {
  const used = new Set<string>()

  for (const thread of threadsOf(doc)) {
    used.add(thread.id)
    thread.replies?.forEach((reply) => used.add(reply.id))
  }

  doc.descendants((node) => {
    for (const mark of node.marks) {
      const id = commentId(mark)

      if (id) {
        used.add(id)
      }
    }

    if (node.type.name === 'note') {
      jsonIds(node.attrs.content, used)
    }

    return true
  })
  jsonIds(doc.attrs.headers, used)

  return used
}

/** The number after the highest one in use, as Word numbers its comments; added to `used`. */
function nextId(used: Set<string>): string {
  let next = 0

  for (const id of used) {
    if (/^\d{1,15}$/.test(id)) {
      next = Math.max(next, Number(id) + 1)
    }
  }

  const id = String(next)
  used.add(id)

  return id
}

/** The id the next comment added to `doc` gets when it is not given one. */
export const newCommentId = (doc: PMNode): string => nextId(usedIds(doc))

export interface CommentOptions {
  /** Who wrote it: the name the person gave Herald when left out. */
  author?: string
  initials?: string | null
  /** The new thread's id (the first one's, when the target has several ranges); one the document does not use is made when left out. */
  id?: string
}

/** One comment to add: what it is on, and what it says. */
export interface CommentSpec {
  target: Target
  text: string
}

const signed = (author: string, initials: string | null | undefined = initialsOf(author)) => ({ author, ...(initials ? { initials } : {}), date: new Date().toISOString() })

function addThreads(state: EditorState, list: readonly CommentSpec[], options: CommentOptions): Transaction | null {
  const used = usedIds(state.doc)
  let named = options.id

  if (named !== undefined && used.has(named)) {
    throw new Error(`The document already has a comment “${named}”`)
  }

  const tr = state.tr
  const by = signed(options.author ?? $author.get(), options.initials)
  const added: CommentThread[] = []

  for (const { target, text } of list) {
    for (const range of rangesFor(state, target)) {
      // Marks change no positions, so the ranges hold for every comment added.
      if (!hasInline(tr.doc, range)) {
        continue
      }

      const id = named ?? nextId(used)
      named = undefined
      used.add(id)
      tr.addMark(range.from, range.to, state.schema.marks.comment.create({ id }))
      added.push({ id, ...by, text })
    }
  }

  return added.length ? tr.setDocAttribute('comments', [...threadsOf(state.doc), ...added]) : null
}

/**
 * A comment on each range of a target: the selection (the word at the caret when nothing is
 * selected), a heading or its section, the first match of some text or every match, or a range.
 * Overlapping comments and comments over several paragraphs are as Word has them.
 */
export const addComment = (target: Target, text: string, options: CommentOptions = {}): Op => (state) => addThreads(state, [{ target, text }], options)

/** Several comments by one author (Hermes's review, say) as one step. */
export const addComments = (list: readonly CommentSpec[], author?: string): Op => (state) => addThreads(state, list, author === undefined ? {} : { author })

export function replyToComment(id: string, text: string, author?: string): Op {
  return (state) => {
    const threads = threadsOf(state.doc)

    if (!threads.some((thread) => thread.id === id)) {
      return null
    }

    const reply: CommentReply = { id: nextId(usedIds(state.doc)), ...signed(author ?? $author.get()), text }

    return state.tr.setDocAttribute(
      'comments',
      threads.map((thread) => (thread.id === id ? { ...thread, replies: [...(thread.replies ?? []), reply] } : thread))
    )
  }
}

/** Change what a comment or a reply says. */
export function editComment(id: string, text: string): Op {
  return (state) => {
    let changed = false
    const threads = threadsOf(state.doc).map((thread) => {
      if (thread.id === id) {
        changed = thread.text !== text

        return changed ? { ...thread, text } : thread
      }

      const reply = thread.replies?.find((entry) => entry.id === id)

      if (!reply || reply.text === text) {
        return thread
      }

      changed = true

      return { ...thread, replies: thread.replies!.map((entry) => (entry === reply ? { ...entry, text } : entry)) }
    })

    return changed ? state.tr.setDocAttribute('comments', threads) : null
  }
}

export function setCommentResolved(id: string, resolved: boolean): Op {
  return (state) => {
    const threads = threadsOf(state.doc)
    const thread = threads.find((entry) => entry.id === id)

    if (!thread || (thread.resolved === true) === resolved) {
      return null
    }

    const { resolved: _was, ...open } = thread

    return state.tr.setDocAttribute(
      'comments',
      threads.map((entry) => (entry === thread ? (resolved ? { ...open, resolved: true } : open) : entry))
    )
  }
}

/** Delete a thread with the marks on its text, or one reply. */
export function deleteComment(id: string): Op {
  return (state) => {
    const threads = threadsOf(state.doc)

    if (threads.some((thread) => thread.id === id)) {
      const rest = threads.filter((thread) => thread.id !== id)

      return state.tr.removeMark(0, state.doc.content.size, state.schema.marks.comment.create({ id })).setDocAttribute('comments', rest.length ? rest : null)
    }

    const owner = threads.find((thread) => thread.replies?.some((reply) => reply.id === id))

    if (!owner) {
      return null
    }

    return state.tr.setDocAttribute(
      'comments',
      threads.map((thread) => {
        if (thread !== owner) {
          return thread
        }

        const { replies, ...own } = thread
        const kept = (replies ?? []).filter((reply) => reply.id !== id)

        return kept.length ? { ...own, replies: kept } : own
      })
    )
  }
}

export function deleteAllComments(): Op {
  return (state) => {
    const tr = state.tr.removeMark(0, state.doc.content.size, state.schema.marks.comment)

    if (threadsOf(state.doc).length) {
      tr.setDocAttribute('comments', null)
    }

    return tr.docChanged ? tr : null
  }
}

// Tables of contents.

export const tocLevels = (value: unknown): number => Math.min(6, Math.max(1, Math.round(Number(value)) || 3))

const headingDocs = new WeakMap<PMNode, DocJSON>()

/** A document of `doc`'s headings alone, in order: what a table of contents lists, without converting the rest. */
export function headingsOf(doc: PMNode): DocJSON {
  let out = headingDocs.get(doc)

  if (!out) {
    const content: DocNode[] = []
    doc.descendants((node) => {
      if (node.type.name === 'heading') {
        content.push(node.toJSON() as DocNode)
      }

      return !node.isTextblock
    })
    out = { type: 'doc', content }
    headingDocs.set(doc, out)
  }

  return out
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * The page each entry of a table of contents listing `levels` levels of `doc` is on, from the page
 * each heading is on (by its place among the headings), or null when none is known. Without
 * heading pages, the pages it `had` are kept while there is one for each entry.
 */
export function tocPages(doc: DocNode, levels: number, headingPages?: readonly (number | null | undefined)[] | null, had?: unknown): (number | null)[] | null {
  const entries = tocEntries(doc, tocLevels(levels))

  if (!headingPages) {
    return Array.isArray(had) && had.length === entries.length ? had.map(finite) : null
  }

  const pages = entries.map((entry) => finite(headingPages[entry.heading]))

  return pages.some((page) => page !== null) ? pages : null
}

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

/** A document's JSON with the page each entry of its tables of contents is on, from the page each heading is on; the same JSON when nothing changes. */
export function fillTocPages(json: DocJSON, headingPages: readonly (number | null | undefined)[] | null | undefined): DocJSON {
  if (!headingPages) {
    return json
  }

  const fill = (node: DocNode): DocNode => {
    if (node.type === 'tableOfContents') {
      const pages = tocPages(json, Number(node.attrs?.levels), headingPages)

      return same(pages, node.attrs?.pages ?? null) ? node : { ...node, attrs: { ...node.attrs, pages } }
    }

    const content = node.content?.map(fill)

    return content?.some((child, index) => child !== node.content![index]) ? { ...node, content } : node
  }

  return fill(json) as DocJSON
}

export interface TocOptions {
  /** The heading levels it lists, from 1 to 6 (3 when left out). */
  levels?: number
  /** Its title ("Contents" when left out), or null for none. */
  title?: string | null
}

/** A table of contents, at the caret unless placed elsewhere. */
export function insertTableOfContents(options: TocOptions = {}, place: Place = 'selection'): Op {
  const attrs = { levels: tocLevels(options.levels ?? 3), title: options.title === undefined ? 'Contents' : options.title || null, pages: null }

  return insertNodes((schema) => [schema.nodes.tableOfContents.create(attrs)], place)
}

/** A table of contents by its position, or by its place among the document's tables of contents (`{ index: 0 }` is the first). */
export type TocRef = number | { index: number }

/** Where the table of contents `at` refers to is, or null when there is none. */
export function tocAt(doc: PMNode, at: TocRef): number | null {
  if (typeof at === 'number') {
    return at >= 0 && at < doc.content.size && doc.nodeAt(at)?.type.name === 'tableOfContents' ? at : null
  }

  let found: number | null = null
  let count = 0
  doc.descendants((node, pos) => {
    if (found !== null) {
      return false
    }

    if (node.type.name === 'tableOfContents') {
      if (count++ === at.index) {
        found = pos
      }

      return false
    }

    return !node.isTextblock
  })

  return found
}

/** Change a table of contents' levels, title or kept pages; the pages it kept go when it lists other levels. A selected one stays selected. */
export function setTableOfContents(at: TocRef, attrs: Partial<TocAttrs>): Op {
  return (state) => {
    const pos = tocAt(state.doc, at)
    const node = pos === null ? null : state.doc.nodeAt(pos)

    if (pos === null || !node) {
      return null
    }

    const levels = attrs.levels === undefined ? node.attrs.levels : tocLevels(attrs.levels)
    const next: Record<string, unknown> = {
      levels,
      title: attrs.title === undefined ? node.attrs.title : attrs.title || null,
      pages: attrs.pages !== undefined ? attrs.pages : levels === node.attrs.levels ? node.attrs.pages : null
    }
    const tr = state.tr

    for (const [name, value] of Object.entries(next)) {
      if (!same(node.attrs[name], value)) {
        tr.setNodeAttribute(pos, name, value)
      }
    }

    return tr.docChanged ? tr : null
  }
}

/**
 * Keep the page each entry of every table of contents is on, from the page each heading is on (a
 * page map's `headings`). Without them, pages that no longer fit the entries are let go.
 */
export function updateTablesOfContents(headingPages?: readonly (number | null | undefined)[] | null): Op {
  return (state) => {
    const tr = state.tr
    const headings = headingsOf(state.doc)
    state.doc.descendants((node, pos) => {
      if (node.type.name !== 'tableOfContents') {
        return !node.isTextblock
      }

      const pages = tocPages(headings, node.attrs.levels, headingPages, node.attrs.pages)

      if (!same(pages, node.attrs.pages)) {
        tr.setNodeAttribute(pos, 'pages', pages)
      }

      return false
    })

    return tr.docChanged ? tr : null
  }
}
