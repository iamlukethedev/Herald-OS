import type { DocJSON } from '../../../../shared/office/document.ts'
import type { WorkbookSnapshot } from '../../../../shared/office/workbook.ts'
import { parseJsonArg } from '../agent-model.ts'
import {
  type Background,
  type Box,
  type Color,
  type Connector,
  type DateFormat,
  type Deck,
  type Fill,
  type GradientStop,
  LAYOUTS,
  type LayoutId,
  SHAPE_KINDS,
  type ShapeKind,
  type Slide,
  type SlideElement,
  type SlideSize,
  SLIDE_SIZES,
  type SlideTransition,
  type TextAlign,
  type TextBody,
  type TextRun,
  type Theme
} from './deck.ts'
import { coverCrop, describeElement } from './elements.ts'
import { headerFooterOf } from './footers.ts'
import type { DocumentOptions } from './from-document.ts'
import { contentArea } from './from-sheet.ts'
import { isEmptyPlaceholder, LAYOUT_NAMES, layoutPlaceholders, placeholderFor } from './layouts.ts'
import * as model from './model.ts'
import type { DeckChange } from './model.ts'
import { SHAPE_GROUPS, SHAPE_NAMES } from './shapes.ts'
import { MAX_COLUMNS, MAX_ROWS, ROW_HEIGHT, tableText } from './tables.ts'
import { isSlot, normalHex, sameTheme, THEMES } from './themes.ts'
import { plainText, tidyRuns } from './text.ts'
import { sameTransition, transitionFor } from './transitions.ts'

/*
 * Herald Slides for Hermes, without a window: the slide, layout, colour and theme a command names;
 * every change as a pure step on the deck, so a batch is its steps one after another and lands as
 * one step to undo; a deck read the way Hermes wants it; find and replace over a deck's text; and
 * the slides a Herald Docs document makes and the tables a Herald Sheets range makes, as the
 * editor's own File and Insert menus make them. Tested directly.
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
export const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : given(value) ? /^(true|yes|on|1)$/i.test(String(value).trim()) : undefined)

/** A number a command gave, within limits, or undefined when it gave none. */
export function numberIn(args: Args, name: string, low: number, high: number): number | undefined {
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

/**
 * The slides a command names: one as `slideIdOf` finds it, several ("2, 4-6", ids or titles,
 * separated by commas) or all; `front`, or else the first slide, when it names none. A title with a
 * comma in it is found whole before the list is split.
 */
export function slideIdsOf(deck: Deck, ref: unknown, front?: string | null): string[] {
  const asked = text(ref)

  if (/^(all|every|all slides|every slide)$/i.test(asked)) {
    return deck.slides.map((slide) => slide.id)
  }

  try {
    return [slideIdOf(deck, asked, front)]
  } catch (error) {
    const parts = asked.split(',').map((part) => part.trim()).filter(Boolean)

    if (parts.length < 2 && !/^\d+\s*[-–]\s*\d+$/.test(asked)) {
      throw error
    }

    const ids = parts.flatMap((part) => {
      const span = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part)

      if (!span) {
        return [slideIdOf(deck, part, front)]
      }

      const [from, to] = [Number(span[1]), Number(span[2])].sort((a, b) => a - b)

      return Array.from({ length: to - from + 1 }, (_, n) => model.slideRef(deck, from + n))
    })

    return [...new Set(ids)]
  }
}

/** A slide's number, 1 for the first. */
export const slideNumber = (deck: Deck, slideId: string): number => deck.slides.findIndex((slide) => slide.id === slideId) + 1

/** "slides 2, 3 and 5" or "slide 4 (“Plan”)", for what a step says it did. */
export function slidesLabel(deck: Deck, ids: readonly string[]): string {
  if (ids.length === 1) {
    return slideLabel(deck, ids[0])
  }

  if (ids.length === deck.slides.length) {
    return 'every slide'
  }

  const numbers = ids.map((id) => slideNumber(deck, id)).sort((a, b) => a - b)

  return `slides ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`
}

