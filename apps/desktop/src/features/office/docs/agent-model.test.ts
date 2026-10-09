import { history, undo, undoDepth } from '@tiptap/pm/history'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import { documentFromMarkdown } from '../../../../shared/office/doc-text.ts'
import { cellsOf, chain, chainBuilt, editsOf, findWithContext, headingRef, markChangeOf, pageArgsOf, placeFor, readDocument, readOptions, sectionDocument, styleOf, targetFor, templateOf, TEMPLATES, whereOf } from './agent-model.ts'
import { markedPlugin, markedRangeOf, markedKey } from './marked.ts'
import { applyLive, documentText, insert, jsonOf, replaceText, setMarks, setStyle } from './model.ts'
import { docsSchema } from './schema.ts'

const schema = docsSchema()
const REPORT = '# Report\n\nIntro text about sales.\n\n## Results\n\nSales grew in March.\n\nSales fell in May.\n\n## Next steps\n\nHire two people.\n'

const stateFrom = (markdown: string, plugins = [history(), markedPlugin()]) => EditorState.create({ schema, doc: schema.nodeFromJSON(documentFromMarkdown(markdown).document), plugins })

/** A state with `text` selected. */
function selecting(state: EditorState, text: string): EditorState {
  let at = -1
  state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(text)) {
      at = pos + node.text!.indexOf(text)
    }
  })

  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, at, at + text.length)))
}

/** A live view over a state, as applyLive takes it. */
function viewOf(state: EditorState) {
  const view = { state, dispatch: (tr: Parameters<EditorState['apply']>[0]) => (view.state = view.state.apply(tr)) }

  return view
}

describe('where a write goes', () => {
  it('reads at, heading and mode', () => {
    expect(whereOf({})).toBe('end')
    expect(whereOf({ heading: 'Results' })).toBe('heading')
    expect(whereOf({ at: 'Caret' })).toBe('selection')
    expect(() => whereOf({ at: 'middle' })).toThrow(/at is one of/)
    expect(placeFor(null, { heading: '2', mode: 'replace' }, null)).toEqual({ heading: 1, mode: 'replace' })
    expect(placeFor(null, { at: 'start' }, null)).toBe('start')
    expect(headingRef('Next steps')).toBe('Next steps')
  })

  it('needs an open document for the selection and the marked text', () => {
    expect(() => placeFor(null, { at: 'selection' }, null)).toThrow(/open in Herald Docs/)
    const state = stateFrom(REPORT)

    expect(() => placeFor(state, { at: 'marked' }, null)).toThrow(/Nothing is marked/)
    expect(placeFor(state, { at: 'marked' }, { from: 3, to: 6 })).toEqual({ from: 3, to: 6 })
  })

  it('puts content after the paragraph the selection is in', () => {
    const state = selecting(stateFrom(REPORT), 'grew')
    const place = placeFor(state, { at: 'after' }, null)
    const next = state.apply(insert('Summary: up.', place)(state)!)

    expect(documentText(next.doc)).toContain('Sales grew in March.\nSummary: up.\nSales fell in May.')
  })

  it('replaces the marked text even after the person typed elsewhere', () => {
    let state = selecting(stateFrom(REPORT), 'Sales grew in March.')
    state = state.apply(state.tr.setMeta(markedKey, { range: { from: state.selection.from, to: state.selection.to } }))
    // The person types at the start of the document meanwhile.
    state = state.apply(state.tr.insertText('DRAFT ', 1))
    const marked = markedRangeOf(state)!

    expect(state.doc.textBetween(marked.from, marked.to)).toBe('Sales grew in March.')
    const next = state.apply(insert('Sales rose sharply in March.', placeFor(state, { at: 'marked' }, marked))(state)!)

    expect(documentText(next.doc)).toContain('DRAFT Report')
    expect(documentText(next.doc)).toContain('Sales rose sharply in March.\nSales fell in May.')
  })

  it('formats the selection, the marked text, a section or every match of some text', () => {
    const state = stateFrom(REPORT)

    expect(targetFor(null, { text: 'Sales' }, null)).toEqual({ text: 'Sales', all: true, options: { caseSensitive: false, wholeWord: false, regex: false } })
    expect(targetFor(null, { heading: 'Results' }, null)).toEqual({ heading: 'Results', part: 'all' })
    expect(targetFor(null, { at: 'heading', heading: 1 }, null)).toEqual({ heading: 0, part: 'heading' })
    expect(targetFor(state, {}, null)).toBe('selection')
    expect(() => targetFor(null, {}, null)).toThrow(/open in Herald Docs/)
    expect(() => targetFor(state, { at: 'marked' }, null)).toThrow(/Nothing is marked/)
  })
})

