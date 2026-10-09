import { columnName, parseRange } from '../../../../shared/office/xlsx/address.ts'
import { parseJsonArg } from '../agent-model.ts'
import {
  type Anchor,
  type ArrowHead,
  type Background,
  type ConnectorPreset,
  DASHES,
  type Dash,
  type DateFormat,
  type Deck,
  DEFAULT_TRANSITION_MS,
  findSlide,
  type FontRef,
  type HeaderFooter,
  LAYOUTS,
  type LayoutId,
  type PlaceholderRole,
  type Slide,
  type SlideElement,
  type Slot,
  SLOTS,
  type Stroke,
  type TableElement,
  type Theme,
  type Transition,
  type TransitionDirection,
  TRANSITIONS
} from './deck.ts'
import {
  addImageStep,
  addShapeStep,
  addTextStep,
  alignOf,
  backgroundText,
  boxIn,
  colorArg,
  colorName,
  composeChanges,
  DATE_NAMES,
  fillArg,
  flag,
  gradientArg,
  layoutOf,
  numberIn,
  rangeSlidesStep,
  readElement,
  readHeaderFooter,
  runEdits,
  shapeOf,
  type SlideEdit,
  slideEditsOf,
  slideIdOf,
  slideIdsOf,
  slideLabel,
  slideNumber,
  slidesLabel,
  type Step,
  type StepContext,
  type StepMaker,
  STEPS
} from './agent-model.ts'
import { describeElement } from './elements.ts'
import { headerFooterOf } from './footers.ts'
import { LAYOUT_NAMES, layoutOf as layoutIn, masterOf } from './layouts.ts'
import * as model from './model.ts'
import type { BorderSide, DeckChange, LogoCorner, PlaceholderStyle } from './model.ts'
import { SHAPE_NAMES } from './shapes.ts'
import type { CellRef } from './tables.ts'
import { editTheme, sameBackground, THEMES } from './themes.ts'
import { DIRECTIONS, TRANSITION_NAMES, transitionFor } from './transitions.ts'

/*
 * Herald Slides' depth for Hermes, without a window: the slide master and its layouts, backgrounds
 * and the header and footer, transitions, groups, connectors, table borders and fills, custom
 * themes and slides from a sheet, each change a pure step on the deck as the Phase 3 steps are, so
 * a batch takes them too. The master and its layouts are changed the way the master view changes
 * them, through the master's own deck. Tested directly.
 */

type Args = Record<string, unknown>

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '')

const given = (value: unknown): boolean => value !== undefined && value !== null && value !== ''

