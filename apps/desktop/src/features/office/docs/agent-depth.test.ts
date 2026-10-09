import { history, undo, undoDepth } from '@tiptap/pm/history'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import { afterEach, describe, expect, it } from 'vitest'
import { documentFromMarkdown } from '../../../../shared/office/doc-text.ts'
import { commentsOf, type DocJSON, type DocNode, headersOf, pageOf, PAGE_SIZES } from '../../../../shared/office/document.ts'
import { $commentName } from '../comment-name.ts'
import {
  addCommentsChange,
  batchOutcome,
  builtInTemplate,
  type Change,
  clearPartChange,
  commentAuthor,
  commentItemOf,
  commentItemsOf,
  commentsList,
  CONTENT_OPS,
  deleteCommentChange,
  depthEdit,
  editCommentChange,
  extrasOf,
  headerKindOf,
  headerOptionsChange,
  insertFieldChange,
  insertNoteChange,
  insertSectionBreakChange,
  insertTocChange,
  isDepthPart,
  newDocumentModel,
  noteRefOf,
  notesList,
  pageSectionOf,
  partReading,
  quoteMatches,
  removeNoteChange,
  removeSectionBreakChange,
  removeTocChange,
  replyChange,
  resolveChange,
  sectionKindOf,
  sectionsList,
  setNoteChange,
  setPageChange,
  setPartChange,
  setTocChange,
  statisticsOutcome,
  templateChoice,
  templateLabel,
  templatesOutcome,
  tocsList,
  updateTocsChange,
  withBody
} from './agent-depth-model.ts'
import { chainBuilt, editsOf, pageArgsOf, readDocument, readOptions } from './agent-model.ts'
import { applyLive, comments, documentSections, headerFooterText, jsonOf, notes, replaceText, stateOf } from './model.ts'
import { docsSchema } from './schema.ts'
import { documentStatistics } from './statistics.ts'
import type { SavedTemplate } from './templates/saved.ts'

// The work of the docs.* page and review commands, made as a command makes it on a document that is not open.

const schema = docsSchema()
const REPORT = '# Report\n\nIntro text about sales.\n\n## Results\n\nSales grew in March.\n\nSales fell in May.\n\n## Next steps\n\nHire two people.\n'
const A4 = { width: PAGE_SIZES.a4.width, height: PAGE_SIZES.a4.height, margins: { top: 72, right: 72, bottom: 72, left: 72 } }

/** The report, on A4 whatever the locale. */
const report = (): DocJSON => {
  const json = documentFromMarkdown(REPORT).document

  return { ...json, attrs: { ...json.attrs, page: A4 } }
}

const blocks = (markdown: string): DocNode[] => documentFromMarkdown(markdown).document.content

/** A command's change made to a document that is not open, as on a file: the JSON it leaves, and its answer. */
function onFile(made: Change, json: DocJSON) {
  const state = stateOf(json)
  const tr = made.build(state, null, false)(state)
  const changed = Boolean(tr && tr.steps.length)

  return { json: tr && changed ? jsonOf(tr.doc) : json, ...made.outcome({ changed, name: 'Report.docx', path: '/tmp/Report.docx' }) }
}

/** An open document's editor: its state with the editor's history, and its dispatch. */
function live(json: DocJSON, selected?: string) {
  let state = EditorState.create({ schema, doc: schema.nodeFromJSON(json), plugins: [history()] })

  if (selected) {
    let at = -1
    state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text!.includes(selected)) {
        at = pos + node.text!.indexOf(selected)
      }
    })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at, at + selected.length)))
  }

  const view = {
    state,
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr)
    }
  }

  return view
}

/** A command's change made to an open document: one step to undo there. */
function onLive(made: Change, view: ReturnType<typeof live>) {
  const changed = applyLive(view, made.build(view.state, null, true))

  return made.outcome({ changed, name: 'Report.docx', path: null })
}

/** A paragraph's inline content as short strings: text as it is, fields and notes by kind. */
const inline = (block: DocNode | undefined): string[] => (block?.content ?? []).map((node) => (node.type === 'text' ? (node.text ?? '') : `[${node.type}:${node.attrs?.kind}]`))

afterEach(() => {
  $commentName.set('')
})

