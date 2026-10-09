import { describe, expect, it } from 'vitest'
import { buildPrompt, type CellSelection, type CleanKind, type DocsAction, editsOffice, MAX_TEXT, type PromptContext, type SlideSelection, type SlidesAction, stepLabel, type TextSelection } from './prompts.ts'

const home = '/Users/sam'
const report = { name: 'Report.docx', path: '/Users/sam/Documents/Report.docx' }
const marked: TextSelection = { kind: 'text', text: 'Our results grew a lot this quarter.', marked: true }
const docs = (extra: Partial<PromptContext> = {}): PromptContext => ({ app: 'docs', document: report, words: 'make the intro friendlier', home, ...extra })

const cells: CellSelection = {
  kind: 'cells',
  sheet: 'Sheet1',
  range: 'B2:D4',
  rows: 3,
  columns: 3,
  top: 1,
  left: 1,
  grid: [
    ['Rent', '1,200', '1,200'],
    ['Food', '300', ''],
    ['Bus', '80', '80']
  ],
  cell: 'D2',
  formula: '=SUM(B2:C2)'
}
const sheets = (extra: Partial<PromptContext> = {}): PromptContext => ({ app: 'sheets', document: { name: 'Budget.xlsx', path: '/Users/sam/Budget.xlsx' }, words: 'add a total row', selection: cells, home, ...extra })

const slide: SlideSelection = {
  kind: 'slide',
  number: 3,
  count: 5,
  id: 'slide-3',
  layout: 'title-content',
  title: 'Market',
  bodies: ['Growing 20% a year\n  Mostly in Europe'],
  notes: 'Say the number twice.',
  selected: ['text box “Source: Gartner”'],
  titles: ['Pitch', 'Problem', 'Market', '', 'Ask']
}
const deck = (extra: Partial<PromptContext> = {}): PromptContext => ({ app: 'slides', document: { name: 'Pitch.pptx', path: '/Users/sam/Pitch.pptx' }, words: 'add a slide about pricing', selection: slide, home, ...extra })

describe('the prompt for a request about a document', () => {
  it('names the document, the words and the docs tool, and asks for one call and a short reply', () => {
    const prompt = buildPrompt(docs())

    expect(prompt.startsWith('[Herald Docs] The person is working on “Report.docx” (~/Documents/Report.docx) in Herald Docs and asks: make the intro friendlier\n')).toBe(true)
    expect(prompt).toContain('- Work on that document with the docs tool (document="~/Documents/Report.docx").')
    expect(prompt).toContain('Land the whole change in ONE call where you can (action=edit for several changes): each call is one step the person can undo.')
    expect(prompt).toContain('- Do not save unless asked.')
    expect(prompt).toContain('- Reply in one or two short sentences saying what changed (or the answer, for a question).')
    expect(prompt).not.toContain('at=marked')
  })

  it('carries the text marked for the request and says how to replace it', () => {
    const prompt = buildPrompt(docs({ selection: marked }))

    expect(prompt).toContain('Selected text, marked for this request:\n"""\nOur results grew a lot this quarter.\n"""')
    expect(prompt).toContain('- When the request is about the marked text, replace it with action=write at=marked.')
  })

  it('says the caret’s place is marked when nothing is selected', () => {
    const prompt = buildPrompt(docs({ selection: { kind: 'text', text: '', marked: true } }))

    expect(prompt).toContain('Nothing is selected; the caret’s place is marked for this request (at=marked writes there).')
    expect(prompt).not.toContain('Selected text')
  })

  it('cuts a long selection and says how to read all of it', () => {
    const prompt = buildPrompt(docs({ selection: { kind: 'text', text: 'x'.repeat(MAX_TEXT + 500), marked: true } }))

    expect(prompt).toContain('Selected text, marked for this request (its first 2,000 characters; docs action=read part=selection gives all of it):')
    expect(prompt).toContain(`${'x'.repeat(MAX_TEXT)}…`)
    expect(prompt).not.toContain('x'.repeat(MAX_TEXT + 1))
  })

  it('calls a document that is not saved yet by its tab name', () => {
    const prompt = buildPrompt(docs({ document: { name: 'Untitled 2', path: null } }))

    expect(prompt).toContain('working on “Untitled 2” (not saved yet: call it "Untitled 2") in Herald Docs')
    expect(prompt).toContain('docs tool (document="Untitled 2")')
  })

  it('lists the other open documents, at most eight, for requests across them', () => {
    const prompt = buildPrompt(docs({ others: [{ app: 'sheets', name: 'Budget.xlsx', path: '/Users/sam/Budget.xlsx', selection: 'Sheet1!B2:D9' }, { app: 'docs', name: 'Notes', path: null }] }))

    expect(prompt).toContain('Also open in Herald Office: “Budget.xlsx” (Herald Sheets, ~/Budget.xlsx, selection Sheet1!B2:D9); “Notes” (Herald Docs, not saved yet).')

    const many = buildPrompt(docs({ others: Array.from({ length: 11 }, (_, n) => ({ app: 'docs' as const, name: `Draft ${n + 1}`, path: null })) }))

    expect(many).toContain('“Draft 8” (Herald Docs, not saved yet), and 3 more.')
    expect(many).not.toContain('Draft 9')
  })
})

