import type {
  ArrowHead,
  Background,
  Box,
  Color,
  ConnectorEnd,
  ConnectorPreset,
  Deck,
  Fill,
  LayoutId,
  ListKind,
  Master,
  ShapeKind,
  Slide,
  SlideElement,
  SlideSize,
  SlideTransition,
  Stroke,
  TableElement,
  TextAlign,
  Theme,
  Transition
} from './deck.ts'
import { findElement, findSlide, newId, SLIDE_SIZES, withElements, withSlide } from './deck.ts'
import { boundsOf, boundsOfAll, copyElement, coverCrop, DEFAULT_LINE, describeElement, imageElement, keepOnSlide, lineElement, moveElement, type Point, shapeElement, textElement, withBox, withEndsOnSlide } from './elements.ts'
import { regroupCopies, tidyGroups } from './groups.ts'
import { changeLayout, defaultMaster, isEmptyPlaceholder, LAYOUT_NAMES, masterOf, newSlide, placeholderFor } from './layouts.ts'
import { connectionSites, relinkCopies, routeDeck, siteFacing } from './sites.ts'
import { borderCells, type BorderSide, type CellRef, cellUnder, fillCells, insertColumn, insertRow, MAX_COLUMNS, MAX_ROWS, removeColumns, removeRows, ROW_HEIGHT, tableElement, withCell } from './tables.ts'
import { DEFAULT_THEME, findTheme, sameBackground, sameTheme } from './themes.ts'
import { MAX_LEVEL, plainText, textBody } from './text.ts'
import { sameTransition } from './transitions.ts'

export {
  addLogo,
  addMasterElements,
  applyMasterDeck,
  layoutSlideId,
  type LogoCorner,
  type LogoOptions,
  MASTER_SLIDE_ID,
  masterDeck,
  type PlaceholderStyle,
  removeMasterElements,
  renameLayout,
  resetMaster,
  setHeaderFooter,
  setLayoutBackground,
  setMasterBackground,
  setPlaceholderBox,
  setPlaceholderStyle,
  setShowMaster,
  slideLayoutId
} from './masters.ts'
export { convertToShapes, expandToGroups, groupElements, regroupCopies, rotateElements, tidyGroups, ungroupElements, unitOf } from './groups.ts'
export { connectionSites, nearestSite, relinkCopies, routeConnectors, routeDeck, siteFacing } from './sites.ts'
export { gradientFill } from './elements.ts'
export { borderCells, type BorderSide } from './tables.ts'
export { editTheme, findTheme, type ThemePatch } from './themes.ts'
export { transitionFor } from './transitions.ts'
export { deckFromDocument, slidesFromDocument } from './from-document.ts'
export { addSlideFromSheet, addTableFromSheet, formatNumber, sheetRange } from './from-sheet.ts'

/*
 * What can be done to a deck, as pure functions: each takes a deck and gives the next one with the
 * name of the step, so the editor, the menus and Hermes's commands make the same change, the live
 * deck in a window records it as one step to undo, and a deck read from disk takes it the same way.
 * Slides and elements are named by id; nothing here touches the screen or the disk.
 */

export interface DeckChange {
  deck: Deck
  label: string
  /** Where the editor goes afterwards: the slide in front and what is selected. */
  focus?: { slideId?: string; selected?: string[] }
  /** Changes with the same key in quick succession are one step (nudging with the arrow keys). */
  join?: string
}

const unchanged = (deck: Deck, label: string): DeckChange => ({ deck, label })

export function newDeck(title: string, options: { size?: SlideSize; theme?: Theme } = {}): Deck {
  const size = options.size ?? SLIDE_SIZES.wide
  const theme = options.theme ?? DEFAULT_THEME
  // A theme's background is the master's, as applying the theme makes it.
  const master = theme.background ? { master: { ...defaultMaster(size), background: theme.background } } : {}

  return { id: newId('deck'), title, size: { ...size }, theme, transition: 'fade', ...master, slides: [newSlide('title', size)] }
}

function requireSlide(deck: Deck, slideId: string): Slide {
  const slide = findSlide(deck, slideId)

  if (!slide) {
    throw new Error(`There is no slide ${slideId} in this presentation`)
  }

  return slide
}

/** Paragraphs from lines of text: leading tabs or pairs of spaces make deeper list levels. */
function linesToParagraphs(lines: readonly string[], list: ListKind | null | undefined, base: { align?: TextAlign; spaceAfter?: number } = {}) {
  return lines.map((line) => {
    const indent = /^(\t| {2})*/.exec(line)?.[0] ?? ''
    const level = Math.min(MAX_LEVEL, (indent.match(/\t| {2}/g) ?? []).length)
    const text = line.slice(indent.length)

    return { ...base, ...(list ? { list, level } : {}), runs: [{ text }] }
  })
}

/**
 * A slide's text element of a role, made from its layout's placeholder when the slide has none. A
 * slide's text is its body, or else its subtitle (a title or section slide) or caption.
 */