describe('headers and footers', () => {
  it('sets a footer with the page number and count as fields, aligned as asked, and says which pages show it', () => {
    const made = onFile(setPartChange('footer', { align: 'center' }, { blocks: blocks('Page {page} of {pages}') }), report())
    const footer = headersOf(made.json)?.footer.default ?? []

    expect(footer[0]).toMatchObject({ type: 'paragraph', attrs: { textAlign: 'center' } })
    expect(inline(footer[0])).toEqual(['Page ', '[field:page]', ' of ', '[field:pages]'])
    expect(made.summary).toBe('Set the footer of Report.docx, on every page: “Page {page} of {pages}”')
    expect(made.data).toMatchObject({ changed: true, part: 'footer', kind: 'default', shownOn: 'every page', text: 'Page {page} of {pages}' })
    expect(onFile(setPartChange('footer', { align: 'center' }, { blocks: blocks('Page {page} of {pages}') }), made.json).summary).toBe('The footer of Report.docx already says that')
  })

  it('puts a first-page header in, turning Different first page on, with a date in a picture of its own', () => {
    const made = onFile(setPartChange('header', { kind: 'First page' }, { text: 'Draft · {date:d MMMM yyyy}' }), report())
    const header = headersOf(made.json)?.header.first ?? []

    expect(headersOf(made.json)?.differentFirst).toBe(true)
    expect(inline(header[0])).toEqual(['Draft · ', '[field:date]'])
    expect(header[0].content?.[1].attrs).toEqual({ kind: 'date', format: 'd MMMM yyyy', instruction: null, text: null })
    expect(made.summary).toMatch(/^Set the first-page header of Report\.docx, on the first page: “Draft · .+” \(Different first page is on now\)$/)
  })

  it('refuses a header with nothing in it and kinds it does not have', () => {
    expect(() => setPartChange('header', {}, { text: '  ' })).toThrow(/Say what the header says .*docs\.clearHeader takes one away/)
    expect(() => headerKindOf('middle')).toThrow(/kind is default/)
    expect(headerKindOf('even pages')).toBe('even')
    expect(headerKindOf(undefined)).toBe('default')
  })

  it('takes one kind or every kind away, and turns the options on and off', () => {
    let json = onFile(setPartChange('footer', {}, { text: 'Odd {page}' }), report()).json
    json = onFile(setPartChange('footer', { kind: 'even' }, { text: '{page} Even' }), json).json
    const cleared = onFile(clearPartChange('footer', {}), json)

    expect(headerFooterText(stateOf(json).doc).parts.map((part) => part.shownOn)).toEqual(['odd pages', 'even pages'])
    expect(cleared.summary).toBe('Took every footer away from Report.docx')
    expect(cleared.data).toMatchObject({ removed: 2 })
    expect(headersOf(cleared.json)).toEqual({ header: {}, footer: {}, differentOddEven: true })
    expect(onFile(clearPartChange('header', { kind: 'first' }), json).summary).toBe('Report.docx has no first-page header')

    const options = onFile(headerOptionsChange({ differentOddEven: false, differentFirst: 'yes' }), json)

    expect(options.summary).toBe('Turned Different first page on and Different odd and even pages off in Report.docx')
    expect(headerFooterText(stateOf(options.json).doc)).toMatchObject({ differentFirst: true, differentOddEven: false })
    expect(() => headerOptionsChange({})).toThrow(/Say which option/)
  })
})

describe('fields', () => {
  it('puts a field right after a quote, in the formatting there', () => {
    const made = onFile(insertFieldChange({ field: 'page count', quote: 'Sales grew' }), report())
    const bold = onFile(insertFieldChange({ field: 'page', quote: 'Total:' }), documentFromMarkdown('**Total:** pages\n').document)

    expect(inline(made.json.content[3])).toEqual(['Sales grew', '[field:pages]', ' in March.'])
    expect(made.summary).toBe('Put the page count in Report.docx, after “Sales grew”')
    expect(bold.json.content[0].content?.[1]).toMatchObject({ type: 'field', marks: [{ type: 'bold' }] })
  })

  it('puts a field between blocks on a line of its own, and refuses fields and quotes it does not have', () => {
    const dated = onFile(insertFieldChange({ field: 'Date', format: 'd MMMM yyyy', at: 'start' }), report())
    const counted = onFile(insertFieldChange({ field: 'pageOfPages' }), report())

    expect(inline(dated.json.content[0])).toEqual(['[field:date]'])
    expect(dated.json.content[0].content?.[0].attrs?.format).toBe('d MMMM yyyy')
    expect(dated.summary).toBe('Put the date in Report.docx, at the start')
    expect(inline(counted.json.content[counted.json.content.length - 1])).toEqual(['Page ', '[field:page]', ' of ', '[field:pages]'])
    expect(() => insertFieldChange({ field: 'chapter' })).toThrow(/field is page .* not “chapter”/)
    expect(() => onFile(insertFieldChange({ field: 'time', quote: 'Sales rose' }), report())).toThrow('“Sales rose” is not in the document: quote its words exactly')
  })
})

