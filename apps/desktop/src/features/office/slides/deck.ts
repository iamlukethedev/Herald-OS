/*
 * Herald Slides' deck: slides holding text boxes, shapes, lines, pictures and tables on a page
 * measured in points, as PowerPoint measures its slides (16:9 is 960 by 540, 4:3 is 720 by 540), so
 * every position is a whole number of EMU (12,700 a point) in a PowerPoint file. A deck is plain
 * data, replaced on every change, so undo is a step back to an earlier deck. Colours either name
 * one of the theme's slots or are literal, and fonts either name the theme's heading or body font
 * or a family: a new theme repaints whatever names a slot or a theme font, and leaves the rest alone.
 */

export const EMU_PER_POINT = 12700

export interface SlideSize {
  width: number
  height: number
}

export const SLIDE_SIZES = { wide: { width: 960, height: 540 }, standard: { width: 720, height: 540 } } as const satisfies Record<string, SlideSize>

export type SizeName = keyof typeof SLIDE_SIZES

export const SLOTS = ['bg1', 'tx1', 'bg2', 'tx2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'] as const

/** A theme colour: backgrounds and text (light and dark pairs, as in PowerPoint) and six accents. */
export type Slot = (typeof SLOTS)[number]

/** A theme slot, or a literal `#rrggbb`. */
export type Color = Slot | `#${string}`

export interface Theme {
  id: string
  name: string
  colors: Record<Slot, string>
  fonts: { heading: string; body: string }
  /** The master's background this theme brings with it (a gradient, say); none keeps the background colour. */
  background?: Background
}

/** `+heading` and `+body` stand for the theme's fonts; anything else is a family. */
export type FontRef = '+heading' | '+body' | (string & {})

export interface RunStyle {
  font?: FontRef
  /** Points. */
  size?: number
  color?: Color
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  highlight?: Color
}

export interface TextRun extends RunStyle {
  /** A `\n` is a line break inside the paragraph. */
  text: string
}

export type ListKind = 'bullet' | 'number'

export const NUMBER_STYLES = ['arabicPeriod', 'arabicParenR', 'alphaLcPeriod', 'alphaUcPeriod', 'alphaLcParenR', 'romanLcPeriod', 'romanUcPeriod'] as const

export type NumberStyle = (typeof NUMBER_STYLES)[number]

export type TextAlign = 'left' | 'center' | 'right' | 'justify'

export interface Paragraph {
  runs: TextRun[]
  align?: TextAlign
  list?: ListKind
  /** 0 to 8. */
  level?: number
  /** The bullet's glyph (bullets only). */
  bullet?: string
  numbering?: NumberStyle
  startAt?: number
  /** A multiple of single spacing. */
  lineSpacing?: number
  /** Points. */
  spaceBefore?: number
  spaceAfter?: number
  /** The text's left margin and the first line's indent in points, where a file set them apart from the level's. */
  margin?: number
  indent?: number
}

export type Anchor = 'top' | 'middle' | 'bottom'

/** `shrink` makes text smaller to fit its box; `grow` makes the box as tall as its text. */
export type AutoFit = 'none' | 'shrink' | 'grow'

export interface BodyStyle extends RunStyle {
  font: FontRef
  size: number
  color: Color
}

export interface TextBody {
  paragraphs: Paragraph[]
  /** What a run has where it says nothing itself. */
  style: BodyStyle
  anchor: Anchor
  /** Left, top, right and bottom, in points. */
  inset: [number, number, number, number]
  fit: AutoFit
  wrap: boolean
}

/** The date, footer and slide number: placed by the master and its layouts, shown on slides as the deck's header and footer settings say. */
export const FOOTER_ROLES = ['date', 'footer', 'number'] as const

export type FooterRole = (typeof FOOTER_ROLES)[number]

export type PlaceholderRole = 'title' | 'subtitle' | 'body' | 'heading' | 'caption' | 'picture' | FooterRole

export interface Placeholder {
  role: PlaceholderRole
  /** Shown while it is empty ("Click to add title"); never presented, printed or saved as text. */
  prompt: string
}

