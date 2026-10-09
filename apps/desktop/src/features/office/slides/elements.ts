import type { ArrowHead, Box, Color, Fill, ImageElement, LineElement, ShapeElement, ShapeKind, SlideElement, SlideSize, Stroke, TextBody, TextElement } from './deck.ts'
import { MIN_SIDE, newId } from './deck.ts'
import { scaleTable } from './tables.ts'
import { textBody } from './text.ts'

/*
 * Making elements, and what every kind of element shares: its box, where it reaches once rotated,
 * moving it and fitting it into another box.
 */

export type Point = [number, number]

export function textElement(box: Box, body: TextBody, patch: Partial<TextElement> = {}): TextElement {
  return { id: newId('text'), kind: 'text', ...box, rotation: 0, body, fill: null, stroke: null, ...patch }
}

/** A shape in the first accent with centred text in the background colour, as PowerPoint draws a new one. */
export function shapeElement(shape: ShapeKind, box: Box, patch: Partial<ShapeElement> = {}): ShapeElement {
  return {
    id: newId('shape'),
    kind: 'shape',
    shape,
    ...box,
    rotation: 0,
    fill: { color: 'accent1' },
    stroke: null,
    body: textBody({ font: '+body', size: 18, color: 'bg1' }, { anchor: 'middle', paragraph: { align: 'center' } }),
    ...patch
  }
}

export function imageElement(src: string, natural: { width: number; height: number }, box: Box, patch: Partial<ImageElement> = {}): ImageElement {
  return { id: newId('image'), kind: 'image', src, natural, ...box, rotation: 0, stroke: null, ...patch }
}

export const DEFAULT_LINE: Stroke = { color: 'tx1', width: 2, dash: 'solid' }

/** A fill running from one colour to another: 90 degrees runs top to bottom, 0 left to right. */
export const gradientFill = (from: Color, to: Color, angle = 90): Fill => ({
  color: from,
  gradient: {
    stops: [
      { at: 0, color: from },
      { at: 1, color: to }
    ],
    angle
  }
})

/** A line from one point to another: its box spans both, flipped where it runs right to left or upwards. */
export function lineElement(from: Point, to: Point, patch: Partial<Omit<LineElement, 'x' | 'y' | 'width' | 'height'>> = {}): LineElement {
  return { id: newId('line'), kind: 'line', rotation: 0, stroke: DEFAULT_LINE, start: 'none', end: 'none', ...patch, ...lineBox(from, to) }
}

export function lineBox(from: Point, to: Point): Pick<LineElement, 'x' | 'y' | 'width' | 'height' | 'flipH' | 'flipV'> {
  return { x: Math.min(from[0], to[0]), y: Math.min(from[1], to[1]), width: Math.abs(to[0] - from[0]), height: Math.abs(to[1] - from[1]), flipH: to[0] < from[0], flipV: to[1] < from[1] }
}

/** Where a line starts and ends. */
export function lineEnds(line: Pick<LineElement, 'x' | 'y' | 'width' | 'height' | 'flipH' | 'flipV'>): { from: Point; to: Point } {
  const left = line.x
  const right = line.x + line.width
  const top = line.y
  const bottom = line.y + line.height

  return { from: [line.flipH ? right : left, line.flipV ? bottom : top], to: [line.flipH ? left : right, line.flipV ? top : bottom] }
}

export const withEnds = (line: LineElement, from: Point, to: Point): LineElement => ({ ...line, ...lineBox(from, to) })

export const center = (box: Box): Point => [box.x + box.width / 2, box.y + box.height / 2]

/** A point turned `degrees` clockwise about `about`. */
export function rotatePoint(point: Point, about: Point, degrees: number): Point {
  if (!degrees) {
    return point
  }

  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const dx = point[0] - about[0]
  const dy = point[1] - about[1]

  return [about[0] + dx * cos - dy * sin, about[1] + dx * sin + dy * cos]
}

/** A box's corners once rotated: top left, top right, bottom right, bottom left. */
export function corners(box: Box, rotation = 0): Point[] {
  const middle = center(box)
  const points: Point[] = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x + box.width, box.y + box.height],
    [box.x, box.y + box.height]
  ]

  return points.map((point) => rotatePoint(point, middle, rotation))
}

/** Where a line starts and ends on the slide, its rotation included. */
export function lineEndsOnSlide(line: LineElement): { from: Point; to: Point } {
  const { from, to } = lineEnds(line)
  const middle = center(line)

  return { from: rotatePoint(from, middle, line.rotation), to: rotatePoint(to, middle, line.rotation) }
}