const squashed = (value: string): string => value.toLowerCase().replace(/[\s_-]/g, '')

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`

const article = (words: string): string => `${/^[aeiou]/i.test(words) ? 'an' : 'a'} ${words}`

/** A step that changes nothing, saying why. */
const unchanged = (deck: Deck, label: string, done: string, info?: Record<string, unknown>): Step => ({ deck, label, done, ...(info ? { info } : {}) })

/** Whether a change left every slide as it was. */
const sameSlides = (before: Deck, after: Deck): boolean => after.slides.length === before.slides.length && after.slides.every((slide, index) => slide === before.slides[index])

// The master and its layouts.

/** The slide master, or one of its layouts. */
export type MasterPlace = 'master' | LayoutId

/** Where a master command works: the slide master ("master", or nothing), or one of its layouts by id, by Herald's name for it or by the name the deck gives it. */
export function masterPlaceOf(deck: Deck, value: unknown): MasterPlace {
  const asked = text(value)

  if (!asked || /^(the\s+)?(slide\s+)?master$/i.test(asked)) {
    return 'master'
  }

  const named = masterOf(deck).layouts.find((layout) => layout.name.toLowerCase() === asked.toLowerCase())

  if (named) {
    return named.id
  }

  try {
    return layoutOf(asked)
  } catch {
    throw new Error(`layout is master (the slide master) or one of its layouts: ${LAYOUTS.join(', ')}; not “${asked}”`)
  }
}

/** "the slide master" or "the Title and Content layout", for what a step says it did. */
const placeName = (deck: Deck, where: MasterPlace): string => (where === 'master' ? 'the slide master' : `the ${layoutIn(masterOf(deck), where).name} layout`)

/** The master's own slide or a layout's in the master's deck. */
const viewSlideId = (where: MasterPlace): string => (where === 'master' ? model.MASTER_SLIDE_ID : model.layoutSlideId(where))

/**
 * A step made on the master's own slide or a layout's in the master's deck, as the master view
 * makes it, and passed back into the deck; the editor stays where it is in the slides.
 */
function onMaster(deck: Deck, where: MasterPlace, make: (view: Deck, slideId: string) => Step): Step {
  const slideId = viewSlideId(where)
  const step = make(model.masterDeck(deck), slideId)

  return { deck: model.applyMasterDeck(deck, step.deck), label: where === 'master' ? 'Add to Master' : 'Add to Layout', done: step.done, ...(step.info ? { info: step.info } : {}) }
}

export function addMasterTextStep(deck: Deck, args: Args, context: StepContext): Step {
  const where = masterPlaceOf(deck, args.layout)
  const step = onMaster(deck, where, (view, slideId) => addTextStep(view, { ...args, slide: slideId }, { ...context, front: slideId }))

  return { ...step, done: `added a text box to ${placeName(deck, where)}`, info: { layout: where, element: step.info?.element } }
}

export function addMasterShapeStep(deck: Deck, args: Args, context: StepContext): Step {
  const where = masterPlaceOf(deck, args.layout)
  const step = onMaster(deck, where, (view, slideId) => addShapeStep(view, { ...args, slide: slideId }, { ...context, front: slideId }))

  return { ...step, done: `added ${article(SHAPE_NAMES[shapeOf(args.kind)].toLowerCase())} to ${placeName(deck, where)}`, info: { layout: where, element: step.info?.element } }
}

export function addMasterImageStep(deck: Deck, args: Args, context: StepContext): Step {
  const where = masterPlaceOf(deck, args.layout)
  const picture = context.pictures?.get(text(args.source))
  const free = !given(args.x) && !given(args.y) && !given(args.width) && !given(args.height) && text(args.fit).toLowerCase() !== 'slide'
  // Without a place a picture would fill a layout's empty picture placeholder; on the master it goes in the middle at its own proportions.
  const width = free && picture ? Math.min(deck.size.width * 0.6, deck.size.height * 0.6 * (picture.natural.width && picture.natural.height ? picture.natural.width / picture.natural.height : 4 / 3), picture.natural.width || deck.size.width * 0.6) : undefined
  const step = onMaster(deck, where, (view, slideId) => addImageStep(view, { ...args, ...(width ? { width } : {}), slide: slideId }, { ...context, front: slideId }))

  return { ...step, done: `added a picture to ${placeName(deck, where)}`, info: { layout: where, element: step.info?.element } }
}

const CORNERS: Record<string, LogoCorner> = { topleft: 'top-left', topright: 'top-right', bottomleft: 'bottom-left', bottomright: 'bottom-right', upperleft: 'top-left', upperright: 'top-right', lowerleft: 'bottom-left', lowerright: 'bottom-right' }

export function addLogoStep(deck: Deck, args: Args, context: StepContext): Step {
  const source = text(args.source)
  const picture = context.pictures?.get(source)

  if (!picture) {
    throw new Error(source ? `The picture ${source} was not read` : 'Say which picture is the logo (source: a file path)')
  }

  const asked = squashed(text(args.corner)) || 'topright'
  const corner = CORNERS[asked]

  if (!corner) {
    throw new Error(`corner is top-left, top-right (the default), bottom-left or bottom-right, not “${text(args.corner)}”`)
  }

  const where = masterPlaceOf(deck, args.layout)
  const width = numberIn(args, 'width', 8, 2000)
  const change = model.addLogo(deck, { src: picture.src, natural: picture.natural, corner, ...(width ? { width } : {}), ...(where === 'master' ? {} : { layoutId: where }) })
  const slides = where === 'master' ? 'every slide that shows the master’s graphics' : `the slides of ${placeName(deck, where)}`

  return { deck: change.deck, label: change.label, done: `put the logo in the ${corner.replace('-', ' ')} corner of ${slides}`, info: { layout: where, element: change.elementId, corner } }
}

/** The drawings of the master's own slide or a layout's: what `slides.readMaster` numbers, placeholders left out. */
const drawingsOf = (elements: readonly SlideElement[]): SlideElement[] => elements.filter((element) => !element.placeholder)

/** The master's and layouts' elements a command names: their ids as slides.readMaster gives them, or the numbers of the drawings of the master (or of `layout`) in its list. */
function masterElementIdsOf(deck: Deck, args: Args): string[] {
  const view = model.masterDeck(deck)
  const where = masterPlaceOf(deck, args.layout)
  const drawings = drawingsOf(findSlide(view, viewSlideId(where))?.elements ?? [])
  const refs = listOf(args.elements)

  if (!refs.length) {
    throw new Error('Say which elements to remove (elements: their ids as slides.readMaster gives them)')
  }

  return [
    ...new Set(
      refs.map((ref) => {
        const found = view.slides.flatMap((slide) => slide.elements).find((element) => element.id === ref)
        const number = /^#?(\d+)$/.exec(ref)
        const nth = number ? drawings[Number(number[1]) - 1] : undefined

        if (!found && !nth) {
          throw new Error(`${placeName(deck, where)} has no element “${ref}”${drawings.length ? `: its elements are ${drawings.map((element, index) => `${index + 1}. ${describeElement(element)} (${element.id})`).join(', ')}` : ', and no elements of its own'}`)
        }

        return (found ?? nth)!.id
      })
    )
  ]
}

export function removeFromMasterStep(deck: Deck, args: Args): Step {
  const ids = masterElementIdsOf(deck, args)
  const change = model.removeMasterElements(deck, ids)

  return { ...change, done: `removed ${plural(ids.length, 'element')} from the slide master and its layouts`, info: { removed: ids } }
}

const ROLES: Record<string, PlaceholderRole> = {
  title: 'title',
  subtitle: 'subtitle',
  body: 'body',
  text: 'body',
  content: 'body',
  heading: 'heading',
  caption: 'caption',
  picture: 'picture',
  date: 'date',
  footer: 'footer',
  number: 'number',
  slidenumber: 'number',
  pagenumber: 'number'
}

const ROLE_NAMES: Record<PlaceholderRole, string> = { title: 'title', subtitle: 'subtitle', body: 'text', heading: 'heading', caption: 'caption', picture: 'picture', date: 'date', footer: 'footer', number: 'slide number' }

const ANCHORS: Record<string, Anchor> = { top: 'top', middle: 'middle', center: 'middle', centre: 'middle', bottom: 'bottom' }

/** A font from a command: the theme's heading or body font, or a family. */
const fontOf = (value: unknown): FontRef => {
  const asked = text(value)

  return /^(\+?heading|headings|heading font)$/i.test(asked) ? '+heading' : /^(\+?body|body font)$/i.test(asked) ? '+body' : asked.replace(/["\\;{}<>]/g, '').slice(0, 80)
}

/** A placeholder's text style from a command: what it gives of font, size, colour, bold, italic, alignment and anchor. */
function placeholderStyleOf(args: Args): PlaceholderStyle {
  const style: PlaceholderStyle = {}
  const size = numberIn(args, 'size', 4, 400)
  const bold = flag(args.bold)
  const italic = flag(args.italic)
  const align = alignOf(args.align)

  if (given(args.font)) {
    style.font = fontOf(args.font)
  }

  if (size !== undefined) {
    style.size = size
  }

  if (given(args.color)) {
    const color = colorArg(args.color, 'color')

    if (!color) {
      throw new Error('A placeholder’s text has a colour: #rrggbb, a name or a theme colour')
    }

    style.color = color
  }

  if (bold !== undefined) {
    style.bold = bold
  }

  if (italic !== undefined) {
    style.italic = italic
  }

  if (align) {
    style.align = align
  }

  if (given(args.anchor)) {
    const anchor = ANCHORS[text(args.anchor).toLowerCase()]

    if (!anchor) {
      throw new Error(`anchor is top, middle or bottom, not “${text(args.anchor)}”`)
    }

    style.anchor = anchor
  }

  return style
}

/** A placeholder of the master or a layout moved, resized or restyled; the layouts' and slides' placeholders that still looked like it follow, as in PowerPoint. */
export function setPlaceholderStep(deck: Deck, args: Args): Step {
  const where = masterPlaceOf(deck, args.layout)
  const role = ROLES[squashed(text(args.role))]

  if (!role) {
    throw new Error(`role is the placeholder: title, subtitle, body (the text), heading, caption, picture, date, footer or number (the slide number); not “${text(args.role)}”`)
  }

  const nth = (numberIn(args, 'which', 1, 20) ?? 1) - 1
  const elements = findSlide(model.masterDeck(deck), viewSlideId(where))?.elements ?? []
  const target = elements.filter((element) => element.placeholder?.role === role)[nth]

  if (!target) {
    const roles = [...new Set(elements.flatMap((element) => (element.placeholder ? [ROLE_NAMES[element.placeholder.role]] : [])))]

    throw new Error(`${placeName(deck, where)} has no ${ROLE_NAMES[role]} placeholder${nth ? ` ${nth + 1}` : ''}${roles.length ? `: it has ${roles.join(', ')}` : ''}`)
  }

  const box = boxIn(args)
  const style = placeholderStyleOf(args)
  const changes: [string, (current: Deck) => DeckChange][] = []

  if (Object.values(box).some((value) => value !== undefined)) {
    changes.push(['place', (current) => model.setPlaceholderBox(current, where, role, { x: box.x ?? target.x, y: box.y ?? target.y, width: box.width ?? target.width, height: box.height ?? target.height }, nth)])
  }

  if (Object.keys(style).length) {
    changes.push(['text', (current) => model.setPlaceholderStyle(current, where, role, style, nth)])
  }

  if (!changes.length) {
    throw new Error('Say what to change: x, y, width or height for its place; font, size, color, bold, italic, align or anchor for its text')
  }

  const change = composeChanges(
    deck,
    changes.map(([, make]) => make),
    'Placeholder'
  )
  const after = (findSlide(model.masterDeck(change.deck), viewSlideId(where))?.elements ?? []).filter((element) => element.placeholder?.role === role)[nth]
  const which = `${placeName(deck, where)}’s ${ROLE_NAMES[role]} placeholder${nth ? ` ${nth + 1}` : ''}`

  return JSON.stringify(after) === JSON.stringify(target)
    ? unchanged(deck, 'Placeholder', `${which} already looks that way`)
    : { ...change, done: `changed the ${changes.map(([what]) => what).join(' and ')} of ${which}`, info: { layout: where, role, element: target.id } }
}

/** Whether the master's graphics (logos, bands) show on a layout's slides or on some slides; for slides, a slide's own choice comes first. */
export function showMasterGraphicsStep(deck: Deck, args: Args, context: StepContext): Step {
  const show = flag(args.show)

  if (show === undefined) {
    throw new Error('Say whether the master’s graphics show (show: true) or not (show: false)')
  }

  const verb = show ? 'showed' : 'hid'

  if (given(args.layout)) {
    const where = masterPlaceOf(deck, args.layout)

    if (where === 'master') {
      throw new Error('The master’s graphics show or hide on a layout’s slides (layout) or on slides (slide), not on the master itself')
    }

    const change = model.setShowMaster(deck, where, show)

    return change.deck === deck
      ? unchanged(deck, change.label, `${placeName(deck, where)} already ${show ? 'shows' : 'hides'} the master’s graphics`)
      : { ...change, done: `${verb} the master’s graphics on ${placeName(deck, where)}’s slides`, info: { layout: where, show } }
  }

  const ids = slideIdsOf(deck, args.slide, context.front)
  const change = model.setShowMasterOnSlides(deck, ids, show)

  const verbs = ids.length === 1 ? ['shows', 'hides'] : ['show', 'hide']

  return sameSlides(deck, change.deck)
    ? unchanged(deck, change.label, `${slidesLabel(deck, ids)} already ${show ? verbs[0] : verbs[1]} the master’s graphics`)
    : { ...change, done: `${verb} the master’s graphics on ${slidesLabel(deck, ids)}`, info: { slides: ids.map((id) => slideNumber(deck, id)), show } }
}

export function renameLayoutStep(deck: Deck, args: Args): Step {
  const where = given(args.layout) ? masterPlaceOf(deck, args.layout) : 'master'

  if (where === 'master') {
    throw new Error('Say which layout to rename (layout: title, title-content, two-content…); the slide master has no name of its own')
  }

  const asked = text(args.name)

  if (!asked) {
    throw new Error('Say the layout’s new name (name); default gives back Herald’s')
  }

  const change = model.renameLayout(deck, where, /^(default|herald)$/i.test(asked) ? '' : asked)
  const name = layoutIn(masterOf(change.deck), where).name

  return change.deck === deck ? unchanged(deck, change.label, `the ${LAYOUT_NAMES[where]} layout is already called “${name}”`) : { ...change, done: `named the ${LAYOUT_NAMES[where]} layout “${name}”`, info: { layout: where, name } }
}

export function resetMasterStep(deck: Deck): Step {
  const change = model.resetMaster(deck)

  return change.deck === deck
    ? unchanged(deck, change.label, 'it already has Herald’s own master')
    : { ...change, done: 'put Herald’s own master and layouts back in place of the presentation’s (their backgrounds, logos and drawings and the placeholders’ places and looks are gone)' }
}

const DATE_FORMATS: Record<string, DateFormat> = {
  ...Object.fromEntries(Object.entries(DATE_NAMES).map(([format, name]) => [name, format as DateFormat])),
  datetime1: 'datetime1',
  datetime2: 'datetime2',
  datetime3: 'datetime3',
  datetime4: 'datetime4',
  short: 'datetime1',
  full: 'datetime2',
  weekday: 'datetime2',
  daymonthyear: 'datetime3',
  monthdayyear: 'datetime4'
}

/** What a read of the header and footer says, in words. */
function footersSaid(deck: Deck): string {
  const read = readHeaderFooter(deck)

  if (!read) {
    return 'no date, slide number or footer'
  }

  const parts = [read.date ? ('text' in read.date ? `the date as “${read.date.text}”` : `the date (${read.date.format})`) : '', read.slideNumber ? 'the slide number' : '', read.footer ? `the footer “${read.footer}”` : ''].filter(Boolean)

  return `${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]}${read.skipTitle ? ', but not on title slides' : ''}`
}

/** The date, slide number and footer every slide shows from the master's places for them (title slides too, unless skipTitle). */
export function setHeaderFooterStep(deck: Deck, args: Args): Step {
  const patch: Partial<HeaderFooter> = {}
  const date = flag(args.date)
  const number = flag(args.number)
  const skip = flag(args.skipTitle)

  if (date !== undefined) {
    patch.date = date
  }

  if (given(args.dateFormat)) {
    const format = DATE_FORMATS[squashed(text(args.dateFormat))]

    if (!format) {
      throw new Error(`dateFormat is numeric (10/9/2026, the default), long (Friday, October 9, 2026), dmy (9 October 2026) or mdy (October 9, 2026); not “${text(args.dateFormat)}”`)
    }

    patch.dateFormat = format
    patch.date ??= true
  }

  if (given(args.dateText)) {
    const fixed = text(args.dateText)
    patch.dateText = /^(none|today)$/i.test(fixed) ? '' : fixed
    patch.date ??= true
  }

  if (number !== undefined) {
    patch.number = number
  }

  if (given(args.footer)) {
    const footer = text(args.footer)

    if (/^(none|off|no|false)$/i.test(footer)) {
      patch.footer = false
    } else if (/^(on|yes|true)$/i.test(footer)) {
      if (!headerFooterOf(deck).footerText) {
        throw new Error('Say what the footer says (footer: its text)')
      }

      patch.footer = true
    } else {
      patch.footer = true
      patch.footerText = footer
    }
  }

  if (skip !== undefined) {
    patch.skipTitle = skip
  }

  if (!Object.keys(patch).length) {
    throw new Error('Say what slides show: date (true or false), dateFormat, dateText, number (the slide number), footer (its text, or none) and skipTitle (true leaves them off title slides)')
  }

  const change = model.setHeaderFooter(deck, patch)

  return change.deck === deck ? unchanged(deck, change.label, `slides already show ${footersSaid(deck)}`) : { ...change, done: `slides now show ${footersSaid(change.deck)}`, info: { headerFooter: readHeaderFooter(change.deck) ?? 'none' } }
}

// Backgrounds and fills.

/** A background from a command: a gradient, a picture read before the change, a colour, or null for none (the layout's, the master's or the theme's then shows). */
function backgroundOf(args: Args, context: StepContext): Background | null {
  const gradient = gradientArg(args)

  if (gradient) {
    return { kind: 'gradient', ...gradient }
  }

  if (given(args.source)) {
    const picture = context.pictures?.get(text(args.source))

    if (!picture) {
      throw new Error(`The picture ${text(args.source)} was not read`)
    }

    return { kind: 'image', src: picture.src, natural: picture.natural }
  }

  if (!given(args.background)) {
    throw new Error('Say what the background is: background (a colour, or none for the one underneath), gradient (two or more colours) or source (a picture file)')
  }

  const color = colorArg(args.background, 'background')

  return color ? { kind: 'solid', color } : null
}

/** The background of slides, of a layout, or of the master (shown wherever a slide and its layout have none of their own). */
export function setBackgroundStep(deck: Deck, args: Args, context: StepContext): Step {
  const background = backgroundOf(args, context)
  const said = background ? `the background ${backgroundText(background)}` : 'no background of its own'

  if (given(args.layout)) {
    const where = masterPlaceOf(deck, args.layout)
    const had = where === 'master' ? masterOf(deck).background : layoutIn(masterOf(deck), where).background

    if (sameBackground(had, background)) {
      return unchanged(deck, 'Background', `${placeName(deck, where)} already has ${said}`)
    }

    const change = where === 'master' ? model.setMasterBackground(deck, background) : model.setLayoutBackground(deck, where, background)

    return { ...change, done: `gave ${placeName(deck, where)} ${said}`, info: { layout: where, background: background ? backgroundText(background) : 'none' } }
  }

  const ids = slideIdsOf(deck, args.slide, context.front)
  const which = slidesLabel(deck, ids)

  if (ids.every((id) => sameBackground(findSlide(deck, id)?.background, background))) {
    return unchanged(deck, 'Background', `${which} already ${ids.length === 1 ? 'has' : 'have'} ${said}`)
  }

  const change = model.setBackground(deck, ids, background)

  return { ...change, done: `gave ${which} ${said}`, info: { slides: ids.map((id) => slideNumber(deck, id)), background: background ? backgroundText(background) : 'none' } }
}

/** Some shapes' and text boxes' fill: a colour, a gradient, or none. */
export function setFillStep(deck: Deck, args: Args, context: StepContext): Step {
  const slideId = slideIdOf(deck, args.slide, context.front)
  const slide = findSlide(deck, slideId)!
  const ids = elementIdsOf(slide, args.elements)
  const fill = fillArg(args)

  if (fill === undefined) {
    throw new Error('Say what fills them: fill (a colour, or none) or gradient (two or more colours, with angle and radial)')
  }

  const wrong = slide.elements.find((element) => ids.includes(element.id) && element.kind !== 'shape' && element.kind !== 'text')

  if (wrong) {
    throw new Error(`${describeElement(wrong)} ${wrong.id} takes no fill: shapes and text boxes do`)
  }

  const change = model.updateElements(deck, slideId, ids, (element) => (element.kind === 'shape' || element.kind === 'text' ? { ...element, fill } : element), 'Fill')
  const said = !fill ? 'no fill' : fill.gradient ? `a gradient of ${fill.gradient.stops.map((stop) => colorName(stop.color)).join(' to ')}` : colorName(fill.color)

  return { ...change, done: `filled ${plural(ids.length, 'element')} on ${slideLabel(deck, slideId)} with ${said}`, info: { slide: slideNumber(deck, slideId), elements: ids } }
}

// Transitions.

const TRANSITION_WORDS: Record<string, Transition> = { dissolve: 'fade', crossfade: 'fade', reveal: 'uncover', off: 'none' }

const DIRECTION_WORDS: Record<string, TransitionDirection> = { fromright: 'left', fromtheright: 'left', fromleft: 'right', fromtheleft: 'right', frombottom: 'up', fromthebottom: 'up', frombelow: 'up', fromtop: 'down', fromthetop: 'down', fromabove: 'down' }

function transitionKindOf(value: unknown): Transition {
  const asked = squashed(text(value))
  const found = TRANSITIONS.find((kind) => kind === asked) ?? TRANSITION_WORDS[asked]

  if (!found) {
    throw new Error(`kind is a transition: ${TRANSITIONS.join(', ')}; not “${text(value)}”`)
  }

  return found
}

/** A slide's transition, as several slides' or every slide's (the deck's too, as Apply To All makes it): its kind, which way it goes and how many seconds it takes. */
export function setTransitionStep(deck: Deck, args: Args, context: StepContext): Step {
  const kind = transitionKindOf(args.kind)
  const seconds = numberIn(args, 'duration', 0.01, 60)
  const transition = transitionFor(kind, seconds === undefined ? DEFAULT_TRANSITION_MS : Math.round(seconds * 1000))

  if (given(args.direction)) {
    const asked = squashed(text(args.direction))
    const direction = (DIRECTIONS[kind] as readonly string[]).includes(asked) ? (asked as TransitionDirection) : DIRECTION_WORDS[asked]

    if (!direction || !DIRECTIONS[kind].includes(direction)) {
      throw new Error(DIRECTIONS[kind].length ? `${TRANSITION_NAMES[kind]} goes ${DIRECTIONS[kind].join(', ')}; not “${text(args.direction)}”` : `${TRANSITION_NAMES[kind]} goes no way in particular: leave direction out`)
    }

    transition.direction = direction
  }

  if (given(args.orientation)) {
    const asked = text(args.orientation).toLowerCase()

    if (kind !== 'split' || !/^(horizontal|vertical|across|up and down)$/.test(asked)) {
      throw new Error('orientation is for split: horizontal or vertical')
    }

    transition.orientation = asked === 'vertical' || asked === 'up and down' ? 'vertical' : 'horizontal'
  }

  const said = `the ${TRANSITION_NAMES[kind]} transition${transition.direction ? ` (${transition.direction})` : ''}${kind === 'none' ? '' : `, ${transition.duration / 1000} s`}`

  if (/^(all|every|all slides|every slide)$/i.test(text(args.slide))) {
    const change = model.applyTransitionToAll(deck, transition)

    return change.deck === deck ? unchanged(deck, change.label, `every slide already has ${said}`) : { ...change, done: `gave every slide ${said}`, info: { slides: 'all', kind } }
  }

  const ids = slideIdsOf(deck, args.slide, context.front)
  const change = model.setSlideTransition(deck, ids, transition)
  const which = slidesLabel(deck, ids)

  return change.deck === deck
    ? unchanged(deck, change.label, `${which} already ${ids.length === 1 ? 'has' : 'have'} ${said}`)
    : { ...change, done: `gave ${which} ${said}`, info: { slides: ids.map((id) => slideNumber(deck, id)), kind } }
}

// Groups.

/** A list a command gives: a JSON list, or text with commas between its parts. */
function listOf(value: unknown): string[] {
  const parsed = parseJsonArg(value, 'elements')

  return (Array.isArray(parsed) ? parsed : given(parsed) ? String(parsed).split(',') : []).map(text).filter(Boolean)
}

/** A slide's elements in a few words, for messages: "1. Title (text-ab12), 2. Shape (shape-cd34), …". */
function elementList(slide: Slide): string {
  const listed = slide.elements.map((element, index) => `${index + 1}. ${describeElement(element)} (${element.id})`)

  return listed.length ? `${listed.slice(0, 12).join(', ')}${listed.length > 12 ? `, and ${listed.length - 12} more` : ''}` : 'nothing on it'
}

/** The elements a command names on a slide: their ids as slides.read gives them (a group's id names all of it), or their numbers in its list from 1. */
export function elementIdsOf(slide: Slide, value: unknown, what = 'elements'): string[] {
  const refs = listOf(value)

  if (!refs.length) {
    throw new Error(`Say which elements (${what}: their ids as slides.read gives them)`)
  }

  const ids = refs.flatMap((ref) => {
    const found = slide.elements.find((element) => element.id === ref)
    const grouped = found ? [] : slide.elements.filter((element) => element.group?.includes(ref))
    const number = /^#?(\d+)$/.exec(ref)
    const nth = number ? slide.elements[Number(number[1]) - 1] : undefined

    if (found ?? nth) {
      return [(found ?? nth)!.id]
    }

    if (!grouped.length) {
      throw new Error(`There is no element “${ref}” on that slide: its elements are ${elementList(slide)}`)
    }

    return grouped.map((element) => element.id)
  })

  return [...new Set(ids)]
}

export function groupStep(deck: Deck, args: Args, context: StepContext): Step {
  const slideId = slideIdOf(deck, args.slide, context.front)
  const change = model.groupElements(deck, slideId, elementIdsOf(findSlide(deck, slideId)!, args.elements))

  if (change.deck === deck) {
    throw new Error('A group takes two or more elements or groups (placeholders stay out of groups): give their ids as slides.read gives them')
  }

  const members = change.focus?.selected ?? []
  const group = findSlide(change.deck, slideId)?.elements.find((element) => element.id === members[0])?.group?.[0]

  return { ...change, done: `grouped ${plural(members.length, 'element')} on ${slideLabel(deck, slideId)}`, info: { slide: slideNumber(deck, slideId), group, elements: members } }
}

export function ungroupStep(deck: Deck, args: Args, context: StepContext): Step {
  const slideId = slideIdOf(deck, args.slide, context.front)
  const change = model.ungroupElements(deck, slideId, elementIdsOf(findSlide(deck, slideId)!, args.elements))
  const members = change.focus?.selected ?? []

  return change.deck === deck
    ? unchanged(deck, change.label, 'none of them is in a group')
    : { ...change, done: `ungrouped ${plural(members.length, 'element')} on ${slideLabel(deck, slideId)}`, info: { slide: slideNumber(deck, slideId), elements: members } }
}

/** Elements (a group as a whole) turned together about their middle, each by as much. */
export function rotateStep(deck: Deck, args: Args, context: StepContext): Step {
  const degrees = numberIn(args, 'degrees', -3600, 3600)

  if (!degrees) {
    throw new Error('Say how far to turn them (degrees: clockwise, or negative for anticlockwise)')
  }

  const slideId = slideIdOf(deck, args.slide, context.front)
  const slide = findSlide(deck, slideId)!
  const ids = model.expandToGroups(slide, elementIdsOf(slide, args.elements))
  const change = model.rotateElements(deck, slideId, ids, degrees)

  return { ...change, done: `turned ${plural(ids.length, 'element')} on ${slideLabel(deck, slideId)} ${Math.abs(degrees)}° ${degrees > 0 ? 'clockwise' : 'anticlockwise'}`, info: { slide: slideNumber(deck, slideId), elements: ids } }
}

/** SmartArt (and other kept objects that carry a drawing) turned into a group of shapes that can be edited; every such object on the slide when none is named. */
export function convertToShapesStep(deck: Deck, args: Args, context: StepContext): Step {
  const slideId = slideIdOf(deck, args.slide, context.front)
  const slide = findSlide(deck, slideId)!
  const ids = given(args.elements) ? elementIdsOf(slide, args.elements) : slide.elements.filter((element) => element.kind === 'object' && element.shapes?.length).map((element) => element.id)
  const change = model.convertToShapes(deck, slideId, ids)

  if (change.deck === deck) {
    throw new Error(`${slideLabel(deck, slideId)} has ${given(args.elements) ? 'no SmartArt among those elements' : 'no SmartArt'} to turn into shapes (only SmartArt and other objects a PowerPoint file keeps a drawing for do)`)
  }

  return { ...change, done: `turned ${plural(ids.length, 'object')} on ${slideLabel(deck, slideId)} into ${plural(change.focus?.selected?.length ?? 0, 'shape')}`, info: { slide: slideNumber(deck, slideId), shapes: change.focus?.selected ?? [] } }
}

// Connectors.

const CONNECTOR_WORDS: Record<string, ConnectorPreset> = { straight: 'straightConnector1', line: 'straightConnector1', elbow: 'bentConnector3', bent: 'bentConnector3', angled: 'bentConnector3', curved: 'curvedConnector3', curve: 'curvedConnector3' }

const DASH_WORDS: Record<string, Dash> = { dashed: 'dash', dotted: 'dot', dashdot: 'dashDot', longdash: 'longDash', longdashes: 'longDash' }

/** A line's dash from a command: solid (the default), dash, dot, dashDot or longDash. */
function dashOf(value: unknown): Dash {
  const asked = squashed(text(value))
  const found = DASHES.find((dash) => dash.toLowerCase() === asked) ?? DASH_WORDS[asked]

  if (asked && !found) {
    throw new Error(`dash is ${DASHES.join(', ')}, not “${text(value)}”`)
  }

  return found ?? 'solid'
}

const ARROWS: Record<string, { start: ArrowHead; end: ArrowHead }> = { end: { start: 'none', end: 'triangle' }, start: { start: 'triangle', end: 'none' }, both: { start: 'triangle', end: 'triangle' }, none: { start: 'none', end: 'none' } }

/** The sites a connector glues to: those asked for, else the pair nearest each other (the one asked for, and the other's nearest to it). */
function sitesFor(from: SlideElement, to: SlideElement, asked: { from?: number; to?: number }): { from: number; to: number } {
  const a = model.connectionSites(from)
  const b = model.connectionSites(to)

  for (const [element, sites, site] of [
    [from, a, asked.from],
    [to, b, asked.to]
  ] as const) {
    if (!sites.length) {
      throw new Error(`${describeElement(element)} ${element.id} has no connection sites`)
    }

    if (site !== undefined && (!Number.isInteger(site) || site >= sites.length)) {
      throw new Error(`${describeElement(element)} ${element.id} has connection sites 0 to ${sites.length - 1} (slides.connectionSites lists them)`)
    }
  }

  const distance = (i: number, j: number) => Math.hypot(a[i][0] - b[j][0], a[i][1] - b[j][1])
  let best = { from: asked.from ?? 0, to: asked.to ?? 0, length: Infinity }

  a.forEach((_, i) => {
    b.forEach((__, j) => {
      if ((asked.from === undefined || asked.from === i) && (asked.to === undefined || asked.to === j) && distance(i, j) < best.length) {
        best = { from: i, to: j, length: distance(i, j) }
      }
    })
  })

  return { from: best.from, to: best.to }
}

/** A connector from one element to another, glued to their connection sites so it follows them as they move. */
export function addConnectorStep(deck: Deck, args: Args, context: StepContext): Step {
  const slideId = slideIdOf(deck, args.slide, context.front)
  const slide = findSlide(deck, slideId)!
  const [fromId, ...moreFrom] = elementIdsOf(slide, args.from, 'from')
  const [toId, ...moreTo] = elementIdsOf(slide, args.to, 'to')

  if (moreFrom.length || moreTo.length || fromId === toId) {
    throw new Error('A connector runs from one element (from) to another (to)')
  }

  const from = slide.elements.find((element) => element.id === fromId)!
  const to = slide.elements.find((element) => element.id === toId)!
  const sites = sitesFor(from, to, { from: numberIn(args, 'fromSite', 0, 99), to: numberIn(args, 'toSite', 0, 99) })
  const asked = squashed(text(args.kind)) || 'straight'
  const preset = CONNECTOR_WORDS[asked]

  if (!preset) {
    throw new Error(`kind is straight (the default), elbow or curved, not “${text(args.kind)}”`)
  }

  const color = given(args.color) ? colorArg(args.color, 'color') : 'tx1'
  const arrow = ARROWS[squashed(text(args.arrow)) || 'end']

  if (!color || !arrow) {
    throw new Error(!color ? 'A connector has a colour: #rrggbb, a name or a theme colour' : `arrow is end (the default), start, both or none, not “${text(args.arrow)}”`)
  }

  const stroke: Stroke = { color, width: numberIn(args, 'width', 0.25, 50) ?? 2, dash: dashOf(args.dash) }
  const change = model.addConnector(deck, slideId, { from: { element: fromId, site: sites.from }, to: { element: toId, site: sites.to }, preset, stroke, ...arrow })
  const kind = asked === 'straight' || asked === 'line' ? 'straight' : preset.startsWith('bent') ? 'elbow' : 'curved'

  return {
    ...change,
    done: `connected the ${describeElement(from).toLowerCase()} to the ${describeElement(to).toLowerCase()} on ${slideLabel(deck, slideId)} with ${article(`${kind} connector`)}`,
    info: { slide: slideNumber(deck, slideId), element: change.elementId, from: fromId, fromSite: sites.from, to: toId, toSite: sites.to }
  }
}

const FACINGS: Record<number, string> = { 0: 'right', 90: 'down', 180: 'left', 270: 'up' }

/** An element's connection sites, numbered as a connector glues to them: where each is on the slide and which way it faces. */
export function connectionSitesOf(deck: Deck, args: Args, context: StepContext) {
  const slideId = slideIdOf(deck, args.slide, context.front)
  const slide = findSlide(deck, slideId)!
  const [id] = elementIdsOf(slide, args.element, 'element')
  const element = slide.elements.find((entry) => entry.id === id)!
  const sites = model.connectionSites(element).map(([x, y], site) => {
    const facing = Math.round(model.siteFacing(element, site)) % 360

    return { site, x: Math.round(x), y: Math.round(y), facing: FACINGS[facing] ?? `${facing}°` }
  })

  return { slide: slideNumber(deck, slideId), element: id, kind: describeElement(element), sites }
}

// Tables.

/** The table a command names on a slide, or the slide's only table. */
function tableOn(slide: Slide, value: unknown): TableElement {
  if (given(value)) {
    const [id] = elementIdsOf(slide, value, 'element')
    const found = slide.elements.find((element) => element.id === id)!

    if (found.kind !== 'table') {
      throw new Error(`${describeElement(found)} ${id} is not a table`)
    }

    return found
  }

  const tables = slide.elements.filter((element): element is TableElement => element.kind === 'table')

  if (tables.length !== 1) {
    throw new Error(tables.length ? `That slide has ${tables.length} tables: say which (element: its id as slides.read gives it)` : 'That slide has no table')
  }

  return tables[0]
}

/** A table's cells from a command: all of them; a range as a sheet names cells (A1:C3, B2: columns lettered from A, rows numbered from 1); or rows or columns ("row 1", "rows 2-4", "column 3"). */
export function cellsOf(value: unknown, table: TableElement): CellRef[] | 'all' {
  const asked = text(value).toLowerCase()
  const rows = table.rows.length
  const columns = table.columns.length

  if (!asked || asked === 'all') {
    return 'all'
  }

  const down = /^rows?\s+(\d+)(?:\s*[-–:]\s*(\d+))?$/.exec(asked)
  const across = /^(?:columns?|cols?)\s+([a-z]+|\d+)(?:\s*[-–:]\s*([a-z]+|\d+))?$/.exec(asked)
  const letter = (part: string) => (/^\d+$/.test(part) ? columnName(Number(part) - 1) : part)
  const ref = down ? `${down[1]}:${down[2] ?? down[1]}` : across ? `${letter(across[1])}:${letter(across[2] ?? across[1])}` : asked
  const range = parseRange(ref.toUpperCase())

  if (!range) {
    throw new Error(`range is the table's cells: A1:C3 or B2 (columns lettered from A, rows numbered from 1), row 1, rows 2-4, column 3, or all; not “${text(value)}”`)
  }

  const bottom = Math.min(rows - 1, range.endRow)
  const right = Math.min(columns - 1, range.endColumn)

  if (range.startRow > bottom || range.startColumn > right) {
    throw new Error(`The table has ${plural(rows, 'row')} and ${plural(columns, 'column')} (A1 to ${columnName(columns - 1)}${rows}); ${text(value)} is outside it`)
  }

  return Array.from({ length: bottom - range.startRow + 1 }, (_, r) => Array.from({ length: right - range.startColumn + 1 }, (__, c) => ({ row: range.startRow + r, column: range.startColumn + c }))).flat()
}

