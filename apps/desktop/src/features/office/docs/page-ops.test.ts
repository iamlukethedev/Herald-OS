import { history, undo } from '@tiptap/pm/history'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import { documentFromMarkdown } from '../../../../shared/office/doc-text.ts'
import { blankDocument, type DocJSON, type DocNode, defaultPage, headersOf, notesOf, PAGE_SIZES, sectionsOf } from '../../../../shared/office/document.ts'
import { documentFromDocx } from '../../../../shared/office/docx/read.ts'
import { docxFromDocument } from '../../../../shared/office/docx/write.ts'
import {
  applyLive,
  applyToJSON,
  clearHeaderFooter,
  documentSections,
  fieldFormat,
  findText,
  headerFooterText,
  insertField,
  insertNote,
  insertSectionBreak,
  notes,
  type Op,
  pageProblem,
  removeNote,
  setHeaderFooter,
  setHeaderOptions,
  setNote,
  setPage,
  setSectionPage,
  stateOf
} from './model.ts'
import { docsSchema } from './schema.ts'

const fromMarkdown = (markdown: string): DocJSON => documentFromMarkdown(markdown).document

/** Where the first match of `text` ends in a document. */
const after = (json: DocJSON, text: string): number => findText(stateOf(json).doc, text)[0].to

const changed = (json: DocJSON, op: Op): DocJSON => {
  const out = applyToJSON(json, op)

  expect(out).not.toBeNull()

  return out!
}

const paragraph = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content })
const text = (value: string): DocNode => ({ type: 'text', text: value })
const field = (kind: string): DocNode => ({ type: 'field', attrs: { kind, format: null, instruction: null, text: null } })

/** A paragraph's inline content as short strings: text as it is, fields and notes by kind. */
const inline = (block: DocNode | undefined): string[] => (block?.content ?? []).map((node) => (node.type === 'text' ? (node.text ?? '') : `[${node.type}:${node.attrs?.kind}]`))

