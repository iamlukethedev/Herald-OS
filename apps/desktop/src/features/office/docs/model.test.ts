import { history, undo, undoDepth } from '@tiptap/pm/history'
import { EditorState, NodeSelection, TextSelection, type Transaction } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import { documentFromMarkdown } from '../../../../shared/office/doc-text.ts'
import { blankDocument, countCharacters, countWords, type DocJSON } from '../../../../shared/office/document.ts'
import {
  applyLive,
  applyToJSON,
  clearFormatting,
  counts,
  documentText,
  findHeading,
  findText,
  indent,
  insert,
  insertImage,
  insertList,
  insertPageBreak,
  insertTable,
  jsonOf,
  type Op,
  outline,
  replaceSection,
  replaceText,
  sectionOf,
  setAlignment,
  setImageAttrs,
  setLineSpacing,
  setMarks,
  setPage,
  setStyle,
  stateOf,
  styleAt
} from './model.ts'
import { docsSchema } from './schema.ts'

const fromMarkdown = (markdown: string): DocJSON => documentFromMarkdown(markdown).document
const markdownState = (markdown: string) => stateOf(fromMarkdown(markdown))

/** A state with the caret (or a selection) at the first match of `text`, at its end unless `select`. */
function at(state: EditorState, text: string, select = false): EditorState {
  const [match] = findText(state.doc, text)

  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, select ? match.from : match.to, match.to)))
}

function run(state: EditorState, op: Op): EditorState {
  const tr = op(state)

  expect(tr).not.toBeNull()
  const next = state.apply(tr!)
  next.doc.check()

  return next
}

const blocks = (state: EditorState) => state.doc.content.content.map((node) => `${node.type.name}${node.attrs.level ? node.attrs.level : ''}${node.attrs.docStyle ? `:${node.attrs.docStyle}` : ''} ${node.textContent}`.trim())

const PLAN = '# Plan\n\nIntro text.\n\n## Costs\n\nRent is due.\n\n### Detail\n\nSmall print.\n\n## Timeline\n\nSoon.\n'

describe('reading', () => {
  it('gives the outline, sections, text and counts', () => {
    const state = markdownState(PLAN)
    const costs = findHeading(state.doc, 'costs')!

    expect(outline(state.doc).map((entry) => [entry.level, entry.text])).toEqual([
      [1, 'Plan'],
      [2, 'Costs'],
      [3, 'Detail'],
      [2, 'Timeline']
    ])
    expect(state.doc.textBetween(sectionOf(state.doc, costs).from, sectionOf(state.doc, costs).to, '|')).toBe('Rent is due.|Detail|Small print.')
    expect(findHeading(state.doc, 'Time')?.text).toBe('Timeline')
    expect(findHeading(state.doc, 3)?.text).toBe('Timeline')
    expect(documentText(state.doc)).toBe('Plan\nIntro text.\nCosts\nRent is due.\nDetail\nSmall print.\nTimeline\nSoon.')
    expect(counts(state.doc)).toEqual({ words: 12, characters: 63 })
  })

  it('counts block by block what the whole text counts, after an edit too', () => {
    const state = markdownState('# Title\n\nFirst line  \nsecond line, with words.\n\n- one item\n- two items\n\n| A | B |\n| - | - |\n| cell one | cell two |\n\n> quoted words here\n\n```\ncode block text\n```\n')
    const whole = (doc: EditorState['doc']) => {
      const text = documentText(doc)

      return { words: countWords(text), characters: countCharacters(text) }
    }

    expect(counts(state.doc)).toEqual(whole(state.doc))
    expect(counts(state.doc).words).toBe(23)
    const [match] = findText(state.doc, 'two items')
    const edited = state.apply(state.tr.insertText(' and three more', match.to))

    expect(counts(edited.doc)).toEqual(whole(edited.doc))
    expect(counts(edited.doc).words).toBe(26)
    expect(counts(state.doc).words).toBe(23)
  })

  it('finds text across formatting, by case, whole words and patterns', () => {
    const state = markdownState('The **cat** sat; *Cat*alogue, concat.\n\nA cat.\n')
    const texts = (query: string, options = {}) => findText(state.doc, query, options).map((match) => state.doc.textBetween(match.from, match.to))

    expect(texts('cat')).toEqual(['cat', 'Cat', 'cat', 'cat'])
    expect(texts('cat', { caseSensitive: true })).toEqual(['cat', 'cat', 'cat'])
    expect(texts('cat', { wholeWord: true })).toEqual(['cat', 'cat'])
    expect(texts('c[a-z]+t', { regex: true, caseSensitive: true })).toEqual(['cat', 'concat', 'cat'])
    expect(texts('(')).toEqual([])
    expect(texts('(', { regex: true })).toEqual([])
  })
})

