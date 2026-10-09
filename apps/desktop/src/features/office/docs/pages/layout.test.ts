import { describe, expect, it } from 'vitest'
import { PAGE_SIZES, paragraphNode, textNode } from '../../../../../shared/office/document.ts'
import { stateOf } from '../model.ts'
import { bodyOf, frameOf, sectionAt, sectionsOfDoc } from './geometry.ts'
import { type FlowBox, type LayoutOptions, paginate } from './layout.ts'
import { type PageMap, pageAt, pagesOf } from './map.ts'

const LINE = 20

type Box = FlowBox<string>

interface Spec {
  ref: string
  lines?: number
  height?: number
  extra?: Partial<Box>
  /** Footnotes by line. */
  notes?: Record<number, number[]>
}

/** Blocks stacked from `top`: paragraphs of lines, or boxes of a height that never split. */
function column(specs: Spec[], top = 0): Box[] {
  let y = top

  return specs.map(({ ref, lines, height, extra, notes }) => {
    const start = y

    if (height !== undefined) {
      y += height

      return { top: start, bottom: y, kind: 'block', ref, keepTogether: true, ...extra }
    }

    const count = lines ?? 1
    const parts: Box[] = Array.from({ length: count }, (_, index) => ({ top: start + index * LINE, bottom: start + (index + 1) * LINE, kind: 'line', ref: `${ref}.${index}`, notes: notes?.[index] }))
    y += count * LINE

    return { top: start, bottom: y, kind: 'block', ref, notes: parts.flatMap((part) => part.notes ?? []), split: count > 1 ? 'lines' : undefined, parts: () => parts, ...extra }
  })
}

const options = (room = 100, extra: Partial<LayoutOptions> = {}): LayoutOptions => ({ room: () => room, noteHeight: () => 30, noteRule: 10, ...extra })

const starts = (boxes: Box[], layout = options()) => paginate(boxes, layout).map((page) => page.ref)

