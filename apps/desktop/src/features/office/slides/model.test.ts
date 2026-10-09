import { describe, expect, it } from 'vitest'
import { type CellBorders, type Deck, findSlide, type ShapeElement, type SlideElement, SLIDE_SIZES, type Stroke, type TableElement, type TextElement } from './deck.ts'
import { boundsOf } from './elements.ts'
import { placeholderFor } from './layouts.ts'
import * as model from './model.ts'
import { borderCells, settleSpans, tableElement, withCell } from './tables.ts'
import { resolveColor, THEMES } from './themes.ts'
import { plainText } from './text.ts'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

const textOf = (element: SlideElement | undefined): string => (element && (element.kind === 'text' || element.kind === 'shape') ? plainText(element.body) : '')
const slideOf = (deck: Deck, index: number) => deck.slides[index]

describe('slides', () => {
  it('starts a 16:9 deck with a title slide whose placeholders wait for text', () => {
    const deck = model.newDeck('Pitch')

    expect(deck.size).toEqual(SLIDE_SIZES.wide)
    expect(deck.slides).toHaveLength(1)
    expect(deck.slides[0].layout).toBe('title')
    expect(deck.slides[0].elements.map((element) => element.placeholder?.role)).toEqual(['title', 'subtitle'])
  })

  it('adds a slide with a layout after the one asked for, with its title and bullets', () => {
    const deck = model.newDeck('Pitch')
    const first = deck.slides[0].id
    const end = model.addSlide(deck, { layout: 'blank' })
    const change = model.addSlide(end.deck, { layout: 'title-content', after: first, title: 'Plan', body: ['Research', '  Interviews', 'Build'] })
    const slide = findSlide(change.deck, change.slideId)!
    const body = placeholderFor(slide, 'body') as TextElement

    expect(change.label).toBe('New Slide')
    expect(change.deck.slides.map((entry) => entry.id)).toEqual([first, change.slideId, end.slideId])
    expect(textOf(placeholderFor(slide, 'title'))).toBe('Plan')
    expect(body.body.paragraphs.map((paragraph) => [paragraph.list, paragraph.level, paragraph.runs[0].text])).toEqual([
      ['bullet', 0, 'Research'],
      ['bullet', 1, 'Interviews'],
      ['bullet', 0, 'Build']
    ])
  })

  it('duplicates, moves, hides and removes slides, keeping one', () => {
    let deck = model.addSlide(model.newDeck('Pitch'), { layout: 'title-only' }).deck
    const [a, b] = deck.slides.map((slide) => slide.id)
    const doubled = model.duplicateSlides(deck, [a])
    deck = doubled.deck

    expect(deck.slides).toHaveLength(3)
    expect(deck.slides[1].elements.map((element) => element.id)).not.toEqual(deck.slides[0].elements.map((element) => element.id))
    expect(doubled.focus?.slideId).toBe(deck.slides[1].id)

    deck = model.moveSlides(deck, [b], 0).deck
    expect(deck.slides[0].id).toBe(b)

    deck = model.setHidden(deck, [a], true).deck
    expect(deck.slides.find((slide) => slide.id === a)?.hidden).toBe(true)

    const emptied = model.removeSlides(deck, deck.slides.map((slide) => slide.id)).deck
    expect(emptied.slides).toHaveLength(1)
    expect(emptied.slides[0].elements).toEqual([])
  })

  it('puts a title slide’s text in its subtitle, and a slide without a place for text gets one', () => {
    let deck = model.newDeck('Pitch')
    const slideId = deck.slides[0].id
    deck = model.setBody(deck, slideId, 'Q3 review').deck

    expect(textOf(placeholderFor(findSlide(deck, slideId)!, 'subtitle'))).toBe('Q3 review')

    const blank = model.addSlide(deck, { layout: 'blank' })
    const filled = findSlide(model.setBody(blank.deck, blank.slideId, 'Now with text').deck, blank.slideId)!

    expect(filled.layout).toBe('title-content')
    expect(textOf(placeholderFor(filled, 'body'))).toBe('Now with text')
  })

  it('moves text into the new layout’s places and keeps what has no place', () => {
    let deck = model.newDeck('Pitch')
    const slideId = deck.slides[0].id
    deck = model.setTitle(deck, slideId, 'Hello').deck
    deck = model.setBody(deck, slideId, 'A subtitle that becomes plain text').deck
    const moved = model.setLayout(deck, slideId, 'title-only').deck
    const slide = findSlide(moved, slideId)!

    expect(slide.layout).toBe('title-only')
    expect(textOf(placeholderFor(slide, 'title'))).toBe('Hello')
    expect(slide.elements.some((element) => !element.placeholder && textOf(element).startsWith('A subtitle'))).toBe(true)
  })

  it('sets notes, backgrounds for some or all slides, the transition and the size', () => {
    let deck = model.addSlide(model.newDeck('Pitch')).deck
    const [a] = deck.slides.map((slide) => slide.id)
    deck = model.setNotes(deck, a, 'Say hello').deck
    deck = model.setBackground(deck, [a], { kind: 'solid', color: 'accent1' }).deck

    expect(slideOf(deck, 0).notes).toBe('Say hello')
    expect(slideOf(deck, 0).background).toEqual({ kind: 'solid', color: 'accent1' })
    expect(slideOf(deck, 1).background).toBeNull()
    expect(model.setNotes(deck, a, 'Say hello').deck).toBe(deck)

    deck = model.setBackground(deck, 'all', null).deck
    expect(deck.slides.every((slide) => slide.background === null)).toBe(true)
    expect(model.setTransition(deck, 'push').deck.transition).toBe('push')

    const title = slideOf(deck, 0).elements[0]
    const narrow = model.setSize(deck, SLIDE_SIZES.standard).deck
    expect(narrow.size).toEqual(SLIDE_SIZES.standard)
    expect(slideOf(narrow, 0).elements[0].x).toBeCloseTo(title.x * 0.75)
    expect(slideOf(narrow, 0).elements[0].y).toBe(title.y)
  })

  it('repaints slots and theme fonts with a new theme, and leaves picked colours alone', () => {
    let deck = model.newDeck('Pitch')
    const slideId = deck.slides[0].id
    deck = model.addShape(deck, slideId, { shape: 'rect', fill: { color: 'accent1' } }).deck
    deck = model.addShape(deck, slideId, { shape: 'ellipse', fill: { color: '#123456' } }).deck
    const midnight = model.applyTheme(deck, 'midnight').deck
    const [slot, literal] = slideOf(midnight, 0).elements.slice(-2) as ShapeElement[]

    expect(resolveColor(slot.fill!.color, midnight.theme)).toBe(THEMES.find((theme) => theme.id === 'midnight')!.colors.accent1)
    expect(resolveColor(literal.fill!.color, midnight.theme)).toBe('#123456')
    expect(() => model.applyTheme(deck, 'no such theme')).toThrow(/no theme/)
  })
})

