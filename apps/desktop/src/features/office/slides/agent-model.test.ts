import { describe, expect, it } from 'vitest'
import {
  addImageStep,
  addShapeStep,
  addSlideStep,
  addTableStep,
  addTextStep,
  alignOf,
  bodiesOf,
  colorArg,
  composeChanges,
  duplicateSlideStep,
  findInDeck,
  headingLevelOf,
  layoutOf,
  moveSlideStep,
  newDeckWith,
  readDeck,
  removeSlideStep,
  replaceInDeck,
  runEdits,
  setSlideStep,
  setThemeStep,
  shapeOf,
  sizeOf,
  slideEditsOf,
  slideIdOf,
  slideSpecsOf
} from './agent-model.ts'
import { type Deck, SLIDE_SIZES, type Slide, type SlideElement, type TextElement } from './deck.ts'
import { SlidesDocument } from './document.ts'
import { placeholderFor } from './layouts.ts'
import * as model from './model.ts'
import { plainText } from './text.ts'

const textOf = (element: SlideElement | undefined): string => (element && (element.kind === 'text' || element.kind === 'shape') ? plainText(element.body) : '')
const titleOf = (slide: Slide): string => model.slideTitle(slide)
const bodyOf = (slide: Slide, nth = 0): string => textOf(placeholderFor(slide, 'body', nth) ?? placeholderFor(slide, 'subtitle'))
const none = { front: null }

/** A deck of an empty title slide and three titled ones: Agenda, Quarterly results, Results summary. */
function sample(): Deck {
  let deck = model.newDeck('Sample')

  for (const title of ['Agenda', 'Quarterly results', 'Results summary']) {
    deck = model.addSlide(deck, { title }).deck
  }

  return deck
}

describe('slides named by a command', () => {
  it('finds a slide by number, id, title, first or last, and falls back on the slide in front', () => {
    const deck = sample()
    const ids = deck.slides.map((slide) => slide.id)

    expect(slideIdOf(deck, 2)).toBe(ids[1])
    expect(slideIdOf(deck, '3')).toBe(ids[2])
    expect(slideIdOf(deck, 'slide 4')).toBe(ids[3])
    expect(slideIdOf(deck, '#2')).toBe(ids[1])
    expect(slideIdOf(deck, ids[2])).toBe(ids[2])
    expect(slideIdOf(deck, 'quarterly results')).toBe(ids[2])
    expect(slideIdOf(deck, '“Agenda”')).toBe(ids[1])
    expect(slideIdOf(deck, 'Results')).toBe(ids[3])
    expect(slideIdOf(deck, 'quarterly')).toBe(ids[2])
    expect(slideIdOf(deck, 'summary')).toBe(ids[3])
    expect(slideIdOf(deck, 'last')).toBe(ids[3])
    expect(slideIdOf(deck, 'first slide')).toBe(ids[0])
    expect(slideIdOf(deck, undefined, ids[2])).toBe(ids[2])
    expect(slideIdOf(deck, '', 'gone')).toBe(ids[0])
  })

  it('says which slides there are when it cannot find one', () => {
    const deck = sample()

    expect(() => slideIdOf(deck, 9)).toThrow('There is no slide 9; the presentation has 4')
    expect(() => slideIdOf(deck, 'Budget')).toThrow('There is no slide “Budget”: the slides are 1. (no title), 2. Agenda, 3. Quarterly results, 4. Results summary')
  })
})