describe('notes', () => {
  it('puts footnotes and endnotes after quotes, numbered in order, and lists them', () => {
    const first = onFile(insertNoteChange({ quote: 'Sales grew in March.' }, { blocks: blocks('Source: the *annual* report.') }), report())
    const end = onFile(insertNoteChange({ kind: 'endnote', quote: 'Hire two people' }, { text: 'Budget permitting.' }), first.json)
    const earlier = onFile(insertNoteChange({ quote: 'Intro text' }, { text: 'Early.' }), end.json)

    expect(first.summary).toBe('Put footnote 1 in Report.docx, after “Sales grew in March.”')
    expect(end.data).toMatchObject({ note: 'endnote 1', kind: 'endnote', number: 1, label: 'i' })
    expect(earlier.data).toMatchObject({ note: 'footnote 1' })
    expect(notesList(stateOf(earlier.json).doc)).toEqual([
      { note: 'footnote 1', kind: 'footnote', number: 1, label: '1', text: 'Early.', after: 'Intro text' },
      { note: 'footnote 2', kind: 'footnote', number: 2, label: '2', text: 'Source: the annual report.', after: 'Sales grew in March.' },
      { note: 'endnote 1', kind: 'endnote', number: 1, label: 'i', text: 'Budget permitting.', after: 'Hire two people' }
    ])
    expect(() => insertNoteChange({}, { text: '' })).toThrow('Say what the footnote says (content, in Markdown)')
  })

  it('names notes by kind and number or by their place, changes one and takes one out', () => {
    let json = onFile(insertNoteChange({ quote: 'Sales grew in March.' }, { text: 'Source.' }), report()).json
    json = onFile(insertNoteChange({ kind: 'endnote', quote: 'Hire two people.' }, { text: 'Budget permitting.' }), json).json
    const changed = onFile(setNoteChange({ note: 'endnote 1' }, { text: 'If the budget allows.' }), json)
    const removed = onFile(removeNoteChange({ note: '1' }), changed.json)

    expect(noteRefOf('Endnote ii')).toEqual({ kind: 'endnote', number: 2 })
    expect(noteRefOf('3')).toBe(2)
    expect(noteRefOf('2', 'endnote')).toEqual({ kind: 'endnote', number: 2 })
    expect(() => noteRefOf('')).toThrow(/Say which note/)
    expect(changed.summary).toBe('Changed what endnote 1 says in Report.docx')
    expect(notes(stateOf(changed.json).doc).map((note) => note.text)).toEqual(['Source.', 'If the budget allows.'])
    expect(removed.summary).toBe('Took footnote 1 and its reference out of Report.docx')
    expect(notes(stateOf(removed.json).doc).map((note) => note.kind)).toEqual(['endnote'])
    expect(() => onFile(removeNoteChange({ note: 'footnote 4' }), json)).toThrow('The document has no footnote 4 (it has 1 footnote and 1 endnote; docs.listNotes lists them)')
  })
})

describe('sections and the page', () => {
  it('starts a landscape section right before a heading, lists the sections and takes the break out', () => {
    const made = onFile(insertSectionBreakChange({ heading: 'Next steps', mode: 'before', orientation: 'landscape' }), report())
    const sections = sectionsList(stateOf(made.json).doc)

    expect(made.summary).toBe('Put a section break in Report.docx, before “Next steps”: section 2 starts on a new page, A4 landscape, margins 72 pt')
    expect(made.data).toMatchObject({ section: 2, kind: 'nextPage', page: { size: 'a4', orientation: 'landscape' } })
    expect(sections).toHaveLength(2)
    expect(sections[0]).toMatchObject({ section: 1, page: { size: 'a4', orientation: 'portrait', margins: { top: 72, header: 36, footer: 36 } } })
    expect(sections[0].text).toMatch(/^Report Intro text about sales\./)
    expect(sections[1]).toEqual({ section: 2, kind: 'nextPage', starts: 'on a new page', page: { size: 'a4', orientation: 'landscape', width: 841.9, height: 595.3, margins: { top: 72, right: 72, bottom: 72, left: 72, header: 36, footer: 36 } }, text: 'Next steps Hire two people.' })

    const joined = onFile(removeSectionBreakChange({}), made.json)

    expect(joined.summary).toBe('Took out the section break that started section 2 of Report.docx: its pages join section 1')
    expect(documentSections(stateOf(joined.json).doc)).toHaveLength(1)
    expect(() => onFile(removeSectionBreakChange({}), report())).toThrow(/one section/)
    expect(() => sectionKindOf('weekly')).toThrow(/kind is nextPage/)
    expect(sectionKindOf('Odd page')).toBe('oddPage')
  })

  it('keeps the page of the sections after a break taken out that kept its page', () => {
    const landscape = { ...A4, width: A4.height, height: A4.width }
    const paragraph = (words: string): DocNode => ({ type: 'paragraph', content: [{ type: 'text', text: words }] })
    const json: DocJSON = {
      type: 'doc',
      attrs: { page: A4 },
      content: [paragraph('One.'), { type: 'sectionBreak', attrs: { kind: 'nextPage', page: landscape } }, paragraph('Two.'), { type: 'sectionBreak', attrs: { kind: 'continuous', page: null } }, paragraph('Three.')]
    }
    const joined = onFile(removeSectionBreakChange({ section: '2' }), json)

    expect(documentSections(stateOf(json).doc).map((section) => section.page.width)).toEqual([A4.width, A4.height, A4.height])
    expect(documentSections(stateOf(joined.json).doc).map((section) => section.page.width)).toEqual([A4.width, A4.height])
    expect(() => onFile(removeSectionBreakChange({}), json)).toThrow('Say which section break (section: the section it starts, from 2 to 3; docs.listSections lists them)')
    expect(() => onFile(removeSectionBreakChange({ section: '1' }), json)).toThrow(/section 1 starts the document/)
  })

  it('sets up the page with the arguments it always took, and with each side, distances, sizes of its own and sections', () => {
    const old = onFile(setPageChange({ size: 'Letter', orientation: 'landscape', margins: '1in' }), report())

    expect(pageOf(old.json)).toEqual({ width: 792, height: 612, margins: { top: 72, right: 72, bottom: 72, left: 72 } })
    expect(old.summary).toBe('Set up the page of Report.docx: Letter landscape, margins 72 pt')
    expect(old.data).toMatchObject({ size: 'letter', orientation: 'landscape', margins: 72, changed: true })
    expect(onFile(setPageChange({ size: 'letter', orientation: 'landscape', margins: '1in' }), old.json).summary).toBe('Report.docx already has that page setup')

    const sides = onFile(setPageChange({ size: '8.5 x 14 in', margins: '1in', left: '1.5in', headerDistance: '0.4in' }), report())

    expect(pageOf(sides.json)).toEqual({ width: 612, height: 1008, margins: { top: 72, right: 72, bottom: 72, left: 108, header: 28.8 } })
    expect(sides.summary).toBe('Set up the page of Report.docx: Legal portrait, margins 72, 72, 72 and 108 pt (top, right, bottom, left)')
    expect(pageArgsOf({ size: '210x297mm' })).toEqual({ size: { width: 595.3, height: 841.9 } })
    expect(() => pageArgsOf({ top: '-1' })).toThrow('top is points from 0 to 288')
    expect(() => pageArgsOf({ size: 'tabloid' })).toThrow(/size is one of a4, letter, legal, a5, or width by height/)

    const split = onFile(insertSectionBreakChange({ heading: 'Results', mode: 'before' }), report()).json
    const second = onFile(setPageChange({ section: '2', orientation: 'landscape' }), split)
    const first = onFile(setPageChange({ margins: '2cm' }), second.json)
    const every = onFile(setPageChange({ section: 'all', size: 'a5' }), second.json)

    expect(second.summary).toBe('Set up the page of section 2 of Report.docx: A4 landscape, margins 72 pt')
    expect(documentSections(stateOf(second.json).doc).map((section) => section.page.width)).toEqual([PAGE_SIZES.a4.width, PAGE_SIZES.a4.height])
    expect(first.summary).toBe('Set up the page of Report.docx: A4 portrait, margins 56.7 pt; the sections with a page of their own keep it (section=all changes them too)')
    expect(documentSections(stateOf(every.json).doc).map((section) => section.page.width)).toEqual([PAGE_SIZES.a5.width, PAGE_SIZES.a5.height])
    expect(pageSectionOf('All')).toBe('all')
    expect(pageSectionOf('section 3')).toBe(2)
    expect(() => pageSectionOf('first')).toThrow(/section is a section’s number from 1, as docs.listSections gives them, or all/)
    expect(() => setPageChange({ section: '2' })).toThrow(/Say what to change/)
    expect(() => onFile(setPageChange({ section: '4', margins: 10 }), split)).toThrow('The document has no section 4: it has 2')
  })
})