const SIDE_WORDS: Record<string, BorderSide | 'none'> = { all: 'all', outer: 'outer', outside: 'outer', outline: 'outer', box: 'outer', inner: 'inner', inside: 'inner', top: 'top', bottom: 'bottom', left: 'left', right: 'right', none: 'none' }

/** A table's cell borders: a line (or none) on some sides of some of its cells, or all of them. */
export function setCellBordersStep(deck: Deck, args: Args, context: StepContext): Step {
  const slideId = slideIdOf(deck, args.slide, context.front)
  const table = tableOn(findSlide(deck, slideId)!, args.element)
  const cells = cellsOf(args.range, table)
  const words = (text(args.sides) || 'all')
    .toLowerCase()
    .split(/[\s,]+(?:and\s+)?/)
    .filter(Boolean)
  const sides = words.map((word) => {
    const side = SIDE_WORDS[word]

    if (!side) {
      throw new Error(`sides is all (the default), outer, inner, top, bottom, left, right or none, or several of them; not “${word}”`)
    }

    return side
  })
  const none = sides.includes('none')
  const color = none ? null : given(args.color) ? colorArg(args.color, 'color') : 'tx1'

  if (!none && !color) {
    throw new Error('Borders have a colour: #rrggbb, a name or a theme colour (sides none takes them off)')
  }

  const stroke: Stroke | null = color ? { color, width: numberIn(args, 'width', 0.25, 20) ?? 1, dash: dashOf(args.dash) } : null
  const change = model.setCellBorders(
    deck,
    slideId,
    table.id,
    cells,
    none ? ['all'] : sides.filter((side): side is BorderSide => side !== 'none'),
    stroke
  )
  const where = cells === 'all' ? 'every cell' : `cells ${text(args.range).toUpperCase()}`
  const done = stroke ? `drew ${stroke.width}-point ${colorName(stroke.color)} borders (${words.join(', ')}) on ${where}` : `took the borders off ${where}`

  return change.deck === deck ? unchanged(deck, change.label, `the borders of ${where} are already so`) : { ...change, done: `${done} of the table on ${slideLabel(deck, slideId)}`, info: { slide: slideNumber(deck, slideId), element: table.id } }
}

