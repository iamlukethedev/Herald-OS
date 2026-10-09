import { history, undo } from '@tiptap/pm/history'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import { documentFromMarkdown } from '../../../shared/office/doc-text.ts'
import { applyLive, findText } from './docs/model.ts'
import { docsSchema } from './docs/schema.ts'
import { addsNothing, characterBefore, columnPlacement, dictatedLines, quoted, typed } from './typing.ts'

/** A document with the editor's history, the caret after the first match of `text` (or the match selected). */
function at(markdown: string, text: string, select = false): EditorState {
  const schema = docsSchema()
  const state = EditorState.create({ schema, doc: schema.nodeFromJSON(documentFromMarkdown(markdown).document), plugins: [history({ newGroupDelay: 500 })] })
  const [match] = findText(state.doc, text)

  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, select ? match.from : match.to, match.to)))
}

function run(state: EditorState, text: string, submit = false): EditorState {
  const tr = typed(text, submit)(state)

  expect(tr).not.toBeNull()
  const next = state.apply(tr!)
  next.doc.check()

  return next
}

const blocks = (state: EditorState) => state.doc.content.content.map((node) => `${node.type.name}${node.attrs.level ?? ''} ${node.textContent}`.trim())

/** The text of the paragraph the caret is in, with a bar at the caret. */
function caret(state: EditorState): string {
  const { $from } = state.selection
  const text = $from.parent.textContent

  return `${text.slice(0, $from.parentOffset)}|${text.slice($from.parentOffset)}`
}

describe('dictated text', () => {
  it('splits into lines at each new line, folding blank ones away', () => {
    expect(dictatedLines('Dear Sam')).toEqual(['Dear Sam'])
    expect(dictatedLines('Dear Sam,\nthanks for writing')).toEqual(['Dear Sam,', 'thanks for writing'])
    expect(dictatedLines(' one\n\ntwo \n three ')).toEqual(['one', 'two', 'three'])
    expect(dictatedLines('\nnext')).toEqual(['', 'next'])
    expect(dictatedLines('last\n')).toEqual(['last', ''])
    expect(dictatedLines('')).toEqual([''])
  })

  it('quotes the words on one line for a caption', () => {
    expect(quoted('Dear Sam,\nthanks')).toBe('Dear Sam, thanks')
    expect(quoted('word '.repeat(20))).toHaveLength(60)
  })
})

describe('dictation into Herald Sheets', () => {
  it('starts at the first cell of the selection, goes down the column and carries on below', () => {
    expect(columnPlacement('B2', 1)).toEqual({ first: 'B2', next: { row: 2, column: 1, name: 'B3' } })
    expect(columnPlacement('B2:D9', 3)).toEqual({ first: 'B2', next: { row: 4, column: 1, name: 'B5' } })
    expect(columnPlacement('C:C', 2)).toEqual({ first: 'C1', next: { row: 2, column: 2, name: 'C3' } })
    expect(columnPlacement('B2', 0)?.next.name).toBe('B3')
    expect(columnPlacement('nonsense', 1)).toBeNull()
  })
})

describe('dictation into Herald Docs', () => {
  it('reads the character before the caret', () => {
    const start = at('Hello world', 'Hello')

    expect(characterBefore(start)).toBe('o')
    expect(characterBefore(at('Hello world', 'Hello '))).toBe(' ')
    expect(characterBefore(start.apply(start.tr.setSelection(TextSelection.create(start.doc, 1))))).toBe('')
  })

  it('joins the text at the caret, with the space dictation leaves out', () => {
    expect(caret(run(at('Dear Sam', 'Dear Sam'), 'thanks for writing'))).toBe('Dear Sam thanks for writing|')
    expect(caret(run(at('Hello world', 'Hello '), 'big'))).toBe('Hello big|world')
    expect(caret(run(at('Hello world', 'world', true), 'there'))).toBe('Hello there|')
  })

  it('starts a new paragraph at each new line and leaves the caret after the last word', () => {
    const state = run(at('Dear Sam,', 'Dear Sam,'), '\nThanks for writing.\nSee you soon')

    expect(blocks(state)).toEqual(['paragraph Dear Sam,', 'paragraph Thanks for writing.', 'paragraph See you soon'])
    expect(caret(state)).toBe('See you soon|')
  })

  it('carries on in a plain paragraph after a heading, in the next item of a list, and on the next line of code', () => {
    expect(blocks(run(at('# Plan', 'Plan'), '\nFirst we book the flights'))).toEqual(['heading1 Plan', 'paragraph First we book the flights'])
    expect(run(at('- milk\n- bread', 'milk'), '\neggs').doc.firstChild!.content.content.map((item) => item.textContent)).toEqual(['milk', 'eggs', 'bread'])
    expect(run(at('```\nlet a = 1\n```', 'let a = 1'), '\nlet b = 2').doc.firstChild!.textContent).toBe('let a = 1\nlet b = 2')
  })

  it('presses Enter after the words when asked', () => {
    const state = run(at('Hello', 'Hello'), 'world', true)

    expect(blocks(state)).toEqual(['paragraph Hello world', 'paragraph'])
    expect(caret(state)).toBe('|')
  })

  it('keeps the formatting at the caret', () => {
    const last = run(at('Some **bold**', 'bold'), 'words').doc.firstChild!.lastChild!

    expect(last.text).toBe('bold words')
    expect(last.marks.map((mark) => mark.type.name)).toEqual(['bold'])
  })

  it('is one step to undo, apart from the typing before and after it', () => {
    const view = {
      state: at('Dear Sam', 'Dear Sam'),
      dispatch(tr: Transaction) {
        view.state = view.state.apply(tr)
      }
    }

    view.dispatch(view.state.tr.insertText(','))
    const before = view.state.doc

    expect(applyLive(view, typed('\nthanks for writing'))).toBe(true)
    view.dispatch(view.state.tr.insertText('!'))
    expect(blocks(view.state)).toEqual(['paragraph Dear Sam,', 'paragraph thanks for writing!'])
    undo(view.state, view.dispatch)
    undo(view.state, view.dispatch)
    expect(view.state.doc.eq(before)).toBe(true)
  })

  it('changes nothing when there is nothing to type', () => {
    expect(typed('')(at('Hello', 'Hello'))).toBeNull()
  })

  it('does not repeat the mark the caret follows already', () => {
    expect(caret(run(at('Hello,', 'Hello,'), ', world'))).toBe('Hello, world|')
    expect(caret(run(at('The end.', 'The end.'), '. Next'))).toBe('The end. Next|')
    expect(caret(run(at('Wait.', 'Wait.'), '..'))).toBe('Wait...|')
    expect(addsNothing(at('Hello,', 'Hello,'), ',')).toBe(true)
    expect(addsNothing(at('Really?', 'Really?'), '?')).toBe(true)
    expect(addsNothing(at('Hello', 'Hello'), ',')).toBe(false)
    expect(addsNothing(at('Hello,', 'Hello,'), ',', true)).toBe(false)
    expect(addsNothing(at('Hello,', 'Hello,'), ',\nnext')).toBe(false)
  })
})