describe('inserting', () => {
  it('fills an empty document, and goes in at the end', () => {
    const state = run(stateOf(blankDocument()), insert('# Notes\n\n- one\n- two\n'))

    expect(blocks(state)).toEqual(['heading1 Notes', 'bulletList onetwo'])
    expect(blocks(run(state, insert({ text: 'Last line' }, 'end')))).toEqual(['heading1 Notes', 'bulletList onetwo', 'paragraph Last line'])
  })

  it('adds to, starts and replaces what is under a heading', () => {
    const state = markdownState(PLAN)

    expect(blocks(run(state, insert('Deposit paid.', { heading: 'Costs' })))).toContain('paragraph Deposit paid.')
    expect(blocks(run(state, insert('Deposit paid.', { heading: 'Costs' }))).indexOf('paragraph Deposit paid.')).toBe(blocks(state).indexOf('paragraph Small print.') + 1)
    expect(blocks(run(state, insert('First.', { heading: 'Costs', mode: 'prepend' })))[3]).toBe('paragraph First.')
    expect(blocks(run(state, replaceSection('Costs', 'All paid.')))).toEqual(['heading1 Plan', 'paragraph Intro text.', 'heading2 Costs', 'paragraph All paid.', 'heading2 Timeline', 'paragraph Soon.'])
    expect(() => insert('x', { heading: 'Nowhere' })(state)).toThrow('The document has no heading “Nowhere”')
  })

  it('puts one paragraph into the line at the caret, and splits it for blocks', () => {
    const state = at(markdownState('Hello world.\n'), 'Hello ')

    expect(blocks(run(state, insert('**big**', 'selection')))).toEqual(['paragraph Hello bigworld.'])
    expect(run(state, insert('**big**', 'selection')).doc.firstChild!.child(1).marks.map((mark) => mark.type.name)).toEqual(['bold'])
    expect(blocks(run(state, insert({ text: 'big ' }, 'selection')))).toEqual(['paragraph Hello big world.'])
    expect(blocks(run(state, insertTable({ rows: 2, cols: 2, cells: [['a', 'b']] }, 'selection')))).toEqual(['paragraph Hello', 'table ab', 'paragraph world.'])
    expect(blocks(run(state, insertPageBreak()))).toEqual(['paragraph Hello', 'pageBreak', 'paragraph world.'])
  })

  it('inserts tables with a header row, pictures and lists', () => {
    const state = stateOf(blankDocument())
    const table = run(state, insertTable({ rows: 3, cols: 2, cells: [['Item', 'Cost']], widths: [200, 100] })).doc.firstChild!

    expect(table.type.name).toBe('table')
    expect(table.firstChild!.firstChild!.type.name).toBe('tableHeader')
    expect(table.child(1).firstChild!.type.name).toBe('tableCell')
    expect(table.firstChild!.firstChild!.attrs.colwidth).toEqual([200])

    const picture = run(state, insertImage({ src: 'data:image/png;base64,AA==', alt: 'A dot', width: 10, height: 10 })).doc.firstChild!

    expect(picture.type.name).toBe('paragraph')
    expect(picture.firstChild!.attrs).toMatchObject({ alt: 'A dot', width: 10 })

    const list = run(state, insertList({ items: ['Milk', 'Eggs'], kind: 'task', checked: [true] })).doc.firstChild!

    expect(list.type.name).toBe('taskList')
    expect(list.content.content.map((item) => [item.attrs.checked, item.textContent])).toEqual([
      [true, 'Milk'],
      [false, 'Eggs']
    ])
    expect(run(state, insertList({ items: ['a'], kind: 'ordered', start: 4 })).doc.firstChild!.attrs.start).toBe(4)
  })

  it('changes a picture’s size and description, and a selected picture stays selected', () => {
    const inserted = run(stateOf(blankDocument()), insertImage({ src: 'data:image/png;base64,AA==', width: 40, height: 20 }))
    let pos = -1
    inserted.doc.descendants((node, offset) => {
      if (node.type.name === 'image') {
        pos = offset
      }
    })
    const selected = inserted.apply(inserted.tr.setSelection(NodeSelection.create(inserted.doc, pos)))
    const changed = run(selected, setImageAttrs(pos, { width: 20, height: 10, alt: 'A dot' }))

    expect(changed.doc.nodeAt(pos)!.attrs).toMatchObject({ width: 20, height: 10, alt: 'A dot' })
    expect(changed.selection).toBeInstanceOf(NodeSelection)
    expect(changed.selection.from).toBe(pos)
    expect(setImageAttrs(pos, { width: 20 })(changed)).toBeNull()
    expect(setImageAttrs(0, { width: 20 })(changed)).toBeNull()
    expect(applyToJSON(jsonOf(changed.doc), setImageAttrs(pos, { alt: null }))?.content?.[0].content?.[0].attrs?.alt).toBeNull()
  })
})

