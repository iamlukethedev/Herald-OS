import type { Anchor, Background, BodyStyle, Box, Deck, HeaderFooter, LayoutId, Master, PlaceholderRole, RunStyle, ShapeElement, Slide, SlideElement, SlideLayout, TextAlign, TextElement } from './deck.ts'
import { findSlide, FOOTER_ROLES, LAYOUTS, withSlide } from './deck.ts'
import { imageElement, withBox } from './elements.ts'
import { headerFooterOf } from './footers.ts'
import { defaultMaster, footerPlace, LAYOUT_NAMES, layoutOf, masterOf, masterPlaceholder } from './layouts.ts'
import type { DeckChange } from './model.ts'
import { RUN_KEYS, styleAll } from './text.ts'

/*
 * Editing the slide master and its layouts. The master and each layout open as the slides of a
 * deck of their own (`masterDeck`), so the ordinary editor edits them, and the edited deck goes
 * back into the presentation (`applyMasterDeck`). As PowerPoint passes a master's look down, a
 * change to the master's title, text or footer placeholders reaches the layouts' placeholders that
 * still looked like the master's, and a change to a layout's placeholders reaches its slides'
 * placeholders that still looked like the layout's; whatever a layout or a slide made its own stays.
 */

/** The master's own slide in the master's deck. */
export const MASTER_SLIDE_ID = 'master'

/** A layout's slide in the master's deck. */
export const layoutSlideId = (layout: LayoutId): string => `layout-${layout}`

/** The layout a slide of the master's deck stands for; null for the master's own slide (or any other). */
export function slideLayoutId(slideId: string): LayoutId | null {
  const id = slideId.slice('layout-'.length) as LayoutId

  return slideId.startsWith('layout-') && LAYOUTS.includes(id) ? id : null
}

const masterDecks = new WeakMap<Master, Deck>()

const page = (id: string, layout: LayoutId, background: Background | null, elements: SlideElement[]): Slide => ({ id, layout, background, elements, notes: '', hidden: false })

/**
 * The master and its layouts as a deck: the master's slide (on the Blank layout, with the master's
 * background and elements) and then a slide for each layout (`layout-title`…), in the deck's size
 * and theme, without header or footer. The same deck comes back while the master is unchanged.
 */
export function masterDeck(deck: Deck): Deck {
  const master = masterOf(deck)
  const known = masterDecks.get(master)

  if (known && known.id === deck.id && known.title === deck.title && known.theme === deck.theme && known.size.width === deck.size.width && known.size.height === deck.size.height) {
    return known
  }

  const layouts = LAYOUTS.map((id) => layoutOf(master, id))
  const made: Deck = {
    id: deck.id,
    title: deck.title,
    size: deck.size,
    theme: deck.theme,
    transition: 'none',
    // Behind each layout's slide its master shows through; the master's own slide shares the Blank layout, so Blank shows nothing behind.
    master: {
      background: master.background,
      elements: master.elements.filter((element) => !element.placeholder),
      layouts: layouts.map((layout) => ({ ...layout, background: null, elements: [], showMaster: layout.id !== 'blank' && layout.showMaster }))
    },
    slides: [page(MASTER_SLIDE_ID, 'blank', master.background, master.elements), ...layouts.map((layout) => page(layoutSlideId(layout.id), layout.id, layout.background, layout.elements))]
  }
  masterDecks.set(master, made)

  return made
}

const NONE = Symbol('none')

type TextLike = TextElement | ShapeElement

const isText = (element: SlideElement): element is TextLike => element.kind === 'text' || element.kind === 'shape'

/** Values alike, a switch left unset being off. */
const sameValue = (a: unknown, b: unknown): boolean => (a ?? false) === (b ?? false)

/** One thing a placeholder passes on: where it is, its prompt, or a part of how its text looks. */
interface Aspect {
  /** Its value on an element; NONE when the element has no such thing (a picture's text style). */
  get: (element: SlideElement) => unknown
  same: (a: unknown, b: unknown) => boolean
  /** The element with `to` wherever it still has `from`. */
  follow: (element: SlideElement, from: unknown, to: unknown) => SlideElement
}