/** "slide 3 (“Plan”)", for what a step says it did. */
export function slideLabel(deck: Deck, slideId: string): string {
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

/** The theme colours a read names as a command would. */
const SLOT_NAMES_READ: Partial<Record<Color, string>> = { tx1: 'text', bg1: 'background', tx2: 'text2', bg2: 'background2' }

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

/**
 * A gradient from a command: two or more colours from first to last, separated by commas or "to"
 * ("navy to teal", "#13204a, #2563eb 60%, white"), evenly spaced unless a percentage places one; at
 * `angle` degrees (90, the default, runs top to bottom, 0 left to right), spreading from the middle
 * with `radial`. Null when no gradient is given.
 */
export function gradientArg(args: Args): { stops: GradientStop[]; angle: number; radial?: boolean } | null {
  if (!given(args.gradient)) {
    return null
  }

  const parts = text(args.gradient)
    .split(/\s*,\s*|\s+to\s+/i)
    .filter(Boolean)

  if (parts.length < 2) {
    throw new Error('gradient is two or more colours from first to last: "navy to teal" or "#13204a, #2563eb 60%, white"')
  }

  const stops = parts.map((part, index): GradientStop => {
    const placed = /^(.+?)\s+(\d+(?:\.\d+)?)\s*%$/.exec(part)
    const color = colorArg(placed ? placed[1] : part, 'gradient')

    if (!color) {
      throw new Error('A gradient’s colours are colours, not none')
    }

    return { at: placed ? Math.min(1, Number(placed[2]) / 100) : index / (parts.length - 1), color }
  })
  const angle = numberIn(args, 'angle', -360, 360) ?? 90
  const radial = flag(args.radial) === true

  return { stops: stops.sort((a, b) => a.at - b.at), angle: ((angle % 360) + 360) % 360, ...(radial ? { radial } : {}) }
}

/** A colour as Hermes reads it: a theme colour by the name a command gives it (accent1, text, background), or #rrggbb. */
export const colorName = (color: Color): string => SLOT_NAMES_READ[color] ?? color

/** A built-in theme, or one of the custom themes the person made, by id or name. */
export function themeOf(value: unknown, custom: readonly Theme[] = []): Theme {
  const wanted = text(value)
    .toLowerCase()
    .replace(/\s+theme$/, '')
  const known = [...THEMES, ...custom]
  const found = known.find((theme) => theme.id === wanted) ?? known.find((theme) => theme.name.toLowerCase() === wanted) ?? (wanted === 'default' ? THEMES[0] : undefined)

  if (!found) {
    throw new Error(`theme is one of ${THEMES.map((theme) => theme.id).join(', ')}${custom.length ? ` or a custom theme (${custom.map((theme) => `${theme.name}: ${theme.id}`).join(', ')})` : ''}, not “${text(value)}”`)
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

const squashed = (value: string): string => value.toLowerCase().replace(/[\s_-]/g, '')

/** Shapes by the names the shape gallery gives them ("cylinder", "decision", "u-turn arrow"). */
const SHAPE_BY_NAME: ReadonlyMap<string, ShapeKind> = new Map(SHAPE_KINDS.map((kind) => [squashed(SHAPE_NAMES[kind]), kind]))

/** A shape from its preset name, a word for it (rectangle, circle, star, arrow, callout) or its name in the shape gallery; a rectangle when none is named. */
export function shapeOf(value: unknown): ShapeKind {
  const wanted = squashed(text(value))

  if (!wanted) {
    return 'rect'
  }

  const found = SHAPE_KINDS.find((kind) => kind.toLowerCase() === wanted) ?? SHAPE_WORDS[wanted] ?? SHAPE_BY_NAME.get(wanted)

  if (!found) {
    throw new Error(`kind is a shape, by PowerPoint's preset name: ${SHAPE_GROUPS.map((group) => `${group.name.toLowerCase()}: ${group.kinds.join(', ')}`).join('; ')} (or rectangle, circle, star, arrow, callout); not “${text(value)}”`)
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

/** A workbook a range comes from, read before the change is made: its snapshot as it is now, and its selection when it is open. */
export interface SheetSource {
  name: string
  workbook: WorkbookSnapshot
  /** What is selected in it, open in Herald Sheets: its sheet's name and the range in A1 style. */
  selection: { sheet: string; range: string } | null
}

export interface StepContext {
  /** The slide in front, where a step that names none lands. */
  front: string | null
  /** Pictures read for the steps that put one in, by their source as given. */
  pictures?: ReadonlyMap<string, Picture>
  /** The custom themes the person made, besides Herald's own. */
  themes?: readonly Theme[]
  /** Workbooks read for the steps that take a range, by the workbook as given ('' for the one in front). */
  sheets?: ReadonlyMap<string, SheetSource>
}

/** A change made by one command or edit: what it did in a few words, and what Hermes is told back. */
export type Step = DeckChange & { done: string; info?: Record<string, unknown> }

/** What one command or edit does to a deck. */
export type StepMaker = (deck: Deck, args: Args, context: StepContext) => Step

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
export function boxIn(args: Args): { x?: number; y?: number; width?: number; height?: number } {
  return { x: numberIn(args, 'x', -5000, 10000), y: numberIn(args, 'y', -5000, 10000), width: numberIn(args, 'width', 4, 10000), height: numberIn(args, 'height', 4, 10000) }
}

export function elementStep(change: DeckChange & { elementId: string }, slideId: string, what: string): Step {
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

/** A fill from a command: a gradient, a colour, null for none, or undefined when it names neither. */
export function fillArg(args: Args): Fill | null | undefined {
  const gradient = gradientArg(args)

  if (gradient) {
    return { color: gradient.stops[0].color, gradient }
  }

  const color = given(args.fill) ? colorArg(args.fill, 'fill') : undefined

  return color === undefined ? undefined : color ? { color } : null
}

export function addShapeStep(deck: Deck, args: Args, context: StepContext): Step {
  const shape = shapeOf(args.kind ?? args.shape)
  const slideId = slideIdOf(deck, args.slide, context.front)
  const fill = fillArg(args)
  const change = model.addShape(deck, slideId, { shape, ...boxIn(args), ...(fill !== undefined ? { fill } : {}), ...(given(args.text) ? { text: String(args.text) } : {}) })
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

/** A theme (Herald's own or a custom one) for the whole deck, or as their own for the slides `slide` names. */
export function setThemeStep(deck: Deck, args: Args, context: StepContext = { front: null }): Step {
  const theme = themeOf(args.theme, context.themes)
  const ids = given(args.slide) ? slideIdsOf(deck, args.slide, context.front) : []

  if (ids.length && ids.length < deck.slides.length) {
    const change = model.applyTheme(deck, theme, ids)
    const which = slidesLabel(deck, ids)

    return { ...change, done: change.deck === deck ? `${which} already ${ids.length === 1 ? 'has' : 'have'} the ${theme.name} theme` : `gave ${which} the ${theme.name} theme`, info: { theme: theme.id, slides: ids.map((id) => slideNumber(deck, id)) } }
  }

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

/** One edit of a batch: an op, and that op's arguments. */
export type SlideEdit = Args & { op: string }

export const STEPS: Readonly<Record<SlideEditOp, StepMaker>> = {
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

/** The edits of a batch: a list of objects, each with an `op` (one of `ops`, in any case) and that op's arguments. */
export function slideEditsOf(value: unknown, ops: readonly string[] = SLIDE_EDIT_OPS): SlideEdit[] {
  const parsed = parseJsonArg(value, 'edits')

  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error('edits is a list: [{"op": "addSlide", "title": "Plan", "body": "Research\\nBuild"}, {"op": "setTheme", "theme": "midnight"}]')
  }

  if (parsed.length > 100) {
    throw new Error('At most 100 edits in one batch')
  }

  return parsed.map((edit, index) => {
    const op = edit && typeof edit === 'object' ? text((edit as Args).op) : ''
    const found = ops.find((name) => name.toLowerCase() === op.toLowerCase())

    if (!found) {
      throw new Error(`Edit ${index + 1}: op is one of ${ops.join(', ')}, not “${op}”`)
    }

    return { ...(edit as Args), op: found }
  })
}

/**
 * A batch as one change: each edit made from the deck the one before left, so a slide an earlier
 * edit added can be named by its title, and an edit that names no slide lands where the one before
 * it left the editor. An edit that fails stops the batch, and nothing of it lands.
 */
export function runEdits(deck: Deck, edits: readonly SlideEdit[], context: StepContext, steps: Readonly<Record<string, StepMaker>> = STEPS): Step {
  let front = context.front
  const done: string[] = []
  const change = composeChanges(
    deck,
    edits.map((edit, index) => (current: Deck) => {
      try {
        const make = steps[edit.op]

        if (!make) {
          throw new Error(`there is no op ${edit.op}`)
        }

        const step = make(current, edit, { ...context, front })
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

/** How a connector runs, as a command names it. */
const CONNECTOR_KINDS: Record<string, string> = { straight: 'straight', bent: 'elbow', curved: 'curved' }

/** A connector as Hermes reads it: how it runs, and the elements (and their connection sites) its ends are glued to. */
function readConnector(connector: Connector) {
  const { start, end } = connector

  return {
    kind: CONNECTOR_KINDS[/^[a-z]+/.exec(connector.preset)?.[0] ?? 'straight'] ?? 'straight',
    ...(start ? { from: start.element, fromSite: start.site } : {}),
    ...(end ? { to: end.element, toSite: end.site } : {})
  }
}

/** A background as Hermes reads it: a colour, a gradient's colours and angle, or a picture. */
export function backgroundText(background: Background): string {
  switch (background.kind) {
    case 'solid':
      return colorName(background.color)
    case 'gradient':
      return `gradient ${background.stops.map((stop) => colorName(stop.color)).join(' to ')}${background.radial ? ', radial' : `, ${Math.round(background.angle)}°`}`
    case 'image':
      return 'picture'
  }
}

/** A slide's transition as Hermes reads it: its kind, which way it goes and how long it takes. */
export function transitionText(transition: SlideTransition) {
  return { kind: transition.kind, ...(transition.direction ? { direction: transition.direction } : {}), ...(transition.orientation ? { orientation: transition.orientation } : {}), seconds: transition.duration / 1000 }
}

/** The names a command gives PowerPoint's date formats. */
export const DATE_NAMES: Record<DateFormat, string> = { datetime1: 'numeric', datetime2: 'long', datetime3: 'dmy', datetime4: 'mdy' }

/** The deck's header and footer as Hermes reads them, when its slides show any: the date (its format, or the text in its place), the slide number and the footer's text, and whether title slides go without. */
export function readHeaderFooter(deck: Deck) {
  const settings = headerFooterOf(deck)
  const footer = settings.footer && settings.footerText ? settings.footerText : ''

  if (!settings.date && !settings.number && !footer) {
    return undefined
  }

  return {
    ...(settings.date ? { date: settings.dateText ? { text: settings.dateText } : { format: DATE_NAMES[settings.dateFormat] } } : {}),
    ...(settings.number ? { slideNumber: true } : {}),
    ...(footer ? { footer } : {}),
    ...(settings.skipTitle ? { skipTitle: true } : {})
  }
}

export function readElement(element: SlideElement) {
  const words = element.kind === 'table' ? shorten(tableText(element).replace(/\t/g, ' | ').replace(/\n/g, ' / '), 240) : element.kind === 'image' ? (element.alt ?? '') : READ_ROLES.has(element.placeholder?.role ?? '') ? '' : shorten(textOfElement(element), 160)

  return {
    id: element.id,
    kind: describeElement(element),
    ...(element.kind === 'shape' ? { shape: element.shape } : {}),
    ...(words ? { text: words } : {}),
    box: [element.x, element.y, element.width, element.height].map(Math.round),
    ...(element.rotation ? { rotation: Math.round(element.rotation) } : {}),
    ...(element.group?.length ? { group: element.group[0] } : {}),
    ...(element.kind === 'line' && element.connector ? { connector: readConnector(element.connector) } : {}),
    ...(isEmptyPlaceholder(element) ? { empty: true } : {})
  }
}

function readSlide(deck: Deck, slide: Slide, index: number) {
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
    ...(slide.theme && !sameTheme(slide.theme, deck.theme) ? { theme: slide.theme.name } : {}),
    ...(slide.transition && !sameTransition(slide.transition, transitionFor(deck.transition)) ? { transition: transitionText(slide.transition) } : {}),
    ...(slide.background ? { background: backgroundText(slide.background) } : {}),
    ...(slide.showMaster === false ? { masterGraphics: 'hidden' } : {}),
    elements: slide.elements.map(readElement)
  }
}

/**
 * A deck as Hermes reads it: its title, size, theme and transition, its header and footer, and each
 * slide (or only `only`) with its text and elements, and its own theme, transition and background
 * where it has them, and whether it hides the master's graphics.
 */
export function readDeck(deck: Deck, only?: string | null) {
  const headerFooter = readHeaderFooter(deck)

  return {
    title: deck.title,
    size: sizeLabel(deck.size),
    theme: deck.theme.name,
    transition: deck.transition,
    ...(headerFooter ? { headerFooter } : {}),
    slideCount: deck.slides.length,
    slides: deck.slides.flatMap((slide, index) => (only && slide.id !== only ? [] : [readSlide(deck, slide, index)]))
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

// Slides from a document, and tables from a sheet.

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** fromDocument's options from its arguments: the heading level that starts a slide (1 to 6), and every paragraph in the speaker notes. */
export function documentOptionsOf(args: Args): DocumentOptions {
  return { ...(given(args.level) ? { level: headingLevelOf(args.level) } : {}), ...(flag(args.notes) ? { notes: true } : {}) }
}

/** A document's slides at the end of a deck as one step, as Insert > Slides from Document puts them in. */
export function documentSlidesStep(deck: Deck, doc: DocJSON, source: { name: string; from: string }, options: DocumentOptions = {}): Step {
  const added = model.slidesFromDocument(deck, doc, { after: deck.slides[deck.slides.length - 1]?.id ?? null, ...options })

  if (!added.slideIds.length) {
    throw new Error(`${source.name} has nothing to make slides of`)
  }

  return {
    ...added,
    label: `Slides from ${source.name.replace(/\.[a-z0-9]{1,5}$/i, '')}`,
    done: `added ${plural(added.slideIds.length, 'slide')} from ${source.name} at the end`,
    info: { from: source.from, first: slideNumber(added.deck, added.slideIds[0]), slides: added.slideIds.length }
  }
}

/** The workbook a step names, as read before the change. */
function sheetSourceIn(args: Args, context: StepContext): SheetSource {
  const ref = text(args.workbook)
  const source = context.sheets?.get(ref)

  if (!source) {
    throw new Error(ref ? `The workbook ${ref} was not read` : 'The workbook was not read')
  }

  return source
}

/** The cells a step takes: a range as given (its sheet's name in it, or in `sheet`), the selection of an open workbook, or the cells that hold something on the sheet. */
function rangeIn(args: Args, source: SheetSource): { range?: string; sheet?: string } {
  const range = text(args.range)

  if (range.toLowerCase() === 'selection') {
    if (!source.selection) {
      throw new Error(`Only a workbook open in Herald Sheets has a selection: give a range of ${source.name}, like A1:D12`)
    }

    return { range: source.selection.range, sheet: source.selection.sheet }
  }

  return { ...(range ? { range } : {}), ...(given(args.sheet) ? { sheet: text(args.sheet) } : {}) }
}

/** The box x, y and width give a table from a sheet: across the slide's content area unless they say otherwise, and down to its foot; undefined when none is given. */
function tableBox(deck: Deck, slideId: string, args: Args): Box | undefined {
  const { x, y, width } = boxIn(args)

  if (x === undefined && y === undefined && width === undefined) {
    return undefined
  }

  const area = contentArea(deck, findSlideIn(deck, slideId)).box
  const wide = width ?? area.width
  const top = y ?? area.y

  return { x: x ?? (deck.size.width - wide) / 2, y: top, width: wide, height: Math.max(ROW_HEIGHT, area.y + area.height - top) }
}

/** A range of a workbook on new Title Only slides after `after` (at the end without one), titled with its sheet's name or `title`, going on over more slides when it is long; as Insert > Table from Sheet makes them. */
export function rangeSlidesStep(deck: Deck, args: Args, context: StepContext): Step {
  const source = sheetSourceIn(args, context)
  const after = given(args.after) ? slideIdOf(deck, args.after, context.front) : null
  const header = flag(args.header)
  const change = model.addSlideFromSheet(deck, source.workbook, { ...rangeIn(args, source), ...(given(args.title) ? { title: text(args.title) } : {}), ...(header === undefined ? {} : { header }), after })
  const first = slideNumber(change.deck, change.slideIds[0])
  const count = change.slideIds.length

  return {
    ...change,
    done: `added ${count === 1 ? `slide ${first}` : `slides ${first} to ${first + count - 1}`} with ${change.range} of ${source.name} as a table`,
    info: { slide: first, slides: count, from: { workbook: source.name, sheet: change.sheet, range: change.range } }
  }
}

/**
 * A range of a workbook as a table on a slide, as its cells show, as Insert > Table from Sheet
 * puts one in: in place of the slide's empty text placeholder, else under its title, or in the box
 * x, y and width give; `slide` new puts it on new slides after the slide in front instead.
 */
export function insertRangeStep(deck: Deck, args: Args, context: StepContext): Step {
  if (text(args.slide).toLowerCase() === 'new') {
    return rangeSlidesStep(deck, { ...args, after: context.front ?? undefined }, context)
  }

  const source = sheetSourceIn(args, context)
  const slideId = slideIdOf(deck, args.slide, context.front)
  const box = tableBox(deck, slideId, args)
  const header = flag(args.header)
  const change = model.addTableFromSheet(deck, slideId, source.workbook, { ...rangeIn(args, source), ...(box ? { box } : {}), ...(header === undefined ? {} : { header }) })
  const table = findSlideIn(change.deck, slideId).elements.find((element) => element.id === change.elementId)
  const rows = table?.kind === 'table' ? table.rows.length : 0

  return {
    ...change,
    label: 'Table',
    done: `put ${change.range} of ${source.name} (${plural(rows, 'row')}) on slide ${slideNumber(change.deck, slideId)} as a table`,
    info: { slide: slideNumber(change.deck, slideId), element: change.elementId, from: { workbook: source.name, sheet: change.sheet, range: change.range } }
  }
}