function ensureText(slide: Slide, role: 'title' | 'body', size: SlideSize, nth = 0, master?: Master): { slide: Slide; element: SlideElement } {
  const found = placeholderFor(slide, role, nth) ?? (role === 'body' && nth === 0 ? (placeholderFor(slide, 'subtitle') ?? placeholderFor(slide, 'caption')) : undefined)

  if (found) {
    return { slide, element: found }
  }

  const layout: LayoutId = role === 'title' ? (slide.layout === 'blank' ? 'title-only' : slide.layout) : slide.layout === 'title' || slide.layout === 'blank' || slide.layout === 'title-only' || slide.layout === 'section' ? 'title-content' : slide.layout
  const moved = changeLayout(slide, layout, size, master)
  const element = placeholderFor(moved, role, nth)

  if (!element) {
    throw new Error(`Slide layout ${LAYOUT_NAMES[layout]} has no place for ${role === 'title' ? 'a title' : 'text'}`)
  }

  return { slide: moved, element }
}

/** A new slide after `after` (at the end without one), with its title and text when given. */
export function addSlide(deck: Deck, options: { layout?: LayoutId; after?: string | null; title?: string; body?: string | string[] } = {}): DeckChange & { slideId: string } {
  const slide = newSlide(options.layout ?? 'title-content', deck.size, deck.master)
  const index = options.after ? deck.slides.findIndex((entry) => entry.id === options.after) + 1 : deck.slides.length
  const slides = [...deck.slides]
  slides.splice(index > 0 ? index : slides.length, 0, slide)
  let next: Deck = { ...deck, slides }

  if (options.title !== undefined) {
    next = setTitle(next, slide.id, options.title).deck
  }

  if (options.body !== undefined) {
    next = setBody(next, slide.id, options.body).deck
  }

  return { deck: next, label: 'New Slide', slideId: slide.id, focus: { slideId: slide.id, selected: [] } }
}

export function duplicateSlides(deck: Deck, ids: readonly string[]): DeckChange {
  const wanted = new Set(ids)
  const copies: string[] = []
  const slides = deck.slides.flatMap((slide) => {
    if (!wanted.has(slide.id)) {
      return [slide]
    }

    const ids = new Map<string, string>()
    const elements = slide.elements.map((element) => {
      const copy = copyElement(element)
      ids.set(element.id, copy.id)

      return copy
    })
    const copy: Slide = { ...slide, id: newId('slide'), elements: relinkCopies(elements, ids) }
    copies.push(copy.id)

    return [slide, copy]
  })

  return copies.length ? { deck: { ...deck, slides }, label: copies.length > 1 ? 'Duplicate Slides' : 'Duplicate Slide', focus: { slideId: copies[0], selected: [] } } : unchanged(deck, 'Duplicate Slide')
}

/** The deck without some slides; at least one stays (the last one left is emptied instead). */
export function removeSlides(deck: Deck, ids: readonly string[]): DeckChange {
  const wanted = new Set(ids)
  const first = deck.slides.findIndex((slide) => wanted.has(slide.id))
  let slides = deck.slides.filter((slide) => !wanted.has(slide.id))

  if (first < 0) {
    return unchanged(deck, 'Delete Slide')
  }

  if (!slides.length) {
    slides = [newSlide('blank', deck.size, deck.master)]
  }

  const focus = slides[Math.min(first, slides.length - 1)].id

  return { deck: { ...deck, slides }, label: ids.length > 1 ? 'Delete Slides' : 'Delete Slide', focus: { slideId: focus, selected: [] } }
}

/** Slides moved together (in their order) to sit before the slide now at `toIndex`, counted without them. */
export function moveSlides(deck: Deck, ids: readonly string[], toIndex: number): DeckChange {
  const wanted = new Set(ids)
  const moving = deck.slides.filter((slide) => wanted.has(slide.id))
  const rest = deck.slides.filter((slide) => !wanted.has(slide.id))
  const at = Math.max(0, Math.min(rest.length, Math.round(toIndex)))
  const slides = [...rest.slice(0, at), ...moving, ...rest.slice(at)]

  if (!moving.length || slides.every((slide, index) => slide === deck.slides[index])) {
    return unchanged(deck, 'Move Slide')
  }

  return { deck: { ...deck, slides }, label: moving.length > 1 ? 'Move Slides' : 'Move Slide', focus: { slideId: moving[0].id } }
}

export function setHidden(deck: Deck, ids: readonly string[], hidden: boolean): DeckChange {
  const wanted = new Set(ids)

  return { deck: { ...deck, slides: deck.slides.map((slide) => (wanted.has(slide.id) && slide.hidden !== hidden ? { ...slide, hidden } : slide)) }, label: hidden ? 'Hide Slide' : 'Show Slide' }
}