describe('words a command uses', () => {
  it('reads layouts by id, by their name in the menu, and as people say them', () => {
    expect(layoutOf('title-content')).toBe('title-content')
    expect(layoutOf('Title and Content')).toBe('title-content')
    expect(layoutOf('title & content')).toBe('title-content')
    expect(layoutOf('two columns')).toBe('two-content')
    expect(layoutOf('Two Content')).toBe('two-content')
    expect(layoutOf('Section Header')).toBe('section')
    expect(layoutOf('title slide')).toBe('title')
    expect(layoutOf('blank slide')).toBe('blank')
    expect(layoutOf('Title Only')).toBe('title-only')
    expect(layoutOf('picture with caption')).toBe('picture-caption')
    expect(layoutOf('compare')).toBe('comparison')
    expect(() => layoutOf('mosaic')).toThrow('layout is one of title, title-content, two-content, section, title-only, blank, picture-caption, comparison')
  })

  it('reads colours, themes, sizes, shapes, alignments and heading levels', () => {
    expect(colorArg('#FFF', 'fill')).toBe('#ffffff')
    expect(colorArg('ff0000', 'fill')).toBe('#ff0000')
    expect(colorArg('navy', 'fill')).toBe('#000080')
    expect(colorArg('Accent 2', 'fill')).toBe('accent2')
    expect(colorArg('text', 'fill')).toBe('tx1')
    expect(colorArg('none', 'fill')).toBeNull()
    expect(() => colorArg('bad', 'fill')).toThrow('fill is a colour')

    expect(setThemeStep(model.newDeck('T'), { theme: 'Midnight' }).deck.theme.id).toBe('midnight')
    expect(setThemeStep(model.newDeck('T'), { theme: 'paper theme' }).deck.theme.id).toBe('paper')
    expect(() => setThemeStep(model.newDeck('T'), { theme: 'neon' })).toThrow('theme is one of herald, midnight, paper')

    expect(sizeOf('4:3')).toEqual(SLIDE_SIZES.standard)
    expect(sizeOf('')).toEqual(SLIDE_SIZES.wide)
    expect(() => sizeOf('huge')).toThrow('size is wide (16:9) or standard (4:3)')

    expect(shapeOf('circle')).toBe('ellipse')
    expect(shapeOf('Rounded Rectangle')).toBe('roundRect')
    expect(shapeOf('right arrow')).toBe('rightArrow')
    expect(shapeOf('star5')).toBe('star5')
    expect(shapeOf('')).toBe('rect')
    expect(() => shapeOf('blob')).toThrow('kind is a shape')

    expect(alignOf('centre')).toBe('center')
    expect(alignOf('')).toBeUndefined()
    expect(headingLevelOf('h2')).toBe(2)
    expect(() => headingLevelOf(7)).toThrow('level is a heading level from 1 to 6')
  })
})

describe('a slide’s text', () => {
  it('reads a line a bullet, list markers, depth from indents and numbered lists', () => {
    expect(bodiesOf('Research\nBuild\n')).toEqual([{ lines: ['Research', 'Build'], numbered: false }])
    expect(bodiesOf('- Plan\n  - Hire\n- Ship')[0].lines).toEqual(['Plan', '\tHire', 'Ship'])
    expect(bodiesOf('Top\n    Sub\n        Deeper')[0].lines).toEqual(['Top', '\tSub', '\t\tDeeper'])
    expect(bodiesOf('A\n\tB')[0].lines).toEqual(['A', '\tB'])
    expect(bodiesOf('1. First\n2. Second\n   a detail')).toEqual([{ lines: ['First', 'Second', '\ta detail'], numbered: true }])
    expect(bodiesOf('[Draft] notes')[0].lines).toEqual(['[Draft] notes'])
  })

  it('reads a JSON list as lines, or as a body a column', () => {
    expect(bodiesOf('["Fast", "Cheap"]')).toEqual([{ lines: ['Fast', 'Cheap'], numbered: false }])
    expect(bodiesOf('["Fast\\nCheap", "Slow"]', 2).map((body) => body.lines)).toEqual([['Fast', 'Cheap'], ['Slow']])
    expect(bodiesOf([['Fast', 'Cheap'], ['Slow']]).map((body) => body.lines)).toEqual([['Fast', 'Cheap'], ['Slow']])
  })
})

