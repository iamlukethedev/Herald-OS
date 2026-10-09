import { describe, expect, it } from 'vitest'
import { type Deck, findElement, findSlide, type LineElement, type Slide } from '../deck.ts'
import { corners, lineElement, lineEndsOnSlide, type Point, rotatePoint, shapeElement } from '../elements.ts'
import * as model from '../model.ts'
import {
  changedDeck,
  endAt,
  enteredGroups,
  enterUnit,
  leaveUnit,
  marqueeHits,
  movedDeck,
  moveLineEnd,
  moveWithSnapping,
  nextUnit,
  pickUnit,
  resizeBox,
  resizedDeck,
  rotatedDeck,
  rotationFor,
  scaleGroup,
  siteTarget,
  snapLines,
  snapResize,
  wholeGroup,
  withConnectorEnd
} from './gestures.ts'

const SIZE = { width: 960, height: 540 }
const box = { x: 100, y: 100, width: 200, height: 100 }
const close = (a: number[], b: number[]) => a.forEach((value, index) => expect(value).toBeCloseTo(b[index], 6))

describe('resizing', () => {
  it('moves only the dragged side or corner of an upright box', () => {
    expect(resizeBox(box, 0, 'se', 50, 20)).toEqual({ x: 100, y: 100, width: 250, height: 120 })
    expect(resizeBox(box, 0, 'w', 30, 999)).toEqual({ x: 130, y: 100, width: 170, height: 100 })
    expect(resizeBox(box, 0, 'n', 0, 300)).toEqual({ x: 100, y: 196, width: 200, height: 4 })
  })

  it('keeps proportions and resizes about the centre when asked', () => {
    expect(resizeBox(box, 0, 'se', 100, 0, { keepRatio: true })).toEqual({ x: 100, y: 100, width: 300, height: 150 })
    expect(resizeBox(box, 0, 'e', 20, 0, { fromCenter: true })).toEqual({ x: 80, y: 100, width: 240, height: 100 })
  })

  it('keeps the opposite corner of a rotated box where it was', () => {
    const before = corners(box, 30)
    const after = resizeBox(box, 30, 'se', ...(rotatePoint([40, 10], [0, 0], 30) as [number, number]))

    expect(after.width).toBeCloseTo(240)
    expect(after.height).toBeCloseTo(110)
    close(corners(after, 30)[0], before[0])
  })

  it('pulls a dragged side onto a line close by', () => {
    const lines = snapLines(SIZE, [shapeElement('rect', { x: 400, y: 0, width: 50, height: 50 })])
    const snapped = snapResize({ ...box, width: 297 }, 'e', lines, 6)

    expect(snapped.box.width).toBe(300)
    expect(snapped.landed[0]).toMatchObject({ axis: 'x', value: 400 })
  })

  it('scales a group into a new box in proportion', () => {
    const a = shapeElement('rect', { x: 0, y: 0, width: 100, height: 100 })
    const b = shapeElement('rect', { x: 100, y: 100, width: 100, height: 100 })
    const [na, nb] = scaleGroup([a, b], { x: 0, y: 0, width: 200, height: 200 }, { x: 0, y: 0, width: 400, height: 200 })

    expect([na.x, na.y, na.width, na.height]).toEqual([0, 0, 200, 100])
    expect([nb.x, nb.y, nb.width, nb.height]).toEqual([200, 100, 200, 100])
  })
})

describe('moving', () => {
  it('snaps to the slide’s centre and shows what it lines up with', () => {
    const moved = moveWithSnapping({ x: 0, y: 0, width: 100, height: 100 }, 427, 3, { lines: snapLines(SIZE, []), reach: 6, others: [], size: SIZE })

    expect(moved.dx).toBe(430)
    expect(moved.dy).toBe(0)
    expect(moved.guides.some((guide) => guide.axis === 'x' && guide.at === 480)).toBe(true)
  })

  it('holds to one axis, and does not snap when told not to', () => {
    expect(moveWithSnapping(box, 40, 7, { lines: [], reach: 6, others: [], size: SIZE, axis: true })).toMatchObject({ dx: 40, dy: 0 })
    expect(moveWithSnapping(box, 3, 3, { lines: snapLines(SIZE, []), reach: 6, others: [], size: SIZE, snap: false })).toMatchObject({ dx: 3, dy: 3, guides: [] })
  })
})