export function setLayout(deck: Deck, slideId: string, layout: LayoutId): DeckChange {
  requireSlide(deck, slideId)

  return { deck: routeDeck(withSlide(deck, slideId, (slide) => changeLayout(slide, layout, deck.size, deck.master)), deck), label: 'Layout', focus: { selected: [] } }
}

/** A background for some slides, or all of them; null goes back to the theme's. */
export function setBackground(deck: Deck, ids: readonly string[] | 'all', background: Background | null): DeckChange {
  const wanted = ids === 'all' ? null : new Set(ids)

  return { deck: { ...deck, slides: deck.slides.map((slide) => (!wanted || wanted.has(slide.id) ? { ...slide, background } : slide)) }, label: 'Background' }
}

export function setNotes(deck: Deck, slideId: string, notes: string): DeckChange {
  const slide = requireSlide(deck, slideId)

  return slide.notes === notes ? unchanged(deck, 'Speaker Notes') : { deck: withSlide(deck, slideId, (entry) => ({ ...entry, notes })), label: 'Speaker Notes' }
}

/** The slide's title, in its title placeholder (the slide gets one from its layout if it has none). */
export function setTitle(deck: Deck, slideId: string, text: string): DeckChange {
  const { slide, element } = ensureText(requireSlide(deck, slideId), 'title', deck.size, 0, deck.master)

  if (element.kind !== 'text' && element.kind !== 'shape') {
    throw new Error('The title is not text')
  }

  const lines = text.split('\n')
  const first = element.body.paragraphs[0]
  const body = { ...element.body, paragraphs: lines.map((line) => ({ ...first, runs: [{ text: line }] })) }
  const next = { ...slide, elements: slide.elements.map((entry) => (entry.id === element.id ? { ...element, body } : entry)) }

  return { deck: withSlide(deck, slideId, () => next), label: 'Title', focus: { slideId, selected: [element.id] } }
}

/**
 * The slide's text, a paragraph a line, in its `nth` text placeholder. Body placeholders keep their
 * bullets unless `list` says otherwise (null for none).
 */
export function setBody(deck: Deck, slideId: string, text: string | readonly string[], options: { list?: ListKind | null; nth?: number } = {}): DeckChange {
  const { slide, element } = ensureText(requireSlide(deck, slideId), 'body', deck.size, options.nth ?? 0, deck.master)

  if (element.kind !== 'text' && element.kind !== 'shape') {
    throw new Error('That is not text')
  }

  const first = element.body.paragraphs[0]
  const list = options.list === undefined ? first?.list : options.list
  const lines = typeof text === 'string' ? text.split('\n') : [...text]
  const paragraphs = linesToParagraphs(lines.length ? lines : [''], list, { align: first?.align, spaceAfter: first?.spaceAfter })
  const body = { ...element.body, paragraphs }
  const next = { ...slide, elements: slide.elements.map((entry) => (entry.id === element.id ? { ...element, body } : entry)) }

  return { deck: withSlide(deck, slideId, () => next), label: 'Text', focus: { slideId, selected: [element.id] } }
}

/** A slide with a theme of its own, or without one (null); a background that came with its old theme goes with it, and its new theme's comes in its place. */
function withSlideTheme(slide: Slide, theme: Theme | null): Slide {
  const old = slide.theme
  const stays = old && theme ? sameTheme(old, theme) : old === undefined && theme === null

  if (stays) {
    return slide
  }

  let background = slide.background && old?.background && sameBackground(slide.background, old.background) ? null : slide.background

  if (theme?.background && !background) {
    background = theme.background
  }

  const next: Slide = { ...slide, background }

  if (theme) {
    next.theme = theme
  } else {
    delete next.theme
  }

  return next
}

/**
 * A theme (a built-in or custom one by id, or a theme): everything naming a slot or a theme font
 * takes the new one. For the whole deck (`all`, as when not said) slides' own themes go, and the
 * master's background goes with the theme: a theme's background becomes the master's where the
 * master had none or had the old theme's. For some slides, they get it as a theme of their own
 * (none when it is the deck's).
 */
export function applyTheme(deck: Deck, theme: Theme | string, slides: readonly string[] | 'all' = 'all'): DeckChange {
  const next = typeof theme === 'string' ? findTheme(theme) : theme

  if (!next) {
    throw new Error(`There is no theme called ${String(theme)}`)
  }

  if (slides !== 'all') {
    const wanted = new Set(slides)
    const own = sameTheme(next, deck.theme) ? null : next
    const changed = deck.slides.map((slide) => (wanted.has(slide.id) ? withSlideTheme(slide, own) : slide))

    return changed.every((slide, index) => slide === deck.slides[index]) ? unchanged(deck, 'Theme') : { deck: { ...deck, slides: changed }, label: 'Theme' }
  }

  const master = masterOf(deck)
  const had = master.background
  const background = next.background ? (!had || sameBackground(had, deck.theme.background) ? next.background : had) : had && sameBackground(had, deck.theme.background) ? null : had
  const own = deck.slides.map((slide) => (slide.theme ? withSlideTheme(slide, null) : slide))
  const slidesChanged = own.some((slide, index) => slide !== deck.slides[index])

  if (next === deck.theme && background === had && !slidesChanged) {
    return unchanged(deck, 'Theme')
  }

  return { deck: { ...deck, theme: next, ...(background !== had ? { master: { ...master, background } } : {}), slides: slidesChanged ? own : deck.slides }, label: 'Theme' }
}