describe('comments', () => {
  const REVIEW = [
    { text: 'Source?', quote: 'Sales grew in March' },
    { text: 'Which people?', quote: 'hire two people' },
    { text: 'Typo?', quote: 'Sales fel in May' },
    { text: 'Shorter?', heading: 'Next steps' },
    { text: 'Every one?', quote: 'Sales', all: true },
    { text: 'Nowhere', heading: 'Appendix' }
  ]

  it('adds a review as one step to undo by Hermes, and lists the items whose text it did not find', () => {
    const view = live(report())
    const before = view.state.doc
    const answer = onLive(addCommentsChange(commentItemsOf(JSON.stringify(REVIEW)), commentAuthor({ source: 'agent' })), view)
    const added = comments(view.state.doc)

    expect(undoDepth(view.state)).toBe(1)
    expect(added.map((thread) => [thread.quote, thread.text])).toEqual([
      ['Sales grew in March', 'Source?'],
      ['Sales', 'Every one?'],
      ['Sales', 'Every one?'],
      ['Next steps', 'Shorter?'],
      ['Hire two people', 'Which people?']
    ])
    expect(new Set(added.map((thread) => `${thread.author} ${thread.initials}`))).toEqual(new Set(['Hermes H']))
    expect(answer.summary).toBe(
      'Added 5 comments to Report.docx as one step; not added: “Sales fel in May” (not found), heading “Appendix” (no such heading); quote the document’s words exactly, within one paragraph (docs.find finds them)'
    )
    expect(answer.data).toMatchObject({
      added: 5,
      missing: [
        { item: 3, text: 'Typo?', quote: 'Sales fel in May', reason: 'not found' },
        { item: 6, text: 'Nowhere', heading: 'Appendix', reason: 'no such heading' }
      ]
    })
    expect([...(answer.data?.ids as string[])].sort()).toEqual(['0', '1', '2', '3', '4'])
    undo(view.state, view.dispatch)
    expect(view.state.doc.eq(before)).toBe(true)
  })

  it('adds the same to a file, by the name the person gave Herald for anyone but Hermes', () => {
    $commentName.set('Ann Example')
    const items = commentItemsOf(REVIEW)
    const byHermes = onFile(addCommentsChange(items, commentAuthor({ source: 'agent' })), report())
    const byVoice = onFile(addCommentsChange(items, commentAuthor({ source: 'voice' })), report())

    expect(commentAuthor({ source: 'palette' })).toBeUndefined()
    expect(byHermes.data).toMatchObject({ added: 5, changed: true })
    expect(new Set(commentsOf(byHermes.json).map((thread) => thread.author))).toEqual(new Set(['Hermes']))
    expect(new Set(commentsOf(byVoice.json).map((thread) => `${thread.author} ${thread.initials}`))).toEqual(new Set(['Ann Example AE']))
    expect(onFile(addCommentsChange(commentItemsOf('[{"text": "Typo?", "quote": "Sales fel in May"}]'), 'Hermes'), report()).summary).toBe(
      'Added no comments to Report.docx: “Sales fel in May” (not found); quote the document’s words exactly, within one paragraph (docs.find finds them)'
    )
  })

  it('reads the list strictly, and quotes with other spacing, quotes and dashes', () => {
    const doc = stateOf(documentFromMarkdown('It’s the team’s call — mostly.\n').document).doc

    expect(quoteMatches(doc, "It's the  team's call - mostly")).toHaveLength(1)
    expect(() => commentItemsOf('[{"text": "Hm"}]')).toThrow('Comment 1 says what it is on: quote (exact text in the document), heading or at (selection or marked)')
    expect(() => commentItemsOf('[{"quote": "Sales"}]')).toThrow('Comment 1 needs text: what it says')
    expect(() => commentItemsOf('[{"text": "Hm", "at": "everywhere"}]')).toThrow(/at is selection or marked/)
    expect(() => commentItemsOf('Sales: check')).toThrow(/comments is a JSON list/)
    expect(commentItemsOf({ text: 'One', quote: 'Sales' })).toEqual([{ text: 'One', quote: 'Sales', all: false }])
  })

  it('puts one comment on a quote, a heading line or the selection of an open document', () => {
    const one = onFile(addCommentsChange([commentItemOf({ text: 'Why?', quote: 'grew' })], 'Hermes', true), report())
    const every = onFile(addCommentsChange([commentItemOf({ text: 'Why?', quote: 'Sales', all: true })], 'Hermes', true), report())
    const heading = onFile(addCommentsChange([commentItemOf({ text: 'Rename?', heading: '2' })], 'Hermes', true), report())
    const view = live(report(), 'two people')
    const selected = onLive(addCommentsChange([commentItemOf({ text: 'Who?' })], 'Hermes', true), view)

    expect(one.summary).toBe('Put a comment on “grew” in Report.docx')
    expect(one.data).toMatchObject({ added: 1, ids: ['0'], missing: [] })
    expect(every.summary).toBe('Put a comment on “Sales” at each of its 2 places in Report.docx')
    expect(heading.summary).toBe('Put a comment on “Results” in Report.docx')
    expect(selected.summary).toBe('Put a comment on “two people” in Report.docx')
    expect(onFile(addCommentsChange([commentItemOf({ text: 'Here?' })], 'Hermes', true), report()).summary).toBe('Added no comment to Report.docx: at=selection (only an open document has a selection: give a quote)')
  })

  it('replies, changes, resolves and deletes comments and replies by their ids', () => {
    $commentName.set('Ann Example')
    const reviewed = onFile(addCommentsChange(commentItemsOf('[{"text": "Source?", "quote": "Sales grew in March"}]')), report()).json
    const replied = onFile(replyChange({ comment: '0', text: 'The annual report.' }, 'Hermes'), reviewed)
    const again = onFile(replyChange({ comment: '1', text: 'Thanks.' }), replied.json)
    const edited = onFile(editCommentChange({ comment: '1', text: 'The 2025 annual report.' }), replied.json)
    const resolved = onFile(resolveChange({ comment: '0' }), edited.json)

    expect(replied.summary).toBe('Replied to Ann Example’s comment on “Sales grew in March” in Report.docx')
    expect(replied.data).toMatchObject({ comment: '0', reply: '1' })
    expect(comments(stateOf(again.json).doc)[0].replies.map((reply) => [reply.id, reply.author, reply.text])).toEqual([
      ['1', 'Hermes', 'The annual report.'],
      ['2', 'Ann Example', 'Thanks.']
    ])
    expect(edited.summary).toBe('Changed what Hermes’s reply to Ann Example’s comment on “Sales grew in March” says in Report.docx')
    expect(commentsList(stateOf(edited.json).doc)).toMatchObject([{ id: '0', author: 'Ann Example', text: 'Source?', quote: 'Sales grew in March', heading: 'Results', resolved: false, replies: [{ id: '1', author: 'Hermes', text: 'The 2025 annual report.' }] }])
    expect(resolved.summary).toBe('Resolved Ann Example’s comment on “Sales grew in March” in Report.docx')
    expect(onFile(resolveChange({ comment: '1' }), resolved.json).summary).toBe('Ann Example’s comment on “Sales grew in March” is resolved already')
    expect(onFile(resolveChange({ comment: '0', resolved: false }), resolved.json).summary).toBe('Opened again Ann Example’s comment on “Sales grew in March” in Report.docx')
    expect(onFile(deleteCommentChange({ comment: '1' }), edited.json).summary).toBe('Deleted Hermes’s reply to Ann Example’s comment on “Sales grew in March” in Report.docx')

    const deleted = onFile(deleteCommentChange({ comment: '0' }), edited.json)

    expect(deleted.summary).toBe('Deleted Ann Example’s comment on “Sales grew in March” and its reply from Report.docx')
    expect(comments(stateOf(deleted.json).doc)).toEqual([])
    expect(onFile(deleteCommentChange({ all: true }), again.json).summary).toBe('Deleted 1 comment from Report.docx')
    expect(onFile(deleteCommentChange({ all: true }), report()).summary).toBe('Report.docx has no comments')
    expect(() => onFile(replyChange({ comment: '9', text: 'Hm' }), edited.json)).toThrow('The document has no comment “9” (its comments are 0; docs.listComments says what each says)')
    expect(() => replyChange({ comment: '0' })).toThrow('Say what the reply says (text)')
    expect(() => deleteCommentChange({})).toThrow(/or all=true for every comment/)
  })
})