// Themes.

/** What theme colours are called in a command. */
const SLOT_ARGS: Record<string, Slot> = { ...Object.fromEntries(SLOTS.map((slot) => [slot, slot])), background: 'bg1', background1: 'bg1', text: 'tx1', text1: 'tx1', background2: 'bg2', text2: 'tx2', accent: 'accent1' }

/** A theme's colours from a command: a JSON object of theme colours ({"accent1": "#0b7d97", "background": "#f2fafc"}), or "accent1 #0b7d97, text navy". */
function themeColorsOf(value: unknown, base: Theme): Partial<Record<Slot, string>> {
  const parsed = parseJsonArg(value, 'colors')
  const pairs =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.entries(parsed as Record<string, unknown>)
      : text(value)
          .split(',')
          .filter((part) => part.trim())
          .map((part): [string, unknown] => {
            const pair = /^\s*([a-z0-9 ]+?)\s*[:=]?\s+(\S+)\s*$/i.exec(part)

            if (!pair) {
              throw new Error(`colors is a theme colour and its colour each, like {"accent1": "#0b7d97", "background": "#f2fafc"}; not “${part.trim()}”`)
            }

            return [pair[1], pair[2]]
          })

  return Object.fromEntries(
    pairs.map(([name, color]) => {
      const slot = SLOT_ARGS[squashed(name)]

      if (!slot) {
        throw new Error(`colors names theme colours: background, text, background2, text2 and accent1 to accent6; not “${name}”`)
      }

      const picked = colorArg(color, `colors ${name}`)

      if (!picked) {
        throw new Error(`A theme colour is a colour, not none (colors ${name})`)
      }

      return [slot, picked.startsWith('#') ? picked : base.colors[picked as Slot]]
    })
  )
}