/** A new slide size: everything is moved and widened in proportion across, and kept as tall. */
export function setSize(deck: Deck, size: SlideSize): DeckChange {
  if (size.width === deck.size.width && size.height === deck.size.height) {
    return unchanged(deck, 'Slide Size')
  }

  const sx = size.width / deck.size.width
  const sy = size.height / deck.size.height
  const scale = (element: SlideElement): SlideElement => withBox(element, { x: element.x * sx, y: element.y * sy, width: element.width * sx, height: element.height * sy })
  const master = deck.master && { ...deck.master, elements: deck.master.elements.map(scale), layouts: deck.master.layouts.map((layout) => ({ ...layout, elements: layout.elements.map(scale) })) }

  const next = { ...deck, size: { ...size }, ...(master ? { master } : {}), slides: deck.slides.map((slide) => ({ ...slide, elements: slide.elements.map(scale) })) }

  return { deck: routeDeck(next, deck), label: 'Slide Size' }
}

/** The deck's transition kind, for every slide: slides' own transitions go. */
export const setTransition = (deck: Deck, transition: Transition): DeckChange => ({
  deck: { ...deck, transition, slides: deck.slides.some((slide) => slide.transition) ? deck.slides.map((slide) => withTransition(slide, null)) : deck.slides },
  label: 'Transition'
})

function withTransition(slide: Slide, transition: SlideTransition | null): Slide {
  if (sameTransition(slide.transition, transition ?? undefined)) {
    return slide
  }

  const next = { ...slide }

  if (transition) {
    next.transition = transition
  } else {
    delete next.transition
  }

  return next
}

/** A transition of their own for some slides, or all of them; null gives them the deck's again. */
export function setSlideTransition(deck: Deck, ids: readonly string[] | 'all', transition: SlideTransition | null): DeckChange {
  const wanted = ids === 'all' ? null : new Set(ids)
  const slides = deck.slides.map((slide) => (!wanted || wanted.has(slide.id) ? withTransition(slide, transition) : slide))

  return slides.every((slide, index) => slide === deck.slides[index]) ? unchanged(deck, 'Transition') : { deck: { ...deck, slides }, label: 'Transition' }
}

/** A transition for every slide, its kind the deck's too (PowerPoint's Apply To All). */
export function applyTransitionToAll(deck: Deck, transition: SlideTransition): DeckChange {
  const slides = deck.slides.map((slide) => withTransition(slide, transition))

  return deck.transition === transition.kind && slides.every((slide, index) => slide === deck.slides[index]) ? unchanged(deck, 'Transition') : { deck: { ...deck, transition: transition.kind, slides }, label: 'Transition' }
}

/** Elements added on top of a slide, kept at least partly on it. */
export function insertElements(deck: Deck, slideId: string, elements: readonly SlideElement[], label: string): DeckChange {
  requireSlide(deck, slideId)
  const placed = elements.map((element) => keepOnSlide(element, deck.size))
  const next = withSlide(deck, slideId, (slide) => ({ ...slide, elements: [...slide.elements, ...placed] }))

  return { deck: routeDeck(next, deck), label, focus: { slideId, selected: placed.map((element) => element.id) } }
}

const middle = (deck: Deck, width: number, height: number): Box => ({ x: (deck.size.width - width) / 2, y: (deck.size.height - height) / 2, width, height })

export interface TextOptions {
  text: string
  x?: number
  y?: number
  width?: number
  height?: number
  size?: number
  color?: Color
  font?: string
  bold?: boolean
  italic?: boolean
  align?: TextAlign
  list?: ListKind | null
}

export function addText(deck: Deck, slideId: string, options: TextOptions): DeckChange & { elementId: string } {
  const size = options.size ?? 24
  const width = options.width ?? Math.min(deck.size.width - 80, 480)
  const lines = options.text.split('\n')
  const height = options.height ?? Math.max(size * 1.2 * lines.length + 8, 24)
  const box = { ...middle(deck, width, height), ...(options.x !== undefined ? { x: options.x } : {}), ...(options.y !== undefined ? { y: options.y } : {}) }
  const body = textBody({ font: options.font ?? '+body', size, color: options.color ?? 'tx1', ...(options.bold ? { bold: true } : {}), ...(options.italic ? { italic: true } : {}) }, { fit: 'grow' })
  const element = textElement(box, { ...body, paragraphs: linesToParagraphs(lines, options.list, { align: options.align ?? 'left' }) })
  const change = insertElements(deck, slideId, [element], 'New Text Box')

  return { ...change, elementId: element.id }
}