describe('tables of contents', () => {
  it('puts one in at the start or right before a heading, with its levels and title', () => {
    const made = onFile(insertTocChange({ levels: 2, title: 'In this report' }), report())
    const before = onFile(insertTocChange({ heading: 'Results', mode: 'before', title: 'none' }), report())

    expect(made.json.content[0]).toEqual({ type: 'tableOfContents', attrs: { levels: 2, title: 'In this report', pages: null } })
    expect(made.summary).toBe('Put a table of contents in Report.docx, at the start: 3 entries from Headings 1 to 2, under “In this report”')
    expect(made.data).toMatchObject({ toc: 1, levels: 2, title: 'In this report', entries: 3 })
    expect(before.json.content.map((block) => block.type)).toEqual(['heading', 'paragraph', 'tableOfContents', 'heading', 'paragraph', 'paragraph', 'heading', 'paragraph'])
    expect(before.summary).toBe('Put a table of contents in Report.docx, before “Results”: 3 entries from Headings 1 to 3, with no title')
    expect(() => insertTocChange({ levels: 9 })).toThrow(/levels is how many heading levels it lists, from 1 to 6/)
  })

  it('changes one, brings the page numbers up to date and takes one out', () => {
    const json = onFile(insertTocChange({}), report()).json
    const changed = onFile(setTocChange({ levels: 1, title: 'Contents' }), json)
    const numbered = onFile(updateTocsChange([1, 2, 3]), json)
    const twice = onFile(insertTocChange({ at: 'end' }), json).json
    const removed = onFile(removeTocChange({}), json)

    expect(changed.summary).toBe('Changed table of contents 1 of Report.docx: 1 entry from Heading 1, under “Contents”')
    expect(tocsList(stateOf(json).doc)).toEqual([{ toc: 1, levels: 3, title: 'Contents', entries: 3 }])
    expect(numbered.summary).toBe('Updated the page numbers of the table of contents in Report.docx')
    expect(numbered.json.content[0].attrs?.pages).toEqual([1, 2, 3])
    expect(onFile(updateTocsChange(null), json).summary).toBe('The table of contents in Report.docx is up to date (its page numbers come from the pages of an open document: docs.open lays them out)')
    expect(onFile(updateTocsChange(null), report()).summary).toBe('Report.docx has no table of contents (docs.insertToc puts one in)')
    expect(removed.summary).toBe('Took the table of contents out of Report.docx')
    expect(removed.json.content).toEqual(jsonOf(stateOf(report()).doc).content)
    expect(onFile(removeTocChange({ toc: '2' }), twice).summary).toBe('Took table of contents 2 out of Report.docx')
    expect(() => onFile(removeTocChange({}), twice)).toThrow('Say which table of contents (toc: from 1 to 2; docs.read part=tocs lists them)')
    expect(() => onFile(setTocChange({ title: 'Index' }), report())).toThrow('The document has no table of contents (docs.insertToc puts one in)')
    expect(() => setTocChange({})).toThrow(/Say what to change/)
  })
})