describe('replacing', () => {
  it('replaces every match or the first, keeping the formatting where each starts', () => {
    const state = markdownState('A **cat** and a cat.\n')
    const all = run(state, replaceText('cat', 'dog'))

    expect(all.doc.textContent).toBe('A dog and a dog.')
    expect(all.doc.firstChild!.child(1).marks.map((mark) => mark.type.name)).toEqual(['bold'])
    expect(run(state, replaceText('CAT', 'dog', { all: false })).doc.textContent).toBe('A dog and a cat.')
    expect(run(state, replaceText('(c)(a)t', '$2$1t', { regex: true })).doc.textContent).toBe('A act and a act.')
    expect(replaceText('bird', 'dog')(state)).toBeNull()
  })
})

describe('styles and formatting', () => {
  it('sets paragraph styles, and reads the style at the caret', () => {
    const state = at(markdownState('One\n\nTwo\n'), 'One')

    expect(styleAt(run(state, setStyle('heading2')))).toBe('heading2')
    expect(blocks(run(state, setStyle('title')))).toEqual(['paragraph:title One', 'paragraph Two'])
    expect(blocks(run(run(state, setStyle('heading1')), setStyle('normal')))).toEqual(['paragraph One', 'paragraph Two'])
    expect(blocks(run(state, setStyle('quote')))).toEqual(['blockquote One', 'paragraph Two'])
    expect(styleAt(run(state, setStyle('quote')))).toBe('quote')
    expect(blocks(run(run(state, setStyle('quote')), setStyle('normal')))).toEqual(['paragraph One', 'paragraph Two'])
    expect(blocks(run(state, setStyle('code', 'all')))).toEqual(['codeBlock One', 'codeBlock Two'])
    expect(blocks(run(markdownState(PLAN), setStyle('heading3', { heading: 'Costs', part: 'heading' })))[2]).toBe('heading3 Costs')
  })

  it('adds and removes formatting, keeping the text style attributes it does not change', () => {
    const state = at(markdownState('Some words here.\n'), 'words', true)
    const red = run(state, setMarks({ bold: true, color: '#ff0000' }))
    const big = run(red, setMarks({ fontSize: 14, fontFamily: 'Georgia' }))
    const words = big.doc.firstChild!.child(1)

    expect(words.text).toBe('words')
    expect(words.marks.map((mark) => [mark.type.name, mark.attrs])).toEqual([
      ['textStyle', { color: '#ff0000', fontFamily: 'Georgia', fontSize: '14pt' }],
      ['bold', {}]
    ])

    const plain = run(big, setMarks({ bold: false, color: null }))

    expect(plain.doc.firstChild!.child(1).marks.map((mark) => [mark.type.name, mark.attrs])).toEqual([['textStyle', { color: null, fontFamily: 'Georgia', fontSize: '14pt' }]])
    expect(run(big, clearFormatting()).doc.firstChild!.childCount).toBe(1)
    expect(run(state, setMarks({ link: 'https://example.com' })).doc.firstChild!.child(1).marks[0].attrs.href).toBe('https://example.com')
    expect(run(run(state, setMarks({ superscript: true })), setMarks({ subscript: true })).doc.firstChild!.child(1).marks.map((mark) => mark.type.name)).toEqual(['subscript'])
  })

  it('aligns, spaces and indents paragraphs', () => {
    const state = markdownState('One\n\nTwo\n')

    expect(run(state, setAlignment('center', 'all')).doc.lastChild!.attrs.textAlign).toBe('center')
    expect(run(run(state, setAlignment('center', 'all')), setAlignment('left', 'all')).doc.lastChild!.attrs.textAlign).toBeNull()
    expect(run(state, setLineSpacing(1.5, 'all')).doc.firstChild!.attrs.lineHeight).toBe(1.5)
    expect(run(run(state, indent(36, 'all')), indent(36, 'all')).doc.firstChild!.attrs.indent).toBe(72)
    expect(run(run(state, indent(36, 'all')), indent(-72, 'all')).doc.firstChild!.attrs.indent).toBeNull()
  })

  it('sets the page size, orientation and margins', () => {
    const state = stateOf(blankDocument())
    const letter = run(state, setPage({ size: 'letter', orientation: 'landscape', margins: 54 }))

    expect(letter.doc.attrs.page).toEqual({ width: 792, height: 612, margins: { top: 54, right: 54, bottom: 54, left: 54 } })
    expect(run(letter, setPage({ orientation: 'portrait', margins: { left: 90 } })).doc.attrs.page).toEqual({ width: 612, height: 792, margins: { top: 54, right: 54, bottom: 54, left: 90 } })
  })
})