/** An element's box before rotation, in points from the slide's top left. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface Frame extends Box {
  id: string
  /** Degrees clockwise about the box's centre. */
  rotation: number
  flipH?: boolean
  flipV?: boolean
  name?: string
  placeholder?: Placeholder
  /**
   * The groups the element is in, outermost first, by ids unique on its slide. Grouped elements
   * stay elements of the slide in their own right (so each draws, edits and keeps its place in
   * the drawing order as any other), are picked and moved together, and go into a PowerPoint file
   * as its groups.
   */
  group?: string[]
}

export interface GradientStop {
  /** 0 to 1 along the gradient. */
  at: number
  color: Color
  /** 0 (clear) to 1 (solid). */
  alpha?: number
}

export interface Gradient {
  stops: GradientStop[]
  /** Degrees: 0 runs left to right, 90 top to bottom (linear gradients). */
  angle: number
  /** Spreading from the middle instead of along a line. */
  radial?: boolean
}

export interface Fill {
  color: Color
  /** 0 (clear) to 1 (solid). */
  alpha?: number
  /** A gradient in place of the colour, which then names its first stop for whatever draws one colour. */
  gradient?: Gradient
}

export const DASHES = ['solid', 'dash', 'dot', 'dashDot', 'longDash'] as const

export type Dash = (typeof DASHES)[number]

export interface Stroke {
  color: Color
  /** Points. */
  width: number
  dash: Dash
  alpha?: number
}

export const ARROW_HEADS = ['none', 'triangle', 'arrow', 'stealth', 'oval', 'diamond'] as const

export type ArrowHead = (typeof ARROW_HEADS)[number]

/** DrawingML's preset names, so a file keeps the very shape. */
export const SHAPE_KINDS = [
  'rect',
  'roundRect',
  'ellipse',
  'triangle',
  'rtTriangle',
  'diamond',
  'parallelogram',
  'trapezoid',
  'pentagon',
  'hexagon',
  'octagon',
  'plus',
  'star5',
  'rightArrow',
  'leftArrow',
  'upArrow',
  'downArrow',
  'leftRightArrow',
  'chevron',
  'homePlate',
  'wedgeRectCallout',
  'wedgeRoundRectCallout',
  'snip1Rect',
  'snip2SameRect',
  'round1Rect',
  'round2SameRect',
  'plaque',
  'foldedCorner',
  'frame',
  'halfFrame',
  'corner',
  'diagStripe',
  'bevel',
  'heptagon',
  'decagon',
  'dodecagon',
  'star4',
  'star6',
  'star8',
  'star10',
  'star12',
  'donut',
  'noSmoking',
  'blockArc',
  'pie',
  'chord',
  'teardrop',
  'heart',
  'lightningBolt',
  'sun',
  'moon',
  'cloud',
  'smileyFace',
  'can',
  'cube',
  'bracketPair',
  'bracePair',
  'leftBracket',
  'rightBracket',
  'leftBrace',
  'rightBrace',
  'upDownArrow',
  'quadArrow',
  'notchedRightArrow',
  'stripedRightArrow',
  'bentArrow',
  'uturnArrow',
  'wedgeEllipseCallout',
  'cloudCallout',
  'mathPlus',
  'mathMinus',
  'mathMultiply',
  'mathDivide',
  'mathEqual',
  'mathNotEqual',
  'wave',
  'doubleWave',
  'flowChartProcess',
  'flowChartAlternateProcess',
  'flowChartDecision',
  'flowChartInputOutput',
  'flowChartPredefinedProcess',
  'flowChartInternalStorage',
  'flowChartDocument',
  'flowChartMultidocument',
  'flowChartTerminator',
  'flowChartPreparation',
  'flowChartManualInput',
  'flowChartManualOperation',
  'flowChartConnector',
  'flowChartOffpageConnector',
  'flowChartPunchedCard',
  'flowChartPunchedTape',
  'flowChartSummingJunction',
  'flowChartOr',
  'flowChartCollate',
  'flowChartSort',
  'flowChartExtract',
  'flowChartMerge',
  'flowChartOnlineStorage',
  'flowChartDelay',
  'flowChartMagneticDisk',
  'flowChartDisplay'
] as const

export type ShapeKind = (typeof SHAPE_KINDS)[number]

