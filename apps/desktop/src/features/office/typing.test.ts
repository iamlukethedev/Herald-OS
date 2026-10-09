import { history, undo } from '@tiptap/pm/history'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { documentFromMarkdown } from '../../../shared/office/doc-text.ts'
import { applyLive, findText } from './docs/model.ts'
import { docsSchema } from './docs/schema.ts'
import { SlidesDocument } from './slides/document.ts'
import { $textSession, editStartFor, requestEditStart, type TextSession } from './slides/editor/active.ts'
import { addText, newDeck } from './slides/model.ts'
import { decks } from './slides/store.ts'
import { plainText } from './slides/text.ts'
import { addsNothing, characterBefore, columnPlacement, dictatedLines, quoted, typed, typeIntoOffice } from './typing.ts'

const slidesInFront = vi.hoisted(() => ({ presenting: null as { key: string; index: number } | null }))

vi.mock('../../store/windows.ts', async () => {
  const { atom } = await import('nanostores')

  return { $focusedWindowId: atom('slides'), $windows: atom({ slides: { phase: 'open', appId: 'slides' } }) }
})

vi.mock('./session.ts', () => ({ loadedSessions: new Map([['slides', { active: () => 'deck' }]]) }))

vi.mock('./slides/store.ts', () => ({ decks: new Map(), slidesSession: { active: () => ({ key: 'deck', name: 'Pitch' }) }, $presenting: { get: () => slidesInFront.presenting } }))

vi.mock('./slides/Present.tsx', () => ({ startPresenting: vi.fn() }))

vi.mock('../../store/edit-target.ts', () => ({ isEditable: (element: { editable?: boolean } | null) => Boolean(element?.editable) }))

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

describe('dictation into Herald Slides', () => {
  let doc: SlidesDocument
  let box: string

  beforeEach(() => {
    const deck = newDeck('Pitch')
    const added = addText(deck, deck.slides[0].id, { text: 'Hello' })
    doc = new SlidesDocument(added.deck, () => {})
    box = added.elementId
    decks.set('deck', doc)
    vi.stubGlobal('document', { activeElement: null })
  })

  afterEach(() => {
    decks.clear()
    $textSession.set(null)
    requestEditStart(null)
    slidesInFront.presenting = null
    vi.unstubAllGlobals()
  })

  /** The editor Herald Slides shows for a text box being typed into: its words, its root, and the words each flush recorded. */
  function editorFor(elementId: string, words: string) {
    const root = { editable: true }
    const view = {
      state: at(words, words),
      dom: { contains: (element: unknown) => element === root },
      dispatch(tr: Transaction) {
        view.state = view.state.apply(tr)
      }
    }
    const flushed: string[] = []
    const session = { editor: { isDestroyed: false, view }, doc, elementId, flush: () => flushed.push(view.state.doc.textContent), finish: () => {} } as unknown as TextSession

    return { session, root, flushed, text: () => view.state.doc.textContent }
  }

  /** The text box's editor comes up a moment after editing it starts, as React mounts it. */
  function mountsOnEdit(editor: ReturnType<typeof editorFor>): void {
    doc.subscribe(() => {
      if (doc.editing === editor.session.elementId) {
        setTimeout(() => $textSession.set(editor.session))
      }
    })
  }

  it('types at the caret of the text box being edited, what was typed before it a step of its own', async () => {
    const editor = editorFor(box, 'Hello')
    doc.edit(box)
    $textSession.set(editor.session)
    vi.stubGlobal('document', { activeElement: editor.root })

    expect(await typeIntoOffice('and welcome')).toBe('Typed "and welcome" in Pitch')
    expect(editor.text()).toBe('Hello and welcome')
    expect(editor.flushed).toEqual(['Hello', 'Hello and welcome'])
  })

  it('opens the selected text box, shape or table and types at its end, the box fitting the words in the same step', async () => {
    const editor = editorFor(box, 'Hello')
    doc.select([box])
    mountsOnEdit(editor)

    expect(await typeIntoOffice('and welcome')).toBe('Typed "and welcome" in Pitch')
    expect(editStartFor(box)).toEqual({ elementId: box, select: 'end' })
    expect(doc.editing).toBe(box)
    expect(editor.text()).toBe('Hello and welcome')
    expect(editor.flushed).toEqual(['Hello and welcome'])
  })

  it('puts the words in a new text box when nothing on the slide takes them, as one step, selected so the next dictation carries on in it', async () => {
    expect(await typeIntoOffice('Dear Sam,\nthanks for coming')).toBe('Typed "Dear Sam, thanks for coming" in a new text box in Pitch')

    const [added] = doc.selection

    expect(added.id).not.toBe(box)
    expect(added.kind === 'text' && plainText(added.body)).toBe('Dear Sam,\nthanks for coming')
    expect(doc.editing).toBeNull()
    expect(editStartFor(added.id)).toBeNull()

    const editor = editorFor(added.id, 'thanks for coming')
    mountsOnEdit(editor)

    expect(await typeIntoOffice('today')).toBe('Typed "today" in Pitch')
    expect(editStartFor(added.id)).toEqual({ elementId: added.id, select: 'end' })
    expect(editor.text()).toBe('thanks for coming today')
    expect(doc.history.undo()).toBe('New Text Box')
    expect(doc.history.canUndo).toBe(false)
  })

  it('leaves the words to the caller while presenting, in the speaker notes and for a bare press enter on the slide', async () => {
    slidesInFront.presenting = { key: 'deck', index: 0 }
    expect(await typeIntoOffice('hello')).toBeNull()

    slidesInFront.presenting = null
    vi.stubGlobal('document', { activeElement: { editable: true } })
    expect(await typeIntoOffice('hello')).toBeNull()

    vi.stubGlobal('document', { activeElement: null })
    doc.select([box])
    expect(await typeIntoOffice('', { submit: true })).toBeNull()
    expect(doc.editing).toBeNull()
    expect(doc.history.canUndo).toBe(false)
  })

  it('does not type a mark the caret follows already', async () => {
    const editor = editorFor(box, 'Hello,')
    doc.edit(box)
    $textSession.set(editor.session)

    expect(await typeIntoOffice(',')).toBe('Already after "," in Pitch')
    expect(editor.text()).toBe('Hello,')
    expect(editor.flushed).toEqual([])
  })
})