describe('what a format asks for', () => {
  it('reads styles by id, label or shorthand', () => {
    expect(styleOf('Heading 2')).toBe('heading2')
    expect(styleOf('h1')).toBe('heading1')
    expect(styleOf('heading5')).toBe('heading5')
    expect(styleOf('Quote')).toBe('quote')
    expect(() => styleOf('fancy')).toThrow(/style is/)
  })

  it('reads marks, with none taking one off', () => {
    expect(markChangeOf({ bold: true, italic: false, color: '#c00000', highlight: 'none', size: 14, link: 'off' })).toEqual({ bold: true, italic: false, color: '#c00000', highlight: null, fontSize: 14, link: null })
    expect(markChangeOf({ size: 0 })).toEqual({ fontSize: null })
    expect(() => markChangeOf({ size: 900 })).toThrow(/points/)
  })

  it('reads table cells and page setup', () => {
    expect(cellsOf('[["Item", "Cost"], ["Rent", 1200]]')).toEqual([['Item', 'Cost'], ['Rent', '1200']])
    expect(() => cellsOf('Item, Cost')).toThrow(/rows/)
    expect(pageArgsOf({ size: 'A4', orientation: 'landscape', margins: '1in' })).toEqual({ size: 'a4', orientation: 'landscape', margins: 72 })
    expect(pageArgsOf({ margins: '20mm' }).margins).toBeCloseTo(56.7, 1)
    expect(() => pageArgsOf({ size: 'tabloid' })).toThrow(/size is one of/)
  })
})

describe('reading a document', () => {
  it('gives the outline, counts and Markdown, or one section', () => {
    const doc = stateFrom(REPORT).doc
    const all = readDocument(doc, readOptions({}))

    expect(all.outline).toEqual([{ level: 1, text: 'Report' }, { level: 2, text: 'Results' }, { level: 2, text: 'Next steps' }])
    expect(all.content).toContain('## Results')
    expect(all.words).toBeGreaterThan(10)
    const section = readDocument(doc, readOptions({ heading: 'Results', part: 'text' }))

    expect(section.content).toBe('Results\nSales grew in March.\nSales fell in May.')
    expect(jsonOf(doc.type.schema.nodeFromJSON(sectionDocument(doc, 'Next steps'))).content).toHaveLength(2)
    expect(readDocument(doc, readOptions({ maxChars: 200, part: 'outline' })).content).toBeUndefined()
    expect(() => readOptions({ part: 'html' })).toThrow(/part is/)
  })

  it('cuts long content at maxChars and says so', () => {
    const long = `# Long\n\n${'word '.repeat(400)}`
    const read = readDocument(stateFrom(long).doc, readOptions({ maxChars: 300 }))

    expect(read.truncated).toBe(true)
    expect(read.content).toHaveLength(300)
  })

  it('finds text with the words around it and its heading', () => {
    const found = findWithContext(stateFrom(REPORT).doc, 'sales', {})

    expect(found.count).toBe(3)
    expect(found.matches[1]).toMatchObject({ text: 'Sales', heading: 'Results' })
    expect(found.matches[1].context).toContain('[Sales] grew in March')
  })
})

describe('one step to undo', () => {
  it('chains several changes into one transaction, each built on the last', () => {
    const view = viewOf(stateFrom(REPORT))
    const op = chainBuilt([() => insert('## Summary\n\nAll good.', 'start'), () => replaceText('Sales', 'Revenue', { all: true }), () => setStyle('heading3', { heading: 'Next steps', part: 'heading' })])

    expect(applyLive(view, op)).toBe(true)
    expect(documentText(view.state.doc)).toContain('Revenue grew in March.')
    expect(documentText(view.state.doc).startsWith('Summary\nAll good.')).toBe(true)
    expect(undoDepth(view.state)).toBe(1)
    undo(view.state, view.dispatch)
    expect(documentText(view.state.doc)).toBe(documentText(stateFrom(REPORT).doc))
  })

  it('chains formatting on the same text', () => {
    const view = viewOf(selecting(stateFrom(REPORT), 'Hire two people.'))
    applyLive(view, chain([setMarks({ bold: true }), setMarks({ color: '#c00000' })]))

    expect(undoDepth(view.state)).toBe(1)
    expect(view.state.doc.nodeAt(view.state.selection.from)?.marks.map((mark) => mark.type.name).sort()).toEqual(['bold', 'textStyle'])
  })

  it('reads a batch of edits and refuses unknown ones', () => {
    expect(editsOf('[{"op": "write", "content": "x"}, {"op": "PAGEBREAK"}]').map((edit) => edit.op)).toEqual(['write', 'pageBreak'])
    expect(() => editsOf('[{"op": "delete"}]')).toThrow(/Edit 1: op is one of/)
    expect(() => editsOf('[]')).toThrow(/edits is a list/)
  })
})

describe('templates', () => {
  it('starts documents from a template by name or alias', () => {
    expect(templateOf('Cover letter').id).toBe('cover letter')
    expect(templateOf('cv').id).toBe('resume')
    expect(templateOf('minutes').label).toBe('Meeting notes')
    expect(() => templateOf('novel')).toThrow(/template is one of/)

    for (const template of Object.values(TEMPLATES)) {
      expect(documentFromMarkdown(template.markdown).document.content?.length).toBeGreaterThan(1)
    }
  })
})