describe('rotating, lines and selecting', () => {
  it('turns with the pointer, in steps of 15 degrees with Shift, and lands on square angles', () => {
    expect(rotationFor([0, 0], [10, 0], [0, 10], 0)).toBeCloseTo(90)
    expect(rotationFor([0, 0], [10, 0], [10, 3.4], 0, { step: true })).toBe(15)
    expect(rotationFor([0, 0], [10, 0], [10, -0.5], 0)).toBe(0)
    expect(rotationFor([0, 0], [10, 0], [-10, 0.01], 0)).toBe(180)
  })

  it('moves one end of a line, in steps of 45 degrees with Shift', () => {
    const line = lineElement([0, 0], [100, 0])

    expect(moveLineEnd(line, 'to', [50, 60])).toEqual({ from: [0, 0], to: [50, 60] })
    const stepped = moveLineEnd(line, 'to', [100, 90], true)
    expect(stepped.to[0]).toBeCloseTo(stepped.to[1])
  })

  it('selects what a rectangle touches, flat lines included', () => {
    const a = shapeElement('rect', { x: 0, y: 0, width: 50, height: 50 })
    const b = shapeElement('rect', { x: 300, y: 300, width: 50, height: 50 })
    const flat = lineElement([0, 200], [400, 200])

    expect(marqueeHits([a, b, flat], { x: 40, y: 40, width: 200, height: 200 }).sort()).toEqual([a.id, flat.id].sort())
  })

  it('moves the end of a turned line where the pointer is on the slide', () => {
    const turned = { ...lineElement([0, 0], [100, 0]), rotation: 90 }
    const ends = moveLineEnd(turned, 'to', [80, 80])

    close(ends.from, [50, -50])
    expect(ends.to).toEqual([80, 80])
  })
})

/** A blank slide with rectangles a, b, c and d side by side: a and b grouped, that group and c grouped again, d alone. */
function grouped() {
  let deck = model.addSlide(model.newDeck('Pitch'), { layout: 'blank' }).deck
  const slideId = deck.slides[1].id
  const ids: string[] = []

  for (const x of [0, 120, 240, 360]) {
    const change = model.addShape(deck, slideId, { shape: 'rect', x, y: 100, width: 80, height: 40 })
    deck = change.deck
    ids.push(change.elementId)
  }

  const [a, b, c, d] = ids
  deck = model.groupElements(deck, slideId, [a, b]).deck
  deck = model.groupElements(deck, slideId, [a, c]).deck

  return { slide: findSlide(deck, slideId)!, a, b, c, d }
}

