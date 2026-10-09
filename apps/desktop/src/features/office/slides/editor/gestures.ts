import { type SnapLine, linesOf, nearest, smartGuides, snapBox, type GuideLine } from '../../../canvas/engine/snapping.ts'
import type { Box, ConnectorEnd, Deck, LineElement, Slide, SlideElement, SlideSize } from '../deck.ts'
import { findElement, findSlide, withElements } from '../deck.ts'
import { boundsOf, boxAround, center, corners, lineEnds, lineEndsOnSlide, moveElement, type Point, rotatePoint, withBox, withEndsOnSlide } from '../elements.ts'
import { connectionSites, rotateElements, routeDeck, siteFacing } from '../model.ts'

/*
 * The arithmetic of dragging on a slide: moving with snapping and smart guides, resizing from any
 * handle (rotated boxes keep the opposite side still), rotating, line ends and the selection
 * rectangle; what a click picks among groups; where a connector's end glues. Pure, in points; the
 * stage turns the pointer into points and draws what comes back.
 */

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** A handle's direction from the box's centre: -1, 0 or 1 each way. */
export const handleDirection = (handle: Handle): Point => [handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0, handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0]

export { type GuideLine, type SnapLine }

/** What things on a slide snap to: its edges and centre, and the other elements' edges and centres. */
export function snapLines(size: SlideSize, others: readonly SlideElement[]): SnapLine[] {
  return linesOf(size, [], others.map(boundsOf))
}

export interface Moved {
  dx: number
  dy: number
  guides: GuideLine[]
}

/**
 * How far a selection moves for a drag of (dx, dy): pulled onto a line within `reach` when one is
 * near, held to one axis with `axis`, with the guides that show what it lines up with.
 */
export function moveWithSnapping(bounds: Box, dx: number, dy: number, options: { lines: readonly SnapLine[]; reach: number; others: readonly Box[]; size: SlideSize; axis?: boolean; snap?: boolean }): Moved {
  let moveX = dx
  let moveY = dy

  if (options.axis) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      moveY = 0
    } else {
      moveX = 0
    }
  }

  const box = { ...bounds, x: bounds.x + moveX, y: bounds.y + moveY }

  if (options.snap === false) {
    return { dx: moveX, dy: moveY, guides: [] }
  }

  const snapped = snapBox(box, options.lines, options.reach)
  const sx = options.axis && moveX === 0 ? 0 : snapped.delta[0]
  const sy = options.axis && moveY === 0 ? 0 : snapped.delta[1]
  const landed = { ...box, x: box.x + sx, y: box.y + sy }
  const { lines } = smartGuides(landed, options.others, { x: 0, y: 0, width: options.size.width, height: options.size.height }, 0.25)

  return { dx: moveX + sx, dy: moveY + sy, guides: lines }
}

/**
 * A box resized by dragging `handle` by (dx, dy) in slide space, for a box rotated `rotation`
 * degrees: the side or corner opposite stays where it is (the centre does with `fromCenter`), and
 * `keepRatio` holds its proportions. Sides never go below `least`.
 */
export function resizeBox(box: Box, rotation: number, handle: Handle, dx: number, dy: number, options: { keepRatio?: boolean; fromCenter?: boolean; least?: number } = {}): Box {
  const least = options.least ?? 4
  const [hx, hy] = handleDirection(handle)
  const [lx, ly] = rotatePoint([dx, dy], [0, 0], -rotation)
  const factor = options.fromCenter ? 2 : 1
  let width = hx ? box.width + hx * lx * factor : box.width
  let height = hy ? box.height + hy * ly * factor : box.height

  if (options.keepRatio && box.width > 0 && box.height > 0) {
    const ratio = box.width / box.height

    if (hx && hy) {
      const scale = Math.max(width / box.width, height / box.height)
      width = box.width * scale
      height = box.height * scale
    } else if (hx) {
      height = width / ratio
    } else {
      width = height * ratio
    }
  }

  width = Math.max(least, width)
  height = Math.max(least, height)

  const middle = center(box)

  if (options.fromCenter) {
    return { x: middle[0] - width / 2, y: middle[1] - height / 2, width, height }
  }

  // The opposite corner (or the opposite side's middle) stays where it is in slide space.
  const fixed = rotatePoint([middle[0] - (hx * box.width) / 2, middle[1] - (hy * box.height) / 2], middle, rotation)
  const offset = rotatePoint([(hx * width) / 2, (hy * height) / 2], [0, 0], rotation)
  const next: Point = [fixed[0] + offset[0], fixed[1] + offset[1]]

  return { x: next[0] - width / 2, y: next[1] - height / 2, width, height }
}

