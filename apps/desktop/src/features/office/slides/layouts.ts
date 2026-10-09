import type { Anchor, Background, BodyStyle, Box, Deck, FooterRole, LayoutId, Master, Paragraph, PlaceholderRole, Slide, SlideElement, SlideLayout, SlideSize, TextAlign } from './deck.ts'
import { FOOTER_ROLES, LAYOUTS, newId, SLIDE_SIZES } from './deck.ts'
import { imageElement, textElement } from './elements.ts'
import { isBlank, textBody } from './text.ts'

/*
 * The slide master and its layouts: where each placeholder sits and how its text looks. Herald's
 * own master is laid out on a 16:9 slide of 960 by 540 points and stretched across for other
 * widths; a deck may have a master of its own (edited, or read from a PowerPoint file), whose
 * layouts' placeholders are elements like a slide's. A slide keeps the layout it was made from, so
 * a PowerPoint file gets a layout for each and changing layout moves text into its place.
 */

export const LAYOUT_NAMES: Record<LayoutId, string> = {
  title: 'Title',
  'title-content': 'Title and Content',
  'two-content': 'Two Content',
  section: 'Section Header',
  'title-only': 'Title Only',
  blank: 'Blank',
  'picture-caption': 'Picture with Caption',
  comparison: 'Comparison'
}

export const PROMPTS: Record<PlaceholderRole, string> = {
  title: 'Click to add title',
  subtitle: 'Click to add subtitle',
  body: 'Click to add text',
  heading: 'Click to add heading',
  caption: 'Click to add text',
  picture: 'Click to add a picture',
  date: 'Date',
  footer: 'Footer',
  number: '‹#›'
}

export const isFooterRole = (role: PlaceholderRole | undefined): role is FooterRole => FOOTER_ROLES.includes(role as FooterRole)

export interface PlaceholderSpec {
  role: PlaceholderRole
  box: Box
  style: BodyStyle
  anchor: Anchor
  align: TextAlign
  paragraph?: Omit<Paragraph, 'runs'>
  /** The prompt a slide's placeholder shows, where the layout has one of its own. */
  prompt?: string
}

const BASE = SLIDE_SIZES.wide

const title = (box: Box, size = 40, anchor: Anchor = 'middle', align: TextAlign = 'left'): PlaceholderSpec => ({ role: 'title', box, style: { font: '+heading', size, color: 'tx1' }, anchor, align })
const body = (box: Box, size = 24, role: PlaceholderRole = 'body'): PlaceholderSpec => ({ role, box, style: { font: '+body', size, color: 'tx1' }, anchor: 'top', align: 'left', paragraph: { list: 'bullet', spaceAfter: 6 } })
const subtitle = (box: Box, size: number, align: TextAlign): PlaceholderSpec => ({ role: 'subtitle', box, style: { font: '+body', size, color: 'tx2' }, anchor: 'top', align })
const footer = (role: FooterRole, box: Box, align: TextAlign): PlaceholderSpec => ({ role, box, style: { font: '+body', size: 12, color: 'tx2' }, anchor: 'middle', align })
const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height })

const SPECS: Record<LayoutId, PlaceholderSpec[]> = {
  title: [title(box(80, 150, 800, 130), 54, 'bottom', 'center'), subtitle(box(80, 292, 800, 80), 24, 'center')],
  'title-content': [title(box(60, 36, 840, 84)), body(box(60, 136, 840, 364))],
  'two-content': [title(box(60, 36, 840, 84)), body(box(60, 136, 408, 364), 22), body(box(492, 136, 408, 364), 22)],
  section: [title(box(66, 150, 828, 150), 48, 'bottom'), subtitle(box(66, 312, 828, 72), 22, 'left')],
  'title-only': [title(box(60, 36, 840, 84))],
  blank: [],
  'picture-caption': [
    title(box(66, 48, 316, 120), 28, 'bottom'),
    { role: 'picture', box: box(418, 48, 476, 444), style: { font: '+body', size: 18, color: 'tx1' }, anchor: 'top', align: 'left' },
    { role: 'caption', box: box(66, 180, 316, 312), style: { font: '+body', size: 16, color: 'tx2' }, anchor: 'top', align: 'left', paragraph: { spaceAfter: 6 } }
  ],
  comparison: [
    title(box(60, 30, 840, 76)),
    { role: 'heading', box: box(60, 118, 408, 44), style: { font: '+body', size: 22, color: 'tx1', bold: true }, anchor: 'bottom', align: 'left' },
    body(box(60, 168, 408, 332), 20),
    { role: 'heading', box: box(492, 118, 408, 44), style: { font: '+body', size: 22, color: 'tx1', bold: true }, anchor: 'bottom', align: 'left' },
    body(box(492, 168, 408, 332), 20)
  ]
}

