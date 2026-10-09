import type { Deck, Slide, SlideElement } from './deck.ts'
import { findSlide, newId, withSlide } from './deck.ts'
import { boundsOfAll, center, copyElement, lineEndsOnSlide, type Point, rotatePoint, withBox, withEndsOnSlide } from './elements.ts'
import type { DeckChange } from './model.ts'
import { routeDeck } from './sites.ts'

/*
 * Groups: elements that are picked, moved and turned together. A grouped element stays an element
 * of its slide, naming its groups outermost first, so groups nest; a click picks the outermost
 * group, and ungrouping takes that one away.
 */

function requireSlide(deck: Deck, slideId: string): Slide {
  const slide = findSlide(deck, slideId)

  if (!slide) {
    throw new Error(`There is no slide ${slideId} in this presentation`)
  }

  return slide
}

/** What an element is picked as: its outermost group, or itself when it is in none. */
const unitKey = (element: SlideElement): string => element.group?.[0] ?? element.id

/** The elements of a slide picked together with one (its outermost group's, in drawing order), or just it. */
export function unitOf(slide: Slide, id: string): string[] {
  return expandToGroups(slide, [id])
}

/** Elements with the rest of every outermost group they are in, in drawing order, as a selection takes them. */
export function expandToGroups(slide: Slide, ids: readonly string[]): string[] {
  const wanted = new Set(ids)
  const units = new Set(slide.elements.filter((element) => wanted.has(element.id)).map(unitKey))

  return slide.elements.filter((element) => units.has(unitKey(element))).map((element) => element.id)
}

/** Elements with groups that fewer than two of them are in taken away (a group of one is no group): those of `among` when given, else any. */
export function tidyGroups(elements: readonly SlideElement[], among?: ReadonlySet<string>): SlideElement[] {
  const counts = new Map<string, number>()

  for (const group of elements.flatMap((element) => element.group ?? [])) {
    counts.set(group, (counts.get(group) ?? 0) + 1)
  }

  return elements.map((element) => {
    const group = element.group?.filter((id) => (among && !among.has(id)) || (counts.get(id) ?? 0) > 1)

    if (!element.group || group?.length === element.group.length) {
      return element
    }

    const next = { ...element }

    if (group?.length) {
      next.group = group
    } else {
      delete next.group
    }

    return next
  })
}

/** Copies of elements in groups of their own: each group they share under a new id, the same for all of them. */
export function regroupCopies(elements: readonly SlideElement[]): SlideElement[] {
  const fresh = new Map<string, string>()
  const renamed = (id: string) => fresh.get(id) ?? fresh.set(id, newId('group')).get(id)!

  return tidyGroups(elements).map((element) => (element.group ? { ...element, group: element.group.map(renamed) } : element))
}

/**
 * Elements made a group (with the rest of any group they are in): at least two elements or groups,
 * placeholders left out. The group sits where its topmost member was in the drawing order, its
 * members together in their order.
 */
export function groupElements(deck: Deck, slideId: string, ids: readonly string[]): DeckChange {
  const slide = requireSlide(deck, slideId)
  const members = new Set(expandToGroups(slide, ids).filter((id) => !slide.elements.find((element) => element.id === id)?.placeholder))
  const chosen = slide.elements.filter((element) => members.has(element.id))

  if (new Set(chosen.map(unitKey)).size < 2) {
    return { deck, label: 'Group' }
  }

  const group = newId('group')
  const top = slide.elements.findLastIndex((element) => members.has(element.id))
  const grouped = chosen.map((element) => ({ ...element, group: [group, ...(element.group ?? [])] }))
  const elements = [...slide.elements.slice(0, top + 1).filter((element) => !members.has(element.id)), ...grouped, ...slide.elements.slice(top + 1)]

  return { deck: withSlide(deck, slideId, (entry) => ({ ...entry, elements })), label: 'Group', focus: { slideId, selected: grouped.map((element) => element.id) } }
}

/** The outermost group of some elements taken away, so what was inside it is picked apart (groups nested in it stay). */
export function ungroupElements(deck: Deck, slideId: string, ids: readonly string[]): DeckChange {
  const slide = requireSlide(deck, slideId)
  const members = new Set(expandToGroups(slide, ids).filter((id) => slide.elements.find((element) => element.id === id)?.group?.length))

  if (!members.size) {
    return { deck, label: 'Ungroup' }
  }

  const elements = slide.elements.map((element) => {
    if (!members.has(element.id)) {
      return element
    }

    const next = { ...element, group: element.group?.slice(1) }

    if (!next.group?.length) {
      delete next.group
    }

    return next
  })

  return { deck: withSlide(deck, slideId, (entry) => ({ ...entry, elements })), label: 'Ungroup', focus: { slideId, selected: [...members] } }
}

/**
 * Kept objects that carry a drawing (SmartArt) made a group of its shapes, placed and stretched as
 * the object is, so they can be edited; what the object kept for PowerPoint goes with it.
 */
export function convertToShapes(deck: Deck, slideId: string, ids: readonly string[]): DeckChange {
  const slide = requireSlide(deck, slideId)
  const wanted = new Set(ids)
  const made: string[] = []
  const elements = slide.elements.flatMap((element): SlideElement[] => {
    if (!wanted.has(element.id) || element.kind !== 'object' || !element.shapes?.length) {
      return [element]
    }

    const sx = element.width / Math.max(1, element.drawnIn?.width ?? element.width)
    const sy = element.height / Math.max(1, element.drawnIn?.height ?? element.height)
    const group = [...(element.group ?? []), newId('group')]
    const shapes = regroupCopies(element.shapes).map((shape) => {
      const placed = withBox(copyElement(shape), { x: element.x + shape.x * sx, y: element.y + shape.y * sy, width: shape.width * sx, height: shape.height * sy })

      return { ...placed, group: [...group, ...(shape.group ?? [])] }
    })
    made.push(...shapes.map((shape) => shape.id))

    return shapes
  })

  if (!made.length) {
    return { deck, label: 'Convert to Shapes' }
  }

  return { deck: withSlide(deck, slideId, (entry) => ({ ...entry, elements })), label: 'Convert to Shapes', focus: { slideId, selected: made } }
}

const turned = (degrees: number): number => ((degrees % 360) + 360) % 360

/** Elements turned together about the middle of all of them, each turning by as much (tables move round but stay upright, as in PowerPoint). */
export function rotateElements(deck: Deck, slideId: string, ids: readonly string[], degrees: number): DeckChange {
  const slide = requireSlide(deck, slideId)
  const wanted = new Set(ids)
  const frame = boundsOfAll(slide.elements.filter((element) => wanted.has(element.id)))

  if (!frame || !degrees || !Number.isFinite(degrees)) {
    return { deck, label: 'Rotate' }
  }

  const about = center(frame)
  const turn = (element: SlideElement): SlideElement => {
    if (element.kind === 'line') {
      const ends = lineEndsOnSlide(element)

      return withEndsOnSlide(element, rotatePoint(ends.from, about, degrees), rotatePoint(ends.to, about, degrees))
    }

    const [x, y]: Point = rotatePoint(center(element), about, degrees)
    const moved = { ...element, x: x - element.width / 2, y: y - element.height / 2 }

    return element.kind === 'table' ? moved : { ...moved, rotation: turned(element.rotation + degrees) }
  }
  const next = withSlide(deck, slideId, (entry) => ({ ...entry, elements: entry.elements.map((element) => (wanted.has(element.id) ? turn(element) : element)) }))

  return { deck: routeDeck(next, deck), label: 'Rotate', focus: { slideId, selected: [...ids] } }
}