/**
 * A custom theme made from `base` with some of its colours and fonts changed (and its background
 * gradient, or none), under a name no theme has yet; it keeps `base`'s id until it is saved.
 */
export function themeFromArgs(args: Args, base: Theme, known: readonly Theme[]): Theme {
  const name = text(args.name)

  if (!name) {
    throw new Error('Say what the new theme is called (name)')
  }

  const clash = known.find((theme) => theme.name.toLowerCase() === name.toLowerCase() || theme.id === name.toLowerCase())

  if (clash) {
    throw new Error(`There is already a theme called ${clash.name} (${clash.id}): give the new one another name${THEMES.includes(clash) ? '' : ', or delete that one first (slides.deleteTheme)'}`)
  }

  if (given(args.background) && !/^none$/i.test(text(args.background))) {
    throw new Error('A theme’s background colour is one of its colours (colors: background); background takes none, to take a theme’s gradient away, and gradient gives it one')
  }

  const gradient = gradientArg(args)
  const background: Background | null | undefined = gradient ? { kind: 'gradient', ...gradient } : given(args.background) ? null : undefined

  return editTheme(base, {
    name,
    colors: given(args.colors) ? themeColorsOf(args.colors, base) : {},
    fonts: { ...(given(args.headingFont) ? { heading: text(args.headingFont) } : {}), ...(given(args.bodyFont) ? { body: text(args.bodyFont) } : {}) },
    ...(background === undefined ? {} : { background })
  })
}