/** The master's own placeholders: the title and text whose look the layouts take, and the date, footer and slide number. */
const MASTER_SPECS: PlaceholderSpec[] = [
  title(box(60, 36, 840, 84)),
  body(box(60, 136, 840, 344)),
  footer('date', box(60, 498, 216, 26), 'left'),
  footer('footer', box(318, 498, 324, 26), 'center'),
  footer('number', box(684, 498, 216, 26), 'right')
]

const scaled = (spec: PlaceholderSpec, size: SlideSize): PlaceholderSpec => {
  const sx = size.width / BASE.width
  const sy = size.height / BASE.height

  return { ...spec, box: { x: spec.box.x * sx, y: spec.box.y * sy, width: spec.box.width * sx, height: spec.box.height * sy } }
}

/** An empty placeholder: a text box that shrinks its text to fit, or a frame waiting for a picture. */
export function placeholderElement(spec: PlaceholderSpec): SlideElement {
  const placeholder = { role: spec.role, prompt: spec.prompt ?? PROMPTS[spec.role] }

  if (spec.role === 'picture') {
    return imageElement('', { width: 0, height: 0 }, spec.box, { placeholder })
  }

  return textElement(spec.box, textBody(spec.style, { anchor: spec.anchor, fit: isFooterRole(spec.role) ? 'none' : 'shrink', paragraph: { align: spec.align, ...spec.paragraph } }), { placeholder })
}

/** Where a placeholder element sits and how its text looks, as a layout passes it on to slides. */
export function specOf(element: SlideElement): PlaceholderSpec | null {
  if (!element.placeholder) {
    return null
  }

  const place = { x: element.x, y: element.y, width: element.width, height: element.height }
  const prompt = element.placeholder.prompt !== PROMPTS[element.placeholder.role] ? { prompt: element.placeholder.prompt } : {}

  if (element.kind !== 'text' && element.kind !== 'shape') {
    return { role: element.placeholder.role, box: place, style: { font: '+body', size: 18, color: 'tx1' }, anchor: 'top', align: 'left', ...prompt }
  }

  const first = element.body.paragraphs[0]
  const paragraph: Omit<Paragraph, 'runs'> = { ...first }
  delete (paragraph as Partial<Paragraph>).runs
  delete paragraph.align

  return { role: element.placeholder.role, box: place, style: element.body.style, anchor: element.body.anchor, align: first?.align ?? 'left', ...(Object.keys(paragraph).length ? { paragraph } : {}), ...prompt }
}

/** A master layout made of placeholder specs. */
const layoutFrom = (id: LayoutId, specs: readonly PlaceholderSpec[]): SlideLayout => ({ id, name: LAYOUT_NAMES[id], background: null, elements: specs.map(placeholderElement), showMaster: true })

const defaults = new Map<string, Master>()

/** Herald's own master for a slide size: the placeholders above, no drawings, the theme's background. */
export function defaultMaster(size: SlideSize = BASE): Master {
  const key = `${size.width}x${size.height}`
  let master = defaults.get(key)

  if (!master) {
    master = { background: null, elements: MASTER_SPECS.map((spec) => placeholderElement(scaled(spec, size))), layouts: LAYOUTS.map((id) => layoutFrom(id, SPECS[id].map((spec) => scaled(spec, size)))) }
    defaults.set(key, master)
  }

  return master
}

/** A deck's master: its own, or Herald's for its size. */
export const masterOf = (deck: Pick<Deck, 'master' | 'size'>): Master => deck.master ?? defaultMaster(deck.size)