describe('the prompt for a request about a workbook', () => {
  it('shows the selection as a grid with the active cell’s formula, and names the sheets tool', () => {
    const prompt = buildPrompt(sheets())

    expect(prompt.startsWith('[Herald Sheets] The person is working on “Budget.xlsx” (~/Budget.xlsx) in Herald Sheets and asks: add a total row\n')).toBe(true)
    expect(prompt).toContain('Selection: Sheet1!B2:D4 (3 rows × 3 columns); the active cell D2 holds =SUM(B2:C2).')
    expect(prompt).toContain('What the cells show:\nrow | B | C | D\n2 | Rent | 1,200 | 1,200\n3 | Food | 300 | \n4 | Bus | 80 | 80')
    expect(prompt).toContain('- Work on that workbook with the sheets tool (workbook="~/Budget.xlsx"); range=selection is the selected cells.')
    expect(prompt).toContain('ONE call where you can (action=edit for several changes)')
  })

  it('quotes a sheet name, escapes cell text and says when the grid is cut', () => {
    const prompt = buildPrompt(sheets({ selection: { ...cells, sheet: 'Q1 sales', range: 'A1:Z100', rows: 100, columns: 26, top: 0, left: 0, grid: [['a|b', 'line one\nline two']], cell: 'A1', formula: null } }))

    expect(prompt).toContain("Selection: 'Q1 sales'!A1:Z100 (100 rows × 26 columns); the active cell A1 has no formula.")
    expect(prompt).toContain('row | A | B\n1 | a\\|b | line one line two')
    expect(prompt).toContain('(the first 1 row and 2 columns; sheets action=read gives the rest)')
  })
})