/** Snap a resized upright box's moving sides onto lines within reach; with the lines landed on. */
export function snapResize(box: Box, handle: Handle, lines: readonly SnapLine[], reach: number): { box: Box; landed: SnapLine[] } {
  const [hx, hy] = handleDirection(handle)
  const out = { ...box }
  const landed: SnapLine[] = []

  if (hx) {
    const edge = hx > 0 ? box.x + box.width : box.x
    const found = nearest(
      [edge],
      lines.filter((line) => line.axis === 'x'),
      reach
    )

    if (found) {
      landed.push(found.line)

      if (hx > 0) {
        out.width += found.delta
      } else {
        out.x += found.delta
        out.width -= found.delta
      }
    }
  }

  if (hy) {
    const edge = hy > 0 ? box.y + box.height : box.y
    const found = nearest(
      [edge],
      lines.filter((line) => line.axis === 'y'),
      reach
    )

    if (found) {
      landed.push(found.line)

      if (hy > 0) {
        out.height += found.delta
      } else {
        out.y += found.delta
        out.height -= found.delta
      }
    }
  }

  return { box: out, landed }
}

/** Elements fitted into a new box for their whole group, each keeping its place and size in proportion. */
export function scaleGroup(elements: readonly SlideElement[], from: Box, to: Box): SlideElement[] {
  const sx = from.width ? to.width / from.width : 1
  const sy = from.height ? to.height / from.height : 1

  return elements.map((element) => {
    const middle = center(element)
    const moved: Point = [to.x + (middle[0] - from.x) * sx, to.y + (middle[1] - from.y) * sy]
    const width = element.width * sx
    const height = element.height * sy

    return withBox(element, { x: moved[0] - width / 2, y: moved[1] - height / 2, width, height })
  })
}

/** The rotation for a pointer at `point` around `about`, started at `from` with `start` degrees. */
export function rotationFor(about: Point, from: Point, point: Point, start: number, options: { step?: boolean } = {}): number {
  const angle = (target: Point) => (Math.atan2(target[1] - about[1], target[0] - about[0]) * 180) / Math.PI
  let turned = start + angle(point) - angle(from)

  if (options.step) {
    turned = Math.round(turned / 15) * 15
  } else {
    const square = Math.round(turned / 90) * 90

    // Square angles pull from a few degrees away, so upright is easy to land on.
    if (Math.abs(turned - square) < 4) {
      turned = square
    }
  }

  return ((turned % 360) + 360) % 360
}

/** A line end dragged to `point`, held to steps of 45 degrees from the other end with `step`; the ends are on the slide, the line's rotation included. */
export function moveLineEnd(element: SlideElement, end: 'from' | 'to', point: Point, step = false): { from: Point; to: Point } {
  const ends = element.kind === 'line' ? lineEndsOnSlide(element) : lineEnds(element)
  const fixed = end === 'from' ? ends.to : ends.from
  let moved = point

  if (step) {
    const length = Math.hypot(point[0] - fixed[0], point[1] - fixed[1])
    const angle = Math.round(Math.atan2(point[1] - fixed[1], point[0] - fixed[0]) / (Math.PI / 4)) * (Math.PI / 4)
    moved = [fixed[0] + Math.cos(angle) * length, fixed[1] + Math.sin(angle) * length]
  }

  return end === 'from' ? { from: moved, to: fixed } : { from: fixed, to: moved }
}

/** The rectangle between two points. */
export const spanBox = (a: Point, b: Point): Box => boxAround([a, b])

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** The elements a selection rectangle touches (a line counts when its box does). */
export function marqueeHits(elements: readonly SlideElement[], area: Box): string[] {
  return elements.filter((element) => overlaps(area, { ...boundsOf(element), width: Math.max(1, boundsOf(element).width), height: Math.max(1, boundsOf(element).height) })).map((element) => element.id)
}

/** A box's corners in screen space, for drawing its outline once rotated. */
export const screenCorners = (box: Box, rotation: number, scale: number): Point[] => corners(box, rotation).map(([x, y]) => [x * scale, y * scale])

// Groups.