describe('picking groups', () => {
  it('picks the whole outermost group with a click, and an element in no group alone', () => {
    const { slide, a, b, c, d } = grouped()

    expect(pickUnit(slide, [], b)).toEqual([a, b, c])
    expect(pickUnit(slide, [a, b, c], c)).toEqual([a, b, c])
    expect(pickUnit(slide, [], d)).toEqual([d])
    expect(model.expandToGroups(slide, marqueeHits(slide.elements, { x: 0, y: 95, width: 10, height: 10 }))).toEqual([a, b, c])
  })

  it('goes into the selected group one level with each double click, until there is no group left to go into', () => {
    const { slide, a, b, c, d } = grouped()

    expect(enterUnit(slide, [a, b, c], a)).toEqual([a, b])
    expect(enterUnit(slide, [a, b, c], c)).toEqual([c])
    expect(enterUnit(slide, [a, b], b)).toEqual([b])
    expect(enterUnit(slide, [b], b)).toBeNull()
    expect(enterUnit(slide, [d], d)).toBeNull()
    expect(enterUnit(slide, [a, d], a)).toBeNull()
  })

  it('picks inside a group it has gone into, and the whole group of anything outside it', () => {
    const { slide, a, b, c, d } = grouped()

    expect(enteredGroups(slide, [a, b])).toHaveLength(1)
    expect(enteredGroups(slide, [a])).toHaveLength(2)
    expect(enteredGroups(slide, [a, b, c])).toEqual([])
    expect(pickUnit(slide, [a, b], c)).toEqual([c])
    expect(pickUnit(slide, [c], a)).toEqual([a, b])
    expect(pickUnit(slide, [a], b)).toEqual([b])
    expect(pickUnit(slide, [a], c)).toEqual([c])
    expect(pickUnit(slide, [a], d)).toEqual([d])
  })

  it('comes back out a level with Escape, then lets go', () => {
    const { slide, a, b, c, d } = grouped()

    expect(leaveUnit(slide, [a])).toEqual([a, b])
    expect(leaveUnit(slide, [a, b])).toEqual([a, b, c])
    expect(leaveUnit(slide, [a, b, c])).toEqual([])
    expect(leaveUnit(slide, [d])).toEqual([])
  })

  it('knows a selection that is one whole group, and steps through a slide a group at a time', () => {
    const { slide, a, b, c, d } = grouped()

    expect(wholeGroup(slide, [a, b, c])).toBe(slide.elements[0].group?.[0])
    expect(wholeGroup(slide, [a, b])).toBe(slide.elements[0].group?.[1])
    expect(wholeGroup(slide, [a, c])).toBeNull()
    expect(wholeGroup(slide, [a, d])).toBeNull()
    expect(wholeGroup(slide, [d])).toBeNull()
    expect(nextUnit(slide, [], 1)).toEqual([a, b, c])
    expect(nextUnit(slide, [b], 1)).toEqual([d])
    expect(nextUnit(slide, [d], 1)).toEqual([a, b, c])
    expect(nextUnit(slide, [], -1)).toEqual([d])
  })
})

/** A blank slide with rectangles a (top left), b (lower right) and c (bottom left), a connector running from a's right to b's left. */
function joined() {
  let deck = model.addSlide(model.newDeck('Pitch'), { layout: 'blank' }).deck
  const slideId = deck.slides[1].id
  const ids: string[] = []

  for (const [x, y] of [
    [100, 100],
    [400, 300],
    [100, 400]
  ]) {
    const change = model.addShape(deck, slideId, { shape: 'rect', x, y, width: 100, height: 60 })
    deck = change.deck
    ids.push(change.elementId)
  }

  const [a, b, c] = ids
  const link = model.addConnector(deck, slideId, { from: { element: a, site: 3 }, to: { element: b, site: 1 } })

  return { deck: link.deck, slideId, a, b, c, line: link.elementId }
}

const slideOf = (deck: Deck, slideId: string): Slide => findSlide(deck, slideId)!
const lineOf = (deck: Deck, slideId: string, id: string): LineElement => findElement(slideOf(deck, slideId), id) as LineElement
const GLUE = { reach: 6, near: 20 }