describe('the inline actions', () => {
  const docsActions: [DocsAction, string][] = [
    [{ id: 'rewrite' }, 'Rewrite the marked text so it reads more clearly, keeping its meaning.'],
    [{ id: 'shorten' }, 'Shorten the marked text, keeping what matters.'],
    [{ id: 'expand' }, 'Expand the marked text with more detail, in the same voice.'],
    [{ id: 'tone', tone: 'Friendly' }, 'Rewrite the marked text in a friendly tone, keeping its meaning.']
  ]

  it.each(docsActions)('replace the marked text with one docs write at=marked (%o)', (action, ask) => {
    const prompt = buildPrompt(docs({ selection: marked, action, others: [{ app: 'docs', name: 'Notes', path: null }] }))

    expect(prompt).toContain(`asks: ${ask}\n`)
    expect(prompt).toContain('- Replace the marked text with ONE docs call: action=write document="~/Documents/Report.docx" at=marked content=<')
    expect(prompt).toContain('- Keep its language, and its emphasis and links where they still fit; no quotes around it; change nothing else.')
    expect(prompt).toContain('- The whole marked text is above: no need to read the document first.')
    expect(prompt).toContain('- Reply with one short sentence.')
    expect(prompt).not.toContain('make the intro friendlier')
    expect(prompt).not.toContain('Also open')
  })

  it('translates into the language asked, which is the one thing it does not keep', () => {
    const prompt = buildPrompt(docs({ selection: marked, action: { id: 'translate', language: 'Spanish' } }))

    expect(prompt).toContain('asks: Translate the marked text into Spanish.')
    expect(prompt).toContain('at=marked content=<the Spanish translation, in Markdown>')
    expect(prompt).not.toContain('Keep its language')
  })

  it('fixes spelling and grammar only, and makes no call when nothing is wrong', () => {
    const prompt = buildPrompt(docs({ selection: marked, action: { id: 'fix' } }))

    expect(prompt).toContain('action=write document="~/Documents/Report.docx" at=marked content=<the corrected text, in Markdown>')
    expect(prompt).toContain('- If nothing is wrong, make no call and say so.')
  })

  it('puts a summary under the paragraph and leaves the selection as it is', () => {
    const prompt = buildPrompt(docs({ selection: marked, action: { id: 'summarise' } }))

    expect(prompt).toContain('- Put the summary under its paragraph with ONE docs call: action=write document="~/Documents/Report.docx" at=after content=<')
    expect(prompt).toContain('- Leave the marked text as it is; change nothing else.')
    expect(prompt).not.toContain('at=marked content')
  })

  it('reads a long selection before rewriting it', () => {
    const prompt = buildPrompt(docs({ selection: { kind: 'text', text: 'x'.repeat(MAX_TEXT + 1), marked: true }, action: { id: 'shorten' } }))

    expect(prompt).not.toContain('no need to read the document first')
  })

  it('explains the active cell’s formula step by step and changes nothing', () => {
    const prompt = buildPrompt(sheets({ action: { id: 'explain' } }))

    expect(prompt).toContain('asks: Explain the formula in D2 step by step.')
    expect(prompt).toContain('the active cell D2 holds =SUM(B2:C2).')
    expect(prompt).toContain('- Read the cells it refers to when that helps (sheets action=read workbook="~/Budget.xlsx"), and change nothing.')
  })

  it('fills the empty cells of a column with one fill when a rule computes them, or one write', () => {
    const column = buildPrompt(sheets({ selection: { ...cells, range: 'D2:D20', rows: 19, columns: 1, left: 3, grid: [['1,200'], ['']] }, action: { id: 'fill' } }))

    expect(column).toContain('asks: Fill the empty cells of Sheet1!D2:D20 following the filled ones.')
    expect(column).toContain('fill a formula with ONE call: action=fill range=<the empty cells> formula=<the first one’s formula>.')
    expect(column).toContain('write all the missing values with ONE call: action=write (or action=edit when the empty cells are not next to each other).')
    expect(column).toContain('- Leave the filled cells as they are; do not save.')

    const cell = buildPrompt(sheets({ selection: { ...cells, range: 'D2', rows: 1, columns: 1, left: 3, grid: [['1,200']] }, action: { id: 'fill' } }))

    expect(cell).toContain('asks: Fill the empty cells of Sheet1!D:D following the filled ones.')
  })

  const cleanings: [CleanKind, string][] = [
    ['dedupe', 'Remove the duplicate rows in Sheet1!B2:D4.'],
    ['dates', 'Turn the dates kept as text in Sheet1!B2:D4 into real dates.'],
    ['split', 'Split Sheet1!B2:D4 at its delimiter into the columns to its right.'],
    ['trim', 'Trim the extra spaces in Sheet1!B2:D4.'],
    ['numbers', 'Turn the numbers stored as text in Sheet1!B2:D4 into numbers.']
  ]

  it.each(cleanings)('clean the selection with one sheets clean call (%s)', (clean, ask) => {
    const prompt = buildPrompt(sheets({ action: { id: 'clean', clean } }))

    expect(prompt).toContain(`asks: ${ask}\n`)
    expect(prompt).toContain(`- Make ONE sheets call: action=clean workbook="~/Budget.xlsx" range=Sheet1!B2:D4 clean=${clean}`)
    expect(prompt).toContain('with header=true when its first row holds column names.')
    expect(prompt).toContain('- Change nothing else; do not save.')
  })

  it('reads the whole sheet to say what stands out, changing nothing', () => {
    const prompt = buildPrompt(sheets({ action: { id: 'insights' } }))

    expect(prompt).toContain('asks: What stands out in this sheet?')
    expect(prompt).toContain('- Read the sheet’s cells that hold something (sheets action=read workbook="~/Budget.xlsx", no range), and change nothing.')
    expect(prompt).toContain('totals, trends, outliers and gaps')
  })

  const pitch = (action: SlidesAction) => buildPrompt(deck({ words: 'an action', action }))

  it('write speaker notes for the slide in front with one set_slide, or for every slide with one edit batch', () => {
    const one = pitch({ id: 'notes' })

    expect(one).toContain('asks: Write speaker notes for slide 3.\n')
    expect(one).toContain('- Make ONE slides call: action=set_slide presentation="~/Pitch.pptx" slide=3 notes=<two to four short sentences to say aloud, in the slide’s language>.')

    const every = pitch({ id: 'allNotes' })

    expect(every).toContain('- Read the deck first (slides action=read presentation="~/Pitch.pptx").')
    expect(every).toContain('- Then make ONE slides call: action=edit presentation="~/Pitch.pptx" edits=[{"op": "setSlide", "slide": <its number>, "notes": "<two to four short sentences to say aloud>"}, …], one setSlide for each slide with something on it.')
  })

  it('choose layouts for the whole deck in one edit batch', () => {
    const prompt = pitch({ id: 'layouts' })

    expect(prompt).toContain('asks: Choose each slide’s layout for what it holds.\n')
    expect(prompt).toContain('action=edit presentation="~/Pitch.pptx" edits=[{"op": "setSlide", "slide": <its number>, "layout": "<title, title-content, two-content, comparison, section, title-only, blank or picture-caption>"}, …]')
  })

  it('tighten the slide in front with one set_slide, its notes left alone', () => {
    const prompt = pitch({ id: 'tighten' })

    expect(prompt).toContain('asks: Tighten slide 3: shorter, parallel bullets.\n')
    expect(prompt).toContain('- Make ONE slides call: action=set_slide presentation="~/Pitch.pptx" slide=3 body=<the tightened text')
    expect(prompt).toContain('leave its notes as they are')
  })

  it('make slides from an open document, into this deck or a new one, saying which', () => {
    const report = { app: 'docs' as const, name: 'Report.docx', path: '/Users/sam/Documents/Report.docx' }
    const into = pitch({ id: 'fromDocument', document: report, into: 'this' })

    expect(into).toContain('asks: Make slides from the document “Report.docx” and add them at the end of this presentation.\n')
    expect(into).toContain('- Make ONE slides call: action=from_document document="~/Documents/Report.docx" presentation="~/Pitch.pptx".')

    const fresh = pitch({ id: 'fromDocument', document: { app: 'docs', name: 'Notes', path: null }, into: 'new' })

    expect(fresh).toContain('asks: Make a new presentation from the document “Notes”.\n')
    expect(fresh).toContain('- Make ONE slides call: action=from_document document="Notes", leaving presentation out so the slides go in a new presentation named after the document.')
  })

  it('put a workbook’s selection on a table slide with insert_range, after a slide that sums it up', () => {
    const prompt = pitch({ id: 'fromSheet', workbook: { app: 'sheets', name: 'Budget.xlsx', path: '/Users/sam/Budget.xlsx', selection: 'Sheet1!B2:D9' } })

    expect(prompt).toContain('asks: Put the cells of “Budget.xlsx” on a new slide after slide 3 as a table, with a slide after it that sums them up.\n')
    expect(prompt).toContain('- Read the cells first (sheets action=read workbook="~/Budget.xlsx" range=Sheet1!B2:D9).')
    expect(prompt).toContain('- Add both slides with ONE slides call: action=edit presentation="~/Pitch.pptx" edits=[{"op": "addSlide", "layout": "title-only", "title": "<what the table shows>", "after": 3}, {"op": "addSlide"')
    expect(prompt).toContain('- Then put the table on the first of them with ONE more call: action=insert_range presentation="~/Pitch.pptx" slide="<the table slide’s title>" workbook="~/Budget.xlsx" range=Sheet1!B2:D9.')

    const used = pitch({ id: 'fromSheet', workbook: { app: 'sheets', name: 'Budget.xlsx', path: '/Users/sam/Budget.xlsx', selection: 'Sheet1!B2' } })

    expect(used).toContain('sheets action=read workbook="~/Budget.xlsx" with no range gives the ones that hold something')
    expect(used).toContain('workbook="~/Budget.xlsx" range=<that range>.')
  })
})