/** The elements in a group, by id, in drawing order. */
export const groupMembers = (slide: Slide, group: string): string[] => slide.elements.filter((element) => element.group?.includes(group)).map((element) => element.id)

/** An element with what it is grouped with `depth` groups in (its group at that depth), or just it when it is in fewer groups. */
function unitAt(slide: Slide, element: SlideElement, depth: number): string[] {
  const group = element.group?.[depth]

  return group ? groupMembers(slide, group) : [element.id]
}

/** The selected elements, and the groups all of them are in, outermost first. */
function sharedGroups(slide: Slide, ids: readonly string[]): { chosen: SlideElement[]; groups: string[] } {
  const wanted = new Set(ids)
  const chosen = slide.elements.filter((element) => wanted.has(element.id))
  const groups = chosen.reduce<string[] | null>((shared, element) => {
    const own = element.group ?? []

    if (!shared) {
      return [...own]
    }

    const length = shared.findIndex((group, index) => own[index] !== group)

    return length < 0 ? shared : shared.slice(0, length)
  }, null)

  return { chosen, groups: groups ?? [] }
}

/** The groups a selection has been taken into, outermost first: those all of it is in without being the whole of. */
export function enteredGroups(slide: Slide, ids: readonly string[]): string[] {
  const { chosen, groups } = sharedGroups(slide, ids)

  return groups.filter((group) => groupMembers(slide, group).length > chosen.length)
}

/** The group a selection of two elements or more is the whole of, or null. */
export function wholeGroup(slide: Slide, ids: readonly string[]): string | null {
  const { chosen, groups } = sharedGroups(slide, ids)

  return chosen.length > 1 ? (groups.find((group) => groupMembers(slide, group).length === chosen.length) ?? null) : null
}

/** What a click on an element picks: its outermost group, or inside a group the selection has been taken into, what it is grouped with one level down. */
export function pickUnit(slide: Slide, selected: readonly string[], id: string): string[] {
  const element = findElement(slide, id)

  if (!element) {
    return []
  }

  const inside = enteredGroups(slide, selected).filter((group) => element.group?.includes(group)).length

  return unitAt(slide, element, inside)
}

/** What a double click on an element of the selected group picks, going into that group: what the element is grouped with one level down; null when there is no group to go into. */
export function enterUnit(slide: Slide, selected: readonly string[], id: string): string[] | null {
  const element = findElement(slide, id)
  const group = wholeGroup(slide, selected)
  const depth = group && element?.group ? element.group.indexOf(group) : -1

  return element && depth >= 0 ? unitAt(slide, element, depth + 1) : null
}

/** What Escape leaves selected: the whole of the innermost group the selection was taken into, or nothing. */
export function leaveUnit(slide: Slide, selected: readonly string[]): string[] {
  const entered = enteredGroups(slide, selected)

  return entered.length ? groupMembers(slide, entered[entered.length - 1]) : []
}

/** The elements after the selection in drawing order (or before it), as Tab steps through a slide, a group as one. */
export function nextUnit(slide: Slide, selected: readonly string[], by: 1 | -1): string[] {
  const keyOf = (element: SlideElement) => element.group?.[0] ?? element.id
  const keys = [...new Set(slide.elements.map(keyOf))]
  const last = findElement(slide, selected[selected.length - 1])
  const at = last ? keys.indexOf(keyOf(last)) : by > 0 ? -1 : keys.length
  const key = keys[(at + by + keys.length) % keys.length]

  return key === undefined ? [] : slide.elements.filter((element) => keyOf(element) === key).map((element) => element.id)
}

// Connectors.

/** What a connector's end at a point glues to: an element with its connection sites, `site` being the one within reach of the point (-1 when none is). */
export interface SiteTarget {
  element: SlideElement
  sites: Point[]
  site: number
}

const distance = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])

/** How far a point is from an element's box (turned with it): 0 inside. */
function distanceToBox(element: SlideElement, point: Point): number {
  const middle = center(element)
  const [x, y] = rotatePoint(point, middle, -element.rotation)

  return Math.hypot(Math.max(0, Math.abs(x - middle[0]) - element.width / 2), Math.max(0, Math.abs(y - middle[1]) - element.height / 2))
}

/**
 * Where a connector's end at `point` glues: the connection site nearest the point within `reach`
 * points, on whichever element has it (the topmost when two are as near). With none in reach, the
 * topmost element under the point (else the nearest within `near` points) shows its sites, and the
 * end stays loose. Elements without sites (connectors) and those in `skip` are passed over.
 */
