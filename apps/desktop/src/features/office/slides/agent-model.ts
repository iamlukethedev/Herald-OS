import type { DocJSON, DocNode } from '../../../../shared/office/document.ts'
import { parseJsonArg } from '../agent-model.ts'
import { type Color, type Deck, LAYOUTS, type LayoutId, SHAPE_KINDS, type ShapeKind, type Slide, type SlideElement, type SlideSize, SLIDE_SIZES, type TextAlign, type TextBody, type TextRun, type Theme } from './deck.ts'
import { coverCrop, describeElement } from './elements.ts'
import { isEmptyPlaceholder, LAYOUT_NAMES, layoutPlaceholders, placeholderFor } from './layouts.ts'
import * as model from './model.ts'
import type { DeckChange } from './model.ts'
import { SHAPE_NAMES } from './shapes.ts'
import { MAX_COLUMNS, MAX_ROWS, tableText } from './tables.ts'
import { isSlot, normalHex, THEMES } from './themes.ts'
import { plainText, tidyRuns } from './text.ts'

/*
 * Herald Slides for Hermes, without a window: the slide, layout, colour and theme a command names;
 * every change as a pure step on the deck, so a batch is its steps one after another and lands as
 * one step to undo; a deck read the way Hermes wants it; find and replace over a deck's text; and
 * the slides a Herald Docs document makes. Tested directly.
 */

type Args = Record<string, unknown>

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '')

const given = (value: unknown): boolean => value !== undefined && value !== null && value !== ''

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const flat = (value: string): string => value.replace(/\s+/g, ' ').trim()

const shorten = (value: string, limit: number): string => {
  const line = flat(value)

  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/** true, false, or undefined when the caller said nothing. */
const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : given(value) ? /^(true|yes|on|1)$/i.test(String(value).trim()) : undefined)

/** A number a command gave, within limits, or undefined when it gave none. */
function numberIn(args: Args, name: string, low: number, high: number): number | undefined {
  if (!given(args[name])) {
    return undefined
  }

  const value = Number(args[name])

  if (!Number.isFinite(value) || value < low || value > high) {
    throw new Error(`${name} is a number from ${low} to ${high}`)
  }

  return value
}

const findSlideIn = (deck: Deck, slideId: string): Slide => deck.slides.find((slide) => slide.id === slideId) ?? deck.slides[0]

// Slides by reference.