describe('templates', () => {
  const saved: SavedTemplate[] = [{ id: 'mine-1', name: 'Board pack', savedAt: '2026-10-01T09:00:00.000Z', doc: newDocumentModel(templateChoice('memo', []), 'a4') }]

  it('finds the built-in templates by id, by name, and by the names new documents were started with before', () => {
    expect(['letter', 'cover letter', 'report', 'memo', 'meeting notes', 'resume', 'proposal', 'essay'].map((name) => builtInTemplate(name)?.id)).toEqual(['letter', 'cover-letter', 'report', 'memo', 'meeting-notes', 'cv', 'project-proposal', 'essay'])
    expect(['Cover letter', 'CV', 'résumé', 'minutes', 'Thank-you note', 'Blank document', 'project proposal'].map((name) => builtInTemplate(name)?.id)).toEqual(['cover-letter', 'cv', 'cv', 'meeting-notes', 'thank-you-note', 'blank', 'project-proposal'])
    expect(builtInTemplate('novel')).toBeNull()
    expect(templateChoice('Board Pack', saved)).toMatchObject({ saved: true, id: 'mine-1', name: 'Board pack' })
    expect(templateChoice('mine-1', saved)).toMatchObject({ saved: true, name: 'Board pack' })
    expect(() => templateChoice('novel', saved)).toThrow(/^Herald Docs has no template “novel”: its own are blank, letter, .*, and the person’s “Board pack” \(docs.listTemplates says what each holds\)$/)
    expect(templateLabel(templateChoice('Cover letter', []))).toBe('the cover letter template')
    expect(templateLabel(templateChoice('cv', []))).toBe('the CV template')
    expect(templateLabel(templateChoice('board pack', saved))).toBe('the person’s template “Board pack”')
  })

  it('makes a document from a template on the paper asked for, content taking the place of its sample text', () => {
    const model = newDocumentModel(templateChoice('report', []), 'letter')
    const doc = stateOf(model).doc
    const written = withBody(model, blocks('# Q3 report\n\nAll good.'))

    expect(pageOf(model)).toMatchObject({ width: PAGE_SIZES.letter.width, height: PAGE_SIZES.letter.height })
    expect(headerFooterText(doc).parts.length).toBeGreaterThan(0)
    expect(tocsList(doc)).toHaveLength(1)
    expect(readDocument(doc, readOptions({ part: 'outline' })).outline.length).toBeGreaterThan(2)
    expect(written.content.map((block) => block.type)).toEqual(['heading', 'paragraph'])
    expect(written.attrs?.headers).toEqual(model.attrs?.headers)
    expect(written.attrs?.page).toEqual(model.attrs?.page)
    expect(newDocumentModel(null).content).toEqual([{ type: 'paragraph' }])
    expect(pageOf(newDocumentModel(null, 'A5'))).toMatchObject({ width: PAGE_SIZES.a5.width })
    expect(() => newDocumentModel(null, 'tabloid')).toThrow('size is one of a4, letter, legal, a5, not “tabloid”')
  })

  it('makes a document from one of the person’s templates as a copy, and lists both kinds', () => {
    const copy = newDocumentModel(templateChoice('Board pack', saved))
    const listed = templatesOutcome(saved)

    expect(copy).toEqual(saved[0].doc)
    expect(copy).not.toBe(saved[0].doc)
    expect(pageOf(newDocumentModel(templateChoice('Board pack', saved), 'letter'))).toMatchObject({ width: PAGE_SIZES.letter.width })
    expect(listed.summary).toMatch(/^Herald Docs has 13 templates \(blank, letter, cover-letter, cv, .*\), and the person saved 1 more: “Board pack”$/)
    expect(listed.data?.builtIn).toHaveLength(13)
    expect(listed.data?.saved).toEqual([{ id: 'mine-1', name: 'Board pack', savedAt: '2026-10-01T09:00:00.000Z' }])
  })
})

