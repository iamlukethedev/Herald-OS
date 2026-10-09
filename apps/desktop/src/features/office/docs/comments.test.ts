import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import type { Decoration } from '@tiptap/pm/view'
import { describe, expect, it } from 'vitest'
import type { CommentThread, DocJSON, DocMark, DocNode } from '../../../../shared/office/document.ts'
import { commentsKey, commentsPlugin } from './comments.ts'
import { applyLive, deleteComment, setCommentResolved } from './model.ts'
import { docsSchema } from './schema.ts'

// Which comment is in front, the comment being written, and the highlights, on a document made here.

const text = (value: string, marks: DocMark[] = []): DocNode => (marks.length ? { type: 'text', text: value, marks } : { type: 'text', text: value })
const comment = (id: string): DocMark => ({ type: 'comment', attrs: { id } })
const paragraph = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content })

const THREADS: CommentThread[] = [
  { id: '0', author: 'Ann Example', date: null, text: 'Long one' },
  { id: '2', author: 'Bo Example', date: null, text: 'Short one' },
  { id: '5', author: 'Ann Example', date: null, text: 'Done', resolved: true }
]

/** Comments 0 and 2 overlapping over two paragraphs (0 from 1 to 32, 2 from 14 to 41), and resolved comment 5 on “Costs” (52 to 57). */
const JSON_DOC: DocJSON = {
  type: 'doc',
  attrs: { comments: THREADS },
  content: [
    paragraph(text('Revenue rose ', [comment('0')]), text('by a third', [comment('0'), comment('2')])),
    paragraph(text('in May', [comment('0'), comment('2')]), text(' and June', [comment('2')]), text(' overall.')),
    paragraph(text('Costs', [comment('5')]), text(' fell sharply.'))
  ]
}

const start = (): EditorState => EditorState.create({ schema: docsSchema(), doc: docsSchema().nodeFromJSON(JSON_DOC), plugins: [commentsPlugin()] })
const caret = (state: EditorState, pos: number): EditorState => state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)))
const withMeta = (state: EditorState, meta: Record<string, unknown>): EditorState => state.apply(state.tr.setMeta(commentsKey, meta))
/** A state and dispatch, as an editor has them. */
function live(state: EditorState) {
  const view = {
    state,
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr)
    }
  }

  return view
}

const activeOf = (state: EditorState) => commentsKey.getState(state)?.active ?? null
const draftOf = (state: EditorState) => commentsKey.getState(state)?.draft ?? null

/** Each highlight: where it runs, its comment (null for the one being written), and whether it is the one in front. */
function highlights(state: EditorState): [number, number, string | null, boolean][] {
  const found: Decoration[] = commentsKey.getState(state)?.decorations.find() ?? []
  const classOf = (decoration: Decoration) => (decoration as unknown as { type: { attrs: { class: string } } }).type.attrs.class

  return found.map((decoration) => [decoration.from, decoration.to, decoration.spec.comment, classOf(decoration).includes('is-active')])
}

describe('the comment in front', () => {
  it('is the open comment the caret is in, the one on the least text where they overlap', () => {
    expect(activeOf(caret(start(), 5))).toBe('0')
    expect(activeOf(caret(start(), 18))).toBe('2')
    expect(activeOf(caret(start(), 1))).toBe('0')
    expect(activeOf(caret(start(), 54))).toBeNull()
    expect(activeOf(caret(caret(start(), 5), 45))).toBeNull()
  })

  it('stays the one picked while the caret moves inside its text, and goes when it is resolved or deleted', () => {
    const picked = withMeta(start(), { active: '0' })

    expect(activeOf(picked)).toBe('0')
    expect(activeOf(caret(picked, 18))).toBe('0')
    expect(activeOf(withMeta(start(), { active: '5' }))).toBeNull()

    const view = live(picked)
    applyLive(view, setCommentResolved('0', true))
    expect(activeOf(view.state)).toBeNull()

    view.state = withMeta(view.state, { active: '2' })
    applyLive(view, deleteComment('2'))
    expect(activeOf(view.state)).toBeNull()
  })
})

describe('the comment being written', () => {
  it('follows the text it is on through changes, and goes when that text does', () => {
    let state = withMeta(start(), { draft: { from: 58, to: 62 } })

    expect(state.doc.textBetween(58, 62)).toBe('fell')
    state = state.apply(state.tr.insertText('Total ', 52))
    expect(draftOf(state)).toEqual({ from: 64, to: 68 })
    state = state.apply(state.tr.insertText('ing', 68))
    expect(state.doc.textBetween(draftOf(state)!.from, draftOf(state)!.to)).toBe('fell')
    state = state.apply(state.tr.delete(63, 72))
    expect(draftOf(state)).toBeNull()
    expect(draftOf(withMeta(withMeta(start(), { draft: { from: 58, to: 62 } }), { draft: null }))).toBeNull()
  })
})

describe('highlights', () => {
  it('mark open comments, the one in front more strongly, and neither resolved comments nor plain text', () => {
    const state = withMeta(caret(start(), 5), { draft: { from: 58, to: 62 } })

    expect(highlights(state)).toEqual([
      [1, 14, '0', true],
      [14, 24, '0', true],
      [14, 24, '2', false],
      [26, 32, '0', true],
      [26, 32, '2', false],
      [32, 41, '2', false],
      [58, 62, null, true]
    ])
  })

  it('go when a comment is resolved', () => {
    const view = live(start())
    applyLive(view, setCommentResolved('2', true))

    expect(highlights(view.state).map(([from, to, id]) => [from, to, id])).toEqual([
      [1, 14, '0'],
      [14, 24, '0'],
      [26, 32, '0']
    ])
  })
})