const comparable = (value: string): string => flat(value.toLowerCase().replace(/[“”"‘’'.,:;!?]/g, ''))

/** The slides as a short list for messages: "1. Intro, 2. Plan, …". */
function slideList(deck: Deck): string {
  const titles = deck.slides.map((slide, index) => `${index + 1}. ${model.slideTitle(slide) || '(no title)'}`)

  return `${titles.slice(0, 12).join(', ')}${titles.length > 12 ? `, and ${titles.length - 12} more` : ''}`
}

/**
 * The slide a command names: its number (1 is the first; "slide 3" works), its id, its title (the
 * whole of it, then its start, then part of it), first or last; `front`, or else the first slide,
 * when it names none.
 */
export function slideIdOf(deck: Deck, ref: unknown, front?: string | null): string {
  const asked = text(ref)

  if (!asked || /^(current|this)( slide)?$/i.test(asked)) {
    return front && deck.slides.some((slide) => slide.id === front) ? front : deck.slides[0].id
  }

  const number = /^(?:slide\s*|#)?(\d+)$/i.exec(asked)

  if (number) {
    return model.slideRef(deck, Number(number[1]))
  }

  if (deck.slides.some((slide) => slide.id === asked)) {
    return asked
  }

  if (/^(first|last)( slide)?$/i.test(asked)) {
    return (asked.toLowerCase().startsWith('first') ? deck.slides[0] : deck.slides[deck.slides.length - 1]).id
  }

  const wanted = comparable(asked)
  const titles = deck.slides.map((slide) => comparable(model.slideTitle(slide)))
  const index = [titles.indexOf(wanted), titles.findIndex((title) => title.startsWith(wanted)), titles.findIndex((title) => title.includes(wanted))].find((found) => found >= 0)

  if (index === undefined || !wanted) {
    throw new Error(`There is no slide “${asked}”: the slides are ${slideList(deck)}`)
  }

  return deck.slides[index].id
}

/** A slide's number, 1 for the first. */
export const slideNumber = (deck: Deck, slideId: string): number => deck.slides.findIndex((slide) => slide.id === slideId) + 1

/** "slide 3 (“Plan”)", for what a step says it did. */
function slideLabel(deck: Deck, slideId: string): string {
  const title = model.slideTitle(findSlideIn(deck, slideId))

  return `slide ${slideNumber(deck, slideId)}${title ? ` (“${shorten(title, 48)}”)` : ''}`
}

/** A new place for a slide: its number from 1, or first or last. */
function positionOf(value: unknown, count: number): number {
  const asked = text(value).toLowerCase()

  if (/^(first|start|beginning|top)$/.test(asked)) {
    return 1
  }

  if (/^(last|end|bottom)$/.test(asked)) {
    return count
  }

  const number = Number(asked.replace(/^(slide\s*|#)/, ''))

  if (!asked || !Number.isFinite(number)) {
    throw new Error('Say where the slide goes: to, its new number (1 is the first), or first or last')
  }

  return Math.max(1, Math.min(count, Math.round(number)))
}

// Words for layouts, colours, themes, sizes and shapes.

const layoutWords = (value: string): string =>
  flat(
    value
      .toLowerCase()
      .replace(/[&+]/g, ' and ')
      .replace(/[-_/]/g, ' ')
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\b(layout|slide)\b/g, ' ')
  )

const LAYOUT_WORDS: Record<string, LayoutId> = {
  cover: 'title',
  opening: 'title',
  content: 'title-content',
  text: 'title-content',
  bullets: 'title-content',
  list: 'title-content',
  'title and text': 'title-content',
  'title and body': 'title-content',
  'title and bullets': 'title-content',
  columns: 'two-content',
  'two columns': 'two-content',
  'two column': 'two-content',
  '2 columns': 'two-content',
  'side by side': 'two-content',
  divider: 'section',
  'section heading': 'section',
  'section title': 'section',
  'heading only': 'title-only',
  empty: 'blank',
  picture: 'picture-caption',
  image: 'picture-caption',
  photo: 'picture-caption',
  'picture and caption': 'picture-caption',
  compare: 'comparison',
  versus: 'comparison',
  'pros and cons': 'comparison',
  'before and after': 'comparison'
}

/** A layout from its id, its name in the menu ("Title and Content"), or a word people use for it ("two columns", "section"). */
export function layoutOf(value: unknown): LayoutId {
  const words = layoutWords(text(value))
  const found = LAYOUTS.find((id) => layoutWords(id) === words || layoutWords(LAYOUT_NAMES[id]) === words) ?? LAYOUT_WORDS[words]

  if (!found) {
    throw new Error(`layout is one of ${LAYOUTS.join(', ')} (or as people say it: “title and content”, “two columns”), not “${text(value)}”`)
  }

  return found
}

/** How many columns of text a layout's slides have: its body placeholders, or one (a subtitle or caption, or one made on demand). */
export const columnsOf = (layout: LayoutId): number => Math.max(1, layoutPlaceholders(layout).filter((spec) => spec.role === 'body').length)

const NAMED_COLORS: Record<string, `#${string}`> = {
  black: '#000000',
  white: '#ffffff',
  gray: '#808080',
  grey: '#808080',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  darkgray: '#404040',
  darkgrey: '#404040',
  silver: '#c0c0c0',
  red: '#ff0000',
  crimson: '#dc143c',
  maroon: '#800000',
  orange: '#ffa500',
  coral: '#ff7f50',
  salmon: '#fa8072',
  yellow: '#ffff00',
  gold: '#ffd700',
  beige: '#f5f5dc',
  brown: '#a52a2a',
  green: '#008000',
  lime: '#00ff00',
  olive: '#808000',
  teal: '#008080',
  cyan: '#00ffff',
  turquoise: '#40e0d0',
  blue: '#0000ff',
  skyblue: '#87ceeb',
  navy: '#000080',
  indigo: '#4b0082',
  purple: '#800080',
  violet: '#ee82ee',
  magenta: '#ff00ff',
  pink: '#ffc0cb'
}

const SLOT_WORDS: Record<string, Color> = { text: 'tx1', text1: 'tx1', text2: 'tx2', background: 'bg1', background1: 'bg1', background2: 'bg2', accent: 'accent1' }

/** A colour from a command: #rrggbb or #rgb, a name (navy, teal…) or a theme colour (accent1 to accent6, text, background); null for none. */
export function colorArg(value: unknown, name: string): Color | null {
  const asked = text(value).toLowerCase()

  if (/^(none|transparent|no fill|clear|theme)$/.test(asked)) {
    return null
  }

  const compact = asked.replace(/[\s_-]/g, '')
  const hex = /^#[0-9a-f]{3}$|^#?[0-9a-f]{6}$/.test(compact) ? normalHex(compact) : null
  const found = (isSlot(compact) ? compact : null) ?? SLOT_WORDS[compact] ?? NAMED_COLORS[compact] ?? hex

  if (!found) {
    throw new Error(`${name} is a colour: #rrggbb, a name like navy or teal, a theme colour (accent1 to accent6, text, background) or none; not “${text(value)}”`)
  }

  return found
}

/** A built-in theme by id or name. */
export function themeOf(value: unknown): Theme {
  const wanted = text(value)
    .toLowerCase()
    .replace(/\s+theme$/, '')
  const found = THEMES.find((theme) => theme.id === wanted || theme.name.toLowerCase() === wanted) ?? (wanted === 'default' ? THEMES[0] : undefined)

  if (!found) {
    throw new Error(`theme is one of ${THEMES.map((theme) => theme.id).join(', ')}, not “${text(value)}”`)
  }

  return found
}

/** A slide size: wide (16:9, the default) or standard (4:3). */
export function sizeOf(value: unknown): SlideSize {
  const wanted = text(value).toLowerCase().replace(/\s+/g, '')

  if (!wanted || ['wide', 'widescreen', '16:9', '16x9'].includes(wanted)) {
    return SLIDE_SIZES.wide
  }

  if (['standard', '4:3', '4x3'].includes(wanted)) {
    return SLIDE_SIZES.standard
  }

  throw new Error(`size is wide (16:9) or standard (4:3), not “${text(value)}”`)
}

const SHAPE_WORDS: Record<string, ShapeKind> = {
  rectangle: 'rect',
  box: 'rect',
  square: 'rect',
  roundedrectangle: 'roundRect',
  roundedrect: 'roundRect',
  rounded: 'roundRect',
  pill: 'roundRect',
  button: 'roundRect',
  circle: 'ellipse',
  oval: 'ellipse',
  righttriangle: 'rtTriangle',
  cross: 'plus',
  star: 'star5',
  arrow: 'rightArrow',
  doublearrow: 'leftRightArrow',
  pentagonarrow: 'homePlate',
  tag: 'homePlate',
  callout: 'wedgeRoundRectCallout',
  speechbubble: 'wedgeRoundRectCallout',
  bubble: 'wedgeRoundRectCallout',
  rectangularcallout: 'wedgeRectCallout'
}

/** A shape from its preset name or a word for it (rectangle, circle, star, arrow, callout); a rectangle when none is named. */
export function shapeOf(value: unknown): ShapeKind {
  const wanted = text(value).toLowerCase().replace(/[\s_-]/g, '')

  if (!wanted) {
    return 'rect'
  }

  const found = SHAPE_KINDS.find((kind) => kind.toLowerCase() === wanted) ?? SHAPE_WORDS[wanted]

  if (!found) {
    throw new Error(`kind is a shape: ${SHAPE_KINDS.join(', ')} (or rectangle, circle, star, arrow, callout), not “${text(value)}”`)
  }

  return found
}

/** Text alignment from a command, or undefined when it names none. */
export function alignOf(value: unknown): TextAlign | undefined {
  const asked = text(value).toLowerCase()

  if (!asked) {
    return undefined
  }

  const found = ({ left: 'left', center: 'center', centre: 'center', middle: 'center', right: 'right', justify: 'justify', justified: 'justify' } as Record<string, TextAlign>)[asked]

  if (!found) {
    throw new Error(`align is left, center, right or justify, not “${text(value)}”`)
  }

  return found
}

/** A heading level from 1 to 6. */
export function headingLevelOf(value: unknown): number {
  const level = Number(text(value).replace(/^(h|heading\s*)/i, ''))

  if (!Number.isInteger(level) || level < 1 || level > 6) {
    throw new Error(`level is a heading level from 1 to 6, not “${text(value)}”`)
  }

  return level
}

/** Rows of cells from a command: JSON rows, every value as text. */
export function rowsOf(value: unknown): string[][] {
  const parsed = parseJsonArg(value, 'cells')

  if (!Array.isArray(parsed) || !parsed.length || !parsed.every(Array.isArray)) {
    throw new Error('Give the cells as rows: [["Item", "Cost"], ["Rent", "1200"]]')
  }

  return (parsed as unknown[][]).map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))))
}

// A slide's text.

export interface Body {
  /** Lines of text, a tab at the start for each level deeper. */
  lines: string[]
  /** Every top line was numbered ("1. "), so the list is numbered. */
  numbered: boolean
}

const BULLET_MARK = /^[-*•–▪◦]\s+/
const NUMBER_MARK = /^\d{1,3}[.)]\s+/

/** One body from lines of text: list markers read, depth from leading tabs or spaces in steps of the smallest indent. */
function bodyFrom(raw: readonly string[]): Body {
  const lines = raw.flatMap((entry) => entry.split('\n')).map((line) => line.replace(/\s+$/, ''))

  while (lines.length && !lines[0].trim()) {
    lines.shift()
  }

  while (lines.length && !lines[lines.length - 1].trim()) {
    lines.pop()
  }

  const leads = lines.map((line) => /^[ \t]*/.exec(line)?.[0] ?? '')
  const step = Math.min(...leads.map((lead) => lead.replace(/\t/g, '').length).filter((width) => width > 0))
  const parsed = lines.map((line, index) => {
    const lead = leads[index]
    const spaces = lead.replace(/\t/g, '').length

    return { level: lead.length - spaces + (spaces ? Math.round(spaces / step) : 0), rest: line.slice(lead.length) }
  })
  const top = parsed.filter((line) => line.level === 0 && line.rest)
  const numbered = top.length > 0 && top.every((line) => NUMBER_MARK.test(line.rest))

  return { lines: parsed.map(({ level, rest }) => `${'\t'.repeat(Math.min(8, level))}${(numbered ? rest.replace(NUMBER_MARK, '') : rest).replace(BULLET_MARK, '')}`), numbered }
}

/** A JSON list a caller sent (or its text), or null when the value is not one. */
function listIn(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value
  }

  const raw = typeof value === 'string' ? value.trim() : ''

  if (!raw.startsWith('[')) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const linesIn = (entry: unknown): string[] => (Array.isArray(entry) ? entry : [entry]).map((line) => (line === null || line === undefined ? '' : String(line)))

/**
 * A slide's text from what a command gave: text with one line a bullet ("- " and "1. " are read as
 * list markers, and two spaces or a tab go a level deeper), a list of lines, or a list of bodies
 * (lists of lines, or as many texts as the layout has columns), one a column.
 */
export function bodiesOf(value: unknown, columns = 1): Body[] {
  const list = listIn(value)

  if (!list) {
    return [bodyFrom(linesIn(value))]
  }

  if (list.some(Array.isArray) || (columns > 1 && list.length === columns)) {
    return list.map((entry) => bodyFrom(linesIn(entry)))
  }

  return [bodyFrom(linesIn(list))]
}

/** A slide's columns of text, each in its own text placeholder. */
function withBodies(deck: Deck, slideId: string, bodies: readonly Body[]): DeckChange {
  const layout = findSlideIn(deck, slideId).layout
  const room = columnsOf(layout)

  if (bodies.length > room) {
    throw new Error(`A ${LAYOUT_NAMES[layout]} slide has ${room === 1 ? 'one column' : `${room} columns`} of text, not ${bodies.length}: give body as one text, or use layout two-content`)
  }

  return { deck: bodies.reduce((next, body, nth) => model.setBody(next, slideId, body.lines, { nth, ...(body.numbered ? { list: 'number' as const } : {}) }).deck, deck), label: 'Text', focus: { slideId } }
}

/** Several changes as one: each made from the deck the one before left; the editor goes where the last one that says sends it. */
export function composeChanges(deck: Deck, makes: readonly ((deck: Deck) => DeckChange)[], label: string): DeckChange {
  let next = deck
  let focus: DeckChange['focus']

  for (const make of makes) {
    const change = make(next)
    next = change.deck
    focus = change.focus ? { ...focus, ...change.focus } : focus
  }

  return { deck: next, label, ...(focus ? { focus } : {}) }
}

// Steps: what one command or edit does to a deck.

/** A picture read from a file for an addImage step. */
export interface Picture {
  src: string
  natural: { width: number; height: number }
}

export interface StepContext {
  /** The slide in front, where a step that names none lands. */
  front: string | null
  /** Pictures read for addImage steps, by their source as given. */
  pictures?: ReadonlyMap<string, Picture>
}

/** A change made by one command or edit: what it did in a few words, and what Hermes is told back. */
export type Step = DeckChange & { done: string; info?: Record<string, unknown> }

export function addSlideStep(deck: Deck, args: Args, context: StepContext): Step {
  const asked = given(args.layout) ? layoutOf(args.layout) : null
  const bodies = given(args.body) ? bodiesOf(args.body, asked ? columnsOf(asked) : 1) : []
  const layout = asked ?? (bodies.length > 1 ? 'two-content' : 'title-content')
  const after = given(args.after) ? slideIdOf(deck, args.after, context.front) : null
  const added = model.addSlide(deck, { layout, after, ...(given(args.title) ? { title: text(args.title) } : {}) })
  let next = bodies.length ? withBodies(added.deck, added.slideId, bodies).deck : added.deck

  if (given(args.notes)) {
    next = model.setNotes(next, added.slideId, text(args.notes)).deck
  }

  return { deck: next, label: added.label, focus: added.focus, done: `added ${slideLabel(next, added.slideId)}`, info: { slide: slideNumber(next, added.slideId), slideId: added.slideId } }
}

export function setSlideStep(deck: Deck, args: Args, context: StepContext): Step {
  const slideId = slideIdOf(deck, args.slide, context.front)
  const changes: [string, (deck: Deck) => DeckChange][] = []

  if (given(args.layout)) {
    const layout = layoutOf(args.layout)
    changes.push(['layout', (current) => model.setLayout(current, slideId, layout)])
  }

  if (given(args.title)) {
    changes.push(['title', (current) => model.setTitle(current, slideId, text(args.title))])
  }

  if (args.body !== undefined && args.body !== null) {
    changes.push(['text', (current) => withBodies(current, slideId, bodiesOf(args.body, columnsOf(findSlideIn(current, slideId).layout)))])
  }

  if (args.notes !== undefined && args.notes !== null) {
    changes.push(['notes', (current) => model.setNotes(current, slideId, text(args.notes))])
  }

  const hidden = flag(args.hidden)

  if (hidden !== undefined) {
    changes.push([hidden ? 'hidden' : 'shown', (current) => model.setHidden(current, [slideId], hidden)])
  }

  if (given(args.background)) {
    const color = colorArg(args.background, 'background')
    changes.push(['background', (current) => model.setBackground(current, [slideId], color ? { kind: 'solid', color } : null)])
  }

  if (!changes.length) {
    throw new Error('Say what to change on the slide: title, body, notes, layout, hidden or background')
  }

  const labels: string[] = []
  const change = composeChanges(
    deck,
    changes.map(([, make]) => (current: Deck) => {
      const made = make(current)
      labels.push(made.label)

      return made
    }),
    ''
  )
  const what = changes.map(([name]) => name)

  return {
    deck: change.deck,
    label: labels.length === 1 ? labels[0] : 'Slide',
    focus: { slideId },
    done: change.deck === deck ? `${slideLabel(deck, slideId)} already looks that way` : `changed the ${what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}` : what[0]} of ${slideLabel(change.deck, slideId)}`,
    info: { slide: slideNumber(change.deck, slideId) }
  }
}

export function duplicateSlideStep(deck: Deck, args: Args, context: StepContext): Step {
  const slideId = slideIdOf(deck, args.slide, context.front)
  const change = model.duplicateSlides(deck, [slideId])
  const copy = change.focus?.slideId ?? slideId

  return { ...change, done: `duplicated slide ${slideNumber(deck, slideId)} as slide ${slideNumber(change.deck, copy)}`, info: { slide: slideNumber(change.deck, copy), slideId: copy } }
}

export function moveSlideStep(deck: Deck, args: Args, context: StepContext): Step {
  const slideId = slideIdOf(deck, args.slide, context.front)
  const to = positionOf(args.to, deck.slides.length)
  const change = model.moveSlides(deck, [slideId], to - 1)

  return { ...change, done: change.deck === deck ? `slide ${to} is already there` : `moved slide ${slideNumber(deck, slideId)} to ${to}`, info: { slide: to } }
}

export function removeSlideStep(deck: Deck, args: Args, context: StepContext): Step {
  const slideId = slideIdOf(deck, args.slide, context.front)
  const change = model.removeSlides(deck, [slideId])

  return { ...change, done: deck.slides.length === 1 ? 'emptied the only slide' : `removed ${slideLabel(deck, slideId)}`, info: { slides: change.deck.slides.length } }
}

/** A box from a command, in points: what it gives of x, y, width and height. */
function boxIn(args: Args): { x?: number; y?: number; width?: number; height?: number } {
  return { x: numberIn(args, 'x', -5000, 10000), y: numberIn(args, 'y', -5000, 10000), width: numberIn(args, 'width', 4, 10000), height: numberIn(args, 'height', 4, 10000) }
}

function elementStep(change: DeckChange & { elementId: string }, slideId: string, what: string): Step {
  return { ...change, done: `added ${what} to ${slideLabel(change.deck, slideId)}`, info: { slide: slideNumber(change.deck, slideId), element: change.elementId } }
}

export function addTextStep(deck: Deck, args: Args, context: StepContext): Step {
  const words = typeof args.text === 'string' ? args.text : text(args.text)

  if (!words.trim()) {
    throw new Error('Say what the text box says (text)')
  }

  const slideId = slideIdOf(deck, args.slide, context.front)
  const color = given(args.color) ? colorArg(args.color, 'color') : null
  const change = model.addText(deck, slideId, { text: words, ...boxIn(args), size: numberIn(args, 'size', 4, 400), ...(color ? { color } : {}), bold: flag(args.bold), align: alignOf(args.align) })

  return elementStep(change, slideId, 'a text box')
}

export function addShapeStep(deck: Deck, args: Args, context: StepContext): Step {
  const shape = shapeOf(args.kind ?? args.shape)
  const slideId = slideIdOf(deck, args.slide, context.front)
  const fill = given(args.fill) ? colorArg(args.fill, 'fill') : undefined
  const change = model.addShape(deck, slideId, { shape, ...boxIn(args), ...(fill !== undefined ? { fill: fill ? { color: fill } : null } : {}), ...(given(args.text) ? { text: String(args.text) } : {}) })
  const name = SHAPE_NAMES[shape].toLowerCase()

  return elementStep(change, slideId, `${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`)
}

const FITS = ['contain', 'cover', 'stretch', 'slide'] as const

export function addImageStep(deck: Deck, args: Args, context: StepContext): Step {
  const source = text(args.source)
  const picture = context.pictures?.get(source)

  if (!picture) {
    throw new Error(source ? `The picture ${source} was not read` : 'Say which picture (source: a file path)')
  }

  const fit = (text(args.fit).toLowerCase() || 'contain') as (typeof FITS)[number]

  if (!FITS.includes(fit)) {
    throw new Error(`fit is contain, cover, stretch or slide, not “${text(args.fit)}”`)
  }

  const slideId = slideIdOf(deck, args.slide, context.front)
  const asked = fit === 'slide' ? { x: 0, y: 0, width: deck.size.width, height: deck.size.height } : boxIn(args)
  let box = asked
  const ratio = picture.natural.width && picture.natural.height ? picture.natural.width / picture.natural.height : 0

  // Contained in a box both ways, the picture keeps its proportions and sits in the middle of it.
  if (fit === 'contain' && asked.width !== undefined && asked.height !== undefined && ratio) {
    const width = Math.min(asked.width, asked.height * ratio)
    const height = width / ratio
    box = { x: (asked.x ?? (deck.size.width - asked.width) / 2) + (asked.width - width) / 2, y: (asked.y ?? (deck.size.height - asked.height) / 2) + (asked.height - height) / 2, width, height }
  }

  const added = model.addImage(deck, slideId, { src: picture.src, natural: picture.natural, ...box })
  const cut = (fit === 'cover' || fit === 'slide') && box.width !== undefined && box.height !== undefined ? coverCrop(picture.natural, { width: box.width, height: box.height }) : undefined
  const change = cut ? { ...model.updateElements(added.deck, slideId, [added.elementId], (element) => ({ ...element, crop: cut }), added.label), elementId: added.elementId } : added

  return elementStep(change, slideId, 'a picture')
}

/** Where a table goes when the command does not say: in place of the slide's empty text placeholder, or under its title. */
function tablePlace(deck: Deck, slideId: string, args: Args): { x?: number; y?: number; width?: number; replaces?: string } {
  const { x, y, width } = boxIn(args)

  if (x !== undefined || y !== undefined || width !== undefined) {
    return { x, y, width }
  }

  const slide = findSlideIn(deck, slideId)
  const free = slide.elements.find((element) => element.placeholder?.role === 'body' && isEmptyPlaceholder(element))

  if (free) {
    return { x: free.x, y: free.y, width: free.width, replaces: free.id }
  }

  const title = placeholderFor(slide, 'title')
  const wide = deck.size.width * 0.75

  return title ? { x: (deck.size.width - wide) / 2, y: title.y + title.height + 12, width: wide } : {}
}

export function addTableStep(deck: Deck, args: Args, context: StepContext): Step {
  const slideId = slideIdOf(deck, args.slide, context.front)
  const cells = given(args.cells) ? rowsOf(args.cells) : undefined
  const rows = cells ? cells.length : numberIn(args, 'rows', 1, MAX_ROWS)
  const columns = cells ? Math.max(...cells.map((row) => row.length)) : numberIn(args, 'columns', 1, MAX_COLUMNS)

  if (!rows || !columns) {
    throw new Error('Give the table its cells (JSON rows of text), or rows and columns for an empty one')
  }

  if (rows > MAX_ROWS || columns > MAX_COLUMNS) {
    throw new Error(`A table on a slide has at most ${MAX_ROWS} rows and ${MAX_COLUMNS} columns; this one has ${rows} by ${columns}`)
  }

  const place = tablePlace(deck, slideId, args)
  const cleared = place.replaces ? model.removeElements(deck, slideId, [place.replaces]).deck : deck
  const change = model.addTable(cleared, slideId, { rows, columns, cells, x: place.x, y: place.y, width: place.width })

  return elementStep(change, slideId, `a table of ${rows} row${rows === 1 ? '' : 's'} by ${columns} column${columns === 1 ? '' : 's'}`)
}

export function setThemeStep(deck: Deck, args: Args): Step {
  const theme = themeOf(args.theme)
  const change = model.applyTheme(deck, theme)

  return { ...change, done: change.deck === deck ? `it already has the ${theme.name} theme` : `applied the ${theme.name} theme`, info: { theme: theme.id } }
}

export function replaceStep(deck: Deck, args: Args): Step {
  const find = typeof args.find === 'string' ? args.find : text(args.find)

  if (!find) {
    throw new Error('Say what to replace (find)')
  }

  const replacement = typeof args.replacement === 'string' ? args.replacement : given(args.replacement) ? String(args.replacement) : ''
  const result = replaceInDeck(deck, find, replacement, { all: flag(args.all) !== false, caseSensitive: flag(args.caseSensitive) === true })

  return { ...result, done: result.replaced ? `replaced ${result.replaced} match${result.replaced === 1 ? '' : 'es'} of “${find}”` : `“${find}” is not there`, info: { replaced: result.replaced, slides: result.slides } }
}

// Batches.

export const SLIDE_EDIT_OPS = ['addSlide', 'setSlide', 'duplicateSlide', 'moveSlide', 'removeSlide', 'addText', 'addShape', 'addImage', 'addTable', 'setTheme', 'replace'] as const

export type SlideEditOp = (typeof SLIDE_EDIT_OPS)[number]

export type SlideEdit = Args & { op: SlideEditOp }

const STEPS: Record<SlideEditOp, (deck: Deck, args: Args, context: StepContext) => Step> = {
  addSlide: addSlideStep,
  setSlide: setSlideStep,
  duplicateSlide: duplicateSlideStep,
  moveSlide: moveSlideStep,
  removeSlide: removeSlideStep,
  addText: addTextStep,
  addShape: addShapeStep,
  addImage: addImageStep,
  addTable: addTableStep,
  setTheme: setThemeStep,
  replace: replaceStep
}

/** The edits of a batch: a list of objects, each with an `op` and that op's arguments. */
export function slideEditsOf(value: unknown): SlideEdit[] {
  const parsed = parseJsonArg(value, 'edits')

  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error('edits is a list: [{"op": "addSlide", "title": "Plan", "body": "Research\\nBuild"}, {"op": "setTheme", "theme": "midnight"}]')
  }

  if (parsed.length > 100) {
    throw new Error('At most 100 edits in one batch')
  }

  return parsed.map((edit, index) => {
    const op = edit && typeof edit === 'object' ? text((edit as Args).op) : ''
    const found = SLIDE_EDIT_OPS.find((name) => name.toLowerCase() === op.toLowerCase())

    if (!found) {
      throw new Error(`Edit ${index + 1}: op is one of ${SLIDE_EDIT_OPS.join(', ')}, not “${op}”`)
    }

    return { ...(edit as Args), op: found }
  })
}

/**
 * A batch as one change: each edit made from the deck the one before left, so a slide an earlier
 * edit added can be named by its title, and an edit that names no slide lands where the one before
 * it left the editor. An edit that fails stops the batch, and nothing of it lands.
 */
export function runEdits(deck: Deck, edits: readonly SlideEdit[], context: StepContext): Step {
  let front = context.front
  const done: string[] = []
  const change = composeChanges(
    deck,
    edits.map((edit, index) => (current: Deck) => {
      try {
        const step = STEPS[edit.op](current, edit, { ...context, front })
        front = step.focus?.slideId ?? front
        done.push(step.done)

        return step
      } catch (error) {
        throw new Error(`Edit ${index + 1} (${edit.op}): ${messageOf(error)}`)
      }
    }),
    `${edits.length} edit${edits.length === 1 ? '' : 's'}`
  )

  return { ...change, done: done.join('; ') }
}

/** slides.new's `slides`: a list of slides, each with a layout, title, body and notes. */
export function slideSpecsOf(value: unknown): Args[] {
  const parsed = parseJsonArg(value, 'slides')

  if (!Array.isArray(parsed) || !parsed.length || !parsed.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
    throw new Error('slides is a list: [{"layout": "title", "title": "Q3 review", "body": "Finance team"}, {"title": "Agenda", "body": "Results\\nRisks\\nNext steps"}]')
  }

  if (parsed.length > 100) {
    throw new Error('At most 100 slides at once')
  }

  return parsed as Args[]
}

/** A new deck with these slides in place of the empty title slide a new deck has; the first is a title slide unless its layout says otherwise. */
export function newDeckWith(title: string, options: { size?: SlideSize; theme?: Theme; slides?: readonly Args[] } = {}): Deck {
  const deck = model.newDeck(title, { size: options.size, theme: options.theme })

  if (!options.slides?.length) {
    return deck
  }

  const filled = options.slides.reduce((next, spec, index) => {
    try {
      return addSlideStep(next, { ...spec, after: undefined, layout: given(spec.layout) ? spec.layout : index === 0 ? 'title' : undefined }, { front: null }).deck
    } catch (error) {
      throw new Error(`Slide ${index + 1}: ${messageOf(error)}`)
    }
  }, deck)

  return model.removeSlides(filled, [deck.slides[0].id]).deck
}

// Reading.

function sizeLabel(size: SlideSize): string {
  if (size.width === SLIDE_SIZES.wide.width && size.height === SLIDE_SIZES.wide.height) {
    return 'wide (16:9)'
  }

  return size.width === SLIDE_SIZES.standard.width && size.height === SLIDE_SIZES.standard.height ? 'standard (4:3)' : `${Math.round(size.width)} by ${Math.round(size.height)} points`
}

/** A body's text as it reads: a line a paragraph, two spaces deeper for each list level. */
const bodyText = (body: TextBody): string =>
  body.paragraphs
    .map((paragraph) => `${'  '.repeat(paragraph.list ? (paragraph.level ?? 0) : 0)}${paragraph.runs.map((run) => run.text).join('')}`)
    .join('\n')
    .replace(/^\n+|\s+$/g, '')

const textOfElement = (element: SlideElement): string => (element.kind === 'text' || element.kind === 'shape' ? bodyText(element.body) : '')

/** The text placeholders a slide's body is in: its body placeholders, or else its subtitle or caption. */
function bodyElements(slide: Slide): SlideElement[] {
  const bodies = slide.elements.filter((element) => element.placeholder?.role === 'body')

  return bodies.length ? bodies : slide.elements.filter((element) => element.placeholder?.role === 'subtitle' || element.placeholder?.role === 'caption')
}

const READ_ROLES = new Set(['title', 'body', 'subtitle', 'caption'])

function readElement(element: SlideElement) {
  const words = element.kind === 'table' ? shorten(tableText(element).replace(/\t/g, ' | ').replace(/\n/g, ' / '), 240) : element.kind === 'image' ? (element.alt ?? '') : READ_ROLES.has(element.placeholder?.role ?? '') ? '' : shorten(textOfElement(element), 160)

  return {
    id: element.id,
    kind: describeElement(element),
    ...(words ? { text: words } : {}),
    box: [element.x, element.y, element.width, element.height].map(Math.round),
    ...(isEmptyPlaceholder(element) ? { empty: true } : {})
  }
}

function readSlide(slide: Slide, index: number) {
  const title = model.slideTitle(slide)
  const bodies = bodyElements(slide).map(textOfElement)

  return {
    number: index + 1,
    id: slide.id,
    layout: slide.layout,
    ...(title ? { title } : {}),
    ...(bodies[0] ? { body: bodies[0] } : {}),
    ...(bodies[1] ? { body2: bodies[1] } : {}),
    ...(slide.notes.trim() ? { notes: slide.notes.trim() } : {}),
    ...(slide.hidden ? { hidden: true } : {}),
    elements: slide.elements.map(readElement)
  }
}

/** A deck as Hermes reads it: its title, size, theme and transition, and each slide (or only `only`) with its text and elements. */
export function readDeck(deck: Deck, only?: string | null) {
  return {
    title: deck.title,
    size: sizeLabel(deck.size),
    theme: deck.theme.name,
    transition: deck.transition,
    slideCount: deck.slides.length,
    slides: deck.slides.flatMap((slide, index) => (only && slide.id !== only ? [] : [readSlide(slide, index)]))
  }
}

// Find and replace.

const patternFor = (query: string, caseSensitive = false): RegExp => new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi')

/** A line around a match, at most `room` long. */
function around(line: string, at: number, length: number, room = 120): string {
  if (line.length <= room) {
    return line.trim()
  }

  const start = Math.max(0, Math.min(at - Math.floor((room - length) / 2), line.length - room))

  return `${start > 0 ? '…' : ''}${line.slice(start, start + room).trim()}${start + room < line.length ? '…' : ''}`
}

export interface DeckMatch {
  slide: number
  /** Where on the slide: title, text, text box, shape, table, notes… */
  where: string
  element?: string
  text: string
}

/** Where a text is in a deck: titles, text, shapes, table cells and speaker notes, slide by slide. */
export function findInDeck(deck: Deck, query: string, options: { caseSensitive?: boolean } = {}): { count: number; matches: DeckMatch[] } {
  const pattern = patternFor(query, options.caseSensitive)
  const matches: DeckMatch[] = []
  let count = 0
  const look = (slide: number, where: string, element: string | undefined, value: string) => {
    for (const line of value.split('\n')) {
      const found = [...line.matchAll(pattern)]

      if (found.length) {
        count += found.length

        if (matches.length < 100) {
          matches.push({ slide, where, ...(element ? { element } : {}), text: around(line, found[0].index ?? 0, query.length) })
        }
      }
    }
  }

  deck.slides.forEach((slide, index) => {
    for (const element of slide.elements) {
      if (element.kind === 'text' || element.kind === 'shape') {
        look(index + 1, describeElement(element).toLowerCase(), element.id, plainText(element.body))
      } else if (element.kind === 'table') {
        for (const cell of element.cells.flat()) {
          if (!cell.merged) {
            look(index + 1, 'table', element.id, plainText(cell.body))
          }
        }
      }
    }

    look(index + 1, 'notes', undefined, slide.notes)
  })

  return { count, matches }
}

interface Budget {
  left: number
  used: number
}

/** Matches replaced in a paragraph's runs; each replacement takes the style of the run its match starts in. */
function replaceInRuns(runs: TextRun[], pattern: RegExp, replacement: string, budget: Budget): TextRun[] {
  const full = runs.map((run) => run.text).join('')
  const spans: [number, number][] = []

  for (const match of full.matchAll(pattern)) {
    if (budget.left <= 0) {
      break
    }

    if (match[0]) {
      spans.push([match.index ?? 0, (match.index ?? 0) + match[0].length])
      budget.left--
      budget.used++
    }
  }

  if (!spans.length) {
    return runs
  }

  let at = 0

  return tidyRuns(
    runs.map((run) => {
      const start = at
      const end = at + run.text.length
      let cursor = start
      let next = ''
      at = end

      for (const [from, to] of spans) {
        if (to <= start || from >= end) {
          continue
        }

        next += from > cursor ? full.slice(cursor, from) : ''
        next += from >= start ? replacement : ''
        cursor = Math.max(cursor, Math.min(to, end))
      }

      return { ...run, text: next + full.slice(cursor, end) }
    })
  )
}

function replaceInBody(body: TextBody, pattern: RegExp, replacement: string, budget: Budget): TextBody {
  let changed = false
  const paragraphs = body.paragraphs.map((paragraph) => {
    const runs = replaceInRuns(paragraph.runs, pattern, replacement, budget)

    if (runs === paragraph.runs) {
      return paragraph
    }

    changed = true

    return { ...paragraph, runs }
  })

  return changed ? { ...body, paragraphs } : body
}

function replaceInElement(element: SlideElement, pattern: RegExp, replacement: string, budget: Budget): SlideElement {
  if (element.kind === 'text' || element.kind === 'shape') {
    const body = replaceInBody(element.body, pattern, replacement, budget)

    return body === element.body ? element : { ...element, body }
  }

  if (element.kind !== 'table') {
    return element
  }

  let changed = false
  const cells = element.cells.map((row) =>
    row.map((cell) => {
      const body = cell.merged ? cell.body : replaceInBody(cell.body, pattern, replacement, budget)

      if (body === cell.body) {
        return cell
      }

      changed = true

      return { ...cell, body }
    })
  )

  return changed ? { ...element, cells } : element
}

/** A text replaced across a deck (titles, text, shapes, table cells and notes): every match, or only the first. */
export function replaceInDeck(deck: Deck, find: string, replacement: string, options: { all?: boolean; caseSensitive?: boolean } = {}): DeckChange & { replaced: number; slides: number[] } {
  const pattern = patternFor(find, options.caseSensitive)
  const budget: Budget = { left: options.all === false ? 1 : Number.POSITIVE_INFINITY, used: 0 }
  const touched: number[] = []
  const slides = deck.slides.map((slide, index) => {
    const before = budget.used
    const elements = slide.elements.map((element) => replaceInElement(element, pattern, replacement, budget))
    const notes = slide.notes.replace(pattern, (match) => {
      if (budget.left <= 0) {
        return match
      }

      budget.left--
      budget.used++

      return replacement
    })

    if (budget.used === before) {
      return slide
    }

    touched.push(index + 1)

    return { ...slide, elements, notes }
  })

  if (!touched.length) {
    return { deck, label: 'Replace', replaced: 0, slides: [] }
  }

  return { deck: { ...deck, slides }, label: 'Replace', replaced: budget.used, slides: touched, focus: { slideId: slides[touched[0] - 1].id } }
}

// Slides from a document.

/** A slide a document makes: its layout, title, text (a line a bullet, a tab deeper a level), speaker notes and a table. */
export interface SlideSpec {
  layout: LayoutId
  title: string
  body: string[]
  notes: string
  table?: string[][]
}

/** A bullet is at most this long; longer text is shortened and the whole of it goes to the notes. */
const BULLET = 120
/** With notes: true, bullets are kept this short. */
const SHORT_BULLET = 80
const MAX_BULLETS = 8
/** As many rows of 18 point text as fit under a slide's title. */
const MAX_TABLE_ROWS = 12

const LISTS = new Set(['bulletList', 'orderedList', 'taskList'])

/** A block's own words, line breaks as spaces. */
function inlineText(node: DocNode): string {
  if (node.type === 'text') {
    return node.text ?? ''
  }

  return node.type === 'hardBreak' ? ' ' : (node.content ?? []).map(inlineText).join(node.type === 'paragraph' || node.type === 'heading' ? '' : ' ')
}

const firstSentence = (line: string): string => /^.+?[.!?…](?=\s+[\p{Lu}\d“"(]|$)/u.exec(line)?.[0] ?? line

/** A text at most `limit` long: as it is when it fits, else its first sentence when that fits, else cut at a word with an ellipsis. */
export function shortVersion(value: string, limit: number): string {
  const line = flat(value)

  if (line.length <= limit) {
    return line
  }

  const sentence = firstSentence(line)

  if (sentence.length <= limit) {
    return sentence
  }

  const cut = line.slice(0, limit - 1)
  const space = cut.lastIndexOf(' ')

  return `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–-]+$/, '')}…`
}

/** Blocks in reading order, callouts and quotes opened up. */
const blocksOf = (nodes: readonly DocNode[]): DocNode[] => nodes.flatMap((node) => (node.type === 'callout' || node.type === 'blockquote' ? blocksOf(node.content ?? []) : [node]))

/** A list's items as bullets: each item's own words, its nested lists a level deeper. */
function listItems(list: DocNode, depth: number, out: { depth: number; words: string }[] = []): { depth: number; words: string }[] {
  for (const item of list.content ?? []) {
    const own = flat(
      (item.content ?? [])
        .filter((child) => !LISTS.has(child.type))
        .map(inlineText)
        .join(' ')
    )

    if (own) {
      out.push({ depth, words: own })
    }

    for (const child of item.content ?? []) {
      if (LISTS.has(child.type)) {
        listItems(child, own ? depth + 1 : depth, out)
      }
    }
  }

  return out
}

const tableRows = (table: DocNode): string[][] => (table.content ?? []).map((row) => (row.content ?? []).map((cell) => flat(inlineText(cell)))).filter((row) => row.some(Boolean))

/** A slide with more bullets than fit, as several ("Title", "Title (cont.)"), breaking before a top-level bullet where it can. */
function split(spec: SlideSpec): SlideSpec[] {
  const out: SlideSpec[] = []
  let rest = spec.body

  do {
    let cut = rest.length

    if (rest.length > MAX_BULLETS) {
      const at = rest.slice(0, MAX_BULLETS + 1).findLastIndex((line, index) => index > 0 && !line.startsWith('\t'))
      cut = at > 0 ? at : MAX_BULLETS
    }

    out.push({ ...spec, title: out.length ? `${spec.title} (cont.)` : spec.title, body: rest.slice(0, cut), notes: out.length ? '' : spec.notes })
    rest = rest.slice(cut)
  } while (rest.length)

  return out
}

/**
 * The slides a document makes. A title slide from its Title paragraph, or a heading that is the
 * only one of the top level and comes first, or else the document's name; its subtitle from a
 * Subtitle paragraph or a short first paragraph, and what else comes before the first slide in its
 * notes. Each heading of `level` (by default the top level below the title) starts a slide: its
 * list items and short paragraphs are its bullets (nested lists and deeper headings a level
 * deeper), long paragraphs are shortened to a bullet with the whole of them in the notes (with
 * notes: true every paragraph goes to the notes and bullets stay short), a table gets a slide of
 * its own, and more than eight bullets go on to another slide. Headings above the level make
 * section slides; a document without headings makes one slide of its content.
 */
export function slidesFromDocument(doc: DocJSON, options: { name?: string; level?: number; notes?: boolean } = {}): { title: string; slides: SlideSpec[] } {
  const blocks = blocksOf(doc.content ?? [])
  const levelOf = (node: DocNode): number => Math.min(6, Math.max(1, Math.round(Number(node.attrs?.level ?? 1)) || 1))
  const headings = blocks.filter((node) => node.type === 'heading' && flat(inlineText(node)))
  const styled = (style: string) => blocks.find((node) => node.type === 'paragraph' && node.attrs?.docStyle === style && flat(inlineText(node)))
  const titled = styled('title')
  const top = headings.length ? Math.min(...headings.map(levelOf)) : 0
  const lone = !titled && headings[0] && levelOf(headings[0]) === top && headings.filter((node) => levelOf(node) === top).length === 1 && !(options.level && options.level <= top) ? headings[0] : undefined
  const titleNode = titled ?? lone
  const subtitleNode = styled('subtitle')
  const title = (titleNode ? flat(inlineText(titleNode)) : '') || options.name?.trim() || 'Untitled'
  const below = headings.filter((node) => node !== titleNode).map(levelOf)
  const asked = options.level ?? (below.length ? Math.min(...below) : 0)
  const starts = below.some((found) => found <= asked)
  // With no heading to start a slide, the shallowest headings are the top bullets of one slide.
  const level = starts ? asked : below.length ? Math.min(...below) - 1 : 0
  const terse = options.notes === true
  const slides: SlideSpec[] = []
  const sections = new Set<SlideSpec>()
  const leads = new Map<SlideSpec, string[]>()
  const intro: string[] = []
  let subtitle = subtitleNode ? flat(inlineText(subtitleNode)) : ''
  let current: SlideSpec | null = null
  let base = 0

  if (!starts) {
    current = { layout: 'title-content', title, body: [], notes: '' }
    slides.push(current)
  }

  const note = (spec: SlideSpec, words: string) => {
    spec.notes = spec.notes ? `${spec.notes}\n\n${words}` : words
  }

  const bullet = (depth: number, words: string, limit: number) => {
    if (!current) {
      intro.push(`${'  '.repeat(depth)}• ${words}`)

      return
    }

    const short = shortVersion(words, limit)
    current.body.push(`${'\t'.repeat(Math.min(8, depth))}${short}`)

    if (short !== words) {
      note(current, words)
    }
  }

  for (const node of blocks) {
    if (node === titleNode || node === subtitleNode) {
      continue
    }

    if (node.type === 'heading') {
      const words = flat(inlineText(node))
      const depth = levelOf(node) - level

      if (!words) {
        continue
      }

      if (depth <= 0) {
        current = { layout: 'title-content', title: words, body: [], notes: '' }
        slides.push(current)
        base = 0

        if (depth < 0) {
          sections.add(current)
        }
      } else {
        bullet(depth - 1, words, BULLET)
        base = depth
      }
    } else if (node.type === 'paragraph') {
      const words = flat(inlineText(node))

      if (!words) {
        continue
      }

      if (!current) {
        if (!subtitle && !intro.length && words.length <= BULLET) {
          subtitle = words
        } else {
          intro.push(words)
        }
      } else if (terse) {
        note(current, words)
        leads.set(current, [...(leads.get(current) ?? []), shortVersion(firstSentence(words), SHORT_BULLET)])
      } else {
        bullet(base, words, BULLET)
      }
    } else if (LISTS.has(node.type)) {
      for (const item of listItems(node, base)) {
        bullet(item.depth, item.words, terse ? SHORT_BULLET : BULLET)
      }
    } else if (node.type === 'table') {
      const rows = tableRows(node)

      if (rows.length) {
        slides.push({ layout: 'title-only', title: current?.title ?? title, body: [], notes: rows.length > MAX_TABLE_ROWS ? `The table has ${rows.length} rows; the first ${MAX_TABLE_ROWS} are on the slide.` : '', table: rows.slice(0, MAX_TABLE_ROWS) })
      }
    } else if (node.type === 'codeBlock') {
      const code = (node.content ?? []).map(inlineText).join('').trim()

      if (code && current) {
        note(current, code)
      } else if (code) {
        intro.push(code)
      }
    }
  }

  for (const spec of slides) {
    if (!spec.body.length && leads.has(spec)) {
      spec.body = leads.get(spec) ?? []
    }

    if (!spec.table) {
      spec.layout = sections.has(spec) ? (spec.body.length <= 1 ? 'section' : 'title-content') : spec.body.length ? 'title-content' : 'title-only'
    }
  }

  const titleSlide: SlideSpec = { layout: 'title', title, body: subtitle ? [subtitle] : [], notes: intro.join('\n') }
  const content = starts ? slides : slides.filter((spec) => spec.body.length || spec.notes || spec.table)

  return { title, slides: [titleSlide, ...content.flatMap(split)] }
}

/** Slides a document made, added after `after` (at the end without one) as one change; a deck with a title slide of its own gets the document's as a section header. */
export function addSpecs(deck: Deck, specs: readonly SlideSpec[], options: { after?: string | null; asSection?: boolean } = {}): DeckChange & { added: string[] } {
  let next = deck
  let after = options.after ?? deck.slides[deck.slides.length - 1]?.id ?? null
  const added: string[] = []

  for (const spec of specs) {
    const slide = model.addSlide(next, { layout: options.asSection && spec.layout === 'title' ? 'section' : spec.layout, after, ...(spec.title ? { title: spec.title } : {}) })
    next = slide.deck

    if (spec.body.length) {
      next = model.setBody(next, slide.slideId, spec.body).deck
    }

    if (spec.notes) {
      next = model.setNotes(next, slide.slideId, spec.notes).deck
    }

    if (spec.table) {
      next = addTableStep(next, { slide: slide.slideId, cells: spec.table }, { front: null }).deck
    }

    added.push(slide.slideId)
    after = slide.slideId
  }

  return { deck: next, label: 'New Slides', added, ...(added.length ? { focus: { slideId: added[0], selected: [] } } : {}) }
}

/** A new deck of the slides a document made. */
export function deckFromSpecs(title: string, specs: readonly SlideSpec[]): Deck {
  const deck = model.newDeck(title)

  return specs.length ? model.removeSlides(addSpecs(deck, specs).deck, [deck.slides[0].id]).deck : deck
}
