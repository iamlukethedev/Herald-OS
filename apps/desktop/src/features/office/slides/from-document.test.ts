import { describe, expect, it } from 'vitest'
import { bytesToBase64, CODE_FONT, type DocJSON, type DocNode, paragraphNode, textNode } from '../../../../shared/office/document.ts'
import { type Deck, type ImageElement, type Slide, type SlideElement, SLIDE_SIZES, type TableElement, type TextElement } from './deck.ts'
import { coverCrop } from './elements.ts'
import { deckFromDocument, slidesFromDocument } from './from-document.ts'
import { placeholderFor } from './layouts.ts'
import * as model from './model.ts'
import { THEMES } from './themes.ts'
import { listMarkers, plainText } from './text.ts'

const doc = (...content: DocNode[]): DocJSON => ({ type: 'doc', attrs: { page: null, styles: null }, content })
const p = (text: string, attrs?: Record<string, unknown>): DocNode => paragraphNode(text ? [textNode(text)] : [], attrs)
const h = (level: number, text: string): DocNode => ({ type: 'heading', attrs: { level }, content: [textNode(text)] })
const li = (text: string, ...nested: DocNode[]): DocNode => ({ type: 'listItem', content: [p(text), ...nested] })
const ul = (...items: DocNode[]): DocNode => ({ type: 'bulletList', content: items })
const ol = (start: number, ...items: DocNode[]): DocNode => ({ type: 'orderedList', attrs: { start }, content: items })
const td = (text: string, attrs?: Record<string, unknown>): DocNode => ({ type: 'tableCell', ...(attrs ? { attrs } : {}), content: [p(text)] })
const th = (text: string): DocNode => ({ type: 'tableHeader', content: [p(text)] })
const tr = (...cells: DocNode[]): DocNode => ({ type: 'tableRow', content: cells })
const picture = (src: string, alt?: string): DocNode => paragraphNode([{ type: 'image', attrs: { src, ...(alt ? { alt } : {}) } }])

/** A PNG's signature and header: enough for its size to be read. */
function png(width: number, height: number): string {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)

  return `data:image/png;base64,${bytesToBase64(bytes)}`
}

const textOf = (element: SlideElement | undefined): string => (element && (element.kind === 'text' || element.kind === 'shape') ? plainText(element.body) : '')
const titles = (deck: Deck) => deck.slides.map((slide) => textOf(placeholderFor(slide, 'title')))
const layouts = (deck: Deck) => deck.slides.map((slide) => slide.layout)
const bodyOf = (slide: Slide) => placeholderFor(slide, 'body') as TextElement
const bullets = (slide: Slide) => bodyOf(slide).body.paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join(''))
const boxes = (slide: Slide) => slide.elements.filter((element): element is TextElement => element.kind === 'text' && !element.placeholder)
const without = (deck: Deck) => JSON.parse(JSON.stringify(deck, (key, value) => (key === 'id' || key === 'slideId' ? undefined : value)))

/** A sentence long enough to take two lines of a Title and Content slide's text. */
const sentence = (n: number) => `Point ${n} explains one part of the plan in a sentence that is long enough to wrap onto a second line.`

const report = doc(
  p('Project Phoenix', { docStyle: 'title' }),
  p('Kick-off, autumn', { docStyle: 'subtitle' }),
  p('Why we are here.'),
  h(1, 'Goals'),
  h(2, 'Speed'),
  p('Pages load in under a second.'),
  h(2, 'Quality'),
  ul(li('Fewer bugs'), li('More tests')),
  h(1, 'Budget'),
  p('We spend less than last year.'),
  h(1, 'Questions')
)

