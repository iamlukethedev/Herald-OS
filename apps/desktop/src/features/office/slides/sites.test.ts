import { describe, expect, it } from 'vitest'
import { type Deck, findSlide, type LineElement, type SlideElement, SLIDE_SIZES, withElements } from './deck.ts'
import { imageElement, lineElement, lineEndsOnSlide, moveElement, type Point, shapeElement, textElement } from './elements.ts'
import * as model from './model.ts'
import { connectionSites, nearestSite, routeDeck, siteFacing } from './sites.ts'
import { tableElement } from './tables.ts'
import { textBody } from './text.ts'

const box = { x: 100, y: 50, width: 200, height: 100 }

const close = (points: readonly Point[], expected: readonly Point[]) => {
  expect(points).toHaveLength(expected.length)
  points.forEach((point, index) => {
    expect(point[0]).toBeCloseTo(expected[index][0])
    expect(point[1]).toBeCloseTo(expected[index][1])
  })
}

/** A blank slide with rectangle a at the top left and rectangle b lower right, joined by a connector from a’s right to b’s left. */
function joined() {
  let deck = model.addSlide(model.newDeck('Pitch'), { layout: 'blank' }).deck
  const slideId = deck.slides[1].id
  const first = model.addShape(deck, slideId, { shape: 'rect', x: 100, y: 100, width: 100, height: 60 })
  const second = model.addShape(first.deck, slideId, { shape: 'rect', x: 400, y: 300, width: 100, height: 60 })
  const link = model.addConnector(second.deck, slideId, { from: { element: first.elementId, site: 3 }, to: { element: second.elementId, site: 1 }, end: 'triangle' })
  deck = link.deck

  return { deck, slideId, a: first.elementId, b: second.elementId, line: link.elementId, label: link.label }
}

const element = (deck: Deck, slideId: string, id: string): SlideElement => findSlide(deck, slideId)!.elements.find((entry) => entry.id === id)!
const line = (deck: Deck, slideId: string, id: string) => element(deck, slideId, id) as LineElement

describe('connection sites', () => {
  it('numbers a box’s sites top, left, bottom and right, for text boxes, pictures, tables and rectangles', () => {
    const expected: Point[] = [
      [200, 50],
      [100, 100],
      [200, 150],
      [300, 100]
    ]

    close(connectionSites(textElement(box, textBody({ font: '+body', size: 18, color: 'tx1' }))), expected)
    close(connectionSites(imageElement('', { width: 2, height: 1 }, box)), expected)
    close(connectionSites(tableElement(box, 2, 2)), expected)
    close(connectionSites(shapeElement('rect', box)), expected)
    close(connectionSites(shapeElement('roundRect', box)), expected)
    close(connectionSites(shapeElement('diamond', box)), expected)
  })

  it('gives an ellipse its eight sites from the top round by the left', () => {
    const r = Math.SQRT1_2

    close(connectionSites(shapeElement('ellipse', box)), [
      [200, 50],
      [200 - 100 * r, 100 - 50 * r],
      [100, 100],
      [200 - 100 * r, 100 + 50 * r],
      [200, 150],
      [200 + 100 * r, 100 + 50 * r],
      [300, 100],
      [200 + 100 * r, 100 - 50 * r]
    ])
  })

  it('places other presets’ sites as DrawingML defines them, adjust values included', () => {
    const triangle = { x: 0, y: 0, width: 100, height: 80 }

    close(connectionSites(shapeElement('triangle', triangle)), [
      [50, 0],
      [25, 40],
      [0, 80],
      [50, 80],
      [100, 80],
      [75, 40]
    ])
    close(connectionSites(shapeElement('triangle', triangle, { adjust: { adj: 0 } })).slice(0, 2), [
      [0, 0],
      [0, 40]
    ])
    close(connectionSites(shapeElement('hexagon', { x: 0, y: 0, width: 200, height: 100 })), [
      [200, 50],
      [175, 100],
      [25, 100],
      [0, 50],
      [25, 0],
      [175, 0]
    ])
    close(connectionSites(shapeElement('rightArrow', { x: 0, y: 0, width: 200, height: 100 })), [
      [150, 0],
      [0, 50],
      [150, 100],
      [200, 50]
    ])
    expect(connectionSites(shapeElement('pentagon', triangle))).toHaveLength(6)
    expect(connectionSites(shapeElement('star10', triangle))).toHaveLength(4)
  })

  it('turns and flips sites with their element', () => {
    close(connectionSites(shapeElement('rect', { x: 0, y: 0, width: 200, height: 100 }, { rotation: 90 })), [
      [150, 50],
      [100, -50],
      [50, 50],
      [100, 150]
    ])
    close(connectionSites(shapeElement('triangle', { x: 0, y: 0, width: 100, height: 80 }, { flipV: true })).slice(0, 3), [
      [50, 80],
      [25, 40],
      [0, 0]
    ])
    close(connectionSites(shapeElement('rtTriangle', { x: 0, y: 0, width: 100, height: 80 }, { flipH: true })).slice(0, 1), [[100, 0]])
    expect(siteFacing(shapeElement('rect', box), 1)).toBe(180)
    expect(siteFacing(shapeElement('rect', box, { rotation: 90 }), 1)).toBe(270)
    expect(siteFacing(shapeElement('rect', box, { flipH: true }), 1)).toBe(0)
  })

  it('finds the nearest site, and gives a line its ends but a connector none', () => {
    expect(nearestSite(shapeElement('rect', box), [310, 90])).toBe(3)
    expect(nearestSite(shapeElement('ellipse', box), [120, 60])).toBe(1)

    const drawn = lineElement([300, 100], [100, 50])
    close(connectionSites(drawn), [
      [300, 100],
      [100, 50]
    ])
    expect(connectionSites({ ...drawn, connector: { preset: 'straightConnector1' } })).toEqual([])
    expect(nearestSite({ ...drawn, connector: { preset: 'straightConnector1' } }, [0, 0])).toBe(-1)
  })
})