/** Herald's themes and the person's, as Hermes reads them: id, name, fonts, colours and background. */
export function themesList(custom: readonly Theme[]) {
  const read = (theme: Theme) => ({
    id: theme.id,
    name: theme.name,
    fonts: theme.fonts,
    colors: { background: theme.colors.bg1, text: theme.colors.tx1, background2: theme.colors.bg2, text2: theme.colors.tx2, accent1: theme.colors.accent1, accent2: theme.colors.accent2, accent3: theme.colors.accent3, accent4: theme.colors.accent4, accent5: theme.colors.accent5, accent6: theme.colors.accent6 },
    ...(theme.background ? { background: backgroundText(theme.background) } : {})
  })

  return { themes: THEMES.map(read), custom: custom.map(read) }
}

// Reading the master.

const fontName = (font: FontRef, deck: Deck): string => (font === '+heading' ? `heading (${deck.theme.fonts.heading})` : font === '+body' ? `body (${deck.theme.fonts.body})` : font)

/** A placeholder of the master or a layout as Hermes reads it: its role, place, and how its text looks. */
function readPlaceholder(deck: Deck, element: SlideElement) {
  const own = element.kind === 'text' || element.kind === 'shape' ? element.body : null

  return {
    id: element.id,
    role: element.placeholder?.role,
    box: [element.x, element.y, element.width, element.height].map(Math.round),
    ...(own
      ? {
          font: fontName(own.style.font, deck),
          size: own.style.size,
          color: colorName(own.style.color),
          ...(own.style.bold ? { bold: true } : {}),
          ...(own.style.italic ? { italic: true } : {}),
          align: own.paragraphs[0]?.align ?? 'left',
          anchor: own.anchor
        }
      : {})
  }
}