describe('decks from documents', () => {
  it('makes a title slide, section headers and slides of bullets from the headings', () => {
    const deck = deckFromDocument(report)

    expect(deck.title).toBe('Project Phoenix')
    expect(layouts(deck)).toEqual(['title', 'title-content', 'section', 'title-content', 'title-content', 'title-content', 'section'])
    expect(titles(deck)).toEqual(['Project Phoenix', 'Project Phoenix', 'Goals', 'Speed', 'Quality', 'Budget', 'Questions'])
    expect(textOf(placeholderFor(deck.slides[0], 'subtitle'))).toBe('Kick-off, autumn')
    expect(deck.slides.slice(1).map((slide) => (slide.layout === 'title-content' ? bullets(slide) : []))).toEqual([['Why we are here.'], [], ['Pages load in under a second.'], ['Fewer bugs', 'More tests'], ['We spend less than last year.'], []])
    expect(deck.slides.every((slide) => slide.notes === '')).toBe(true)
  })

  it('takes the title from the heading that heads the document, else the title given, else the first heading', () => {
    const notes = deckFromDocument(doc(h(1, 'Field notes'), p('A week at the lake.'), h(2, 'Monday'), p('Rain.'), h(2, 'Tuesday'), p('Sun.')), { title: 'notes' })

    expect(titles(notes)).toEqual(['Field notes', 'Monday', 'Tuesday'])
    expect(textOf(placeholderFor(notes.slides[0], 'subtitle'))).toBe('A week at the lake.')
    expect(layouts(notes)).toEqual(['title', 'title-content', 'title-content'])

    const sync = doc(h(1, 'Agenda'), p('Introductions, then the plan for the week ahead: who does what, by when, and how we will know it worked, with time for questions at the end.'), h(1, 'Decisions'), p('Ship it.'))

    expect(titles(deckFromDocument(sync, { title: 'Weekly sync' }))).toEqual(['Weekly sync', 'Agenda', 'Decisions'])
    expect(titles(deckFromDocument(sync))).toEqual(['Agenda', 'Agenda', 'Decisions'])
    expect(titles(deckFromDocument(doc(p('Just a note.')), { title: 'Memo' }))).toEqual(['Memo', 'Memo'])
    expect(titles(deckFromDocument(doc()))).toEqual([''])
  })

  it('gives a section header its heading’s one short paragraph as its subtitle', () => {
    const deck = deckFromDocument(doc(p('Plan', { docStyle: 'title' }), h(1, 'Goals'), p('Where we want to be by June.'), h(2, 'Speed'), p('Fast pages.')))

    expect(layouts(deck)).toEqual(['title', 'section', 'title-content'])
    expect(textOf(placeholderFor(deck.slides[1], 'subtitle'))).toBe('Where we want to be by June.')
  })

  it('keeps list levels, numbering, to-do boxes and emphasis', () => {
    const tasks: DocNode = {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [p('Done')] },
        { type: 'taskItem', attrs: { checked: false }, content: [p('To do')] }
      ]
    }
    const emphasis = paragraphNode([textNode('Ship '), textNode('fast', [{ type: 'bold' }]), textNode(' with '), textNode('npm', [{ type: 'code' }])])
    const callout: DocNode = { type: 'callout', attrs: { kind: 'warning' }, content: [p('Mind the gap.')] }
    const deck = deckFromDocument(doc(h(1, 'Plan'), ul(li('Research', ul(li('Interviews'), li('Surveys', ul(li('Online'))))), li('Build')), ol(3, li('Third'), li('Fourth')), tasks, h(2, 'Notes'), emphasis, callout))
    const paragraphs = bodyOf(deck.slides[1]).body.paragraphs

    expect(titles(deck)).toEqual(['Plan', 'Plan', 'Notes'])
    expect(paragraphs.map((paragraph) => [paragraph.list, paragraph.level, paragraph.runs.map((run) => run.text).join('')])).toEqual([
      ['bullet', 0, 'Research'],
      ['bullet', 1, 'Interviews'],
      ['bullet', 1, 'Surveys'],
      ['bullet', 2, 'Online'],
      ['bullet', 0, 'Build'],
      ['number', 0, 'Third'],
      ['number', 0, 'Fourth'],
      ['bullet', 0, 'Done'],
      ['bullet', 0, 'To do']
    ])
    expect(listMarkers(paragraphs)).toEqual(['•', '◦', '◦', '▪', '•', '3.', '4.', '☑', '☐'])
    expect(bullets(deck.slides[2])).toEqual(['Ship fast with npm', 'Mind the gap.'])
    expect(bodyOf(deck.slides[2]).body.paragraphs[0].runs).toEqual([{ text: 'Ship ' }, { text: 'fast', bold: true }, { text: ' with ' }, { text: 'npm', font: CODE_FONT }])
  })

  it('goes on over further slides with a long section, numbering on, paragraphs whole', () => {
    const deck = deckFromDocument(doc(p('Notes', { docStyle: 'title' }), h(1, 'Details'), ...Array.from({ length: 20 }, (_, n) => p(sentence(n + 1))), h(1, 'Steps'), ol(1, ...Array.from({ length: 8 }, (_, n) => li(sentence(n + 1))))))
    const details = deck.slides.filter((slide) => textOf(placeholderFor(slide, 'title')).startsWith('Details'))
    const steps = deck.slides.filter((slide) => textOf(placeholderFor(slide, 'title')).startsWith('Steps'))

    expect(titles({ ...deck, slides: details })).toEqual(['Details', 'Details (continued)', 'Details (continued)', 'Details (continued)'])
    expect(details.map((slide) => bullets(slide).length)).toEqual([5, 5, 5, 5])
    expect(details.flatMap(bullets)).toEqual(Array.from({ length: 20 }, (_, n) => sentence(n + 1)))
    expect(steps.map((slide) => listMarkers(bodyOf(slide).body.paragraphs))).toEqual([
      ['1.', '2.', '3.', '4.', '5.'],
      ['6.', '7.', '8.']
    ])
    expect(deck.slides.every((slide) => slide.notes === '')).toBe(true)
  })

  it('shortens a paragraph too long for a slide of its own, and gives that slide the section’s text as notes', () => {
    const words = `${Array.from({ length: 600 }, (_, n) => `word${n}`).join(' ')}.`
    const deck = deckFromDocument(doc(p('Essays', { docStyle: 'title' }), h(1, 'Essay'), p('A short opening.'), p(words), h(1, 'After'), p('Fine.')))
    const [cut] = bullets(deck.slides[2])

    expect(titles(deck)).toEqual(['Essays', 'Essay', 'Essay (continued)', 'After'])
    expect(cut.endsWith('…')).toBe(true)
    expect(words.startsWith(cut.slice(0, -1))).toBe(true)
    expect(cut.length).toBeLessThan(words.length / 2)
    expect(deck.slides.map((slide) => slide.notes)).toEqual(['', '', `A short opening.\n${words}`, ''])
  })

  it('puts one picture beside its text on a Two Content slide', () => {
    const deck = deckFromDocument(doc(p('Tour', { docStyle: 'title' }), h(1, 'Office'), p('The new office opened in May.'), picture(png(800, 400), 'The office')))
    const slide = deck.slides[1]
    const image = slide.elements.find((element): element is ImageElement => element.kind === 'image')!

    expect(slide.layout).toBe('two-content')
    expect(bullets(slide)).toEqual(['The new office opened in May.'])
    expect(slide.elements.filter((element) => element.placeholder?.role === 'body')).toHaveLength(1)
    expect(image).toMatchObject({ src: png(800, 400), natural: { width: 800, height: 400 }, alt: 'The office', x: 492, width: 408, height: 204 })
    expect(image.y + image.height / 2).toBeCloseTo(136 + 364 / 2)
  })

  it('puts a picture alone on a Picture with Caption slide, cut to fill its frame', () => {
    const deck = deckFromDocument(doc(p('Album', { docStyle: 'title' }), h(1, 'Team'), picture(png(300, 600)), p('Everyone at the summit.'), h(1, 'Map'), picture(png(400, 300), 'The route we took')))
    const [team, map] = deck.slides.slice(1)
    const frame = placeholderFor(team, 'picture') as ImageElement

    expect(layouts(deck)).toEqual(['title', 'picture-caption', 'picture-caption'])
    expect(frame).toMatchObject({ src: png(300, 600), natural: { width: 300, height: 600 }, crop: coverCrop({ width: 300, height: 600 }, frame) })
    expect(frame.crop!.top).toBeGreaterThan(0)
    expect(textOf(placeholderFor(team, 'caption'))).toBe('Everyone at the summit.')
    expect(textOf(placeholderFor(map, 'caption'))).toBe('The route we took')
    expect(titles(deck).slice(1)).toEqual(['Team', 'Map'])
  })

  it('gives several pictures among text slides of their own after the text', () => {
    const deck = deckFromDocument(doc(p('Trip', { docStyle: 'title' }), h(1, 'Days'), p('We walked.'), picture(png(400, 300), 'Hills'), p('We swam.'), picture(png(400, 300), 'Lake')))

    expect(layouts(deck)).toEqual(['title', 'title-content', 'picture-caption', 'picture-caption'])
    expect(bullets(deck.slides[1])).toEqual(['We walked.', 'We swam.'])
    expect(deck.slides.slice(2).map((slide) => textOf(placeholderFor(slide, 'caption')))).toEqual(['Hills', 'Lake'])
  })

  it('gives a picture a slide of its own when its text is too long to go beside it, and leaves out pictures not in the document', () => {
    const long = deckFromDocument(doc(p('Trip', { docStyle: 'title' }), h(1, 'Days'), ...Array.from({ length: 6 }, (_, n) => p(sentence(n + 1))), picture(png(400, 300), 'Hills')))
    const linked = deckFromDocument(doc(p('Trip', { docStyle: 'title' }), h(1, 'Days'), p('We walked.'), picture('https://example.com/hills.png', 'Hills')))

    expect(layouts(long)).toEqual(['title', 'title-content', 'title-content', 'picture-caption'])
    expect(layouts(linked)).toEqual(['title', 'title-content'])
    expect(linked.slides[1].elements.some((element) => element.kind === 'image')).toBe(false)
  })

  it('makes a table slide with the header row styled, numbers right-aligned and merged cells kept', () => {
    const table: DocNode = { type: 'table', content: [tr(th('Quarter'), th('Revenue')), tr(td('Q1'), td('$1,200')), tr(td('Q2'), td('$1,450')), tr(td('Two quarters', { colspan: 2 }))] }
    const deck = deckFromDocument(doc(p('Results', { docStyle: 'title' }), h(1, 'Revenue'), table))
    const slide = deck.slides[1]
    const title = placeholderFor(slide, 'title')!
    const element = slide.elements.find((entry): entry is TableElement => entry.kind === 'table')!

    expect(slide.layout).toBe('title-only')
    expect(element.y).toBeGreaterThanOrEqual(title.y + title.height)
    expect(element.cells.map((row) => row.map((cell) => (cell.merged ? '·' : plainText(cell.body))))).toEqual([
      ['Quarter', 'Revenue'],
      ['Q1', '$1,200'],
      ['Q2', '$1,450'],
      ['Two quarters', '·']
    ])
    expect(element.cells[0].map((cell) => [cell.fill, cell.body.style.color, cell.body.style.bold])).toEqual([
      [{ color: 'accent1' }, 'bg1', true],
      [{ color: 'accent1' }, 'bg1', true]
    ])
    expect(element.cells.map((row) => row[1].body.paragraphs[0].align)).toEqual(['right', 'right', 'right', undefined])
    expect(element.cells[3][0].colSpan).toBe(2)
  })

  it('goes on with a table too tall for a slide, under its header row again', () => {
    const rows = Array.from({ length: 40 }, (_, n) => tr(td(`Week ${n + 1}`), td(String((n + 1) * 10))))
    const deck = deckFromDocument(doc(p('Log', { docStyle: 'title' }), h(1, 'Weeks'), { type: 'table', content: [tr(th('Week'), th('Hours')), ...rows] }))
    const tables = deck.slides.slice(1).map((slide) => slide.elements.find((entry): entry is TableElement => entry.kind === 'table')!)

    expect(tables.length).toBeGreaterThan(1)
    expect(titles(deck).slice(1)).toEqual(['Weeks', ...tables.slice(1).map(() => 'Weeks (continued)')])
    expect(tables.map((table) => plainText(table.cells[0][0].body))).toEqual(tables.map(() => 'Week'))
    expect(tables.flatMap((table) => table.cells.slice(1).map((row) => plainText(row[0].body)))).toEqual(Array.from({ length: 40 }, (_, n) => `Week ${n + 1}`))
  })

  it('makes a slide of a quote, large and in quotation marks, with who said it', () => {
    const quote: DocNode = { type: 'blockquote', content: [p('Keep it plain and it stays easy to change.'), p('— A designer')] }
    const deck = deckFromDocument(doc(p('Ideas', { docStyle: 'title' }), h(1, 'Principle'), quote))
    const [box] = boxes(deck.slides[1])

    expect(deck.slides[1].layout).toBe('title-only')
    expect(box.body.paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join(''))).toEqual(['“Keep it plain and it stays easy to change.”', '— A designer'])
    expect(box.body.style).toMatchObject({ size: 40, italic: true })
    expect(box.body.paragraphs[1].runs[0]).toMatchObject({ italic: false, color: 'tx2' })
    expect(deck.slides[1].notes).toBe('')

    const speech = Array.from({ length: 40 }, (_, n) => sentence(n + 1)).join(' ')
    const long = deckFromDocument(doc(p('Ideas', { docStyle: 'title' }), h(1, 'Speech'), { type: 'blockquote', content: [p(speech)] }))
    const [cut] = boxes(long.slides[1])
    const text = cut.body.paragraphs[0].runs[0].text

    expect(cut.body.style.size).toBe(24)
    expect(text.startsWith('“Point 1 explains')).toBe(true)
    expect(text.endsWith('…”')).toBe(true)
    expect(long.slides[1].notes).toBe(speech)
  })

  it('keeps code’s lines in a monospace box, going on over further slides when it is long', () => {
    const code: DocNode = { type: 'codeBlock', attrs: { language: 'ts' }, content: [textNode('function add(a, b) {\n\treturn a + b\n}')] }
    const long: DocNode = { type: 'codeBlock', content: [textNode(Array.from({ length: 60 }, (_, n) => `line(${n})`).join('\n'))] }
    const deck = deckFromDocument(doc(p('Code', { docStyle: 'title' }), h(1, 'Adding'), code, h(1, 'Listing'), long))
    const [box] = boxes(deck.slides[1])
    const listing = deck.slides.slice(2).flatMap((slide) => boxes(slide).flatMap((entry) => entry.body.paragraphs.map((paragraph) => paragraph.runs[0].text)))

    expect(box.body.style.font).toBe(CODE_FONT)
    expect(box.fill).toEqual({ color: 'bg2' })
    expect(box.body.paragraphs.map((paragraph) => paragraph.runs[0].text)).toEqual(['function add(a, b) {', '    return a + b', '}'])
    expect(box.body.paragraphs.every((paragraph) => paragraph.list === undefined)).toBe(true)
    expect(titles(deck).slice(2)).toEqual(['Listing', ...titles(deck).slice(3).map(() => 'Listing (continued)')])
    expect(deck.slides.length).toBeGreaterThan(3)
    expect(listing).toEqual(Array.from({ length: 60 }, (_, n) => `line(${n})`))
  })

  it('makes the same deck from the same document, in the size and theme asked for', () => {
    const standard = deckFromDocument(report, { size: SLIDE_SIZES.standard, theme: THEMES[2] })

    expect(without(deckFromDocument(report))).toEqual(without(deckFromDocument(report)))
    expect(standard).toMatchObject({ size: SLIDE_SIZES.standard, theme: THEMES[2] })
    expect(bodyOf(standard.slides[1]).width).toBe(630)
  })

  it('adds a document’s slides to a deck after a slide, as one step', () => {
    const deck = model.addSlide(model.newDeck('Deck'), { layout: 'blank' }).deck
    const change = slidesFromDocument(deck, report, { after: deck.slides[0].id })
    const added = change.deck.slides.slice(1, -1)

    expect(change).toMatchObject({ label: 'Slides from Document', focus: { slideId: change.slideIds[0], selected: [] } })
    expect(change.deck.slides.map((slide) => slide.id)).toEqual([deck.slides[0].id, ...change.slideIds, deck.slides[1].id])
    expect(without({ ...deck, slides: added })).toEqual(without({ ...deck, slides: deckFromDocument(report).slides }))
    expect(layouts({ ...deck, slides: slidesFromDocument(deck, doc(p('Just a note.'))).deck.slides.slice(2) })).toEqual(['title-content'])
    expect(slidesFromDocument(deck, doc())).toMatchObject({ deck, slideIds: [] })
  })
})