describe('page breaking', () => {
  it('fills pages with whole paragraphs, and starts the next page at the first that does not fit', () => {
    const boxes = column(Array.from({ length: 12 }, (_, index) => ({ ref: `p${index}` })))
    const pages = paginate(boxes, options())

    expect(pages.map((page) => page.ref)).toEqual([null, 'p5', 'p10'])
    expect(pages.map((page) => [page.top, page.before, page.end])).toEqual([
      [0, 0, 100],
      [100, 100, 200],
      [200, 200, 240]
    ])
  })

  it('splits a paragraph between lines, keeping two lines on each side of the page end', () => {
    expect(starts(column([{ ref: 'a', lines: 3 }, { ref: 'b', lines: 6 }]))).toEqual([null, 'b.2'])
    // One line would be left alone at the foot of the page: the paragraph moves.
    expect(starts(column([{ ref: 'a', lines: 4 }, { ref: 'b', lines: 4 }]))).toEqual([null, 'b'])
    // One line would be left alone at the top of the next: two go.
    expect(starts(column([{ ref: 'a' }, { ref: 'b', lines: 5 }]))).toEqual([null, 'b.3'])
    // Three lines cannot split two and two: the paragraph moves whole.
    expect(starts(column([{ ref: 'a', lines: 3 }, { ref: 'b', lines: 3 }]))).toEqual([null, 'b'])
  })

  it('runs a paragraph longer than a page over as many pages as it takes', () => {
    const pages = paginate(column([{ ref: 'a', lines: 12 }]), options())

    expect(pages.map((page) => [page.ref, page.kind, page.top])).toEqual([
      [null, 'first', 0],
      ['a.5', 'line', 100],
      ['a.10', 'line', 200]
    ])
  })

  it('keeps headings with the block after them', () => {
    const heading = { keepWithNext: true, keepTogether: true }

    expect(starts(column([{ ref: 'a', lines: 3 }, { ref: 'h', height: 30, extra: heading }, { ref: 'b', lines: 3 }]))).toEqual([null, 'h'])
    // Two headings in a row go together.
    expect(starts(column([{ ref: 'a', lines: 2 }, { ref: 'h1', height: 25, extra: heading }, { ref: 'h2', height: 25, extra: heading }, { ref: 'b', lines: 2 }]))).toEqual([null, 'h1'])
    // When the headings and what follows do not fit on one page together, the last heading goes with it.
    expect(starts(column([{ ref: 'a', lines: 2 }, { ref: 'h1', height: 25, extra: heading }, { ref: 'h2', height: 25, extra: heading }, { ref: 'b', lines: 3 }]))).toEqual([null, 'h1', 'h2'])
    // A heading at the top of a page stays there even when what follows does not fit after it.
    expect(starts(column([{ ref: 'h', height: 30, extra: heading }, { ref: 'tall', height: 150 }]))).toEqual([null, 'tall'])
  })

  it('starts pages at page breaks, and sections on even or odd pages with a blank page between', () => {
    const boxes = column([{ ref: 'a' }, { ref: 'b', extra: { force: { kind: 'page', section: 0 } } }, { ref: 'c', extra: { force: { kind: 'evenPage', section: 1 } } }, { ref: 'd', extra: { force: { kind: 'oddPage', section: 2 } } }])
    const pages = paginate(boxes, options())

    expect(pages.map((page) => [page.ref, page.kind, page.section])).toEqual([
      [null, 'first', 0],
      ['b', 'block', 0],
      [null, 'blank', 0],
      ['c', 'block', 1],
      ['d', 'block', 2]
    ])
    expect(pages[1].before).toBe(20)
  })

  it('goes on on the same page after a continuous section, and gives the next pages its room', () => {
    const boxes = column([{ ref: 'a', lines: 2 }, { ref: 'b', lines: 6, extra: { force: { kind: 'continuous', section: 1 } } }, { ref: 'c', lines: 4 }])
    const pages = paginate(boxes, options(100, { room: (_number, section) => (section ? 60 : 100) }))

    expect(pages.map((page) => [page.ref, page.section])).toEqual([
      [null, 0],
      ['b.3', 1],
      ['c', 1],
      ['c.2', 1]
    ])
  })

  it('gives footnotes room at the foot of the page their reference is on', () => {
    // Line 1 refers to a note: with the rule, it takes 40 of the page's 100.
    const pages = paginate(column([{ ref: 'a', lines: 5, notes: { 1: [1] } }]), options())

    expect(pages.map((page) => [page.ref, page.notes])).toEqual([
      [null, [1]],
      ['a.3', []]
    ])
    // A reference whose note does not fit goes to the next page with it, and two lines with it.
    const moved = paginate(column([{ ref: 'a', lines: 5, notes: { 4: [1] } }]), options())

    expect(moved.map((page) => [page.ref, page.notes])).toEqual([
      [null, []],
      ['a.3', [1]]
    ])
  })

  it('lets a box taller than a page run past its end, and starts the next page after it', () => {
    const pages = paginate(column([{ ref: 'picture', height: 150 }, { ref: 'a' }]), options())

    expect(pages.map((page) => [page.ref, page.overflow])).toEqual([
      [null, 50],
      ['a', 0]
    ])
    // After text, it goes to a page of its own first.
    expect(starts(column([{ ref: 'a' }, { ref: 'picture', height: 150 }, { ref: 'b' }]))).toEqual([null, 'picture', 'b'])
  })

  it('splits tables between rows, and moves a table whose first row does not fit', () => {
    const table = (ref: string, top: number, rows: number, height = 30): Box => {
      const parts: Box[] = Array.from({ length: rows }, (_, index) => ({ top: top + index * height, bottom: top + (index + 1) * height, kind: 'row', ref: `${ref}.${index}` }))

      return { top, bottom: top + rows * height, kind: 'block', ref, split: 'rows', parts: () => parts }
    }

    expect(starts([...column([{ ref: 'a' }]), table('t', 20, 4)])).toEqual([null, 't.2'])
    expect(starts([...column([{ ref: 'a', lines: 4 }]), table('t', 80, 3)])).toEqual([null, 't'])
    // A table split over three pages, one row left for the last.
    const pages = paginate([table('t', 0, 7)], options())

    expect(pages.map((page) => [page.ref, page.kind])).toEqual([
      [null, 'first'],
      ['t.3', 'row'],
      ['t.6', 'row']
    ])
  })

  it('breaks inside a list item, or before an item, or before the list', () => {
    const list = (ref: string, top: number, items: number[]): Box => {
      let y = top
      const parts = items.map((lines, index) => {
        const [item] = column([{ ref: `${ref}.${index}`, lines }], y)
        y = item.bottom

        return { ...item, split: 'blocks' as const, parts: () => column([{ ref: `${ref}.${index}.p`, lines }], item.top) }
      })

      return { top, bottom: y, kind: 'block', ref, split: 'blocks', parts: () => parts }
    }

    expect(starts([...column([{ ref: 'a', lines: 2 }]), list('l', 40, [1, 6])])).toEqual([null, 'l.1.p.2'])
    expect(starts([...column([{ ref: 'a', lines: 2 }]), list('l', 40, [2, 4])])).toEqual([null, 'l.1'])
    expect(starts([...column([{ ref: 'a', lines: 4 }]), list('l', 80, [3])])).toEqual([null, 'l'])
  })

  it('lines up a page that starts at a block after the block before it', () => {
    const boxes: Box[] = [
      { top: 0, bottom: 70, kind: 'block', ref: 'a', keepTogether: true },
      // Its top margin of 10 falls between the two.
      { top: 80, bottom: 120, kind: 'block', ref: 'b', keepTogether: true }
    ]
    const [, second] = paginate(boxes, options())

    expect([second.ref, second.top, second.before]).toEqual(['b', 80, 70])
  })
})