const followWhole = (aspect: Pick<Aspect, 'get' | 'same'>, set: (element: SlideElement, to: unknown) => SlideElement): Aspect => ({
  ...aspect,
  follow: (element, from, to) => {
    const now = aspect.get(element)

    return now !== NONE && aspect.same(now, from) ? set(element, to) : element
  }
})

const BOX_KEYS = ['x', 'y', 'width', 'height'] as const

const BOX = followWhole(
  {
    get: (element) => ({ x: element.x, y: element.y, width: element.width, height: element.height }),
    same: (a, b) => BOX_KEYS.every((key) => Math.abs((a as Box)[key] - (b as Box)[key]) <= 0.5)
  },
  (element, to) => withBox(element, to as Box)
)

const PROMPT = followWhole({ get: (element) => element.placeholder?.prompt ?? NONE, same: (a, b) => a === b }, (element, to) =>
  element.placeholder ? { ...element, placeholder: { ...element.placeholder, prompt: String(to) } } : element
)

const ANCHOR = followWhole({ get: (element) => (isText(element) ? element.body.anchor : NONE), same: (a, b) => a === b }, (element, to) =>
  isText(element) ? { ...element, body: { ...element.body, anchor: to as Anchor } } : element
)

const styleAspect = (key: keyof RunStyle): Aspect =>
  followWhole({ get: (element) => (isText(element) ? element.body.style[key] : NONE), same: sameValue }, (element, to) => {
    if (!isText(element)) {
      return element
    }

    const style: Record<string, unknown> = { ...element.body.style }

    if (to === undefined) {
      delete style[key]
    } else {
      style[key] = to
    }

    return { ...element, body: { ...element.body, style: style as unknown as BodyStyle } }
  })

/** A first paragraph's settings that pass on: its alignment, list and spacing (not its level, which is the text's own). */
const PARAGRAPH_KEYS = ['align', 'list', 'bullet', 'numbering', 'startAt', 'lineSpacing', 'spaceBefore', 'spaceAfter', 'margin', 'indent'] as const

const paragraphAspect = (key: (typeof PARAGRAPH_KEYS)[number]): Aspect => {
  const same = key === 'align' ? (a: unknown, b: unknown) => (a ?? 'left') === (b ?? 'left') : sameValue

  return {
    get: (element) => (isText(element) ? element.body.paragraphs[0]?.[key] : NONE),
    same,
    follow: (element, from, to) => {
      if (!isText(element) || !element.body.paragraphs.some((paragraph) => same(paragraph[key], from))) {
        return element
      }

      const paragraphs = element.body.paragraphs.map((paragraph) => {
        if (!same(paragraph[key], from)) {
          return paragraph
        }

        const next: Record<string, unknown> = { ...paragraph }

        if (to === undefined) {
          delete next[key]
        } else {
          next[key] = to
        }

        return next as unknown as typeof paragraph
      })

      return { ...element, body: { ...element.body, paragraphs } }
    }
  }
}

const ASPECTS: readonly Aspect[] = [BOX, PROMPT, ANCHOR, ...RUN_KEYS.map(styleAspect), ...PARAGRAPH_KEYS.map(paragraphAspect)]

interface Change {
  aspect: Aspect
  from: unknown
  to: unknown
}

/** What changed from one placeholder to another, aspect by aspect. */
function changesBetween(before: SlideElement, after: SlideElement): Change[] {
  if (before === after) {
    return []
  }

  return ASPECTS.flatMap((aspect) => {
    const from = aspect.get(before)
    const to = aspect.get(after)

    return from === NONE || to === NONE || aspect.same(from, to) ? [] : [{ aspect, from, to }]
  })
}

const ofRole = (elements: readonly SlideElement[], role: PlaceholderRole): SlideElement[] => elements.filter((element) => element.placeholder?.role === role)

/** The placeholder in `others` that is `element` of `among`: the same element, else the one of its role in the same place among them. */
function counterpart(element: SlideElement, among: readonly SlideElement[], others: readonly SlideElement[]): SlideElement | undefined {
  const role = element.placeholder?.role
  const same = others.find((other) => other.id === element.id && other.placeholder?.role === role)

  return same ?? (role ? ofRole(others, role)[ofRole(among, role).indexOf(element)] : undefined)
}

