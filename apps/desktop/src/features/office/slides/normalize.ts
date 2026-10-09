import {
  ARROW_HEADS,
  type Background,
  type BodyStyle,
  type CellBorders,
  type Color,
  type Connector,
  CONNECTOR_PRESETS,
  type ConnectorEnd,
  type Crop,
  type CustomPath,
  DASHES,
  DATE_FORMATS,
  type Deck,
  DEFAULT_TRANSITION_MS,
  type Fill,
  type FontRef,
  type Gradient,
  type GradientStop,
  type HeaderFooter,
  type KeptPart,
  LAYOUTS,
  type Master,
  newId,
  NUMBER_STYLES,
  OBJECT_KINDS,
  type Paragraph,
  type Placeholder,
  type PlaceholderRole,
  SHAPE_KINDS,
  type Slide,
  type SlideElement,
  type SlideLayout,
  SLIDE_SIZES,
  type SlideSize,
  type SlideTransition,
  SLOTS,
  type Stroke,
  type TableCell,
  type TableElement,
  type TextBody,
  type TextRun,
  type Theme,
  TRANSITION_DIRECTIONS,
  TRANSITIONS
} from './deck.ts'
import { defaultMaster, LAYOUT_NAMES, PROMPTS } from './layouts.ts'
import { MAX_COLUMNS, MAX_ROWS, ROW_HEIGHT, settleSpans } from './tables.ts'
import { colorOf, DEFAULT_THEME, normalHex } from './themes.ts'
import { DEFAULT_INSET, MAX_LEVEL } from './text.ts'

/*
 * A deck as read from a file, made safe and whole: every field is checked and given its default
 * when it is missing or wrong, unknown kinds are dropped, and pictures may only be image data. A
 * file is never trusted to be what Herald wrote; what fails here is left out, never shown broken.
 */

type Raw = Record<string, unknown>

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value)

const list = (value: unknown, most: number): unknown[] => (Array.isArray(value) ? value.slice(0, most) : [])

function num(value: unknown, fallback: number, low = -100_000, high = 100_000): number {
  const n = typeof value === 'number' ? value : Number.NaN

  return Number.isFinite(n) ? Math.max(low, Math.min(high, n)) : fallback
}

const str = (value: unknown, fallback = '', most = 10_000): string => (typeof value === 'string' ? value.slice(0, most) : fallback)

const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => (options.includes(value as T) ? (value as T) : fallback)

const flag = (value: unknown): boolean => value === true

const color = (value: unknown, fallback: Color): Color => colorOf(value) ?? fallback