export interface ShapeOptions {
  shape: ShapeKind
  x?: number
  y?: number
  width?: number
  height?: number
  fill?: Fill | null
  stroke?: Stroke | null
  text?: string
}

export function addShape(deck: Deck, slideId: string, options: ShapeOptions): DeckChange & { elementId: string } {
  const box = { ...middle(deck, options.width ?? 240, options.height ?? 160), ...(options.x !== undefined ? { x: options.x } : {}), ...(options.y !== undefined ? { y: options.y } : {}) }
  const element = shapeElement(options.shape, box, { ...(options.fill !== undefined ? { fill: options.fill } : {}), ...(options.stroke !== undefined ? { stroke: options.stroke } : {}) })
  const withText = options.text ? { ...element, body: { ...element.body, paragraphs: linesToParagraphs(options.text.split('\n'), null, { align: 'center' }) } } : element
  const change = insertElements(deck, slideId, [withText], 'New Shape')

  return { ...change, elementId: element.id }
}

export interface ImageOptions {
  src: string
  natural: { width: number; height: number }
  x?: number
  y?: number
  width?: number
  height?: number
  alt?: string
}

/**
 * A picture on a slide: into the slide's empty picture placeholder (cut to fill it) when no place
 * is asked for, otherwise where asked, at its own proportions within the slide when no size is.
 */
export function addImage(deck: Deck, slideId: string, options: ImageOptions): DeckChange & { elementId: string } {
  const slide = requireSlide(deck, slideId)
  const free = options.x === undefined && options.y === undefined && options.width === undefined ? slide.elements.find((element) => element.placeholder?.role === 'picture' && isEmptyPlaceholder(element)) : undefined

  if (free) {
    const filled = { ...free, src: options.src, natural: options.natural, crop: coverCrop(options.natural, free), ...(options.alt ? { alt: options.alt } : {}) } as SlideElement

    return { deck: withSlide(deck, slideId, (entry) => ({ ...entry, elements: entry.elements.map((element) => (element.id === free.id ? filled : element)) })), label: 'Picture', elementId: free.id, focus: { slideId, selected: [free.id] } }
  }

  const ratio = options.natural.width && options.natural.height ? options.natural.width / options.natural.height : 4 / 3
  const most = { width: deck.size.width * 0.6, height: deck.size.height * 0.6 }
  let width = options.width ?? (options.height ? options.height * ratio : Math.min(most.width, most.height * ratio, options.natural.width || most.width))
  let height = options.height ?? width / ratio

  if (!options.width && !options.height && height > most.height) {
    height = most.height
    width = height * ratio
  }

  const box = { ...middle(deck, width, height), ...(options.x !== undefined ? { x: options.x } : {}), ...(options.y !== undefined ? { y: options.y } : {}) }
  const element = imageElement(options.src, options.natural, box, options.alt ? { alt: options.alt } : {})
  const change = insertElements(deck, slideId, [element], 'New Picture')

  return { ...change, elementId: element.id }
}

export function addLine(deck: Deck, slideId: string, options: { from: Point; to: Point; stroke?: Stroke; start?: ArrowHead; end?: ArrowHead }): DeckChange & { elementId: string } {
  const element = lineElement(options.from, options.to, { stroke: options.stroke ?? DEFAULT_LINE, start: options.start ?? 'none', end: options.end ?? 'none' })
  const change = insertElements(deck, slideId, [element], 'New Line')

  return { ...change, elementId: element.id }
}

export interface ConnectorOptions {
  /** An end glued to an element's connection site (`connectionSites` numbers them), or a point on the slide. */
  from: ConnectorEnd | Point
  to: ConnectorEnd | Point
  preset?: ConnectorPreset
  stroke?: Stroke
  start?: ArrowHead
  end?: ArrowHead
}

/**
 * A connector between two elements' connection sites (or points), straight unless a preset says
 * otherwise; glued ends follow their elements as they move. A bent or curved one leaves its first
 * glued end the way that site faces.
 */