describe('the prompt for a request about a presentation', () => {
  it('names the slide in front by number, with its text, notes, selection and the deck’s titles', () => {
    const prompt = buildPrompt(deck())

    expect(prompt.startsWith('[Herald Slides] The person is working on “Pitch.pptx” (~/Pitch.pptx) in Herald Slides and asks: add a slide about pricing\n')).toBe(true)
    expect(prompt).toContain(
      'In front: slide 3 of 5, “Market” (layout title-content, id slide-3).\nIts text:\n"""\nGrowing 20% a year\n  Mostly in Europe\n"""\nIts speaker notes:\n"""\nSay the number twice.\n"""\nSelected on it: text box “Source: Gartner”.\nThe slides: 1 “Pitch”, 2 “Problem”, 3 “Market”, 4 (no title), 5 “Ask”.'
    )
    expect(prompt).toContain('- Work on that presentation with the slides tool (presentation="~/Pitch.pptx"); slide=3 is the slide in front.')
    expect(prompt).toContain('- Land the whole change in ONE call where you can (action=edit for several changes): each call is one step the person can undo.')
    expect(prompt).not.toContain('os_ui')
  })

  it('shows both columns of a two-column slide, and at most forty titles', () => {
    const prompt = buildPrompt(deck({ selection: { ...slide, layout: 'two-content', bodies: ['Pros\nFast', 'Cons\nCostly'], notes: '', selected: [], titles: Array.from({ length: 45 }, (_, n) => `Slide ${n + 1}`) } }))

    expect(prompt).toContain('Its two columns:\n"""\nPros\nFast\n"""\n"""\nCons\nCostly\n"""')
    expect(prompt).toContain('40 “Slide 40”, and 5 more.')
    expect(prompt).not.toContain('Its speaker notes')
  })

  it('says what the editor shows when there is no slide to read', () => {
    const prompt = buildPrompt(deck({ selection: null, detail: 'slide 3 of 12 (“Market”)' }))

    expect(prompt).toContain('On screen: slide 3 of 12 (“Market”).')
    expect(prompt).toContain('- Work on that presentation with the slides tool (presentation="~/Pitch.pptx").')
  })
})