function font(value: unknown, fallback: FontRef): FontRef {
  if (value === '+heading' || value === '+body') {
    return value
  }

  const clean = str(value, '', 80)
    .replace(/["\\;{}<>]/g, '')
    .trim()

  return clean || fallback
}

const IMAGE_DATA = /^data:image\/(png|jpeg|gif|webp|bmp|svg\+xml);base64,[A-Za-z0-9+/=\r\n]*$/

/** A picture source Herald shows: image data, nothing else. */
export const imageSource = (value: unknown): string => {
  const text = str(value, '', 400_000_000)

  return IMAGE_DATA.test(text) ? text : ''
}

function theme(value: unknown): Theme {
  if (!isObject(value)) {
    return DEFAULT_THEME
  }

  const colors = isObject(value.colors) ? value.colors : {}
  const fonts = isObject(value.fonts) ? value.fonts : {}

  const own = background(value.background)

  return {
    id: str(value.id, 'custom', 80) || 'custom',
    name: str(value.name, 'Theme', 120) || 'Theme',
    colors: Object.fromEntries(SLOTS.map((slot) => [slot, normalHex(colors[slot]) ?? DEFAULT_THEME.colors[slot]])) as Theme['colors'],
    fonts: { heading: font(fonts.heading, DEFAULT_THEME.fonts.heading).replace(/^\+.*/, DEFAULT_THEME.fonts.heading), body: font(fonts.body, DEFAULT_THEME.fonts.body).replace(/^\+.*/, DEFAULT_THEME.fonts.body) },
    ...(own && own.kind !== 'image' ? { background: own } : {})
  }
}

/** A theme checked as `theme` does, for a custom theme read from a file of themes. */
export const normalizeTheme = (value: unknown): Theme => theme(value)

function run(value: unknown): TextRun | null {
  if (!isObject(value)) {
    return null
  }

  const out: TextRun = { text: str(value.text, '', 200_000) }

  if (value.font !== undefined) out.font = font(value.font, '+body')
  if (value.size !== undefined) out.size = num(value.size, 18, 1, 4000)
  if (value.color !== undefined) out.color = color(value.color, 'tx1')
  if (value.highlight !== undefined) out.highlight = color(value.highlight, '#ffff00')

  for (const key of ['bold', 'italic', 'underline', 'strike'] as const) {
    if (typeof value[key] === 'boolean') {
      out[key] = value[key] as boolean
    }
  }

  return out
}

function paragraph(value: unknown): Paragraph | null {
  if (!isObject(value)) {
    return null
  }

  const runs = list(value.runs, 5000)
    .map(run)
    .filter((entry): entry is TextRun => entry !== null)
  const out: Paragraph = { runs: runs.length ? runs : [{ text: '' }] }

  if (value.align !== undefined) out.align = oneOf(value.align, ['left', 'center', 'right', 'justify'] as const, 'left')
  if (value.list === 'bullet' || value.list === 'number') out.list = value.list
  if (value.level !== undefined) out.level = Math.round(num(value.level, 0, 0, MAX_LEVEL))
  if (typeof value.bullet === 'string' && value.bullet) out.bullet = [...value.bullet][0]
  if (value.numbering !== undefined) out.numbering = oneOf(value.numbering, NUMBER_STYLES, 'arabicPeriod')
  if (value.startAt !== undefined) out.startAt = Math.round(num(value.startAt, 1, 1, 30000))
  if (value.lineSpacing !== undefined) out.lineSpacing = num(value.lineSpacing, 1, 0.1, 10)
  if (value.spaceBefore !== undefined) out.spaceBefore = num(value.spaceBefore, 0, 0, 2000)
  if (value.spaceAfter !== undefined) out.spaceAfter = num(value.spaceAfter, 0, 0, 2000)
  if (value.margin !== undefined) out.margin = num(value.margin, 0, 0, 2000)
  if (value.indent !== undefined) out.indent = num(value.indent, 0, -2000, 2000)

  return out
}

function body(value: unknown): TextBody {
  const raw = isObject(value) ? value : {}
  const style = isObject(raw.style) ? raw.style : {}
  const paragraphs = list(raw.paragraphs, 5000)
    .map(paragraph)
    .filter((entry): entry is Paragraph => entry !== null)
  const inset = list(raw.inset, 4)
  const bodyStyle: BodyStyle = { font: font(style.font, '+body'), size: num(style.size, 18, 1, 4000), color: color(style.color, 'tx1') }

  for (const key of ['bold', 'italic', 'underline', 'strike'] as const) {
    if (typeof style[key] === 'boolean') {
      bodyStyle[key] = style[key] as boolean
    }
  }

  if (style.highlight !== undefined) {
    bodyStyle.highlight = color(style.highlight, '#ffff00')
  }

  return {
    paragraphs: paragraphs.length ? paragraphs : [{ runs: [{ text: '' }] }],
    style: bodyStyle,
    anchor: oneOf(raw.anchor, ['top', 'middle', 'bottom'] as const, 'top'),
    inset: inset.length === 4 ? (inset.map((entry, index) => num(entry, DEFAULT_INSET[index], 0, 2000)) as TextBody['inset']) : [...DEFAULT_INSET],
    fit: oneOf(raw.fit, ['none', 'shrink', 'grow'] as const, 'none'),
    wrap: raw.wrap !== false
  }
}

const stops = (value: unknown, fallback: Color): GradientStop[] =>
  list(value, 16)
    .filter(isObject)
    .map((stop): GradientStop => ({ at: num(stop.at, 0, 0, 1), color: color(stop.color, fallback), ...(stop.alpha !== undefined ? { alpha: num(stop.alpha, 1, 0, 1) } : {}) }))

function gradient(value: unknown): Gradient | undefined {
  if (!isObject(value)) {
    return undefined
  }

  const points = stops(value.stops, 'accent1')

  return points.length >= 2 ? { stops: points, angle: num(value.angle, 90, -3600, 3600), ...(value.radial === true ? { radial: true } : {}) } : undefined
}

function fill(value: unknown): Fill | null {
  if (!isObject(value)) {
    return null
  }

  const shaded = gradient(value.gradient)

  return { color: color(value.color, 'accent1'), ...(value.alpha !== undefined ? { alpha: num(value.alpha, 1, 0, 1) } : {}), ...(shaded ? { gradient: shaded } : {}) }
}

function stroke(value: unknown): Stroke | null {
  if (!isObject(value)) {
    return null
  }

  return { color: color(value.color, 'tx1'), width: num(value.width, 1, 0, 200), dash: oneOf(value.dash, DASHES, 'solid'), ...(value.alpha !== undefined ? { alpha: num(value.alpha, 1, 0, 1) } : {}) }
}

function crop(value: unknown): Crop | undefined {
  if (!isObject(value)) {
    return undefined
  }

  const side = (key: string) => num(value[key], 0, 0, 0.99)
  const out = { left: side('left'), top: side('top'), right: side('right'), bottom: side('bottom') }

  return out.left + out.right < 0.99 && out.top + out.bottom < 0.99 ? out : undefined
}

function placeholder(value: unknown): Placeholder | undefined {
  if (!isObject(value)) {
    return undefined
  }

  const role = oneOf<PlaceholderRole>(value.role, ['title', 'subtitle', 'body', 'heading', 'caption', 'picture', 'date', 'footer', 'number'], 'body')

  return { role, prompt: str(value.prompt, PROMPTS[role], 200) || PROMPTS[role] }
}

function borders(value: unknown): CellBorders | undefined {
  if (!isObject(value)) {
    return undefined
  }

  const out: CellBorders = {}

  for (const side of ['left', 'top', 'right', 'bottom'] as const) {
    if (value[side] === null) {
      out[side] = null
    } else if (isObject(value[side])) {
      out[side] = stroke(value[side])
    }
  }

  return Object.keys(out).length ? out : undefined
}

function cell(value: unknown): TableCell {
  const raw = isObject(value) ? value : {}
  const across = Math.round(num(raw.colSpan, 1, 1, MAX_COLUMNS))
  const down = Math.round(num(raw.rowSpan, 1, 1, MAX_ROWS))
  const lines = borders(raw.borders)

  return { body: body(raw.body), fill: fill(raw.fill), ...(across > 1 ? { colSpan: across } : {}), ...(down > 1 ? { rowSpan: down } : {}), ...(lines ? { borders: lines } : {}) }
}

const PATH_DATA = /^[MLCQZ0-9eE.,\s+-]*$/

function paths(value: unknown): CustomPath[] | undefined {
  const out = list(value, 64)
    .filter(isObject)
    .map((path): CustomPath | null => {
      const d = str(path.d, '', 2_000_000).trim()

      return d && PATH_DATA.test(d)
        ? { width: num(path.width, 1, 0, 100_000_000), height: num(path.height, 1, 0, 100_000_000), d, ...(path.fill === false ? { fill: false } : {}), ...(path.stroke === false ? { stroke: false } : {}) }
        : null
    })
    .filter((path): path is CustomPath => path !== null)

  return out.length ? out : undefined
}

const adjustOf = (value: unknown): Record<string, number> | undefined => {
  const adjust = isObject(value) ? Object.fromEntries(Object.entries(value).filter(([key, entry]) => /^adj\d?$/.test(key) && typeof entry === 'number' && Number.isFinite(entry))) : undefined

  return adjust && Object.keys(adjust).length ? (adjust as Record<string, number>) : undefined
}

const end = (value: unknown): ConnectorEnd | undefined => (isObject(value) && typeof value.element === 'string' && value.element ? { element: str(value.element, '', 80), site: Math.round(num(value.site, 0, 0, 1000)) } : undefined)

function connector(value: unknown): Connector | undefined {
  if (!isObject(value) || !CONNECTOR_PRESETS.includes(value.preset as Connector['preset'])) {
    return undefined
  }

  const adjust = adjustOf(value.adjust)
  const start = end(value.start)
  const finish = end(value.end)

  return { preset: value.preset as Connector['preset'], ...(adjust ? { adjust } : {}), ...(start ? { start } : {}), ...(finish ? { end: finish } : {}) }
}

const PART_PATH = /^[\w./-]+$/

function keptParts(value: unknown, depth = 0): KeptPart[] {
  if (depth > 4) {
    return []
  }

  return list(value, 64)
    .filter(isObject)
    .map((part): KeptPart | null => {
      const path = str(part.path, '', 300).replace(/^\/+/, '')
      const data = str(part.data, '', 64_000_000)
      const inner = keptParts(part.parts, depth + 1)

      return path && PART_PATH.test(path) && !path.includes('..') && /^[A-Za-z0-9+/=\r\n]*$/.test(data)
        ? { id: str(part.id, '', 80), type: str(part.type, '', 300), path, contentType: str(part.contentType, 'application/octet-stream', 300), data, ...(inner.length ? { parts: inner } : {}) }
        : null
    })
    .filter((part): part is KeptPart => part !== null)
}

/** A table whole: a cell for every row and column, merged cells that fit, its size its columns' and rows'; never rotated, flipped or a placeholder. */
function table(value: Raw, frame: Pick<TableElement, 'id' | 'x' | 'y' | 'name' | 'group'>): TableElement | null {
  const columns = list(value.columns, MAX_COLUMNS).map((width) => num(width, 72, 1, 100_000))
  const rows = list(value.rows, MAX_ROWS).map((height) => num(height, ROW_HEIGHT, 1, 100_000))

  if (!columns.length || !rows.length) {
    return null
  }

  const raw = list(value.cells, MAX_ROWS)
  const cells = rows.map((_, r) => columns.map((_, c) => cell(list(raw[r], MAX_COLUMNS)[c])))

  return {
    id: frame.id,
    kind: 'table',
    x: frame.x,
    y: frame.y,
    width: columns.reduce((sum, width) => sum + width, 0),
    height: rows.reduce((sum, height) => sum + height, 0),
    rotation: 0,
    ...(frame.name ? { name: frame.name } : {}),
    ...(frame.group ? { group: frame.group } : {}),
    columns,
    rows,
    cells: settleSpans(cells, columns.length),
    stroke: stroke(value.stroke)
  }
}

const cleanId = (value: unknown): string => str(value, '', 80).replace(/[^\w-]/g, '')

function element(value: unknown, depth = 0): SlideElement | null {
  if (!isObject(value)) {
    return null
  }

  const groups = list(value.group, 32).map(cleanId).filter(Boolean)
  const frame = {
    id: cleanId(value.id) || newId('element'),
    x: num(value.x, 0),
    y: num(value.y, 0),
    width: num(value.width, 100, 0),
    height: num(value.height, 100, 0),
    rotation: num(value.rotation, 0, -3600, 3600),
    ...(typeof value.flipH === 'boolean' ? { flipH: value.flipH } : {}),
    ...(typeof value.flipV === 'boolean' ? { flipV: value.flipV } : {}),
    ...(typeof value.name === 'string' && value.name ? { name: str(value.name, '', 200) } : {}),
    ...(placeholder(value.placeholder) ? { placeholder: placeholder(value.placeholder) } : {}),
    ...(groups.length ? { group: groups } : {})
  }

  switch (value.kind) {
    case 'text':
      return { ...frame, kind: 'text', body: body(value.body), fill: fill(value.fill), stroke: stroke(value.stroke) }
    case 'shape': {
      const adjust = adjustOf(value.adjust)
      const outline = paths(value.paths)

      return { ...frame, kind: 'shape', shape: oneOf(value.shape, SHAPE_KINDS, 'rect'), fill: fill(value.fill), stroke: stroke(value.stroke), body: body(value.body), ...(adjust ? { adjust } : {}), ...(outline ? { paths: outline } : {}) }
    }
    case 'object': {
      const source = isObject(value.source) ? value.source : {}
      const xml = str(source.xml, '', 4_000_000)
      const preview = isObject(value.preview) ? value.preview : null
      const picture = preview ? imageSource(preview.src) : ''
      const natural = preview && isObject(preview.natural) ? preview.natural : {}
      const drawnIn = isObject(value.drawnIn) ? value.drawnIn : {}
      const drawing =
        depth < 1
          ? list(value.shapes, 2000)
              .map((entry) => element(entry, depth + 1))
              .filter((entry): entry is SlideElement => entry !== null && entry.kind !== 'object')
          : []

      if (!xml.trim().startsWith('<')) {
        return null
      }

      return {
        ...frame,
        kind: 'object',
        object: oneOf(value.object, OBJECT_KINDS, 'other'),
        ...(picture ? { preview: { src: picture, natural: { width: num(natural.width, 0, 0, 1_000_000), height: num(natural.height, 0, 0, 1_000_000) } } } : {}),
        ...(drawing.length ? { shapes: drawing, drawnIn: { width: num(drawnIn.width, frame.width, 1, 100_000), height: num(drawnIn.height, frame.height, 1, 100_000) } } : {}),
        source: { xml, parts: keptParts(source.parts) }
      }
    }
    case 'image': {
      const natural = isObject(value.natural) ? value.natural : {}
      const src = imageSource(value.src)

      if (!src && frame.placeholder?.role !== 'picture') {
        return null
      }

      return {
        ...frame,
        kind: 'image',
        src,
        natural: { width: num(natural.width, 0, 0, 1_000_000), height: num(natural.height, 0, 0, 1_000_000) },
        ...(crop(value.crop) ? { crop: crop(value.crop) } : {}),
        ...(typeof value.alt === 'string' && value.alt ? { alt: str(value.alt, '', 2000) } : {}),
        stroke: stroke(value.stroke)
      }
    }
    case 'line': {
      const link = connector(value.connector)

      return { ...frame, kind: 'line', stroke: stroke(value.stroke) ?? { color: 'tx1', width: 2, dash: 'solid' }, start: oneOf(value.start, ARROW_HEADS, 'none'), end: oneOf(value.end, ARROW_HEADS, 'none'), ...(link ? { connector: link } : {}) }
    }
    case 'table':
      return table(value, frame)
    default:
      return null
  }
}

function background(value: unknown): Background | null {
  if (!isObject(value)) {
    return null
  }

  if (value.kind === 'solid') {
    return { kind: 'solid', color: color(value.color, 'bg1') }
  }

  if (value.kind === 'gradient') {
    const points = stops(value.stops, 'bg1')

    return points.length >= 2 ? { kind: 'gradient', stops: points, angle: num(value.angle, 90, -3600, 3600), ...(value.radial === true ? { radial: true } : {}) } : null
  }

  if (value.kind === 'image') {
    const natural = isObject(value.natural) ? value.natural : {}
    const src = imageSource(value.src)

    return src ? { kind: 'image', src, natural: { width: num(natural.width, 0, 0, 1_000_000), height: num(natural.height, 0, 0, 1_000_000) } } : null
  }

  return null
}

/** Elements with ids unique among them, since ids name elements in commands and selections. */
function elementsOf(value: unknown): SlideElement[] {
  const seen = new Set<string>()

  return list(value, 5000)
    .map((entry) => element(entry))
    .filter((entry): entry is SlideElement => entry !== null)
    .map((entry) => {
      const unique = seen.has(entry.id) ? { ...entry, id: newId(entry.kind) } : entry
      seen.add(unique.id)

      return unique
    })
}

function transition(value: unknown): SlideTransition | undefined {
  if (!isObject(value)) {
    return undefined
  }

  const direction = TRANSITION_DIRECTIONS.includes(value.direction as never) ? { direction: value.direction as SlideTransition['direction'] } : {}
  const orientation = value.orientation === 'horizontal' || value.orientation === 'vertical' ? { orientation: value.orientation as SlideTransition['orientation'] } : {}

  return { kind: oneOf(value.kind, TRANSITIONS, 'fade'), duration: Math.round(num(value.duration, DEFAULT_TRANSITION_MS, 0, 60_000)), ...direction, ...orientation }
}

function slide(value: unknown): Slide | null {
  if (!isObject(value)) {
    return null
  }

  const own = transition(value.transition)

  return {
    id: cleanId(value.id) || newId('slide'),
    layout: oneOf(value.layout, LAYOUTS, 'blank'),
    background: background(value.background),
    elements: elementsOf(value.elements),
    notes: str(value.notes, '', 200_000),
    hidden: flag(value.hidden),
    ...(own ? { transition: own } : {}),
    ...(isObject(value.theme) ? { theme: theme(value.theme) } : {})
  }
}

/** A master whole: its background and drawings, and a layout for each of Herald's layouts (Herald's own where one is missing). */
function master(value: unknown, size: SlideSize): Master | undefined {
  if (!isObject(value)) {
    return undefined
  }

  const fallback = defaultMaster(size)
  const given = list(value.layouts, 64).filter(isObject)
  const layouts = LAYOUTS.map((id): SlideLayout => {
    const raw = given.find((entry) => entry.id === id)

    if (!raw) {
      return fallback.layouts.find((layout) => layout.id === id)!
    }

    return { id, name: str(raw.name, LAYOUT_NAMES[id], 200) || LAYOUT_NAMES[id], background: background(raw.background), elements: elementsOf(raw.elements), showMaster: raw.showMaster !== false }
  })

  return { background: background(value.background), elements: elementsOf(value.elements), layouts }
}

function headerFooter(value: unknown): HeaderFooter | undefined {
  if (!isObject(value)) {
    return undefined
  }

  const fixed = str(value.dateText, '', 200)

  return {
    date: flag(value.date),
    dateFormat: oneOf(value.dateFormat, DATE_FORMATS, 'datetime1'),
    ...(fixed ? { dateText: fixed } : {}),
    number: flag(value.number),
    footer: flag(value.footer),
    footerText: str(value.footerText, '', 500),
    skipTitle: flag(value.skipTitle)
  }
}

/** A deck from untrusted data, whole and safe; throws when it is not a deck at all. */
export function normalizeDeck(value: unknown, title?: string): Deck {
  if (!isObject(value) || !Array.isArray(value.slides)) {
    throw new Error('This is not a Herald Slides deck')
  }

  const raw = isObject(value.size) ? value.size : {}
  const size = { width: num(raw.width, SLIDE_SIZES.wide.width, 72, 10_000), height: num(raw.height, SLIDE_SIZES.wide.height, 72, 10_000) }
  const seen = new Set<string>()
  const slides = list(value.slides, 5000)
    .map(slide)
    .filter((entry): entry is Slide => entry !== null)
    .map((entry) => {
      const unique = seen.has(entry.id) ? { ...entry, id: newId('slide') } : entry
      seen.add(unique.id)

      return unique
    })
  const own = master(value.master, size)
  const footers = headerFooter(value.headerFooter)

  return {
    id: cleanId(value.id) || newId('deck'),
    title: title ?? (str(value.title, 'Untitled', 500) || 'Untitled'),
    size,
    theme: theme(value.theme),
    transition: oneOf(value.transition, TRANSITIONS, 'fade'),
    ...(own ? { master: own } : {}),
    ...(footers ? { headerFooter: footers } : {}),
    slides: slides.length ? slides : [{ id: newId('slide'), layout: 'blank', background: null, elements: [], notes: '', hidden: false }]
  }
}
