import { history, undo, undoDepth } from '@tiptap/pm/history'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import { afterEach, describe, expect, it } from 'vitest'
import { documentFromMarkdown } from '../../../../shared/office/doc-text.ts'
import type { CommentThread, DocJSON, DocMark, DocNode } from '../../../../shared/office/document.ts'
import { $author } from './comment-author.ts'
import {
  addComment,
  addComments,
  applyLive,
  applyToJSON,
  commentRange,
  comments,
  deleteAllComments,
  deleteComment,
  editComment,
  fillTocPages,
  insertTableOfContents,
  type Op,
  replyToComment,
  setCommentResolved,
  setTableOfContents,
  stateOf,
  tocAt,
  updateTablesOfContents,
  wordAt
} from './model.ts'
import { docsSchema } from './schema.ts'

// Comments and tables of contents through the document API, on documents made here.

const text = (value: string, marks: DocMark[] = []): DocNode => (marks.length ? { type: 'text', text: value, marks } : { type: 'text', text: value })
const comment = (id: string): DocMark => ({ type: 'comment', attrs: { id } })
const paragraph = (...content: (DocNode | string)[]): DocNode => ({ type: 'paragraph', content: content.map((item) => (typeof item === 'string' ? text(item) : item)) })

const THREADS: CommentThread[] = [
  { id: '0', author: 'Ann Example', initials: 'AE', date: '2026-10-01T09:00:00.000Z', text: 'Check the figures', resolved: true, replies: [{ id: '1', author: 'Bo Example', date: '2026-10-01T10:00:00.000Z', text: 'Done' }] },
  { id: '2', author: 'Bo Example', date: '2026-10-02T09:00:00.000Z', text: 'Overlaps' },
  { id: '7', author: 'Ann Example', date: '2026-10-03T09:00:00.000Z', text: 'Gone' }
]

/** Two comments over two paragraphs, overlapping, and one whose text was removed. */
const reviewed = (): DocJSON => ({
  type: 'doc',
  attrs: { comments: THREADS },
  content: [
    paragraph(text('Revenue rose ', [comment('0')]), text('by a third', [comment('0'), comment('2')])),
    paragraph(text('in May', [comment('0'), comment('2')]), text(' and June', [comment('2')]), ' overall.'),
    paragraph('Costs fell sharply.')
  ]
})

const PLAN = '# Plan\n\nIntro text.\n\n## Costs\n\nRent is due.\n\n### Detail\n\nSmall print.\n\n#### Deep\n\nMore.\n\n## Timeline\n\nSoon.\n'
const plan = (): DocJSON => documentFromMarkdown(PLAN).document

const threadsOf = (json: DocJSON | null): CommentThread[] => (json?.attrs?.comments as CommentThread[] | null | undefined) ?? []
const read = (json: DocJSON | null) => comments(stateOf(json!).doc)
const quotes = (json: DocJSON | null) => Object.fromEntries(read(json).map((thread) => [thread.id, thread.quote]))

/** The ids of the comment marks on each piece of text, in order. */
function marked(json: DocJSON | null): string[] {
  const out: string[] = []
  stateOf(json!).doc.descendants((node) => {
    if (node.isText) {
      out.push(`${node.text}:${node.marks.filter((mark) => mark.type.name === 'comment').map((mark) => mark.attrs.id).join(',')}`)
    }
  })

  return out
}

afterEach(() => $author.set(''))

describe('reading comments', () => {
  it('gives each thread in the order of its text, with what it quotes and where, and threads whose text went last', () => {
    const all = read(reviewed())

    expect(all.map((thread) => [thread.id, thread.from, thread.to, thread.resolved])).toEqual([
      ['0', 1, 32, true],
      ['2', 14, 41, false],
      ['7', null, null, false]
    ])
    expect(all.map((thread) => thread.quote)).toEqual(['Revenue rose by a third\nin May', 'by a third\nin May and June', ''])
    expect(all[0]).toMatchObject({ author: 'Ann Example', initials: 'AE', text: 'Check the figures', replies: [{ id: '1', text: 'Done' }] })
    expect(all[1]).toMatchObject({ initials: null, replies: [] })
  })

  it('finds the word at the caret, or nothing between words', () => {
    const { doc } = stateOf(reviewed())

    expect(wordAt(doc, 3)).toEqual({ from: 1, to: 8 })
    expect(wordAt(doc, 8)).toEqual({ from: 1, to: 8 })
    expect(doc.textBetween(wordAt(doc, 16)!.from, wordAt(doc, 16)!.to)).toBe('by')
    expect(wordAt(stateOf({ type: 'doc', content: [paragraph('a  b')] }).doc, 3)).toBeNull()
    expect(wordAt(doc, 0)).toBeNull()
  })

  it('takes a new comment on the selection, or on the word at the caret', () => {
    const state = stateOf(reviewed())
    const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3, 20)))

    expect(commentRange(selected)).toEqual({ from: 3, to: 20 })
    expect(commentRange(state.apply(state.tr.setSelection(TextSelection.create(state.doc, 45))))).toEqual({ from: 42, to: 49 })
  })
})