describe('steps', () => {
  it('adds a slide with its layout, title, bullets and notes after the one asked for', () => {
    const deck = sample()
    const step = addSlideStep(deck, { title: 'Plan', body: 'Research\n  Interviews', notes: 'Keep it short', after: 'Agenda' }, none)
    const slide = step.deck.slides[2]

    expect(step.label).toBe('New Slide')
    expect(step.done).toBe('added slide 3 (“Plan”)')
    expect(step.info).toEqual({ slide: 3, slideId: slide.id })
    expect(slide.layout).toBe('title-content')
    expect(titleOf(slide)).toBe('Plan')
    expect((placeholderFor(slide, 'body') as TextElement).body.paragraphs.map((paragraph) => [paragraph.list, paragraph.level, paragraph.runs[0].text])).toEqual([
      ['bullet', 0, 'Research'],
      ['bullet', 1, 'Interviews']
    ])
    expect(slide.notes).toBe('Keep it short')
  })

  it('makes two columns from two bodies, and numbers a numbered list', () => {
    const columns = addSlideStep(model.newDeck('T'), { title: 'Choice', body: [['Fast', 'Cheap'], ['Slow']] }, none).deck.slides[1]
    const asked = addSlideStep(model.newDeck('T'), { layout: 'two columns', body: '["Left", "Right"]' }, none).deck.slides[1]
    const numbered = addSlideStep(model.newDeck('T'), { body: '1. First\n2. Second' }, none).deck.slides[1]

    expect(columns.layout).toBe('two-content')
    expect([bodyOf(columns, 0), bodyOf(columns, 1)]).toEqual(['Fast\nCheap', 'Slow'])
    expect([bodyOf(asked, 0), bodyOf(asked, 1)]).toEqual(['Left', 'Right'])
    expect((placeholderFor(numbered, 'body') as TextElement).body.paragraphs.map((paragraph) => [paragraph.list, paragraph.runs[0].text])).toEqual([
      ['number', 'First'],
      ['number', 'Second']
    ])
    expect(() => addSlideStep(model.newDeck('T'), { layout: 'title-content', body: [['A'], ['B']] }, none)).toThrow('A Title and Content slide has one column of text, not 2')
  })

  it('changes several things on a slide as one change, or says what it can change', () => {
    const deck = sample()
    const step = setSlideStep(deck, { slide: 2, title: 'Today', notes: 'Say hello', hidden: true, background: 'navy' }, none)
    const slide = step.deck.slides[1]

    expect(step.label).toBe('Slide')
    expect(step.done).toBe('changed the title, notes, hidden and background of slide 2 (“Today”)')
    expect([titleOf(slide), slide.notes, slide.hidden, slide.background]).toEqual(['Today', 'Say hello', true, { kind: 'solid', color: '#000080' }])
    expect(setSlideStep(deck, { slide: 'Agenda', notes: 'Only notes' }, none).label).toBe('Speaker Notes')
    expect(setSlideStep(deck, { slide: 'Agenda', layout: 'two-content', body: '["Left", "Right"]' }, none).deck.slides[1].layout).toBe('two-content')
    expect(() => setSlideStep(deck, { slide: 2 }, none)).toThrow('Say what to change on the slide')
  })

  it('moves, duplicates and removes slides by what names them', () => {
    const deck = sample()
    const moved = moveSlideStep(deck, { slide: 'Agenda', to: 'last' }, none)

    expect(moved.deck.slides.map(titleOf)).toEqual(['', 'Quarterly results', 'Results summary', 'Agenda'])
    expect(moved.done).toBe('moved slide 2 to 4')
    expect(moveSlideStep(deck, { slide: 4, to: 1 }, none).deck.slides.map(titleOf)[0]).toBe('Results summary')
    expect(moveSlideStep(deck, { slide: 2, to: 2 }, none).deck).toBe(deck)
    expect(() => moveSlideStep(deck, { slide: 2 }, none)).toThrow('Say where the slide goes')
    expect(duplicateSlideStep(deck, { slide: 'Agenda' }, none)).toMatchObject({ done: 'duplicated slide 2 as slide 3', info: { slide: 3 } })
    expect(removeSlideStep(deck, { slide: 'summary' }, none).deck.slides.map(titleOf)).toEqual(['', 'Agenda', 'Quarterly results'])
    expect(removeSlideStep(model.newDeck('T'), {}, none).done).toBe('emptied the only slide')
  })

  it('puts text boxes and shapes where asked, as asked', () => {
    const deck = model.newDeck('T')
    const text = addTextStep(deck, { text: 'Hello', x: 100, y: 50, size: 32, color: 'navy', bold: true, align: 'centre' }, none)
    const box = text.deck.slides[0].elements.find((element) => element.id === text.info?.element) as TextElement
    const shape = addShapeStep(deck, { kind: 'circle', fill: 'none', text: 'Hi' }, none)
    const drawn = shape.deck.slides[0].elements.find((element) => element.id === shape.info?.element)

    expect([box.x, box.y, plainText(box.body), box.body.style.size, box.body.style.color, box.body.style.bold, box.body.paragraphs[0].align]).toEqual([100, 50, 'Hello', 32, '#000080', true, 'center'])
    expect(drawn?.kind === 'shape' && [drawn.shape, drawn.fill, plainText(drawn.body)]).toEqual(['ellipse', null, 'Hi'])
    expect(shape.done).toBe('added an ellipse to slide 1')
    expect(() => addTextStep(deck, { text: '  ' }, none)).toThrow('Say what the text box says')
  })

  it('places a picture contained in a box, covering it, or across the slide', () => {
    const deck = model.newDeck('T')
    const pictures = new Map([['~/wide.png', { src: 'data:image/png;base64,iVBORw0KGgo=', natural: { width: 400, height: 200 } }]])
    const picture = (args: Record<string, unknown>) => {
      const step = addImageStep(deck, { source: '~/wide.png', ...args }, { front: null, pictures })

      return step.deck.slides[0].elements.find((element) => element.id === step.info?.element)!
    }

    expect(picture({ x: 10, y: 20, width: 300, height: 300 })).toMatchObject({ x: 10, y: 95, width: 300, height: 150 })
    expect(picture({ x: 10, y: 20, width: 300, height: 300, fit: 'cover' })).toMatchObject({ x: 10, y: 20, width: 300, height: 300, crop: { left: 0.25, top: 0, right: 0.25, bottom: 0 } })
    expect(picture({ fit: 'slide' })).toMatchObject({ x: 0, y: 0, width: 960, height: 540 })
    expect(() => addImageStep(deck, { source: '~/other.png' }, { front: null, pictures })).toThrow('The picture ~/other.png was not read')
    expect(() => addImageStep(deck, { source: '~/wide.png', fit: 'tile' }, { front: null, pictures })).toThrow('fit is contain, cover, stretch or slide')
  })

  it('puts a table in place of an empty text placeholder, or under the title', () => {
    const deck = addSlideStep(addSlideStep(model.newDeck('T'), { title: 'Costs' }, none).deck, { title: 'Only a title', layout: 'title-only' }, none).deck
    const inBody = addTableStep(deck, { slide: 'Costs', cells: '[["Item", "Cost"], ["Rent", 1200]]' }, none)
    const costs = inBody.deck.slides[1]
    const underTitle = addTableStep(deck, { slide: 'Only a title', rows: 2, columns: 3 }, none).deck.slides[2]
    const placed = underTitle.elements.find((element) => element.kind === 'table')

    expect(costs.elements.map((element) => element.placeholder?.role ?? element.kind)).toEqual(['title', 'table'])
    expect(costs.elements[1]).toMatchObject({ x: 60, y: 136, width: 840 })
    expect(inBody.done).toBe('added a table of 2 rows by 2 columns to slide 2 (“Costs”)')
    expect(placed?.kind === 'table' && [placed.x, placed.y, placed.width, placed.rows.length, placed.columns.length]).toEqual([120, 132, 720, 2, 3])
    expect(() => addTableStep(deck, { cells: JSON.stringify(Array.from({ length: 80 }, () => ['x'])) }, none)).toThrow('A table on a slide has at most 75 rows')
    expect(() => addTableStep(deck, {}, none)).toThrow('Give the table its cells')
  })
})