describe('connectors', () => {
  it('glues a new connector’s ends to its elements’ sites', () => {
    const { deck, slideId, a, b, line: id, label } = joined()
    const made = line(deck, slideId, id)

    expect(label).toBe('New Connector')
    expect(made.connector).toEqual({ preset: 'straightConnector1', start: { element: a, site: 3 }, end: { element: b, site: 1 } })
    close(Object.values(lineEndsOnSlide(made)), [
      [200, 130],
      [400, 330]
    ])
    expect(made.end).toBe('triangle')
    expect(() => model.addConnector(deck, slideId, { from: { element: a, site: 9 }, to: [0, 0] })).toThrow(/connection sites 0 to 3/)
  })

  it('turns a bent connector that leaves a site upwards or downwards', () => {
    const { deck, slideId, a, b } = joined()
    const bent = model.addConnector(deck, slideId, { from: { element: a, site: 2 }, to: { element: b, site: 0 }, preset: 'bentConnector3' })
    const made = line(bent.deck, slideId, bent.elementId)

    expect(made.rotation).toBe(90)
    close(Object.values(lineEndsOnSlide(made)), [
      [150, 160],
      [450, 300]
    ])
  })

  it('keeps glued ends on their sites as elements move, turn and change size', () => {
    const { deck, slideId, a, b, line: id } = joined()
    const nudged = model.nudge(deck, slideId, [b], 10, -20).deck
    close(Object.values(lineEndsOnSlide(line(nudged, slideId, id))), [
      [200, 130],
      [410, 310]
    ])

    const aligned = model.align(deck, slideId, [a, b], 'top').deck
    close(Object.values(lineEndsOnSlide(line(aligned, slideId, id))), [
      [200, 130],
      [400, 130]
    ])

    const grown = model.updateElements(deck, slideId, [a], (entry) => ({ ...entry, width: 200 }), 'Size').deck
    expect(lineEndsOnSlide(line(grown, slideId, id)).from).toEqual([300, 130])

    const turned = model.rotateElements(deck, slideId, [b], 90).deck
    close([lineEndsOnSlide(line(turned, slideId, id)).to], [connectionSites(element(turned, slideId, b))[1]])

    const narrow = model.setSize(deck, SLIDE_SIZES.standard).deck
    close([lineEndsOnSlide(line(narrow, slideId, id)).from], [connectionSites(element(narrow, slideId, a))[3]])
  })

  it('lets an end go where its element is removed, leaving the line where it was', () => {
    const { deck, slideId, a, b, line: id } = joined()
    const removed = model.removeElements(deck, slideId, [a]).deck
    const left = line(removed, slideId, id)

    expect(left.connector).toEqual({ preset: 'straightConnector1', end: { element: b, site: 1 } })
    expect(lineEndsOnSlide(left)).toEqual(lineEndsOnSlide(line(deck, slideId, id)))
  })

  it('lets ends dragged off their sites come loose, and keeps those moved with their element', () => {
    const { deck, slideId, a, b, line: id } = joined()
    const alone = line(model.nudge(deck, slideId, [id], 30, 0).deck, slideId, id)

    expect(alone.connector).toEqual({ preset: 'straightConnector1' })
    expect(lineEndsOnSlide(alone).from).toEqual([230, 130])

    const together = line(model.nudge(deck, slideId, [a, id], 0, 20).deck, slideId, id)
    expect(together.connector).toEqual({ preset: 'straightConnector1', start: { element: a, site: 3 } })
    expect(lineEndsOnSlide(together).from).toEqual([200, 150])

    const restyled = line(model.updateElements(deck, slideId, [id], (entry) => ({ ...entry, stroke: { color: 'accent2', width: 3, dash: 'dash' } }) as SlideElement, 'Line').deck, slideId, id)
    expect(restyled.connector).toEqual(line(deck, slideId, id).connector)
    expect(model.updateElements(deck, slideId, [b], (entry) => entry, 'Nothing').deck.slides[1].elements.find((entry) => entry.id === id)).toBe(line(deck, slideId, id))
  })

  it('glues copied connectors to the copies, on duplicated slides and among duplicated elements', () => {
    const { deck, slideId, a, b, line: id } = joined()
    const doubled = model.duplicateSlides(deck, [slideId]).deck
    const copy = doubled.slides[2]
    const copied = copy.elements.find((entry) => entry.kind === 'line') as LineElement
    const [copyA, copyB] = copy.elements.filter((entry) => entry.kind === 'shape').map((entry) => entry.id)

    expect(copied.connector).toEqual({ preset: 'straightConnector1', start: { element: copyA, site: 3 }, end: { element: copyB, site: 1 } })
    expect([copyA, copyB]).not.toContain(a)

    const all = model.duplicateElements(deck, slideId, [a, b, id])
    const [shapeA, shapeB, connector] = findSlide(all.deck, slideId)!.elements.slice(-3) as [SlideElement, SlideElement, LineElement]
    expect(connector.connector).toEqual({ preset: 'straightConnector1', start: { element: shapeA.id, site: 3 }, end: { element: shapeB.id, site: 1 } })
    close(Object.values(lineEndsOnSlide(connector)), [
      [212, 142],
      [412, 342]
    ])

    const lone = findSlide(model.duplicateElements(deck, slideId, [id]).deck, slideId)!.elements.at(-1) as LineElement
    expect(lone.connector).toEqual({ preset: 'straightConnector1' })
  })

  it('routes the slides that changed, or all of them, and gives back the same deck when nothing moves', () => {
    const { deck, slideId, b, line: id } = joined()
    const shifted = withElements(deck, slideId, new Set([b]), (entry) => moveElement(entry, 50, 0))

    expect(routeDeck(deck)).toBe(deck)
    expect(routeDeck(shifted, shifted)).toBe(shifted)
    expect(lineEndsOnSlide(line(routeDeck(shifted, deck), slideId, id)).to).toEqual([450, 330])
    expect(lineEndsOnSlide(line(routeDeck(shifted), slideId, id)).to).toEqual([450, 330])
  })
})