/**
 * A freeform outline as DrawingML's custom geometry keeps it: a path in units of its own,
 * stretched over the element's box. `d` is SVG path data with absolute M, L, C, Q and Z commands
 * only (arcs become cubic curves), so it reads and writes one for one as DrawingML's moveTo,
 * lnTo, cubicBezTo, quadBezTo and close.
 */
export interface CustomPath {
  width: number
  height: number
  d: string
  /** False for a path drawn without its fill (DrawingML's fill="none"). */
  fill?: boolean
  /** False for a path drawn without its outline. */
  stroke?: boolean
}

/** How much of a picture is cut off at each side, as fractions of it. */
export interface Crop {
  left: number
  top: number
  right: number
  bottom: number
}

export interface TextElement extends Frame {
  kind: 'text'
  body: TextBody
  fill: Fill | null
  stroke: Stroke | null
}

export interface ShapeElement extends Frame {
  kind: 'shape'
  shape: ShapeKind
  fill: Fill | null
  stroke: Stroke | null
  body: TextBody
  /** DrawingML's adjust values by guide name (`adj`, `adj1`…), where they differ from the preset's. */
  adjust?: Record<string, number>
  /** A freeform outline drawn in place of the preset, which then only places the text. */
  paths?: CustomPath[]
}

export interface ImageElement extends Frame {
  kind: 'image'
  /** A data URL. */
  src: string
  /** The picture's own size in pixels. */
  natural: { width: number; height: number }
  crop?: Crop
  alt?: string
  stroke: Stroke | null
}

/** DrawingML's connector presets: straight, bent at right angles, or curved, through 1 to 4 turns. */
export const CONNECTOR_PRESETS = [
  'straightConnector1',
  'bentConnector2',
  'bentConnector3',
  'bentConnector4',
  'bentConnector5',
  'curvedConnector2',
  'curvedConnector3',
  'curvedConnector4',
  'curvedConnector5'
] as const

export type ConnectorPreset = (typeof CONNECTOR_PRESETS)[number]

/** A connector's end glued to an element on the same slide, at one of its connection sites (DrawingML's numbering for its shape). */
export interface ConnectorEnd {
  element: string
  site: number
}

/** What makes a line a connector: how it runs from end to end, and what its ends are glued to. */
export interface Connector {
  preset: ConnectorPreset
  /** DrawingML's adjust values (`adj1`…), where they differ from the preset's. */
  adjust?: Record<string, number>
  start?: ConnectorEnd
  end?: ConnectorEnd
}

/** A line across its box: from the top left to the bottom right, unless flipped; a connector runs between the same two ends as its preset says. */
export interface LineElement extends Frame {
  kind: 'line'
  stroke: Stroke
  /** The ends at the line's start and at its end. */
  start: ArrowHead
  end: ArrowHead
  connector?: Connector
}

/** A cell's own lines, side by side: a side left out takes the table's line, null has none. */
export interface CellBorders {
  left?: Stroke | null
  top?: Stroke | null
  right?: Stroke | null
  bottom?: Stroke | null
}

export interface TableCell {
  body: TextBody
  fill: Fill | null
  /** How many columns and rows a merged cell reaches across from its top left (1 when absent). */
  colSpan?: number
  rowSpan?: number
  /** Covered by a merged cell: not drawn, and its text kept only for the file. */
  merged?: boolean
  borders?: CellBorders
}

/**
 * Rows of cells, a cell for every column, as PowerPoint's tables have them: a merged cell starts at
 * its top left and the cells it covers stay in the grid, marked. A row is at least as tall as its
 * height and grows with its text. Tables neither rotate nor flip, as in PowerPoint.
 */
export interface TableElement extends Frame {
  kind: 'table'
  /** Column widths in points, adding up to the width. */
  columns: number[]
  /** Row heights in points, adding up to the height. */
  rows: number[]
  cells: TableCell[][]
  /** The lines around and between the cells. */
  stroke: Stroke | null
}

/** A part of a PowerPoint file that an object refers to, carried as it was with the parts it refers to in turn. */
export interface KeptPart {
  /** The relationship id its referrer names it by. */
  id: string
  /** The relationship's type. */
  type: string
  /** Where it was in the file it came from (`ppt/charts/chart1.xml`); another name may be given on writing. */
  path: string
  contentType: string
  /** Its bytes, as base64. */
  data: string
  parts?: KeptPart[]
}