describe('one step to undo', () => {
  /** A live editor's state and dispatch, with the editor's own history. */
  function live(markdown: string) {
    const view = {
      state: EditorState.create({ schema: docsSchema(), doc: docsSchema().nodeFromJSON(fromMarkdown(markdown)), plugins: [history({ newGroupDelay: 500 })] }),
      dispatch(tr: Transaction) {
        view.state = view.state.apply(tr)
      }
    }

    return view
  }

  const type = (view: ReturnType<typeof live>, text: string) => view.dispatch(view.state.tr.insertText(text, view.state.doc.content.size - 1))
  const undoOnce = (view: ReturnType<typeof live>) => undo(view.state, view.dispatch)

  it('undoes a command in one step, without the typing before or after it', () => {
    const view = live('Start.\n')
    type(view, ' typed')
    const typed = view.state.doc.textContent

    expect(applyLive(view, replaceText('t', 'T'))).toBe(true)
    const changed = view.state.doc.textContent
    type(view, ' more')

    expect(view.state.doc.textContent).toBe('STarT. Typed more')
    expect(undoDepth(view.state)).toBe(3)
    undoOnce(view)
    expect(view.state.doc.textContent).toBe(changed)
    undoOnce(view)
    expect(view.state.doc.textContent).toBe(typed)
    undoOnce(view)
    expect(view.state.doc.textContent).toBe('Start.')
  })

  it('undoes a change of many places, a table, a style and the page in one step each', () => {
    const view = live(PLAN)
    const before = view.state.doc

    for (const op of [replaceSection('Costs', '| a | b |\n| - | - |\n| 1 | 2 |\n\nMore.'), setStyle('heading1', 'all'), setPage({ size: 'letter' }), setMarks({ italic: true }, 'all')]) {
      const start = view.state.doc
      expect(applyLive(view, op)).toBe(true)
      undoOnce(view)
      expect(view.state.doc.eq(start)).toBe(true)
    }

    expect(view.state.doc.eq(before)).toBe(true)
    expect(applyLive(view, replaceText('missing', 'x'))).toBe(false)
  })

  it('changes a document that is not open, as JSON', () => {
    const json = fromMarkdown(PLAN)
    const changed = applyToJSON(json, insert('Paid.', { heading: 'Costs', mode: 'replace' }))

    expect(changed?.content.map((block) => block.type)).toEqual(['heading', 'paragraph', 'heading', 'paragraph', 'heading', 'paragraph'])
    expect(applyToJSON(json, replaceText('nothing here', 'x'))).toBeNull()
    expect(jsonOf(stateOf(json).doc)).toEqual(docsSchema().nodeFromJSON(json).toJSON())
  })
})

describe('the schema', () => {
  it('takes every document the Markdown reader makes', () => {
    const json = fromMarkdown('# A\n\n> [!NOTE]\n> Hi\n\n- [ ] task\n  - nested\n\n| a | b |\n| - | - |\n| `c` | **d** |\n\n```py\nprint(1)\n```\n\n[`code` link](https://example.com) ![x](https://example.com/x.png)\n\n<div data-page-break></div>\n\n***\n')

    expect(() => docsSchema().nodeFromJSON(json).check()).not.toThrow()
  })
})