export function addConnector(deck: Deck, slideId: string, options: ConnectorOptions): DeckChange & { elementId: string } {
  const slide = requireSlide(deck, slideId)
  const place = (end: ConnectorEnd | Point): { point: Point; glued?: ConnectorEnd; facing?: number } => {
    if (Array.isArray(end)) {
      return { point: [end[0], end[1]] }
    }

    const element = findElement(slide, end.element)

    if (!element) {
      throw new Error(`There is no element ${end.element} on that slide`)
    }

    const sites = connectionSites(element)
    const point = sites[end.site]

    if (!point) {
      throw new Error(sites.length ? `${describeElement(element)} has connection sites 0 to ${sites.length - 1}` : `${describeElement(element)} has no connection sites`)
    }

    return { point, glued: { element: element.id, site: end.site }, facing: siteFacing(element, end.site) }
  }
  const from = place(options.from)
  const to = place(options.to)
  const preset = options.preset ?? 'straightConnector1'
  const facing = from.facing ?? to.facing
  const line = lineElement(from.point, to.point, {
    stroke: options.stroke ?? DEFAULT_LINE,
    start: options.start ?? 'none',
    end: options.end ?? 'none',
    connector: { preset, ...(from.glued ? { start: from.glued } : {}), ...(to.glued ? { end: to.glued } : {}) }
  })
  // DrawingML's bent and curved connectors leave their start across their box, so one that leaves upwards or downwards is turned a quarter.
  const upright = preset !== 'straightConnector1' && facing !== undefined && Math.abs(Math.sin((facing * Math.PI) / 180)) > Math.SQRT1_2
  const element = upright ? withEndsOnSlide({ ...line, rotation: 90 }, from.point, to.point) : line
  const change = insertElements(deck, slideId, [element], 'New Connector')

  return { ...change, elementId: element.id }
}

export interface TableOptions {
  rows: number
  columns: number
  x?: number
  y?: number
  width?: number
  height?: number
  /** Text for the cells, row by row. */
  cells?: readonly (readonly string[])[]
}

/** A table in PowerPoint's default style, three quarters of the slide wide with rows for 18 point text, in the middle unless placed. */
export function addTable(deck: Deck, slideId: string, options: TableOptions): DeckChange & { elementId: string } {
  const rows = Math.max(1, Math.min(MAX_ROWS, Math.round(options.rows) || 1))
  const columns = Math.max(1, Math.min(MAX_COLUMNS, Math.round(options.columns) || 1))
  const box = { ...middle(deck, options.width ?? deck.size.width * 0.75, options.height ?? rows * ROW_HEIGHT), ...(options.x !== undefined ? { x: options.x } : {}), ...(options.y !== undefined ? { y: options.y } : {}) }
  const element = tableElement(box, rows, columns, options.cells)
  const change = insertElements(deck, slideId, [element], 'New Table')

  return { ...change, elementId: element.id }
}

/** A table of a slide, or an error saying it is not there. */
export function requireTable(deck: Deck, slideId: string, tableId: string): TableElement {
  const element = requireElement(deck, slideId, tableId)

  if (element.kind !== 'table') {
    throw new Error(`Element ${tableId} is not a table`)
  }

  return element
}

/** A table changed as one step; a table left with no rows or columns goes. */
function changeTable(deck: Deck, slideId: string, tableId: string, label: string, change: (table: TableElement) => TableElement | null): DeckChange {
  const table = requireTable(deck, slideId, tableId)
  const next = change(table)

  if (next === table) {
    return unchanged(deck, label)
  }

  if (!next) {
    return { ...removeElements(deck, slideId, [tableId]), label: 'Delete Table' }
  }

  return { deck: routeDeck(withElements(deck, slideId, new Set([tableId]), () => next), deck), label, focus: { slideId, selected: [tableId] } }
}

/** A cell's text (rows and columns count from 0), a paragraph a line with the cell's first paragraph's settings; a covered cell's goes to the merged cell over it. */
export function setCellText(deck: Deck, slideId: string, tableId: string, row: number, column: number, text: string): DeckChange {
  return changeTable(deck, slideId, tableId, 'Cell Text', (table) => {
    if (!table.cells[row]?.[column]) {
      throw new Error(`There is no cell at row ${row + 1}, column ${column + 1}; the table has ${table.rows.length} rows and ${table.columns.length} columns`)
    }

    return withCell(table, cellUnder(table, { row, column }), (cell) => {
      const first = cell.body.paragraphs[0]

      return { ...cell, body: { ...cell.body, paragraphs: text.split('\n').map((line) => ({ ...first, runs: [{ ...first?.runs[0], text: line }] })) } }
    })
  })
}

export const insertTableRow = (deck: Deck, slideId: string, tableId: string, row: number, where: 'above' | 'below' = 'below'): DeckChange => changeTable(deck, slideId, tableId, 'Insert Row', (table) => insertRow(table, row, where))

export const insertTableColumn = (deck: Deck, slideId: string, tableId: string, column: number, where: 'left' | 'right' = 'right'): DeckChange =>
  changeTable(deck, slideId, tableId, 'Insert Column', (table) => insertColumn(table, column, where))

export const removeTableRows = (deck: Deck, slideId: string, tableId: string, rows: readonly number[]): DeckChange => changeTable(deck, slideId, tableId, rows.length > 1 ? 'Delete Rows' : 'Delete Row', (table) => removeRows(table, rows))

export const removeTableColumns = (deck: Deck, slideId: string, tableId: string, columns: readonly number[]): DeckChange =>
  changeTable(deck, slideId, tableId, columns.length > 1 ? 'Delete Columns' : 'Delete Column', (table) => removeColumns(table, columns))