describe('a batch of edits', () => {
  it('reads a list of ops, refusing ops it does not know', () => {
    expect(slideEditsOf('[{"op": "addslide", "title": "A"}]')).toEqual([{ op: 'addSlide', title: 'A' }])
    expect(() => slideEditsOf('[{"op": "addSlide"}, {"op": "explode"}]')).toThrow('Edit 2: op is one of addSlide, setSlide, duplicateSlide, moveSlide, removeSlide, addText, addShape, addImage, addTable, setTheme, replace, not “explode”')
    expect(() => slideEditsOf('add a slide')).toThrow('edits is a list')
    expect(() => slideEditsOf('[{"op": ')).toThrow('edits is not valid JSON')
    expect(() => slideEditsOf(JSON.stringify(Array.from({ length: 101 }, () => ({ op: 'addSlide' }))))).toThrow('At most 100 edits in one batch')
  })

  it('makes every edit as one step to undo, later edits naming what earlier ones made', () => {
    const deck = sample()
    const doc = new SlidesDocument(deck, () => {})
    const edits = slideEditsOf(
      JSON.stringify([
        { op: 'addSlide', title: 'Risks', body: 'Supply\nHiring' },
        { op: 'addShape', slide: 'Risks', kind: 'star', x: 820, y: 40, width: 80, height: 80 },
        { op: 'addText', text: 'Draft' },
        { op: 'moveSlide', slide: 'Risks', to: 2 },
        { op: 'replace', find: 'results', replacement: 'numbers' },
        { op: 'setTheme', theme: 'paper' }
      ])
    )
    const step = runEdits(doc.history.present, edits, { front: doc.slideId })
    doc.commit({ ...step, label: `Hermes: ${step.label}` })
    const risks = doc.history.present.slides[1]

    expect(doc.history.present.slides.map(titleOf)).toEqual(['', 'Risks', 'Agenda', 'Quarterly numbers', 'numbers summary'])
    expect(risks.elements.map((element) => element.placeholder?.role ?? element.kind)).toEqual(['title', 'body', 'shape', 'text'])
    expect(doc.history.present.theme.id).toBe('paper')
    expect(step.done).toBe('added slide 5 (“Risks”); added a star to slide 5 (“Risks”); added a text box to slide 5 (“Risks”); moved slide 5 to 2; replaced 2 matches of “results”; applied the Paper theme')
    // The editor goes where the last edit that moves it sends it: the first slide the replace changed.
    expect(doc.slideId).toBe(doc.history.present.slides[3].id)
    expect(doc.undo()).toBe('Hermes: 6 edits')
    expect(doc.history.present).toBe(deck)
    expect(doc.history.canUndo).toBe(false)
  })

  it('stops at an edit that fails, saying which, and makes none of them', () => {
    const deck = sample()
    const edits = slideEditsOf('[{"op": "addSlide", "title": "A"}, {"op": "moveSlide", "slide": "Nope", "to": 1}]')

    expect(() => runEdits(deck, edits, none)).toThrow('Edit 2 (moveSlide): There is no slide “Nope”')
    expect(deck.slides).toHaveLength(4)
  })

  it('composes changes into one, the editor going where the last one says', () => {
    const deck = model.newDeck('T')
    const change = composeChanges(deck, [(current) => model.addSlide(current, { title: 'One' }), (current) => model.setNotes(current, current.slides[0].id, 'First notes')], 'Hermes: 2 edits')

    expect(change.label).toBe('Hermes: 2 edits')
    expect(change.deck.slides.map((slide) => [titleOf(slide), slide.notes])).toEqual([
      ['', 'First notes'],
      ['One', '']
    ])
    expect(change.focus?.slideId).toBe(change.deck.slides[1].id)
  })
})