describe('statistics', () => {
  it('counts the whole document with its pages, one section, or the selection', () => {
    const json = report()
    const whole = statisticsOutcome(stateOf(json), {}, false, { name: 'Report.docx', path: null, pages: 2 })
    const section = statisticsOutcome(stateOf(json), { heading: 'Results' }, false, { name: 'Report.docx', path: null, pages: 2 })
    const view = live(json, 'Hire two people.')
    const selected = statisticsOutcome(view.state, { selection: true }, true, { name: 'Report.docx', path: null })

    expect(whole.data).toMatchObject({ ...documentStatistics(json, { pages: 2 }), scope: 'document', readingTime: 'Under a minute', speakingTime: 'Under a minute' })
    expect(whole.summary).toMatch(/^Report\.docx: 19 words, \d+ characters \(\d+ without spaces\), 7 paragraphs, 7 sentences, 2 pages; under a minute to read and under a minute to say aloud; reading ease [\d.]+ \([A-Za-z ]+\), US school grade [\d.]+$/)
    expect(section.data).toMatchObject({ scope: 'section', heading: 'Results', words: 9 })
    expect(section.data).not.toHaveProperty('pages')
    expect(section.summary).toMatch(/^Report\.docx \(the section “Results”\): 9 words/)
    expect(selected.data).toMatchObject({ scope: 'selection', words: 3, sentences: 1 })
    expect(() => statisticsOutcome(stateOf(json), { selection: true }, false, { name: 'Report.docx', path: null })).toThrow(/Only a document open in Herald Docs has a selection/)
  })
})