describe('adding comments', () => {
  it('comments the word at the caret, with an id of its own, the author and a date', () => {
    $author.set('Cy Example')
    const changed = applyToJSON(reviewed(), addComment('selection', 'Which revenue?'))
    const added = threadsOf(changed)[3]

    expect(added).toMatchObject({ id: '8', author: 'Cy Example', initials: 'CE', text: 'Which revenue?' })
    expect(Number.isNaN(Date.parse(added.date!))).toBe(false)
    expect(quotes(changed)['8']).toBe('Revenue')
    expect(threadsOf(changed).slice(0, 3)).toEqual(THREADS)
  })

  it('comments text, a range over paragraphs and a heading, overlapping comments already there', () => {
    const across = applyToJSON(reviewed(), addComment({ from: 9, to: 30 }, 'Across', { author: 'Ann Example', id: 'mine' }))

    expect(quotes(across).mine).toBe('rose by a third\nin M')
    expect(marked(across).slice(0, 4)).toEqual(['Revenue :0', 'rose :0,mine', 'by a third:0,2,mine', 'in M:0,2,mine'])
    expect(threadsOf(across).find((thread) => thread.id === 'mine')).toMatchObject({ author: 'Ann Example', initials: 'AE' })

    const found = applyToJSON(reviewed(), addComment({ text: 'sharply' }, 'Source?', { author: 'Bo Example', initials: null }))
    expect(quotes(found)['8']).toBe('sharply')
    expect(threadsOf(found)[3]).not.toHaveProperty('initials')

    const section = applyToJSON(plan(), addComment({ heading: 'Costs' }, 'Too long', { author: 'Ann Example' }))
    expect(quotes(section)['0']).toBe('Costs\nRent is due.\nDetail\nSmall print.\nDeep\nMore.')
  })

  it('adds nothing where there is no text, and never reuses an id', () => {
    const empty: DocJSON = { type: 'doc', content: [{ type: 'paragraph' }] }

    expect(applyToJSON(empty, addComment('selection', 'Hello'))).toBeNull()
    expect(applyToJSON(reviewed(), addComment({ text: 'missing' }, 'Hello'))).toBeNull()
    expect(() => applyToJSON(reviewed(), addComment({ text: 'Costs' }, 'Again', { id: '7' }))).toThrow('The document already has a comment “7”')
    expect(() => applyToJSON(reviewed(), addComment({ text: 'Costs' }, 'Again', { id: '1' }))).toThrow('already has a comment “1”')
  })

  it('adds a list of comments as one step, each with an id of its own', () => {
    const view = live(reviewed())
    const before = view.state.doc
    const list = [
      { target: { text: 'Costs' }, text: 'Which costs?' },
      { target: { text: 'June' }, text: 'And July?' },
      { target: { text: 'fell', all: true }, text: 'How much?' }
    ]

    expect(applyLive(view, addComments(list, 'Hermes'))).toBe(true)
    expect(comments(view.state.doc).map((thread) => [thread.id, thread.quote, thread.author, thread.initials])).toEqual([
      ['0', 'Revenue rose by a third\nin May', 'Ann Example', 'AE'],
      ['2', 'by a third\nin May and June', 'Bo Example', null],
      ['9', 'June', 'Hermes', 'H'],
      ['8', 'Costs', 'Hermes', 'H'],
      ['10', 'fell', 'Hermes', 'H'],
      ['7', '', 'Ann Example', null]
    ])
    expect(undoDepth(view.state)).toBe(1)
    undo(view.state, view.dispatch)
    expect(view.state.doc.eq(before)).toBe(true)
    expect(applyToJSON(reviewed(), addComments([{ target: { text: 'nowhere' }, text: 'x' }], 'Hermes'))).toBeNull()
  })
})