/** A fill for some cells of a table, or all of them; null for none. */
export const setCellFill = (deck: Deck, slideId: string, tableId: string, cells: readonly CellRef[] | 'all', fill: Fill | null): DeckChange => changeTable(deck, slideId, tableId, 'Cell Fill', (table) => fillCells(table, cells, fill))

/** A line (null for none) on some sides of some cells of a table, or all of them: a side of the cells together, their outside, the lines between them, or all. */
export const setCellBorders = (deck: Deck, slideId: string, tableId: string, cells: readonly CellRef[] | 'all', sides: readonly BorderSide[], stroke: Stroke | null): DeckChange =>
  changeTable(deck, slideId, tableId, 'Cell Borders', (table) => borderCells(table, cells, sides, stroke))

/** Some elements changed alike, as one step called `label`; connectors glued to them follow. */
export function updateElements(deck: Deck, slideId: string, ids: readonly string[], change: (element: SlideElement) => SlideElement, label: string): DeckChange {
  requireSlide(deck, slideId)

  return { deck: routeDeck(withElements(deck, slideId, new Set(ids), change), deck), label, focus: { slideId, selected: [...ids] } }
}

/** Elements taken off a slide: their groups go when one member is left, and connectors glued to them come loose where they are. */
export function removeElements(deck: Deck, slideId: string, ids: readonly string[]): DeckChange {
  const wanted = new Set(ids)
  const next = withSlide(deck, slideId, (slide) => {
    const left = slide.elements.filter((element) => !wanted.has(element.id))
    const broken = new Set(slide.elements.flatMap((element) => (wanted.has(element.id) ? (element.group ?? []) : [])))

    return { ...slide, elements: broken.size ? tidyGroups(left, broken) : left }
  })

  return { deck: routeDeck(next, deck), label: 'Delete', focus: { slideId, selected: [] } }
}

/** Copies of elements (as they were), shifted by `offset` points, on top of the slide: groups among them under new ids, connectors glued to the copies of what they were glued to. */
export function pasteElements(deck: Deck, slideId: string, elements: readonly SlideElement[], offset = 0, label = 'Paste'): DeckChange {
  const ids = new Map<string, string>()
  const copies = elements.map((element) => {
    const copy = copyElement(offset ? moveElement(element, offset, offset) : element)
    // A pasted placeholder is an ordinary element: the slide's own placeholder stays the one.
    delete copy.placeholder
    ids.set(element.id, copy.id)

    return copy
  })

  return insertElements(deck, slideId, relinkCopies(regroupCopies(copies), ids), label)
}

export function duplicateElements(deck: Deck, slideId: string, ids: readonly string[], offset = 12): DeckChange {
  const slide = requireSlide(deck, slideId)
  const chosen = slide.elements.filter((element) => ids.includes(element.id))

  return chosen.length ? pasteElements(deck, slideId, chosen, offset, 'Duplicate') : unchanged(deck, 'Duplicate')
}

export type Arrangement = 'front' | 'back' | 'forward' | 'backward'

export const ARRANGE_LABELS: Record<Arrangement, string> = { front: 'Bring to Front', back: 'Send to Back', forward: 'Bring Forward', backward: 'Send Backward' }

/** Elements moved up or down the slide's stack, keeping their order among themselves. */
export function arrange(deck: Deck, slideId: string, ids: readonly string[], how: Arrangement): DeckChange {
  const wanted = new Set(ids)
  const slide = requireSlide(deck, slideId)
  let elements = [...slide.elements]

  if (how === 'front' || how === 'back') {
    const moving = elements.filter((element) => wanted.has(element.id))
    const rest = elements.filter((element) => !wanted.has(element.id))
    elements = how === 'front' ? [...rest, ...moving] : [...moving, ...rest]
  } else if (how === 'forward') {
    for (let i = elements.length - 2; i >= 0; i--) {
      if (wanted.has(elements[i].id) && !wanted.has(elements[i + 1].id)) {
        ;[elements[i], elements[i + 1]] = [elements[i + 1], elements[i]]
      }
    }
  } else {
    for (let i = 1; i < elements.length; i++) {
      if (wanted.has(elements[i].id) && !wanted.has(elements[i - 1].id)) {
        ;[elements[i], elements[i - 1]] = [elements[i - 1], elements[i]]
      }
    }
  }

  return { deck: withSlide(deck, slideId, (entry) => ({ ...entry, elements })), label: ARRANGE_LABELS[how], focus: { slideId, selected: [...ids] } }
}

export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'

export const ALIGN_LABELS: Record<AlignEdge, string> = { left: 'Align Left', center: 'Align Centre', right: 'Align Right', top: 'Align Top', middle: 'Align Middle', bottom: 'Align Bottom' }