/** The master's own slide's or a layout's elements as Hermes reads them: its placeholders, and its drawings numbered from 1. */
const readPart = (deck: Deck, elements: readonly SlideElement[]) => ({
  placeholders: elements.filter((element) => element.placeholder).map((element) => readPlaceholder(deck, element)),
  elements: drawingsOf(elements).map((element, index) => ({ number: index + 1, ...readElement(element) }))
})

/**
 * The slide master and its layouts as Hermes reads them: the master's background, placeholders and
 * drawings; each layout's name, background, whether its slides show the master's graphics, its
 * placeholders and drawings and the slides on it; and the header and footer the slides show.
 */
export function readMaster(deck: Deck, only: MasterPlace | null = null) {
  const master = masterOf(deck)
  const headerFooter = readHeaderFooter(deck)

  return {
    master: { background: master.background ? backgroundText(master.background) : 'the theme’s background colour', ...readPart(deck, master.elements) },
    layouts: LAYOUTS.flatMap((id) => {
      if (only && only !== id) {
        return []
      }

      const layout = layoutIn(master, id)
      const slides = deck.slides.flatMap((slide, index) => (slide.layout === id ? [index + 1] : []))

      return [{ id, name: layout.name, background: layout.background ? backgroundText(layout.background) : 'the master’s', showsMasterGraphics: layout.showMaster, ...readPart(deck, layout.elements), slides }]
    }),
    ...(headerFooter ? { headerFooter } : {})
  }
}