/** The roles whose master placeholder the layouts' follow. */
const MASTER_ROLES: readonly PlaceholderRole[] = ['title', 'body', ...FOOTER_ROLES]

/** A layout whose placeholders follow the master's changes where they were left as the master had them and this edit did not touch them. */
function followMaster(layout: SlideLayout, before: SlideLayout, oldMaster: Master, newMaster: Master): SlideLayout {
  let elements = layout.elements

  for (const role of MASTER_ROLES) {
    const from = masterPlaceholder(oldMaster, role)
    const to = masterPlaceholder(newMaster, role)
    const changes = from && to ? changesBetween(from, to) : []

    if (!changes.length) {
      continue
    }

    elements = elements.map((element) => {
      const was = element.placeholder?.role === role ? counterpart(element, layout.elements, before.elements) : undefined

      return was ? changes.reduce((next, change) => (change.aspect.same(change.aspect.get(element), change.aspect.get(was)) ? change.aspect.follow(next, change.from, change.to) : next), element) : element
    })
  }

  return elements.every((element, index) => element === layout.elements[index]) ? layout : { ...layout, elements }
}

/** A slide whose placeholders follow its layout's changes where they still looked like the layout's (by role, the first title with the first title and so on). */
function followLayout(slide: Slide, before: SlideLayout, after: SlideLayout): Slide {
  if (before.elements === after.elements) {
    return slide
  }

  let elements = slide.elements

  for (const old of before.elements) {
    const role = old.placeholder?.role
    const now = role ? counterpart(old, before.elements, after.elements) : undefined
    const changes = now ? changesBetween(old, now) : []
    const target = role && changes.length ? ofRole(elements, role)[ofRole(before.elements, role).indexOf(old)] : undefined

    if (target) {
      const followed = changes.reduce((next, change) => change.aspect.follow(next, change.from, change.to), target)
      elements = elements.map((element) => (element === target ? followed : element))
    }
  }

  return elements.every((element, index) => element === slide.elements[index]) ? slide : { ...slide, elements }
}

/** The deck with a new master, the layouts following the master's placeholders (unless `follow` is off) and the slides their layouts'. */
function withMaster(deck: Deck, next: Master, follow = true): Deck {
  const old = masterOf(deck)

  if (next.background === old.background && next.elements === old.elements && next.layouts.length === old.layouts.length && next.layouts.every((layout, index) => layout === old.layouts[index])) {
    return deck
  }

  const master = follow ? { ...next, layouts: next.layouts.map((layout) => followMaster(layout, layoutOf(old, layout.id), old, next)) } : next
  let changed = false
  const slides = deck.slides.map((slide) => {
    const followed = followLayout(slide, layoutOf(old, slide.layout), layoutOf(master, slide.layout))
    changed ||= followed !== slide

    return followed
  })

  return { ...deck, master, slides: changed ? slides : deck.slides }
}

/**
 * The master's deck (as `masterDeck` made it, then edited) back into the presentation as its master:
 * the master's slide gives the master's background and elements, each layout's slide its layout's.
 * Placeholders pass their changes on to the layouts and slides that had not changed them.
 */
export function applyMasterDeck(deck: Deck, edited: Deck): Deck {
  const master = masterOf(deck)
  const own = findSlide(edited, MASTER_SLIDE_ID)
  const layouts = LAYOUTS.map((id) => {
    const layout = layoutOf(master, id)
    const slide = findSlide(edited, layoutSlideId(id))

    return slide && (slide.background !== layout.background || slide.elements !== layout.elements) ? { ...layout, background: slide.background, elements: slide.elements } : layout
  })

  return withMaster(deck, { background: own ? own.background : master.background, elements: own ? own.elements : master.elements, layouts })
}

/** The master's own slide or a layout's, changed in the master's deck and passed on. */
function editIn(deck: Deck, where: 'master' | LayoutId, change: (slide: Slide) => Slide): Deck {
  return applyMasterDeck(deck, withSlide(masterDeck(deck), where === 'master' ? MASTER_SLIDE_ID : layoutSlideId(where), change))
}

/** The background of every slide that has none of its own and whose layout has none either; null for the theme's background colour. */
export const setMasterBackground = (deck: Deck, background: Background | null): DeckChange => ({ deck: editIn(deck, 'master', (slide) => ({ ...slide, background })), label: 'Master Background' })

