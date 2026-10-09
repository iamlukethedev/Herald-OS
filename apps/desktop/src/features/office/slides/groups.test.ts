import { describe, expect, it } from 'vitest'
import { type Deck, findSlide, type SlideElement } from './deck.ts'
import { center } from './elements.ts'
import * as model from './model.ts'

/** A blank slide with shapes a, x, b and y side by side, in that drawing order. */
function shapes() {
  let deck = model.addSlide(model.newDeck('Pitch'), { layout: 'blank' }).deck
  const slideId = deck.slides[1].id
  const ids: string[] = []

  for (const x of [0, 100, 200, 300]) {
    const change = model.addShape(deck, slideId, { shape: 'rect', x, y: 100, width: 80, height: 40 })
    deck = change.deck
    ids.push(change.elementId)
  }

  const [a, x, b, y] = ids

  return { deck, slideId, a, x, b, y }
}

const elementsOf = (deck: Deck, slideId: string): SlideElement[] => findSlide(deck, slideId)!.elements
const groupOf = (deck: Deck, slideId: string, id: string) => elementsOf(deck, slideId).find((element) => element.id === id)?.group
const order = (deck: Deck, slideId: string) => elementsOf(deck, slideId).map((element) => element.id)

describe('groups', () => {
  it('groups elements together at the topmost one’s place in the drawing order', () => {
    const { deck, slideId, a, x, b, y } = shapes()
    const change = model.groupElements(deck, slideId, [b, a])
    const group = groupOf(change.deck, slideId, a)

    expect(change.label).toBe('Group')
    expect(group).toHaveLength(1)
    expect(groupOf(change.deck, slideId, b)).toEqual(group)
    expect(groupOf(change.deck, slideId, x)).toBeUndefined()
    expect(order(change.deck, slideId)).toEqual([x, a, b, y])
    expect(change.focus).toEqual({ slideId, selected: [a, b] })
  })

  it('needs two elements or groups, and leaves placeholders out', () => {
    const { deck, slideId, a } = shapes()
    const title = model.newDeck('Pitch')
    const titleSlide = title.slides[0]

    expect(model.groupElements(deck, slideId, [a]).deck).toBe(deck)
    expect(model.groupElements(title, titleSlide.id, titleSlide.elements.map((element) => element.id)).deck).toBe(title)

    const grouped = model.groupElements(deck, slideId, [a, deck.slides[1].elements[1].id]).deck
    expect(model.groupElements(grouped, slideId, [a]).deck).toBe(grouped)
  })

  it('nests groups, picks the outermost and ungroups one level at a time', () => {
    const { deck, slideId, a, x, b, y } = shapes()
    const inner = model.groupElements(deck, slideId, [a, b]).deck
    const innerId = groupOf(inner, slideId, a)![0]
    const outer = model.groupElements(inner, slideId, [a, y]).deck
    const outerId = groupOf(outer, slideId, y)![0]
    const slide = findSlide(outer, slideId)!

    expect(groupOf(outer, slideId, a)).toEqual([outerId, innerId])
    expect(groupOf(outer, slideId, b)).toEqual([outerId, innerId])
    expect(groupOf(outer, slideId, y)).toEqual([outerId])
    expect(model.unitOf(slide, b)).toEqual([a, b, y])
    expect(model.unitOf(slide, x)).toEqual([x])
    expect(model.expandToGroups(slide, [x, y])).toEqual([x, a, b, y])

    const once = model.ungroupElements(outer, slideId, [y])
    expect(once.label).toBe('Ungroup')
    expect(groupOf(once.deck, slideId, a)).toEqual([innerId])
    expect(groupOf(once.deck, slideId, y)).toBeUndefined()
    expect(model.unitOf(findSlide(once.deck, slideId)!, a)).toEqual([a, b])

    const twice = model.ungroupElements(once.deck, slideId, [b]).deck
    expect(groupOf(twice, slideId, a)).toBeUndefined()
    expect(model.ungroupElements(twice, slideId, [a]).deck).toBe(twice)
  })

  it('gives copies groups of their own, and keeps groups on a duplicated slide', () => {
    const { deck, slideId, a, b, x } = shapes()
    const grouped = model.groupElements(deck, slideId, [a, b]).deck
    const group = groupOf(grouped, slideId, a)![0]
    const doubled = model.duplicateElements(grouped, slideId, [a, b])
    const [copyA, copyB] = elementsOf(doubled.deck, slideId).slice(-2)

    expect(copyA.group).toHaveLength(1)
    expect(copyA.group).toEqual(copyB.group)
    expect(copyA.group).not.toEqual([group])

    const single = model.duplicateElements(grouped, slideId, [a, x])
    expect(elementsOf(single.deck, slideId).slice(-2).map((element) => element.group)).toEqual([undefined, undefined])

    const slides = model.duplicateSlides(grouped, [slideId]).deck
    const copied = slides.slides[2].elements
    expect(copied.filter((element) => element.group?.[0] === group)).toHaveLength(2)
    expect(copied.map((element) => element.id)).not.toContain(a)
  })

  it('makes fresh group ids for copies, the same across them', () => {
    const elements = shapes().deck.slides[1].elements.map((element, index) => ({ ...element, group: index < 3 ? ['g1', 'g2'] : ['g1'] }))
    const copies = model.regroupCopies(elements)

    expect(new Set(copies.map((element) => element.group![0])).size).toBe(1)
    expect(copies[0].group![0]).not.toBe('g1')
    expect(copies[0].group).toEqual(copies[2].group)
    expect(copies[3].group).toEqual([copies[0].group![0]])
  })

  it('drops a group left with one member when the others go, and only that group', () => {
    const { deck, slideId, a, b, x, y } = shapes()
    const grouped = model.groupElements(deck, slideId, [a, b]).deck
    const lone = model.updateElements(grouped, slideId, [x], (element) => ({ ...element, group: ['from-a-file'] }), 'Group').deck
    const removed = model.removeElements(lone, slideId, [b, y]).deck

    expect(groupOf(removed, slideId, a)).toBeUndefined()
    expect(groupOf(removed, slideId, x)).toEqual(['from-a-file'])
  })

  it('turns elements together about the middle of all of them', () => {
    const { deck, slideId, a, y } = shapes()
    const table = model.addTable(deck, slideId, { rows: 2, columns: 2, x: 0, y: 300, width: 200, height: 60 })
    const change = model.rotateElements(table.deck, slideId, [a, y], 90)
    const [turnedA, turnedY] = [a, y].map((id) => elementsOf(change.deck, slideId).find((element) => element.id === id)!)

    expect(change.label).toBe('Rotate')
    expect(turnedA.rotation).toBe(90)
    expect(center(turnedA)[0]).toBeCloseTo(190)
    expect(center(turnedA)[1]).toBeCloseTo(120 - 150)
    expect(center(turnedY)[0]).toBeCloseTo(190)
    expect(center(turnedY)[1]).toBeCloseTo(120 + 150)
    expect(model.rotateElements(table.deck, slideId, [a], 0).deck).toBe(table.deck)

    const spun = model.rotateElements(table.deck, slideId, [table.elementId], 45).deck
    expect(elementsOf(spun, slideId).find((element) => element.id === table.elementId)!.rotation).toBe(0)
    expect(model.rotateElements(change.deck, slideId, [a], 300).deck.slides[1].elements.find((element) => element.id === a)!.rotation).toBe(30)
  })

  it('turns a kept drawing into a group of its shapes, stretched to the object’s box', () => {
    const { deck, slideId } = shapes()
    const drawing = model.addShape(deck, slideId, { shape: 'ellipse', x: 10, y: 20, width: 40, height: 30 }).deck
    const shape = elementsOf(drawing, slideId).at(-1)!
    const object: SlideElement = { id: 'smartart', kind: 'object', object: 'diagram', x: 100, y: 100, width: 200, height: 120, rotation: 0, shapes: [shape, { ...shape, id: 'second', x: 60 }], drawnIn: { width: 100, height: 60 }, source: { xml: '<p:graphicFrame/>', parts: [] } }
    const withObject = model.insertElements(deck, slideId, [object], 'Paste').deck
    const change = model.convertToShapes(withObject, slideId, ['smartart'])
    const made = elementsOf(change.deck, slideId).filter((element) => change.focus?.selected?.includes(element.id))

    expect(elementsOf(change.deck, slideId).some((element) => element.id === 'smartart')).toBe(false)
    expect(made).toHaveLength(2)
    expect(made[0]).toMatchObject({ kind: 'shape', x: 120, y: 140, width: 80, height: 60 })
    expect(new Set(made.map((element) => element.group?.[0])).size).toBe(1)
    expect(model.convertToShapes(change.deck, slideId, [made[0].id]).deck).toBe(change.deck)
  })
})