/** A live editor's state and dispatch, with the editor's own history. */
function live(json: DocJSON) {
  const view = {
    state: EditorState.create({ schema: docsSchema(), doc: docsSchema().nodeFromJSON(json), plugins: [history()] }),
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr)
    }
  }

  return view
}

describe('changing comments', () => {
  it('replies to a thread, with an id no comment has', () => {
    const changed = applyToJSON(reviewed(), replyToComment('2', 'Agreed', 'Cy Example'))

    expect(threadsOf(changed)[1].replies).toEqual([{ id: '8', author: 'Cy Example', initials: 'CE', date: expect.any(String), text: 'Agreed' }])
    expect(threadsOf(applyToJSON(reviewed(), replyToComment('0', 'More')))[0].replies?.map((reply) => [reply.id, reply.author])).toEqual([
      ['1', 'Bo Example'],
      ['8', '']
    ])
    expect(applyToJSON(reviewed(), replyToComment('1', 'To a reply'))).toBeNull()
  })

  it('edits what a comment or a reply says', () => {
    expect(threadsOf(applyToJSON(reviewed(), editComment('2', 'Overlaps, twice')))[1].text).toBe('Overlaps, twice')
    expect(threadsOf(applyToJSON(reviewed(), editComment('1', 'Done now')))[0].replies?.[0].text).toBe('Done now')
    expect(applyToJSON(reviewed(), editComment('2', 'Overlaps'))).toBeNull()
    expect(applyToJSON(reviewed(), editComment('9', 'Nobody'))).toBeNull()
  })

  it('resolves and reopens a thread', () => {
    expect(threadsOf(applyToJSON(reviewed(), setCommentResolved('2', true)))[1]).toEqual({ ...THREADS[1], resolved: true })
    expect(threadsOf(applyToJSON(reviewed(), setCommentResolved('0', false)))[0]).not.toHaveProperty('resolved')
    expect(applyToJSON(reviewed(), setCommentResolved('0', true))).toBeNull()
    expect(applyToJSON(reviewed(), setCommentResolved('1', true))).toBeNull()
  })

  it('deletes a thread with its marks, leaving the comments over it, or a reply', () => {
    const changed = applyToJSON(reviewed(), deleteComment('0'))

    expect(threadsOf(changed).map((thread) => thread.id)).toEqual(['2', '7'])
    expect(marked(changed)).toEqual(['Revenue rose :', 'by a third:2', 'in May and June:2', ' overall.:', 'Costs fell sharply.:'])
    expect(threadsOf(applyToJSON(reviewed(), deleteComment('1')))[0]).not.toHaveProperty('replies')
    expect(threadsOf(applyToJSON(reviewed(), deleteComment('7'))).map((thread) => thread.id)).toEqual(['0', '2'])
    expect(applyToJSON(reviewed(), deleteComment('5'))).toBeNull()
  })

  it('deletes every comment, and does nothing to a document without any', () => {
    const changed = applyToJSON(reviewed(), deleteAllComments())

    expect(changed?.attrs?.comments).toBeNull()
    expect(marked(changed).every((piece) => piece.endsWith(':'))).toBe(true)
    expect(applyToJSON(plan(), deleteAllComments())).toBeNull()
  })

  it('undoes each change in one step', () => {
    const view = live(reviewed())
    const ops: Op[] = [addComment({ text: 'Costs' }, 'Why?', { author: 'Ann Example' }), replyToComment('2', 'Yes'), editComment('7', 'Back'), setCommentResolved('2', true), deleteComment('0'), deleteAllComments()]
    // A mark put back by undo comes after the others of its kind: the same comments, in another order.
    const canonical = (doc: typeof view.state.doc) => JSON.stringify(doc.toJSON(), (key, value) => (key === 'marks' ? [...value].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : value))

    for (const op of ops) {
      const start = canonical(view.state.doc)
      expect(applyLive(view, op)).toBe(true)
      undo(view.state, view.dispatch)
      expect(canonical(view.state.doc)).toBe(start)
    }
  })
})