export const OBJECT_KINDS = ['chart', 'diagram', 'ole', 'media', 'other'] as const

export type ObjectKind = (typeof OBJECT_KINDS)[number]

/**
 * Something a PowerPoint file holds that Herald does not edit (a chart, SmartArt, an embedded
 * object), kept whole so a file saved again still has it: the XML of its graphic frame and the
 * parts it refers to are written back as they were, moved and sized to its box. Herald shows the
 * picture or the drawing the file keeps for it, or a labelled box.
 */
export interface ObjectElement extends Frame {
  kind: 'object'
  object: ObjectKind
  /** The picture the file keeps for it (an embedded object's, or a chart's fallback), as a data URL. */
  preview?: { src: string; natural: { width: number; height: number } }
  /** The drawing the file keeps for it (SmartArt's shapes), placed from the object's top left as laid out in a box of `drawnIn`, and stretched with the box. */
  shapes?: SlideElement[]
  drawnIn?: { width: number; height: number }
  /** The frame's XML as the file had it (`p:graphicFrame`, or the `mc:AlternateContent` around one), and the parts it names. */
  source: { xml: string; parts: KeptPart[] }
}

export type SlideElement = TextElement | ShapeElement | ImageElement | LineElement | TableElement | ObjectElement

export type ElementKind = SlideElement['kind']

export type Background =
  | { kind: 'solid'; color: Color }
  /** `angle` in degrees: 0 runs left to right, 90 top to bottom. */
  | { kind: 'gradient'; stops: GradientStop[]; angle: number; radial?: boolean }
  | { kind: 'image'; src: string; natural: { width: number; height: number } }

export const LAYOUTS = ['title', 'title-content', 'two-content', 'section', 'title-only', 'blank', 'picture-caption', 'comparison'] as const

export type LayoutId = (typeof LAYOUTS)[number]

export const TRANSITIONS = ['none', 'fade', 'push', 'wipe', 'cover', 'uncover', 'split', 'zoom'] as const

export type Transition = (typeof TRANSITIONS)[number]

export const TRANSITION_DIRECTIONS = ['left', 'right', 'up', 'down', 'in', 'out'] as const

export type TransitionDirection = (typeof TRANSITION_DIRECTIONS)[number]

/** How long a transition takes when nothing says, in milliseconds. */
export const DEFAULT_TRANSITION_MS = 500

/** How a slide comes in when presenting. */
export interface SlideTransition {
  kind: Transition
  /** Milliseconds. */
  duration: number
  /**
   * Push, wipe, cover and uncover: the way the slide travels, as PowerPoint's files say it (`left`
   * comes in from the right). Split and zoom: `in` or `out`.
   */
  direction?: TransitionDirection
  /** Split: across (`horizontal`) or up and down. */
  orientation?: 'horizontal' | 'vertical'
}

export interface Slide {
  id: string
  layout: LayoutId
  /** Null: its layout's background, else the master's, else the theme's. */
  background: Background | null
  elements: SlideElement[]
  notes: string
  hidden: boolean
  /** Its own transition; none takes the deck's. */
  transition?: SlideTransition
  /** A theme of its own in place of the deck's (PowerPoint keeps it as a master of its own). */
  theme?: Theme
}

/**
 * One of a master's layouts: its placeholders (empty text and picture elements with a role, whose
 * boxes and text are where and how a slide's placeholders start) and its own drawings, in drawing
 * order, over its background.
 */
export interface SlideLayout {
  id: LayoutId
  /** The name PowerPoint shows for it. */
  name: string
  /** Null: the master's. */
  background: Background | null
  elements: SlideElement[]
  /** Whether the master's drawings show on its slides too (PowerPoint's "Hide background graphics" unticked). */
  showMaster: boolean
}

/**
 * The slide master: the background and drawings every slide has (a logo, a band), its title and
 * text placeholders (whose look the layouts' take), the date, footer and slide number
 * placeholders, and a layout for each of Herald's layouts. Its elements are a slide's in kind;
 * placeholders among them are not drawn on slides, but place and style the layouts' own.
 */