/** A layout's background for its slides that have none of their own; null for the master's. */
export const setLayoutBackground = (deck: Deck, layoutId: LayoutId, background: Background | null): DeckChange => ({
  deck: editIn(deck, layoutId, (slide) => ({ ...slide, background })),
  label: 'Layout Background'
})

/** Drawings added on top of the master's (shown on every slide whose layout shows the master's), or of a layout's. */
export function addMasterElements(deck: Deck, elements: readonly SlideElement[], layoutId?: LayoutId): DeckChange {
  const label = layoutId ? 'Add to Layout' : 'Add to Master'

  return elements.length ? { deck: editIn(deck, layoutId ?? 'master', (slide) => ({ ...slide, elements: [...slide.elements, ...elements] })), label } : { deck, label }
}

export type LogoCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export interface LogoOptions {
  /** A data URL. */
  src: string
  natural: { width: number; height: number }
  corner: LogoCorner
  /** Points; when not given, 96 on a slide 540 high and in proportion on others. */
  width?: number
  /** On one layout's slides only, instead of the master's. */
  layoutId?: LayoutId
  alt?: string
}

/** The boxes of the date, footer and slide number on the slides that show the master's drawings (or a layout's). */
function footerBoxes(deck: Deck, layoutId?: LayoutId): Box[] {
  const master = masterOf(deck)
  const layouts = layoutId ? [layoutId] : LAYOUTS.filter((id) => layoutOf(master, id).showMaster)

  return layouts.flatMap((id) => FOOTER_ROLES.flatMap((role) => footerPlace(master, id, role) ?? []))
}

/** A logo on the master (or a layout): a picture in a corner of every slide, set in from the edges and clear of the date, footer and slide number. */
export function addLogo(deck: Deck, options: LogoOptions): DeckChange & { elementId: string } {
  const scale = deck.size.height / 540
  const margin = 24 * scale
  const ratio = options.natural.width > 0 && options.natural.height > 0 ? options.natural.width / options.natural.height : 1
  let width = Math.max(8, Math.min(options.width ?? 96 * scale, deck.size.width / 3))
  let height = width / ratio

  if (height > deck.size.height * 0.15) {
    height = deck.size.height * 0.15
    width = height * ratio
  }

  const x = options.corner.endsWith('right') ? deck.size.width - margin - width : margin
  let y = margin

  if (options.corner.startsWith('bottom')) {
    const below = footerBoxes(deck, options.layoutId).filter((box) => box.x < x + width && box.x + box.width > x)
    y = Math.max(margin, Math.min(deck.size.height - margin, ...below.map((box) => box.y - 8 * scale)) - height)
  }

  const logo = imageElement(options.src, options.natural, { x, y, width, height }, { name: 'Logo', alt: options.alt ?? 'Logo' })

  return { ...addMasterElements(deck, [logo], options.layoutId), label: 'Logo', elementId: logo.id }
}

/** Drawings or placeholders taken off the master and its layouts. */
export function removeMasterElements(deck: Deck, ids: readonly string[]): DeckChange {
  const wanted = new Set(ids)
  const edited = masterDeck(deck)

  return {
    deck: applyMasterDeck(deck, { ...edited, slides: edited.slides.map((slide) => (slide.elements.some((element) => wanted.has(element.id)) ? { ...slide, elements: slide.elements.filter((element) => !wanted.has(element.id)) } : slide)) }),
    label: 'Delete'
  }
}

const ROLE_NAMES: Record<PlaceholderRole, string> = { title: 'title', subtitle: 'subtitle', body: 'text', heading: 'heading', caption: 'caption', picture: 'picture', date: 'date', footer: 'footer', number: 'slide number' }

/** A placeholder of the master or a layout (the `nth` of its role) changed, and the change passed on. */
function editPlaceholder(deck: Deck, where: 'master' | LayoutId, role: PlaceholderRole, nth: number, change: (element: SlideElement) => SlideElement): Deck {
  return editIn(deck, where, (slide) => {
    const target = ofRole(slide.elements, role)[nth]

    if (!target) {
      throw new Error(`${where === 'master' ? 'The slide master' : `The ${LAYOUT_NAMES[where]} layout`} has no ${nth ? `${ROLE_NAMES[role]} placeholder ${nth + 1}` : `${ROLE_NAMES[role]} placeholder`}`)
    }

    return { ...slide, elements: slide.elements.map((element) => (element === target ? change(element) : element)) }
  })
}