export function siteTarget(elements: readonly SlideElement[], point: Point, options: { reach: number; near: number; skip?: ReadonlySet<string> }): SiteTarget | null {
  let glued: (SiteTarget & { gap: number }) | null = null
  let under: { element: SlideElement; sites: Point[]; away: number } | null = null

  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index]
    const sites = options.skip?.has(element.id) ? [] : connectionSites(element)

    if (!sites.length) {
      continue
    }

    const site = sites.reduce((best, entry, at) => (distance(entry, point) < distance(sites[best], point) ? at : best), 0)
    const gap = distance(sites[site], point)
    const away = distanceToBox(element, point)

    if (gap <= options.reach && (!glued || gap < glued.gap)) {
      glued = { element, sites, site, gap }
    }

    if (away <= options.near && (!under || away < under.away)) {
      under = { element, sites, away }
    }
  }

  if (glued) {
    return { element: glued.element, sites: glued.sites, site: glued.site }
  }

  return under ? { element: under.element, sites: under.sites, site: -1 } : null
}

/** Where a target puts a connector's end: its site when one is in reach, else where the pointer is; and what the end is glued to. */
export function endAt(target: SiteTarget | null, point: Point): { point: Point; glued: ConnectorEnd | null } {
  return target && target.site >= 0 ? { point: target.sites[target.site], glued: { element: target.element.id, site: target.site } } : { point, glued: null }
}

const upright = (degrees: number): boolean => Math.abs(Math.sin((degrees * Math.PI) / 180)) > Math.SQRT1_2

/**
 * A connector with one end moved to `point` and glued to `glued`, or loose. A bent or curved one
 * turns upright (or back) when its first glued end comes to face up or down (or across), as a new
 * connector is laid out; the other end stays where it is.
 */
export function withConnectorEnd(slide: Slide, line: LineElement, end: 'from' | 'to', point: Point, glued: ConnectorEnd | null): LineElement {
  const side = end === 'from' ? 'start' : 'end'
  const connector = { ...(line.connector ?? { preset: 'straightConnector1' as const }) }

  if (glued) {
    connector[side] = glued
  } else {
    delete connector[side]
  }

  const facing = [connector.start, connector.end].flatMap((link) => {
    const element = link && findElement(slide, link.element)

    return link && element ? [siteFacing(element, link.site)] : []
  })[0]
  const rotation = connector.preset === 'straightConnector1' || facing === undefined || upright(facing) === upright(line.rotation) ? line.rotation : upright(facing) ? 90 : 0
  const ends = lineEndsOnSlide(line)

  return withEndsOnSlide({ ...line, rotation, connector }, end === 'from' ? point : ends.from, end === 'to' ? point : ends.to)
}

/** Whether an element is a connector glued to any of `ids` (so it follows them as they move). */
export const followsAny = (element: SlideElement, ids: ReadonlySet<string>): boolean =>
  element.kind === 'line' && [element.connector?.start, element.connector?.end].some((link) => link !== undefined && ids.has(link.element))

// Decks shown while dragging.

/** Some elements of a slide changed, with the connectors glued to them following, as a drag shows and commits it. */
export const changedDeck = (base: Deck, slideId: string, ids: readonly string[], change: (element: SlideElement) => SlideElement): Deck => routeDeck(withElements(base, slideId, new Set(ids), change), base)

export const movedDeck = (base: Deck, slideId: string, ids: readonly string[], dx: number, dy: number): Deck => changedDeck(base, slideId, ids, (element) => moveElement(element, dx, dy))

/** Elements fitted from the box around them into another (one element into it as its own box). */
export function resizedDeck(base: Deck, slideId: string, ids: readonly string[], from: Box, to: Box): Deck {
  const wanted = new Set(ids)
  const chosen = (findSlide(base, slideId)?.elements ?? []).filter((element) => wanted.has(element.id))
  const scaled = new Map((chosen.length === 1 ? [withBox(chosen[0], to)] : scaleGroup(chosen, from, to)).map((element) => [element.id, element]))

  return changedDeck(base, slideId, ids, (element) => scaled.get(element.id) ?? element)
}

/** Elements turned together about their middle by `degrees` (one element about its own). */
export const rotatedDeck = (base: Deck, slideId: string, ids: readonly string[], degrees: number): Deck => rotateElements(base, slideId, ids, degrees).deck