describe('elements', () => {
  it('adds text, shapes and lines on top, kept on the slide and selected', () => {
    let deck = model.newDeck('Pitch')
    const slideId = deck.slides[0].id
    const text = model.addText(deck, slideId, { text: 'Hello\nWorld', x: 5000, y: 20, size: 30, bold: true })
    deck = text.deck
    const added = findSlide(deck, slideId)!.elements.at(-1) as TextElement

    expect(text.focus?.selected).toEqual([text.elementId])
    expect(added.body.style).toMatchObject({ size: 30, bold: true })
    expect(added.body.paragraphs).toHaveLength(2)
    expect(boundsOf(added).x).toBeLessThan(deck.size.width)

    const line = model.addLine(deck, slideId, { from: [300, 100], to: [100, 50], end: 'triangle' })
    const drawn = findSlide(line.deck, slideId)!.elements.at(-1)!
    expect(drawn).toMatchObject({ kind: 'line', x: 100, y: 50, width: 200, height: 50, flipH: true, flipV: true, end: 'triangle' })
  })

  it('puts a picture into an empty picture placeholder, cut to fill it, else at its proportions', () => {
    let deck = model.addSlide(model.newDeck('Pitch'), { layout: 'picture-caption' }).deck
    const slideId = deck.slides[1].id
    const into = model.addImage(deck, slideId, { src: PNG, natural: { width: 400, height: 100 } })
    const frame = findSlide(into.deck, slideId)!.elements.find((element) => element.id === into.elementId)!

    expect(frame.placeholder?.role).toBe('picture')
    expect(frame.kind === 'image' && frame.crop?.left).toBeGreaterThan(0)

    deck = into.deck
    const free = model.addImage(deck, slideId, { src: PNG, natural: { width: 400, height: 200 } })
    const picture = findSlide(free.deck, slideId)!.elements.at(-1)!

    expect(picture.width / picture.height).toBeCloseTo(2)
    expect(picture.placeholder).toBeUndefined()
  })

  it('duplicates and pastes elements as ordinary elements under new ids', () => {
    const deck = model.newDeck('Pitch')
    const slide = deck.slides[0]
    const title = slide.elements[0]
    const change = model.duplicateElements(deck, slide.id, [title.id])
    const copy = findSlide(change.deck, slide.id)!.elements.at(-1)!

    expect(change.label).toBe('Duplicate')
    expect(copy.id).not.toBe(title.id)
    expect(copy.placeholder).toBeUndefined()
    expect(copy.x).toBe(title.x + 12)
  })

  it('arranges, aligns, distributes and nudges', () => {
    let deck = model.addSlide(model.newDeck('Pitch'), { layout: 'blank' }).deck
    const slideId = deck.slides[1].id
    const ids: string[] = []

    for (const x of [0, 100, 400]) {
      const change = model.addShape(deck, slideId, { shape: 'rect', x, y: x / 2, width: 50, height: 50 })
      deck = change.deck
      ids.push(change.elementId)
    }

    expect(model.arrange(deck, slideId, [ids[0]], 'front').deck.slides[1].elements.map((element) => element.id)).toEqual([ids[1], ids[2], ids[0]])
    expect(model.arrange(deck, slideId, [ids[2]], 'backward').deck.slides[1].elements.map((element) => element.id)).toEqual([ids[0], ids[2], ids[1]])

    const aligned = model.align(deck, slideId, ids, 'top').deck.slides[1].elements
    expect(aligned.map((element) => element.y)).toEqual([0, 0, 0])

    const spread = model.distribute(deck, slideId, ids, 'horizontal').deck.slides[1].elements
    expect(spread.map((element) => element.x)).toEqual([0, 200, 400])

    const nudged = model.nudge(deck, slideId, [ids[0]], 1, -1)
    expect(nudged.join).toContain('nudge')
    expect(nudged.deck.slides[1].elements[0]).toMatchObject({ x: 1, y: -1 })

    const single = model.align(deck, slideId, [ids[0]], 'center').deck.slides[1].elements[0]
    expect(single.x + single.width / 2).toBe(deck.size.width / 2)
  })

  it('names slides by number and describes the deck in a few lines', () => {
    let deck = model.newDeck('Pitch')
    deck = model.setTitle(deck, deck.slides[0].id, 'Welcome').deck
    deck = model.addSlide(deck, { layout: 'title-content', title: 'Agenda' }).deck

    expect(model.slideRef(deck, 2)).toBe(deck.slides[1].id)
    expect(() => model.slideRef(deck, 3)).toThrow(/no slide 3/)
    expect(model.outline(deck)).toBe('1. Welcome: Title, 2 elements\n2. Agenda: Title and Content, 2 elements')
  })

  it('fills with a gradient from one colour to another', () => {
    expect(model.gradientFill('accent1', '#ffffff')).toEqual({
      color: 'accent1',
      gradient: {
        stops: [
          { at: 0, color: 'accent1' },
          { at: 1, color: '#ffffff' }
        ],
        angle: 90
      }
    })
    expect(model.gradientFill('bg1', 'bg2', 0).gradient?.angle).toBe(0)
  })
})