describe('page geometry', () => {
  const letter = { width: PAGE_SIZES.letter.width, height: PAGE_SIZES.letter.height, margins: { top: 72, right: 54, bottom: 72, left: 54 } }

  it('works in CSS pixels, with Word’s half inch for the header and footer when the page has none', () => {
    expect(frameOf(letter)).toEqual({ width: 816, height: 1056, top: 96, right: 72, bottom: 96, left: 72, header: 48, footer: 48 })
    expect(frameOf({ ...letter, margins: { ...letter.margins, header: 18, footer: 27 } })).toMatchObject({ header: 24, footer: 36 })
  })

  it('pushes the text down under a header taller than the top margin, and up over a tall footer', () => {
    expect(bodyOf(frameOf(letter), 20, 0)).toEqual({ top: 96, bottom: 96 })
    expect(bodyOf(frameOf(letter), 70, 60)).toEqual({ top: 118, bottom: 108 })
  })

  it('reads sections from section breaks, a continuous one on a page of another size starting a page', () => {
    const landscape = { ...letter, width: letter.height, height: letter.width }
    const { doc } = stateOf({
      type: 'doc',
      attrs: { page: letter, styles: null },
      content: [
        paragraphNode([textNode('One')]),
        { type: 'sectionBreak', attrs: { kind: 'continuous', page: landscape } },
        paragraphNode([textNode('Two')]),
        { type: 'sectionBreak', attrs: { kind: 'oddPage', page: null } },
        paragraphNode([textNode('Three')])
      ]
    })
    const sections = sectionsOfDoc(doc)

    expect(sections.map((section) => [section.start, section.kind, section.page.width])).toEqual([
      [0, 'nextPage', 612],
      [2, 'nextPage', 792],
      [4, 'oddPage', 792]
    ])
    expect([0, 1, 2, 3, 4].map((index) => sectionAt(sections, index))).toEqual([0, 0, 1, 1, 2])
  })
})

describe('the page map', () => {
  const map: PageMap = {
    pages: [
      { number: 1, from: 0, to: 40, kind: 'first', section: 0, blank: false },
      { number: 2, from: 40, to: 40, kind: 'even', section: 0, blank: true },
      { number: 3, from: 40, to: 90, kind: 'default', section: 1, blank: false }
    ],
    headings: [],
    footnotes: []
  }

  it('finds the page a position is on, past blank pages', () => {
    expect(pageAt(map, 0)?.number).toBe(1)
    expect(pageAt(map, 39)?.number).toBe(1)
    expect(pageAt(map, 40)?.number).toBe(3)
    expect(pageAt(map, 90)?.number).toBe(3)
    expect(pageAt(null, 3)).toBeNull()
  })

  it('numbers positions in document order in one pass', () => {
    expect(pagesOf(map, [2, 41, 89])).toEqual([1, 3, 3])
  })
})