describe('a new deck from a brief', () => {
  it('starts with the slides given, the first a title slide unless it says otherwise', () => {
    const deck = newDeckWith('Pitch', {
      size: SLIDE_SIZES.standard,
      slides: slideSpecsOf('[{"title": "Pitch", "body": "Seed round"}, {"title": "Plan", "body": "Research\\nBuild", "notes": "Keep it short"}, {"layout": "section", "title": "Money"}]')
    })

    expect(deck.size).toEqual(SLIDE_SIZES.standard)
    expect(deck.slides.map((slide) => [slide.layout, titleOf(slide), bodyOf(slide), slide.notes])).toEqual([
      ['title', 'Pitch', 'Seed round', ''],
      ['title-content', 'Plan', 'Research\nBuild', 'Keep it short'],
      ['section', 'Money', '', '']
    ])
    expect(newDeckWith('Blank').slides).toHaveLength(1)
    expect(() => newDeckWith('Bad', { slides: [{ layout: 'mosaic' }] })).toThrow('Slide 1: layout is one of')
    expect(() => slideSpecsOf('["Intro"]')).toThrow('slides is a list')
  })
})

describe('reading, finding and replacing', () => {
  it('reads a deck compactly: titles, text by level, notes, and elements with their boxes', () => {
    let deck = newDeckWith('Pitch', { slides: [{ title: 'Pitch', body: 'Seed round' }, { title: 'Plan', body: 'Research\n  Interviews', notes: 'Slow down' }, { layout: 'title-content', title: 'Empty' }] })
    deck = model.setHidden(deck, [deck.slides[1].id], true).deck
    deck = addTextStep(deck, { slide: 2, text: 'Draft', x: 10.4, y: 20.6, width: 100, height: 30 }, none).deck
    const read = readDeck(deck)

    expect(read).toMatchObject({ title: 'Pitch', size: 'wide (16:9)', theme: 'Herald', transition: 'fade', slideCount: 3 })
    expect(read.slides[0]).toMatchObject({ number: 1, layout: 'title', title: 'Pitch', body: 'Seed round' })
    expect(read.slides[1]).toMatchObject({ number: 2, title: 'Plan', body: 'Research\n  Interviews', notes: 'Slow down', hidden: true })
    expect(read.slides[1].elements.map((element) => ('text' in element ? element.text : element.kind))).toEqual(['Title', 'Text', 'Draft'])
    expect(read.slides[1].elements[2].box).toEqual([10, 21, 100, 30])
    expect(read.slides[2].elements.find((element) => element.kind === 'Text')).toMatchObject({ empty: true })
    expect(readDeck(deck, deck.slides[2].id).slides.map((slide) => slide.title)).toEqual(['Empty'])
  })

  it('finds text in titles, text, tables and notes', () => {
    let deck = sample()
    deck = model.setNotes(deck, deck.slides[1].id, 'Mention the results early').deck
    deck = addTableStep(deck, { slide: 1, cells: [['Results', 'Q3']] }, none).deck
    const found = findInDeck(deck, 'results')

    expect(found.count).toBe(4)
    expect(found.matches.map((match) => [match.slide, match.where, match.text])).toEqual([
      [1, 'table', 'Results'],
      [2, 'notes', 'Mention the results early'],
      [3, 'title', 'Quarterly results'],
      [4, 'title', 'Results summary']
    ])
    expect(findInDeck(deck, 'results', { caseSensitive: true }).count).toBe(2)
  })

  it('replaces across a deck, each replacement keeping the formatting where its match starts', () => {
    let deck = model.newDeck('T')
    const slideId = deck.slides[0].id
    const added = model.addText(deck, slideId, { text: 'x' })
    deck = model.updateElements(added.deck, slideId, [added.elementId], (element) => (element.kind === 'text' ? { ...element, body: { ...element.body, paragraphs: [{ runs: [{ text: 'Hello Wor', bold: true }, { text: 'ld and world' }] }] } } : element), 'Text').deck
    deck = model.setNotes(deck, slideId, 'Say world').deck
    const all = replaceInDeck(deck, 'world', 'Earth')
    const box = all.deck.slides[0].elements.find((element) => element.id === added.elementId) as TextElement

    expect(all.replaced).toBe(3)
    expect(all.slides).toEqual([1])
    expect(box.body.paragraphs[0].runs).toEqual([{ text: 'Hello Earth', bold: true }, { text: ' and Earth' }])
    expect(all.deck.slides[0].notes).toBe('Say Earth')
    expect(replaceInDeck(deck, 'world', 'Earth', { all: false }).replaced).toBe(1)
    expect(replaceInDeck(deck, 'World', 'Earth', { caseSensitive: true }).replaced).toBe(1)
    expect(replaceInDeck(deck, 'Mars', 'Earth').deck).toBe(deck)
  })
})