describe('cell borders', () => {
  const line: Stroke = { color: 'accent2', width: 2, dash: 'solid' }

  /** A slide with a 3 by 3 table on it. */
  function table() {
    const deck = model.addSlide(model.newDeck('Pitch'), { layout: 'blank' }).deck
    const slideId = deck.slides[1].id
    const change = model.addTable(deck, slideId, { rows: 3, columns: 3 })

    return { deck: change.deck, slideId, tableId: change.elementId }
  }

  const bordersOf = (deck: Deck, slideId: string, tableId: string): (CellBorders | undefined)[][] => (findSlide(deck, slideId)!.elements.find((element) => element.id === tableId) as TableElement).cells.map((row) => row.map((cell) => cell.borders))

  it('lines a cell’s outside, the cells about it saying the same', () => {
    const { deck, slideId, tableId } = table()
    const change = model.setCellBorders(deck, slideId, tableId, [{ row: 1, column: 1 }], ['outer'], line)
    const borders = bordersOf(change.deck, slideId, tableId)

    expect(change.label).toBe('Cell Borders')
    expect(borders[1][1]).toEqual({ left: line, top: line, right: line, bottom: line })
    expect([borders[1][0], borders[0][1], borders[1][2], borders[2][1]]).toEqual([{ right: line }, { bottom: line }, { left: line }, { top: line }])
    expect([borders[0][0], borders[2][2]]).toEqual([undefined, undefined])
    expect(model.setCellBorders(change.deck, slideId, tableId, [{ row: 1, column: 1 }], ['outer'], line).deck).toBe(change.deck)
  })

  it('lines between picked cells, one side of them, or the whole table’s outside', () => {
    const { deck, slideId, tableId } = table()
    const block = [
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 1, column: 0 },
      { row: 1, column: 1 }
    ]
    const inner = bordersOf(model.setCellBorders(deck, slideId, tableId, block, ['inner'], line).deck, slideId, tableId)

    expect(inner[0][0]).toEqual({ right: line, bottom: line })
    expect(inner[1][1]).toEqual({ left: line, top: line })
    expect(inner[0][2]).toBeUndefined()

    const left = bordersOf(model.setCellBorders(deck, slideId, tableId, [{ row: 0, column: 1 }, { row: 1, column: 1 }], ['left'], line).deck, slideId, tableId)
    expect(left.map((row) => row.slice(0, 2))).toEqual([
      [{ right: line }, { left: line }],
      [{ right: line }, { left: line }],
      [undefined, undefined]
    ])

    const outline = bordersOf(model.setCellBorders(deck, slideId, tableId, 'all', ['outer'], line).deck, slideId, tableId)
    expect(outline[0][0]).toEqual({ left: line, top: line })
    expect(outline[2][2]).toEqual({ right: line, bottom: line })
    expect(outline[1][1]).toBeUndefined()

    const none = bordersOf(model.setCellBorders(deck, slideId, tableId, 'all', ['all'], null).deck, slideId, tableId)
    expect(none[1][1]).toEqual({ left: null, top: null, right: null, bottom: null })
  })

  it('lines a merged cell as one, and keeps cells’ lines as rows and columns come and go', () => {
    const base = tableElement({ x: 0, y: 0, width: 300, height: 90 }, 3, 3)
    const wide = withCell(base, { row: 0, column: 0 }, (cell) => ({ ...cell, colSpan: 2 }))
    const merged: TableElement = { ...wide, cells: settleSpans(wide.cells, 3) }
    const lined = borderCells(merged, [{ row: 0, column: 1 }], ['outer'], line)

    expect(lined.cells[0][0].borders).toEqual({ left: line, top: line, right: line, bottom: line })
    expect(lined.cells[0][2].borders).toEqual({ left: line })
    expect([lined.cells[1][0].borders, lined.cells[1][1].borders]).toEqual([{ top: line }, { top: line }])

    const { deck, slideId, tableId } = table()
    const boxed = model.setCellBorders(deck, slideId, tableId, [{ row: 1, column: 1 }], ['left', 'top'], line).deck
    const widened = bordersOf(model.insertTableColumn(boxed, slideId, tableId, 0, 'left').deck, slideId, tableId)
    const lengthened = bordersOf(model.insertTableRow(boxed, slideId, tableId, 0, 'above').deck, slideId, tableId)

    expect(widened[1][2]).toEqual({ left: line, top: line })
    expect(widened[1][1]).toEqual({ right: line })
    expect(lengthened[2][1]).toEqual({ left: line, top: line })
  })
})