const tidy = (value: number): number => (Math.abs(value) < 1e-9 ? 0 : value)

/** A line moved to run between two points on the slide, keeping its rotation: its box is the one that, turned by it, has those ends. */
export function withEndsOnSlide(line: LineElement, from: Point, to: Point): LineElement {
  if (!line.rotation) {
    return withEnds(line, from, to)
  }

  const [dx, dy] = rotatePoint([to[0] - from[0], to[1] - from[1]], [0, 0], -line.rotation).map(tidy)
  const width = Math.abs(dx)
  const height = Math.abs(dy)

  return { ...line, x: (from[0] + to[0]) / 2 - width / 2, y: (from[1] + to[1]) / 2 - height / 2, width, height, flipH: dx < 0, flipV: dy < 0 }
}

/** The upright box around points. */
export function boxAround(points: readonly Point[]): Box {
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)

  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/** The upright box an element reaches, rotation included. */
export const boundsOf = (element: SlideElement): Box => (element.rotation ? boxAround(corners(element, element.rotation)) : { x: element.x, y: element.y, width: element.width, height: element.height })

/** The upright box around several elements. */
export const boundsOfAll = (elements: readonly SlideElement[]): Box | null => (elements.length ? boxAround(elements.flatMap((element) => corners(boundsOf(element)))) : null)

export const moveElement = <T extends SlideElement>(element: T, dx: number, dy: number): T => ({ ...element, x: element.x + dx, y: element.y + dy })

/** An element given a new box (rotation and flips kept, a table's columns and rows in proportion); boxes keep at least MIN_SIDE except a line's. */
export function withBox<T extends SlideElement>(element: T, box: Box): T {
  const least = element.kind === 'line' ? 0 : MIN_SIDE
  const width = Math.max(least, box.width)
  const height = Math.max(least, box.height)

  if (element.kind === 'table') {
    return scaleTable({ ...element, x: box.x, y: box.y }, width, height) as T
  }

  return { ...element, x: box.x, y: box.y, width, height }
}

/** An element kept at least partly on its slide. */
export function keepOnSlide<T extends SlideElement>(element: T, size: SlideSize): T {
  const bounds = boundsOf(element)
  const reach = Math.min(16, Math.max(1, Math.min(bounds.width, bounds.height)))
  const dx = bounds.x > size.width - reach ? size.width - reach - bounds.x : bounds.x + bounds.width < reach ? reach - bounds.x - bounds.width : 0
  const dy = bounds.y > size.height - reach ? size.height - reach - bounds.y : bounds.y + bounds.height < reach ? reach - bounds.y - bounds.height : 0

  return dx || dy ? moveElement(element, dx, dy) : element
}

/** The crop that makes a picture cover a box without stretching, cut evenly at the sides that are too long. */
export function coverCrop(natural: { width: number; height: number }, box: Pick<Box, 'width' | 'height'>): { left: number; top: number; right: number; bottom: number } | undefined {
  if (!natural.width || !natural.height || !box.width || !box.height) {
    return undefined
  }

  const picture = natural.width / natural.height
  const frame = box.width / box.height

  if (Math.abs(picture - frame) < 1e-3) {
    return undefined
  }

  const cut = picture > frame ? (1 - frame / picture) / 2 : (1 - picture / frame) / 2

  return picture > frame ? { left: cut, top: 0, right: cut, bottom: 0 } : { left: 0, top: cut, right: 0, bottom: cut }
}

/** The same element under a new id (pasting, duplicating). */
export const copyElement = <T extends SlideElement>(element: T): T => ({ ...element, id: newId(element.kind) })

export const ARROW_NAMES: Record<ArrowHead, string> = { none: 'None', triangle: 'Arrow', arrow: 'Open arrow', stealth: 'Stealth arrow', oval: 'Dot', diamond: 'Diamond' }

/** What an element is called in menus and in what Hermes is told. */
export function describeElement(element: SlideElement): string {
  if (element.placeholder) {
    return { title: 'Title', subtitle: 'Subtitle', body: 'Text', heading: 'Heading', caption: 'Caption', picture: 'Picture', date: 'Date', footer: 'Footer', number: 'Slide number' }[element.placeholder.role]
  }

  if (element.kind === 'object') {
    return { chart: 'Chart', diagram: 'SmartArt', ole: 'Embedded object', media: 'Media', other: 'Object' }[element.object]
  }

  return element.kind === 'text' ? 'Text box' : element.kind === 'image' ? 'Picture' : element.kind === 'line' ? (element.connector ? 'Connector' : 'Line') : element.kind === 'table' ? 'Table' : 'Shape'
}