// Batches.

/** The depth's changes a batch can make, each named after its command. */
export const DEPTH_STEPS: Readonly<Record<string, StepMaker>> = {
  setBackground: setBackgroundStep,
  addMasterText: addMasterTextStep,
  addMasterShape: addMasterShapeStep,
  addMasterImage: addMasterImageStep,
  addLogo: addLogoStep,
  removeFromMaster: removeFromMasterStep,
  setPlaceholder: setPlaceholderStep,
  showMasterGraphics: showMasterGraphicsStep,
  renameLayout: renameLayoutStep,
  resetMaster: resetMasterStep,
  setHeaderFooter: setHeaderFooterStep,
  setTransition: setTransitionStep,
  group: groupStep,
  ungroup: ungroupStep,
  rotate: rotateStep,
  convertToShapes: convertToShapesStep,
  addConnector: addConnectorStep,
  setCellBorders: setCellBordersStep,
  setFill: setFillStep,
  addSlideFromSheet: rangeSlidesStep
}

/** Every op of slides.edit: Phase 3's and the depth's. */
export const EDIT_STEPS: Readonly<Record<string, StepMaker>> = { ...STEPS, ...DEPTH_STEPS }

export const EDIT_OPS: readonly string[] = Object.keys(EDIT_STEPS)

/** The ops that put in a picture read from a file first. */
const PICTURE_OPS = new Set(['addImage', 'addMasterImage', 'addLogo', 'setBackground'])

/** A batch's edits, of any op slides.edit takes. */
export const editsOf = (value: unknown): SlideEdit[] => slideEditsOf(value, EDIT_OPS)

/** The picture files a batch puts in, to be read before it runs. */
export const batchPictures = (edits: readonly SlideEdit[]): string[] => edits.flatMap((edit) => (PICTURE_OPS.has(edit.op) && given(edit.source) ? [text(edit.source)] : []))

/** The workbooks a batch takes ranges from, to be read before it runs ('' for the one in front). */
export const batchWorkbooks = (edits: readonly SlideEdit[]): string[] => [...new Set(edits.flatMap((edit) => (edit.op === 'addSlideFromSheet' ? [text(edit.workbook)] : [])))]

/** A batch as one change, any op slides.edit takes in it. */
export const runBatch = (deck: Deck, edits: readonly SlideEdit[], context: StepContext): Step => runEdits(deck, edits, context, EDIT_STEPS)