describe('reading a document’s other parts', () => {
  /** The report with a footer, a footnote, a second section, a table of contents and two comments. */
  function rich(): DocJSON {
    let json = onFile(setPartChange('footer', {}, { text: 'Page {page} of {pages}' }), report()).json
    json = onFile(insertNoteChange({ quote: 'Sales grew in March.' }, { text: 'Source.' }), json).json
    json = onFile(insertSectionBreakChange({ heading: 'Next steps', mode: 'before', orientation: 'landscape' }), json).json
    json = onFile(insertTocChange({}), json).json

    return onFile(addCommentsChange(commentItemsOf('[{"text": "Up?", "quote": "Sales grew"}, {"text": "Who?", "quote": "Hire two people"}]'), 'Hermes'), json).json
  }

  it('reads comments, notes, headers and footers, sections and tables of contents as parts', () => {
    const doc = stateOf(rich()).doc

    expect(['comments', 'Footnotes', 'headers and footers', 'sections', 'toc'].map((part) => readOptions({ part }).part)).toEqual(['comments', 'notes', 'headers', 'sections', 'tocs'])
    expect(() => readOptions({ part: 'html' })).toThrow('part is markdown, text, outline, selection, comments, notes, headers, sections or tocs, not “html”')
    expect(readDocument(doc, readOptions({ part: 'comments' })).content).toBeUndefined()
    expect(isDepthPart('comments') && !isDepthPart('markdown')).toBe(true)
    expect(partReading(doc, 'comments').summary('Report.docx')).toBe('Report.docx: 2 comments')
    expect(partReading(doc, 'comments', 'Results').data.comments).toMatchObject([{ text: 'Up?', quote: 'Sales grew', heading: 'Results', author: 'Hermes' }])
    expect(partReading(doc, 'comments', 'Results').summary('Report.docx')).toBe('Report.docx: 1 comment under “Results”')
    expect(partReading(doc, 'notes').summary('Report.docx')).toBe('Report.docx: 1 footnote and 0 endnotes')
    expect(partReading(doc, 'headers').summary('Report.docx')).toBe('Report.docx: the footer on every page: “Page {page} of {pages}”')
    expect(partReading(doc, 'sections').summary('Report.docx')).toBe('Report.docx: 2 sections (1: A4 portrait, margins 72 pt; 2: A4 landscape, margins 72 pt)')
    expect(partReading(doc, 'tocs').summary('Report.docx')).toBe('Report.docx: 1 table of contents (3 entries from Headings 1 to 3, under “Contents”)')
    expect(() => partReading(doc, 'notes', 'Appendix')).toThrow('The document has no heading “Appendix” (docs.read part=outline lists them)')
  })

  it('says what else a document has whatever part is read', () => {
    expect(extrasOf(stateOf(rich()).doc)).toEqual({
      also: { comments: 2, footnotes: 1, footers: 1, sections: 2, tablesOfContents: 1 },
      words: 'it also has 2 comments, a footnote, a footer, 2 sections and a table of contents (part=comments, part=notes, part=headers, part=sections or part=tocs reads them)'
    })
    expect(extrasOf(stateOf(report()).doc)).toBeNull()
  })
})

describe('a batch of edits', () => {
  it('makes the new ops with the old ones as one step to undo, each on the document the ones before left', () => {
    const edits = editsOf(
      JSON.stringify([
        { op: 'replace', find: 'Sales', replacement: 'Revenue' },
        { op: 'SETFOOTER', content: 'Page {page} of {pages}', align: 'center' },
        { op: 'insertNote', quote: 'Hire two people.', content: 'From May.' },
        { op: 'insertSectionBreak', heading: 'Next steps', mode: 'before', orientation: 'landscape' },
        { op: 'addComments', comments: [{ text: 'Check', quote: 'Revenue grew' }, { text: 'Gone', quote: 'Sales grew' }] },
        { op: 'insertToc', levels: 2 },
        { op: 'setPage', section: '1', margins: '2cm' }
      ])
    )
    const view = live(report())
    const before = view.state.doc
    const depth = edits.map((entry) => depthEdit(entry, { content: CONTENT_OPS.has(entry.op) ? { blocks: blocks(String(entry.content)) } : null, author: 'Hermes' }))
    const op = chainBuilt(edits.map((entry, index) => (state: EditorState) => depth[index]?.build(state, null, true) ?? replaceText(String(entry.find), String(entry.replacement), { all: true })))
    const changed = applyLive(view, op)
    const doc = view.state.doc
    const answer = batchOutcome(edits.length, depth, { changed, name: 'Report.docx', path: null })

    expect(edits.map((entry) => entry.op)).toEqual(['replace', 'setFooter', 'insertNote', 'insertSectionBreak', 'addComments', 'insertToc', 'setPage'])
    expect(depth[0]).toBeNull()
    expect(undoDepth(view.state)).toBe(1)
    expect(headerFooterText(doc).parts.map((part) => part.text)).toEqual(['Page {page} of {pages}'])
    expect(notes(doc).map((note) => note.text)).toEqual(['From May.'])
    expect(documentSections(doc).map((section) => [section.page.margins.top, section.page.width > section.page.height])).toEqual([
      [56.7, false],
      [72, true]
    ])
    expect(comments(doc).map((thread) => [thread.quote, thread.author])).toEqual([['Revenue grew', 'Hermes']])
    expect(doc.firstChild?.type.name).toBe('tableOfContents')
    expect(answer.summary).toBe('Made 7 edits to Report.docx as one step; comments not added: “Sales grew” (not found); quote the document’s words exactly, within one paragraph (docs.find finds them)')
    expect(answer.data).toMatchObject({ edits: 7, changed: true, missing: [{ edit: 5, item: 2, text: 'Gone', quote: 'Sales grew', reason: 'not found' }] })
    undo(view.state, view.dispatch)
    expect(view.state.doc.eq(before)).toBe(true)
  })

  it('names every new op after its command, and refuses ops it does not have and edits without what they need', () => {
    expect(editsOf('[{"op": "removetoc"}, {"op": "replyToComment"}, {"op": "page"}]').map((entry) => entry.op)).toEqual(['removeToc', 'replyToComment', 'page'])
    expect(() => editsOf('[{"op": "addFootnote"}]')).toThrow(/Edit 1: op is one of .*setHeader.*removeToc, not “addFootnote”/)
    expect(() => depthEdit({ op: 'setHeader' }, { content: { text: '' } })).toThrow(/Say what the header says/)
    expect(() => depthEdit({ op: 'addComments', comments: '[]' }, { content: null })).toThrow(/comments is a JSON list/)
    expect(depthEdit({ op: 'write' }, { content: null })).toBeNull()
  })
})