describe('gluing connectors', () => {
  it('glues to the nearest connection site within reach, and shows the sites of what is near without gluing beyond it', () => {
    const { deck, slideId, a } = joined()
    const elements = slideOf(deck, slideId).elements
    const on = siteTarget(elements, [203, 131], GLUE)

    expect(on?.element.id).toBe(a)
    expect(on?.site).toBe(3)
    expect(on?.sites).toHaveLength(4)
    expect(endAt(on, [203, 131])).toEqual({ point: [200, 130], glued: { element: a, site: 3 } })

    const near = siteTarget(elements, [215, 145], GLUE)

    expect(near?.element.id).toBe(a)
    expect(near?.site).toBe(-1)
    expect(endAt(near, [215, 145])).toEqual({ point: [215, 145], glued: null })
    expect(siteTarget(elements, [700, 60], GLUE)).toBeNull()
    expect(siteTarget(elements, [203, 131], { ...GLUE, skip: new Set([a]) })).toBeNull()
  })

  it('shows the sites of the topmost element under the pointer', () => {
    const lower = shapeElement('rect', { x: 0, y: 0, width: 300, height: 300 })
    const upper = shapeElement('ellipse', { x: 100, y: 100, width: 100, height: 100 })

    expect(siteTarget([lower, upper], [150, 140], GLUE)?.element.id).toBe(upper.id)
    expect(siteTarget([lower, upper], [40, 40], GLUE)?.element.id).toBe(lower.id)
  })

  it('glues a dragged end to a site, or lets it go loose where it is dropped', () => {
    const { deck, slideId, b, c, line } = joined()
    const slide = slideOf(deck, slideId)
    const before = lineOf(deck, slideId, line)
    const glued = withConnectorEnd(slide, before, 'to', [150, 400], { element: c, site: 0 })

    expect(glued.connector?.end).toEqual({ element: c, site: 0 })
    close(lineEndsOnSlide(glued).to, [150, 400])
    close(lineEndsOnSlide(glued).from, [200, 130])

    const loose = changedDeck(deck, slideId, [line], () => withConnectorEnd(slide, before, 'to', [700, 500], null))

    expect(lineOf(loose, slideId, line).connector?.end).toBeUndefined()
    expect(lineOf(loose, slideId, line).connector?.start).toBeDefined()

    const after = movedDeck(loose, slideId, [b], 30, 30)

    close(lineEndsOnSlide(lineOf(after, slideId, line)).to, [700, 500])
  })

  it('turns a bent connector upright when its first glued end comes to face down', () => {
    const { deck, slideId, a, b } = joined()
    const elbow = model.addConnector(deck, slideId, { from: { element: a, site: 3 }, to: { element: b, site: 1 }, preset: 'bentConnector3' })
    const slide = slideOf(elbow.deck, slideId)
    const before = lineOf(elbow.deck, slideId, elbow.elementId)
    const down = withConnectorEnd(slide, before, 'from', [150, 160], { element: a, site: 2 })

    expect(before.rotation).toBe(0)
    expect(down.rotation).toBe(90)
    close(lineEndsOnSlide(down).from, [150, 160])
    close(lineEndsOnSlide(down).to, [400, 330])
  })
})

describe('decks shown while dragging', () => {
  it('moves the ends glued to what is moved, live', () => {
    const { deck, slideId, a, line } = joined()
    const shown = movedDeck(deck, slideId, [a], 50, 20)
    const ends = lineEndsOnSlide(lineOf(shown, slideId, line))

    close(ends.from, [250, 150])
    close(ends.to, [400, 330])
  })

  it('follows a shape as it is resized', () => {
    const { deck, slideId, a, line } = joined()
    const shown = resizedDeck(deck, slideId, [a], { x: 100, y: 100, width: 100, height: 60 }, { x: 100, y: 100, width: 160, height: 100 })

    close(lineEndsOnSlide(lineOf(shown, slideId, line)).from, [260, 150])
  })

  it('follows a group as it turns, each end on its site', () => {
    const { deck, slideId, a, b, line } = joined()
    const shown = rotatedDeck(deck, slideId, [a, b], 180)
    const sites = (id: string): Point[] => model.connectionSites(findElement(slideOf(shown, slideId), id)!)
    const ends = lineEndsOnSlide(lineOf(shown, slideId, line))

    close(ends.from, sites(a)[3])
    close(ends.to, sites(b)[1])
    expect(lineOf(shown, slideId, line).connector).toMatchObject({ start: { element: a, site: 3 }, end: { element: b, site: 1 } })
  })

  it('keeps the deck as it was when a drag moves nothing', () => {
    const { deck, slideId, a } = joined()

    expect(movedDeck(deck, slideId, [a], 0, 0).slides[1].elements.map((element) => [element.x, element.y])).toEqual(deck.slides[1].elements.map((element) => [element.x, element.y]))
    expect(rotatedDeck(deck, slideId, [a], 0)).toBe(deck)
  })
})