export interface Master {
  /** Null: the theme's background colour. */
  background: Background | null
  elements: SlideElement[]
  /** One for each of `LAYOUTS`, in that order. */
  layouts: SlideLayout[]
}

/** PowerPoint's date fields Herald draws: 10/9/2026, Friday, October 9, 2026, 9 October 2026 and October 9, 2026. */
export const DATE_FORMATS = ['datetime1', 'datetime2', 'datetime3', 'datetime4'] as const

export type DateFormat = (typeof DATE_FORMATS)[number]

/** What slides show in the master's date, footer and slide number places. */
export interface HeaderFooter {
  date: boolean
  dateFormat: DateFormat
  /** Text shown in place of the date of the day. */
  dateText?: string
  number: boolean
  footer: boolean
  footerText: string
  /** Left off slides with the Title layout. */
  skipTitle: boolean
}

export interface Deck {
  id: string
  title: string
  size: SlideSize
  theme: Theme
  /** How a slide without a transition of its own comes in when presenting. */
  transition: Transition
  /** The slide master; none is Herald's own for the size (`masterOf` in layouts.ts). */
  master?: Master
  /** None shows no date, footer or slide number. */
  headerFooter?: HeaderFooter
  slides: Slide[]
}

let counter = 0

export const newId = (prefix: string): string => `${prefix}-${(++counter).toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** The smallest side a box keeps, in points (a line may be flat). */
export const MIN_SIDE = 4

export const findSlide = (deck: Deck, slideId: string | null | undefined): Slide | undefined => deck.slides.find((slide) => slide.id === slideId)

export const findElement = (slide: Slide | undefined, elementId: string | null | undefined): SlideElement | undefined => slide?.elements.find((element) => element.id === elementId)

export const withSlide = (deck: Deck, slideId: string, change: (slide: Slide) => Slide): Deck => ({ ...deck, slides: deck.slides.map((slide) => (slide.id === slideId ? change(slide) : slide)) })

export const withElements = (deck: Deck, slideId: string, ids: ReadonlySet<string>, change: (element: SlideElement) => SlideElement): Deck =>
  withSlide(deck, slideId, (slide) => ({ ...slide, elements: slide.elements.map((element) => (ids.has(element.id) ? change(element) : element)) }))

/** Undo and redo over whole decks, each step with the name the Edit menu shows. */
export class DeckHistory {
  private past: { deck: Deck; label: string }[] = []
  private future: { deck: Deck; label: string }[] = []
  /** The last step, while later changes may still join it (typing notes, nudging). */
  private joinable: { key: string; at: number } | null = null

  constructor(
    public present: Deck,
    private readonly limit = 200
  ) {}

  /**
   * Make `next` the present deck as one step. A change with the same `join` key as the step before
   * it, within a couple of seconds, becomes part of that step.
   */
  commit(next: Deck, label: string, join?: string, now = Date.now()): void {
    if (next === this.present) {
      return
    }

    if (join && this.joinable?.key === join && now - this.joinable.at < 2000 && this.past.length) {
      this.present = next
      this.future = []
      this.joinable.at = now

      return
    }

    this.past.push({ deck: this.present, label })
    this.past.splice(0, Math.max(0, this.past.length - this.limit))
    this.future = []
    this.present = next
    this.joinable = join ? { key: join, at: now } : null
  }

  /** Start over from `deck` (a version loaded from disk). */
  reset(deck: Deck): void {
    this.past = []
    this.future = []
    this.present = deck
    this.joinable = null
  }

  undo(): string | null {
    const step = this.past.pop()

    if (!step) {
      return null
    }

    this.future.push({ deck: this.present, label: step.label })
    this.present = step.deck
    this.joinable = null

    return step.label
  }

  redo(): string | null {
    const step = this.future.pop()

    if (!step) {
      return null
    }

    this.past.push({ deck: this.present, label: step.label })
    this.present = step.deck
    this.joinable = null

    return step.label
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  get undoLabel(): string | null {
    return this.past.at(-1)?.label ?? null
  }

  get redoLabel(): string | null {
    return this.future.at(-1)?.label ?? null
  }
}