describe('what the bar says of Hermes’s work', () => {
  it('names the tool and its action, in words for reading', () => {
    expect(stepLabel('docs', { action: 'write' })).toBe('docs · write')
    expect(stepLabel('docs', { action: 'read' })).toBe('Reading the document')
    expect(stepLabel('sheets', { action: 'read' })).toBe('Reading the cells')
    expect(stepLabel('slides', { action: 'read' })).toBe('Reading the presentation')
    expect(stepLabel('slides', { action: 'set_slide' })).toBe('slides · set_slide')
    expect(stepLabel('sheets', { action: 'list_all' })).toBe('Looking at what is open')
    expect(stepLabel('os_ui', { action: 'run', command: 'slides.setSlide' })).toBe('slides · setSlide')
    expect(stepLabel('terminal', null)).toBe('terminal')
  })

  it('tells calls that change Office documents from the rest', () => {
    expect(editsOffice('docs', { action: 'write' })).toBe(true)
    expect(editsOffice('sheets', { action: 'clean' })).toBe(true)
    expect(editsOffice('slides', { action: 'add_slide' })).toBe(true)
    expect(editsOffice('os_ui', { action: 'run', command: 'slides.addSlide' })).toBe(true)
    expect(editsOffice('os_ui', { action: 'run', command: 'page.open' })).toBe(false)
    expect(editsOffice('terminal', { command: 'ls' })).toBe(false)
  })
})