/** Where a placeholder of the master or a layout sits; layouts' and slides' placeholders that sat where it did move with it. */
export const setPlaceholderBox = (deck: Deck, where: 'master' | LayoutId, role: PlaceholderRole, box: Box, nth = 0): DeckChange => ({
  deck: editPlaceholder(deck, where, role, nth, (element) => withBox(element, box)),
  label: 'Placeholder'
})

export type PlaceholderStyle = Partial<BodyStyle> & { align?: TextAlign; anchor?: Anchor }

/** How a placeholder's text of the master or a layout looks; layouts' and slides' placeholders that looked as it did follow. */
export function setPlaceholderStyle(deck: Deck, where: 'master' | LayoutId, role: PlaceholderRole, patch: PlaceholderStyle, nth = 0): DeckChange {
  const { align, anchor, ...rest } = patch
  const style = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as Partial<BodyStyle>

  return {
    deck: editPlaceholder(deck, where, role, nth, (element) => {
      if (!isText(element)) {
        throw new Error('That placeholder holds a picture, not text')
      }

      const styled = Object.keys(style).length ? styleAll(element.body, style) : element.body
      const anchored = anchor ? { ...styled, anchor } : styled

      return { ...element, body: align ? { ...anchored, paragraphs: anchored.paragraphs.map((paragraph) => ({ ...paragraph, align })) } : anchored }
    }),
    label: 'Placeholder Style'
  }
}

/** A layout changed in itself (not in what its slides show from it). */
function changeLayoutItself(deck: Deck, layoutId: LayoutId, label: string, change: (layout: SlideLayout) => SlideLayout): DeckChange {
  const master = masterOf(deck)
  const layout = layoutOf(master, layoutId)
  const next = change(layout)

  return next === layout ? { deck, label } : { deck: withMaster(deck, { ...master, layouts: LAYOUTS.map((id) => (id === layoutId ? next : layoutOf(master, id))) }), label }
}

/** Whether a layout's slides show the master's drawings (PowerPoint's Hide Background Graphics, the other way round). */
export const setShowMaster = (deck: Deck, layoutId: LayoutId, show: boolean): DeckChange =>
  changeLayoutItself(deck, layoutId, show ? 'Show Background Graphics' : 'Hide Background Graphics', (layout) => (layout.showMaster === show ? layout : { ...layout, showMaster: show }))

/** A layout's name as PowerPoint shows it; an empty name gives back Herald's. */
export function renameLayout(deck: Deck, layoutId: LayoutId, name: string): DeckChange {
  const next = name.trim().slice(0, 200) || LAYOUT_NAMES[layoutId]

  return changeLayoutItself(deck, layoutId, 'Rename Layout', (layout) => (layout.name === next ? layout : { ...layout, name: next }))
}

/** Herald's own master for the deck's size in place of the deck's; slides' placeholders that looked as their layout's had them move to Herald's. */
export function resetMaster(deck: Deck): DeckChange {
  if (!deck.master) {
    return { deck, label: 'Reset Master' }
  }

  const next = { ...withMaster(deck, defaultMaster(deck.size), false) }
  delete next.master

  return { deck: next, label: 'Reset Master' }
}

/** The deck's header and footer settings: whether slides show the date, footer and slide number, and what they say. */
export function setHeaderFooter(deck: Deck, patch: Partial<HeaderFooter>): DeckChange {
  const current = headerFooterOf(deck)
  const next: HeaderFooter = { ...current, ...(Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<HeaderFooter>) }

  if (!next.dateText?.trim()) {
    delete next.dateText
  }

  const keys = new Set([...Object.keys(current), ...Object.keys(next)]) as Set<keyof HeaderFooter>
  const same = [...keys].every((key) => current[key] === next[key])

  return same ? { deck, label: 'Header and Footer' } : { deck: { ...deck, headerFooter: next }, label: 'Header and Footer' }
}