/** One of a master's layouts (Herald's own when the master has none of that id). */
export const layoutOf = (master: Master, id: LayoutId): SlideLayout => master.layouts.find((layout) => layout.id === id) ?? layoutFrom(id, SPECS[id])

/** The master's placeholder of a role (its title, text, date, footer or slide number). */
export const masterPlaceholder = (master: Master, role: PlaceholderRole): SlideElement | undefined => master.elements.find((element) => element.placeholder?.role === role)

/** Where a slide on a layout shows the date, footer or slide number: the layout's own place for it, or the master's. */
export const footerPlace = (master: Master, layout: LayoutId, role: FooterRole): SlideElement | undefined =>
  layoutOf(master, layout).elements.find((element) => element.placeholder?.role === role) ?? masterPlaceholder(master, role)

/** A layout's placeholders on a slide of `size`: the master's, when given, or Herald's own stretched to the size. */
export function layoutPlaceholders(layout: LayoutId, size: SlideSize = BASE, master?: Master): PlaceholderSpec[] {
  if (master) {
    return layoutOf(master, layout)
      .elements.filter((element) => element.placeholder && !isFooterRole(element.placeholder.role))
      .map(specOf)
      .filter((spec): spec is PlaceholderSpec => spec !== null)
  }

  return SPECS[layout].map((spec) => scaled(spec, size))
}

export function newSlide(layout: LayoutId, size: SlideSize = BASE, master?: Master): Slide {
  return { id: newId('slide'), layout, background: null, elements: layoutPlaceholders(layout, size, master).map(placeholderElement), notes: '', hidden: false }
}

/** Whether an element still shows only its placeholder's prompt. */
export function isEmptyPlaceholder(element: SlideElement): boolean {
  if (!element.placeholder) {
    return false
  }

  if (element.kind === 'image') {
    return !element.src
  }

  return element.kind === 'text' || element.kind === 'shape' ? isBlank(element.body) : false
}

/**
 * A slide moved onto another layout: each new placeholder takes the content of the first unused
 * placeholder of the same role, in the new layout's place; content with no place of its own stays
 * where it was as an ordinary element, and empty placeholders with no place go.
 */
export function changeLayout(slide: Slide, layout: LayoutId, size: SlideSize = BASE, master?: Master): Slide {
  const old = slide.elements.filter((element) => element.placeholder)
  const used = new Set<string>()
  const placed: SlideElement[] = layoutPlaceholders(layout, size, master).map((spec) => {
    const match = old.find((element) => !used.has(element.id) && element.placeholder?.role === spec.role)

    if (!match) {
      return placeholderElement(spec)
    }

    used.add(match.id)

    return { ...match, ...spec.box, rotation: 0 } as SlideElement
  })
  const rest = slide.elements.flatMap((element): SlideElement[] => {
    if (!element.placeholder) {
      return [element]
    }

    if (used.has(element.id) || isEmptyPlaceholder(element)) {
      return []
    }

    const free = { ...element }
    delete free.placeholder

    return [free]
  })

  return { ...slide, layout, elements: [...placed, ...rest] }
}

/** The background a slide shows: its own, else its layout's, else the master's; null is the theme's background colour. */
export const backgroundOf = (deck: Pick<Deck, 'master' | 'size'>, slide: Pick<Slide, 'background' | 'layout'>): Background | null => {
  const master = masterOf(deck)

  return slide.background ?? layoutOf(master, slide.layout).background ?? master.background
}

/** The master's and the layout's drawings a slide shows behind its own, in drawing order (placeholders are not drawn). */
export function decorationsOf(deck: Pick<Deck, 'master' | 'size'>, layoutId: LayoutId, slide?: Pick<Slide, 'showMaster'>): SlideElement[] {
  if (slide?.showMaster === false) {
    return []
  }

  const master = masterOf(deck)
  const layout = layoutOf(master, layoutId)
  const drawn = (element: SlideElement) => !element.placeholder

  return [...(layout.showMaster ? master.elements.filter(drawn) : []), ...layout.elements.filter(drawn)]
}

/** The element a role's text goes into on a slide (the first such placeholder). */
export const placeholderFor = (slide: Slide, role: PlaceholderRole, nth = 0): SlideElement | undefined => slide.elements.filter((element) => element.placeholder?.role === role)[nth]