/** Elements lined up by an edge or centre: with each other, or with the slide when there is one (or `toSlide`). */
export function align(deck: Deck, slideId: string, ids: readonly string[], edge: AlignEdge, toSlide = false): DeckChange {
  const slide = requireSlide(deck, slideId)
  const chosen = slide.elements.filter((element) => ids.includes(element.id))
  const frame = toSlide || chosen.length === 1 ? { x: 0, y: 0, width: deck.size.width, height: deck.size.height } : boundsOfAll(chosen)

  if (!frame) {
    return unchanged(deck, ALIGN_LABELS[edge])
  }

  const target = { left: frame.x, center: frame.x + frame.width / 2, right: frame.x + frame.width, top: frame.y, middle: frame.y + frame.height / 2, bottom: frame.y + frame.height }[edge]
  const change = (element: SlideElement): SlideElement => {
    const box = boundsOf(element)
    const at = { left: box.x, center: box.x + box.width / 2, right: box.x + box.width, top: box.y, middle: box.y + box.height / 2, bottom: box.y + box.height }[edge]
    const horizontal = edge === 'left' || edge === 'center' || edge === 'right'

    return moveElement(element, horizontal ? target - at : 0, horizontal ? 0 : target - at)
  }

  return { deck: routeDeck(withElements(deck, slideId, new Set(ids), change), deck), label: ALIGN_LABELS[edge], focus: { slideId, selected: [...ids] } }
}

/** Three or more elements spread so the gaps between them are equal, across or down. */
export function distribute(deck: Deck, slideId: string, ids: readonly string[], axis: 'horizontal' | 'vertical'): DeckChange {
  const slide = requireSlide(deck, slideId)
  const label = axis === 'horizontal' ? 'Distribute Horizontally' : 'Distribute Vertically'
  const chosen = slide.elements.filter((element) => ids.includes(element.id))

  if (chosen.length < 3) {
    return unchanged(deck, label)
  }

  const across = axis === 'horizontal'
  const start = (box: Box) => (across ? box.x : box.y)
  const length = (box: Box) => (across ? box.width : box.height)
  const ordered = [...chosen].sort((a, b) => start(boundsOf(a)) + length(boundsOf(a)) / 2 - (start(boundsOf(b)) + length(boundsOf(b)) / 2))
  const first = boundsOf(ordered[0])
  const last = boundsOf(ordered[ordered.length - 1])
  const used = ordered.reduce((sum, element) => sum + length(boundsOf(element)), 0)
  const gap = (start(last) + length(last) - start(first) - used) / (ordered.length - 1)
  const moves = new Map<string, number>()
  let at = start(first)

  for (const element of ordered) {
    moves.set(element.id, at - start(boundsOf(element)))
    at += length(boundsOf(element)) + gap
  }

  return {
    deck: routeDeck(
      withElements(deck, slideId, new Set(ids), (element) => moveElement(element, across ? (moves.get(element.id) ?? 0) : 0, across ? 0 : (moves.get(element.id) ?? 0))),
      deck
    ),
    label,
    focus: { slideId, selected: [...ids] }
  }
}

export function nudge(deck: Deck, slideId: string, ids: readonly string[], dx: number, dy: number): DeckChange {
  return { ...updateElements(deck, slideId, ids, (element) => moveElement(element, dx, dy), 'Nudge'), join: `nudge:${slideId}:${[...ids].sort().join(',')}` }
}

/** A slide's title as text (empty when it has none). */
export function slideTitle(slide: Slide): string {
  const title = placeholderFor(slide, 'title')

  return title && (title.kind === 'text' || title.kind === 'shape') ? plainText(title.body).trim() : ''
}

/** The deck in a few lines of text: each slide's number, layout, title and how much is on it, for Hermes. */
export function outline(deck: Deck): string {
  return deck.slides
    .map((slide, index) => {
      const title = slideTitle(slide)
      const extra = [slide.hidden ? 'hidden' : '', slide.notes.trim() ? 'with notes' : ''].filter(Boolean).join(', ')

      return `${index + 1}. ${title || '(no title)'}: ${LAYOUT_NAMES[slide.layout]}, ${slide.elements.length} element${slide.elements.length === 1 ? '' : 's'}${extra ? `, ${extra}` : ''}`
    })
    .join('\n')
}

/** The id of the slide at a position (1 is the first) or named by id. */
export function slideRef(deck: Deck, ref: string | number): string {
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const slide = deck.slides[Number(ref) - 1]

    if (!slide) {
      throw new Error(`There is no slide ${ref}; the presentation has ${deck.slides.length}`)
    }

    return slide.id
  }

  return requireSlide(deck, String(ref)).id
}

/** An element of a slide, or an error saying it is not there. */
export function requireElement(deck: Deck, slideId: string, elementId: string): SlideElement {
  const element = findElement(requireSlide(deck, slideId), elementId)

  if (!element) {
    throw new Error(`There is no element ${elementId} on that slide`)
  }

  return element
}