describe('tables of contents', () => {
  const tocOf = (json: DocJSON | null, index = 0) => json?.content.filter((block) => block.type === 'tableOfContents')[index]

  it('inserts one listing three levels under “Contents”, or as asked, where asked', () => {
    const inserted = applyToJSON(plan(), insertTableOfContents({}, 'start'))

    expect(inserted?.content[0]).toEqual({ type: 'tableOfContents', attrs: { levels: 3, title: 'Contents', pages: null } })

    const own = applyToJSON(plan(), insertTableOfContents({ levels: 9, title: null }, { heading: 'Costs', mode: 'prepend' }))
    expect(own?.content.map((block) => block.type).slice(2, 6)).toEqual(['heading', 'tableOfContents', 'paragraph', 'heading'])
    expect(tocOf(own)?.attrs).toEqual({ levels: 6, title: null, pages: null })
  })

  it('finds a table of contents by position or by its place among them', () => {
    const json = applyToJSON(applyToJSON(plan(), insertTableOfContents({}, 'start'))!, insertTableOfContents({ levels: 1 }, 'end'))!
    const { doc } = stateOf(json)
    const last = doc.content.size - doc.lastChild!.nodeSize - 1

    expect(tocAt(doc, 0)).toBe(0)
    expect(tocAt(doc, { index: 0 })).toBe(0)
    expect(tocAt(doc, { index: 1 })).toBe(last)
    expect(doc.nodeAt(last)?.attrs.levels).toBe(1)
    expect(tocAt(doc, 3)).toBeNull()
    expect(tocAt(doc, { index: 2 })).toBeNull()
  })

  it('changes its levels and title, letting the pages it kept go when it lists other levels', () => {
    const json = applyToJSON(applyToJSON(plan(), insertTableOfContents({}, 'start'))!, updateTablesOfContents([1, 1, 2, 3, 3]))!

    expect(tocOf(json)?.attrs?.pages).toEqual([1, 1, 2, 3])
    expect(tocOf(applyToJSON(json, setTableOfContents(0, { title: 'In this plan' })))?.attrs).toEqual({ levels: 3, title: 'In this plan', pages: [1, 1, 2, 3] })
    expect(tocOf(applyToJSON(json, setTableOfContents({ index: 0 }, { levels: 2 })))?.attrs).toEqual({ levels: 2, title: 'Contents', pages: null })
    expect(applyToJSON(json, setTableOfContents(0, { levels: 3, title: 'Contents' }))).toBeNull()
    expect(applyToJSON(json, setTableOfContents(1, { levels: 2 }))).toBeNull()
  })

  it('keeps the page each entry is on, and lets pages go that no longer fit the entries', () => {
    const json = applyToJSON(plan(), insertTableOfContents({ levels: 4 }, 'start'))!
    const paged = applyToJSON(json, updateTablesOfContents([1, 1, 2, null, 3]))!

    expect(tocOf(paged)?.attrs?.pages).toEqual([1, 1, 2, null, 3])
    expect(applyToJSON(paged, updateTablesOfContents([1, 1, 2, null, 3]))).toBeNull()
    expect(applyToJSON(paged, updateTablesOfContents())).toBeNull()

    const longer = applyToJSON(paged, addHeading('Appendix'))!
    expect(tocOf(applyToJSON(longer, updateTablesOfContents()))?.attrs?.pages).toBeNull()
    expect(applyToJSON(json, updateTablesOfContents([]))).toBeNull()
  })

  it('fills the pages a saved document keeps, without changing the document it was given', () => {
    const json = applyToJSON(plan(), insertTableOfContents({}, 'start'))!
    const filled = fillTocPages(json, [2, 2, 3, 4, 5])

    expect(tocOf(filled)?.attrs?.pages).toEqual([2, 2, 3, 5])
    expect(tocOf(json)?.attrs?.pages).toBeNull()
    expect(filled.content.slice(1)).toEqual(json.content.slice(1))
    expect(filled.content[1]).toBe(json.content[1])
    expect(fillTocPages(json, undefined)).toBe(json)
    expect(fillTocPages(filled, [2, 2, 3, 4, 5])).toBe(filled)
  })
})

/** A level-one heading at the end. */
const addHeading = (title: string): Op => (state) => state.tr.insert(state.doc.content.size, state.schema.nodes.heading.create({ level: 1 }, state.schema.text(title)))