describe('headers and footers', () => {
  it('puts content in a header or footer, and takes blank content away', () => {
    const json = fromMarkdown('Body text.\n')
    const headed = changed(json, setHeaderFooter('header', 'default', 'Ann Example Ltd'))

    expect(headersOf(headed)).toMatchObject({ header: { default: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ann Example Ltd' }] }] }, footer: {} })
    expect(applyToJSON(headed, setHeaderFooter('header', 'default', 'Ann Example Ltd'))).toBeNull()

    const footed = changed(headed, setHeaderFooter('footer', 'even', { blocks: [paragraph(text('Even '), field('page'))] }))

    expect(inline(headersOf(footed)?.footer.even?.[0])).toEqual(['Even ', '[field:page]'])
    expect(headersOf(changed(footed, setHeaderFooter('footer', 'even', { text: '' })))?.footer).toEqual({})
    expect(headersOf(changed(headed, setHeaderFooter('header', 'default', '')))).toBeNull()
    expect(() => applyToJSON(json, setHeaderFooter('side' as 'header', 'default', 'x'))).toThrow(/header or a footer/)
  })

  it('keeps notes, breaks and tables of contents in the text', () => {
    const blocks = [paragraph(text('Logo'), { type: 'note', attrs: { kind: 'footnote', content: [paragraph(text('No.'))] } }), { type: 'pageBreak' }, { type: 'tableOfContents' }, paragraph(text('Address'))]
    const headed = changed(fromMarkdown('Body.\n'), setHeaderFooter('header', 'default', { blocks }))

    expect(headersOf(headed)?.header.default?.map((block) => block.type)).toEqual(['paragraph', 'paragraph'])
    expect(inline(headersOf(headed)?.header.default?.[0])).toEqual(['Logo'])
  })

  it('clears one kind of header or all of them', () => {
    let json = changed(fromMarkdown('Body.\n'), setHeaderFooter('header', 'default', 'Usual'))
    json = changed(json, setHeaderFooter('header', 'first', 'Cover'))
    json = changed(json, setHeaderFooter('footer', 'default', 'Foot'))

    expect(Object.keys(headersOf(changed(json, clearHeaderFooter('header', 'first')))?.header ?? {})).toEqual(['default'])
    expect(headersOf(changed(json, clearHeaderFooter('header')))).toEqual({ header: {}, footer: headersOf(json)?.footer })
    expect(headersOf(changed(changed(json, clearHeaderFooter('header')), clearHeaderFooter('footer')))).toBeNull()
    expect(applyToJSON(fromMarkdown('Body.\n'), clearHeaderFooter('footer'))).toBeNull()
  })

  it('sets the header options and says what each header and footer shows, and where', () => {
    let json = changed(fromMarkdown('Body.\n'), setHeaderOptions({ differentFirst: true }))

    expect(headersOf(json)).toEqual({ header: {}, footer: {}, differentFirst: true })
    expect(applyToJSON(json, setHeaderOptions({ differentFirst: true }))).toBeNull()

    json = changed(json, setHeaderFooter('header', 'first', 'Cover'))
    json = changed(json, setHeaderFooter('header', 'default', '# Ann Example'))
    json = changed(json, setHeaderFooter('footer', 'default', { blocks: [paragraph(text('Page '), field('page'), text(' of '), field('pages'))] }))
    json = changed(json, setHeaderFooter('footer', 'even', 'Left'))
    const read = headerFooterText(stateOf(json).doc)

    expect(read).toEqual({
      differentFirst: true,
      differentOddEven: false,
      parts: [
        { part: 'header', kind: 'default', shownOn: 'every page after the first', text: 'Ann Example' },
        { part: 'header', kind: 'first', shownOn: 'the first page', text: 'Cover' },
        { part: 'footer', kind: 'default', shownOn: 'every page after the first', text: 'Page {page} of {pages}' },
        { part: 'footer', kind: 'even', shownOn: 'no page, as Different odd and even pages is off', text: 'Left' }
      ]
    })

    json = changed(json, setHeaderOptions({ differentFirst: false, differentOddEven: true }))

    expect(headerFooterText(stateOf(json).doc).parts.map((part) => part.shownOn)).toEqual(['odd pages', 'no page, as Different first page is off', 'odd pages', 'even pages'])
  })
})

describe('fields', () => {
  it('puts a page number, Page X of Y, a page count, the date or the time in a line of text', () => {
    const json = fromMarkdown('Total pages: here.\n\nLast line\n')
    const numbered = changed(json, insertField('pageOfPages', {}, { pos: after(json, 'pages: ') }))

    expect(inline(numbered.content[0])).toEqual(['Total pages: Page ', '[field:page]', ' of ', '[field:pages]', 'here.'])

    const counted = changed(json, insertField('pages', {}, { pos: after(json, 'here') }))

    expect(inline(counted.content[0])).toEqual(['Total pages: here', '[field:pages]', '.'])

    const dated = changed(json, insertField('date', { format: 'd MMMM yyyy' }, 'end'))

    expect(inline(dated.content[1])).toEqual(['Last line', '[field:date]'])
    expect(dated.content[1].content?.[1].attrs).toEqual({ kind: 'date', format: 'd MMMM yyyy', instruction: null, text: null })
    expect(changed(json, insertField('time', { locale: 'en-US' }, 'end')).content[1].content?.[1].attrs?.format).toBe('h:mm AM/PM')
    expect(fieldFormat('date', 'en-US')).toBe('MMMM d, yyyy')
    expect(fieldFormat('date', 'en-GB')).toBe('d MMMM yyyy')
    expect(fieldFormat('time', 'fr-FR')).toBe('HH:mm')
    expect(() => applyToJSON(json, insertField('chapter' as 'page'))).toThrow(/no “chapter” field/)
  })

  it('takes the formatting at the caret and leaves the caret after what it put in', () => {
    const json: DocJSON = { type: 'doc', content: [paragraph({ type: 'text', text: 'Bold', marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://example.com' } }] })] }
    const state = stateOf(json)
    const caret = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)))
    const tr = insertField('page')(caret)!
    const next = caret.apply(tr)
    const inserted = next.doc.nodeAt(3)!

    expect(inserted.type.name).toBe('field')
    expect(inserted.marks.map((mark) => mark.type.name)).toEqual(['bold'])
    expect(next.selection.from).toBe(4)
    expect(next.selection.empty).toBe(true)
  })

  it('makes a paragraph for a field when there is no line of text to put it in', () => {
    const json: DocJSON = { type: 'doc', content: [{ type: 'horizontalRule' }] }

    expect(changed(json, insertField('page', {}, 'end')).content.map((block) => block.type)).toEqual(['horizontalRule', 'paragraph'])
  })
})

describe('notes', () => {
  it('puts footnotes and endnotes in the text, holding what they say, and lists them', () => {
    const json = fromMarkdown('First claim. Second claim.\n')
    let noted = changed(json, insertNote('footnote', 'Ann Example, *A Study* (2024).', { pos: after(json, 'First claim.') }))
    noted = changed(noted, insertNote('endnote', 'See the appendix.', { pos: after(noted, 'Second claim.') }))
    noted = changed(noted, insertNote('footnote', '', { pos: after(noted, 'Second') }))
    const listed = notes(stateOf(noted).doc)

    expect(inline(noted.content[0])).toEqual(['First claim.', '[note:footnote]', ' Second', '[note:footnote]', ' claim.', '[note:endnote]'])
    expect(listed.map(({ kind, number, label, text: said }) => ({ kind, number, label, said }))).toEqual([
      { kind: 'footnote', number: 1, label: '1', said: 'Ann Example, A Study (2024).' },
      { kind: 'footnote', number: 2, label: '2', said: '' },
      { kind: 'endnote', number: 1, label: 'i', said: 'See the appendix.' }
    ])
    expect(listed[0].content[0].content?.[1]).toMatchObject({ type: 'text', text: 'A Study', marks: [{ type: 'italic' }] })
    expect(listed[1].content).toEqual([{ type: 'paragraph' }])
    expect(stateOf(noted).doc.nodeAt(listed[2].pos)?.attrs.kind).toBe('endnote')
    expect(notesOf(noted).map((note) => note.number)).toEqual([1, 2, 1])
  })

  it('puts a note given a place between blocks at the end of the text before it', () => {
    const json = fromMarkdown('# Title\n\nThe end.\n\n---\n')
    const noted = changed(json, insertNote('endnote', 'Last word.', 'end'))

    expect(inline(noted.content[1])).toEqual(['The end.', '[note:endnote]'])
    expect(() => applyToJSON(json, insertNote('sidenote' as 'footnote', 'x', 'end'))).toThrow(/footnote or an endnote/)
  })

  it('puts the caret after a new note, after any selected text', () => {
    const state = stateOf(fromMarkdown('Some words here.\n'))
    const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 11)))
    const next = selected.apply(insertNote('footnote')(selected)!)

    expect(next.doc.textContent).toBe('Some words here.')
    expect(next.doc.nodeAt(11)?.type.name).toBe('note')
    expect(next.selection.from).toBe(12)
  })

  it('changes a note by its place, its reference or its number, keeps notes out of notes, and takes one away', () => {
    let json = fromMarkdown('One. Two.\n')
    json = changed(json, insertNote('footnote', 'First.', { pos: after(json, 'One.') }))
    json = changed(json, insertNote('endnote', 'Second.', { pos: after(json, 'Two.') }))
    const [first, second] = notes(stateOf(json).doc)

    expect(notes(stateOf(changed(json, setNote(0, 'Changed.'))).doc)[0].text).toBe('Changed.')
    expect(notes(stateOf(changed(json, setNote({ pos: second.pos }, 'Moved on.'))).doc)[1].text).toBe('Moved on.')
    expect(notes(stateOf(changed(json, setNote({ kind: 'endnote', number: 1 }, { text: 'Line one\nLine two' }))).doc)[1].text).toBe('Line one\nLine two')
    expect(applyToJSON(json, setNote(0, 'First.'))).toBeNull()

    const nested = changed(json, setNote(0, { blocks: [paragraph(text('Outer'), { type: 'note', attrs: { kind: 'footnote', content: [] } })] }))

    expect(notes(stateOf(nested).doc).map((note) => note.text)).toEqual(['Outer', 'Second.'])

    const removed = changed(json, removeNote({ pos: first.pos }))

    expect(notes(stateOf(removed).doc).map((note) => note.kind)).toEqual(['endnote'])
    expect(stateOf(removed).doc.textContent).toBe('One. Two.')
    expect(() => applyToJSON(json, setNote(5, 'x'))).toThrow(/no note number 6/)
    expect(() => applyToJSON(json, setNote({ kind: 'footnote', number: 2 }, 'x'))).toThrow(/no footnote 2/)
    expect(() => applyToJSON(json, setNote({ pos: 1 }, 'x'))).toThrow(/no note at 1/)
  })
})

describe('sections and the page', () => {
  const landscapeA4 = { width: PAGE_SIZES.a4.height, height: PAGE_SIZES.a4.width, margins: { top: 72, right: 72, bottom: 72, left: 72 } }

  it('starts a section with the page of the section it is in, splitting the paragraph at the caret', () => {
    const json = changed(fromMarkdown('Before the break and after it.\n'), setPage({ size: 'a4', orientation: 'landscape' }))
    const broken = changed(json, insertSectionBreak('nextPage', { pos: after(json, 'Before the break') }))

    expect(broken.content.map((block) => block.type)).toEqual(['paragraph', 'sectionBreak', 'paragraph'])
    expect(broken.content[1].attrs).toEqual({ kind: 'nextPage', page: landscapeA4 })
    expect(documentSections(stateOf(broken).doc).map(({ index, kind, page, own }) => ({ index, kind, width: page.width, own }))).toEqual([
      { index: 0, kind: 'nextPage', width: PAGE_SIZES.a4.height, own: true },
      { index: 1, kind: 'nextPage', width: PAGE_SIZES.a4.height, own: true }
    ])

    for (const kind of ['continuous', 'oddPage', 'evenPage'] as const) {
      expect(changed(json, insertSectionBreak(kind, 'end')).content.find((block) => block.type === 'sectionBreak')?.attrs?.kind).toBe(kind)
    }

    expect(() => applyToJSON(json, insertSectionBreak('column' as 'nextPage'))).toThrow(/not “column”/)
  })

  it('puts a section break in a list after the list, and the caret after the break', () => {
    const state = stateOf(fromMarkdown('- one\n- two\n\nAfter.\n'))
    const [match] = findText(state.doc, 'one')
    const caret = state.apply(state.tr.setSelection(TextSelection.create(state.doc, match.to)))
    const next = caret.apply(insertSectionBreak('continuous')(caret)!)

    expect(next.doc.content.content.map((block) => block.type.name)).toEqual(['bulletList', 'sectionBreak', 'paragraph'])
    expect(next.selection.$from.parent.textContent).toBe('After.')
  })

  it('changes one section’s page, the sections after it keeping the page they had', () => {
    let json = fromMarkdown('One.\n\nTwo.\n\nThree.\n')
    json = { ...json, content: [json.content[0], { type: 'sectionBreak', attrs: { kind: 'nextPage', page: null } }, json.content[1], { type: 'sectionBreak', attrs: { kind: 'oddPage', page: null } }, json.content[2]] }
    const usual = defaultPage()
    const first = changed(json, setSectionPage(0, { orientation: 'landscape' }))

    expect(sectionsOf(first).map((section) => section.page.width > section.page.height)).toEqual([true, false, false])
    expect(first.content[1].attrs?.page).toEqual(usual)
    expect(first.content[3].attrs?.page).toEqual(usual)

    const second = changed(json, setSectionPage(1, { size: 'legal', margins: 36 }))

    expect(second.attrs?.page).toBeNull()
    expect(second.content[1].attrs?.page).toEqual({ width: 612, height: 1008, margins: { top: 36, right: 36, bottom: 36, left: 36 } })
    expect(second.content[3].attrs?.page).toEqual(usual)
    expect(applyToJSON(second, setSectionPage(1, { size: 'legal' }))).toBeNull()
    expect(() => applyToJSON(json, setSectionPage(3, { size: 'a5' }))).toThrow(/no section 4: it has 3/)
  })

  it('sets custom sizes and header and footer distances, keeping the distances when the margins change', () => {
    const json = blankDocument()
    const custom = changed(json, setPage({ size: { width: 500, height: 700 }, margins: { header: 20, footer: 24 } }))

    expect(custom.attrs?.page).toEqual({ width: 500, height: 700, margins: { top: 72, right: 72, bottom: 72, left: 72, header: 20, footer: 24 } })
    expect(changed(custom, setPage({ margins: 54 })).attrs?.page?.margins).toEqual({ top: 54, right: 54, bottom: 54, left: 54, header: 20, footer: 24 })
    expect(changed(custom, setPage({ size: { width: 500, height: 700 }, orientation: 'landscape' })).attrs?.page).toMatchObject({ width: 700, height: 500 })
    expect(changed(custom, setPage({ orientation: 'landscape' })).attrs?.page).toMatchObject({ width: 700, height: 500 })
    expect(changed(custom, setPage({ size: 'letter', orientation: 'portrait' })).attrs?.page).toMatchObject({ width: 612, height: 792, margins: { header: 20 } })
  })

  it('refuses a page that cannot be laid out', () => {
    const json = blankDocument()

    expect(() => applyToJSON(json, setPage({ margins: { left: 300, right: 300 } }))).toThrow('The left and right margins leave too little room for text')
    expect(() => applyToJSON(json, setPage({ margins: { top: 420, bottom: 420 } }))).toThrow('The top and bottom margins leave too little room for text')
    expect(() => applyToJSON(json, setPage({ size: { width: 40, height: 700 } }))).toThrow(/from 1 to 22 inches/)
    expect(() => applyToJSON(json, setPage({ margins: { header: -1 } }))).toThrow(/below zero/)
    expect(() => applyToJSON(json, setPage({ size: 'tabloid' as 'a4' }))).toThrow(/no “tabloid” page size/)
    expect(pageProblem({ width: 612, height: 792, margins: { top: 72, right: 72, bottom: 72, left: 72, footer: 500 } })).toMatch(/half of the page/)
    expect(pageProblem({ width: 612, height: Number.NaN, margins: { top: 72, right: 72, bottom: 72, left: 72 } })).toMatch(/number/)
    expect(pageProblem({ width: PAGE_SIZES.a5.width, height: PAGE_SIZES.a5.height, margins: { top: 0, right: 0, bottom: 0, left: 0 } })).toBeNull()
  })

  it('changes every section’s page with sections: all, and only the document’s page without', () => {
    let json = fromMarkdown('One.\n\nTwo.\n')
    json = { ...json, content: [json.content[0], { type: 'sectionBreak', attrs: { kind: 'nextPage', page: landscapeA4 } }, json.content[1]] }

    expect(changed(json, setPage({ margins: 36 })).content[1].attrs?.page).toEqual(landscapeA4)

    const all = changed(json, setPage({ margins: 36 }, 'all'))

    expect(all.content[1].attrs?.page).toEqual({ ...landscapeA4, margins: { top: 36, right: 36, bottom: 36, left: 36 } })
    expect(all.attrs?.page?.margins).toEqual({ top: 36, right: 36, bottom: 36, left: 36 })
  })
})

describe('one step to undo', () => {
  it('undoes each change to headers, fields, notes, sections and the page in one step', () => {
    const json = changed(fromMarkdown('Body text.\n'), insertNote('footnote', 'Note.', { pos: 5 }))
    const view = {
      state: EditorState.create({ schema: docsSchema(), doc: docsSchema().nodeFromJSON(json), plugins: [history({ newGroupDelay: 500 })] }),
      dispatch(tr: Transaction) {
        view.state = view.state.apply(tr)
      }
    }
    const ops: Op[] = [
      setHeaderFooter('header', 'default', 'Ann Example'),
      setHeaderOptions({ differentFirst: true, differentOddEven: true }),
      insertField('pageOfPages', {}, 'end'),
      insertNote('endnote', 'Later.', 'end'),
      setNote(0, 'Changed.'),
      insertSectionBreak('evenPage', 'end'),
      setPage({ size: { width: 520, height: 720 }, margins: { header: 18 } }),
      setSectionPage(0, { size: 'letter', orientation: 'landscape' })
    ]

    for (const op of ops) {
      const before = view.state.doc

      expect(applyLive(view, op)).toBe(true)
      undo(view.state, view.dispatch)
      expect(view.state.doc.eq(before)).toBe(true)
    }
  })
})

describe('Word files', () => {
  it('keeps headers, footers, page numbers, notes and sections through a Word file', async () => {
    let json = fromMarkdown('A claim worth a source.\n\nThe second section.\n')
    json = changed(json, setHeaderFooter('header', 'default', 'Ann Example Ltd'))
    json = changed(json, setHeaderOptions({ differentFirst: true }))
    json = changed(json, setHeaderFooter('header', 'first', 'Cover'))
    const footer = stateOf({ type: 'doc', content: [paragraph()] })
    const footerBlocks = footer.apply(insertField('pageOfPages', {}, 'end')(footer)!).doc.toJSON().content as DocNode[]
    json = changed(json, setHeaderFooter('footer', 'default', { blocks: footerBlocks }))
    json = changed(json, insertNote('footnote', 'Ann Example, 2024.', { pos: after(json, 'a source.') }))
    json = changed(json, insertSectionBreak('nextPage', { pos: after(json, 'a source.') + 1 }))
    json = changed(json, setSectionPage(1, { orientation: 'landscape', margins: { header: 30 } }))
    const { bytes } = await docxFromDocument(json)
    const { doc } = await documentFromDocx(bytes)
    const read = headerFooterText(stateOf(doc).doc)

    expect(read.differentFirst).toBe(true)
    expect(read.parts.map(({ part, kind, text: said }) => ({ part, kind, said }))).toEqual([
      { part: 'header', kind: 'default', said: 'Ann Example Ltd' },
      { part: 'header', kind: 'first', said: 'Cover' },
      { part: 'footer', kind: 'default', said: 'Page {page} of {pages}' }
    ])
    expect(notes(stateOf(doc).doc).map((note) => `${note.kind} ${note.label}: ${note.text}`)).toEqual(['footnote 1: Ann Example, 2024.'])

    const sections = sectionsOf(doc)

    expect(sections).toHaveLength(2)
    expect(sections[0].page.width).toBeLessThan(sections[0].page.height)
    expect(sections[1].page.width).toBeGreaterThan(sections[1].page.height)
    expect(sections[1].page.margins.header).toBe(30)
  })
})
