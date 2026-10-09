import type JSZip from 'jszip'
import type {
  Anchor,
  ArrowHead,
  Background,
  BodyStyle,
  Box,
  CellBorders,
  Color,
  ConnectorEnd,
  ConnectorPreset,
  Crop,
  Dash,
  Deck,
  Fill,
  FontRef,
  FooterRole,
  Gradient,
  GradientStop,
  LayoutId,
  LineElement,
  Master as DeckMaster,
  NumberStyle,
  ObjectKind,
  Paragraph,
  Placeholder,
  PlaceholderRole,
  ShapeKind,
  Slide,
  SlideElement,
  SlideLayout,
  SlideSize,
  Slot,
  Stroke,
  TableCell,
  TableElement,
  TextAlign,
  TextBody,
  Theme,
  Transition
} from '../deck.ts'
import { ARROW_HEADS, CONNECTOR_PRESETS, EMU_PER_POINT, LAYOUTS, newId, NUMBER_STYLES, SHAPE_KINDS, SLIDE_SIZES, SLOTS } from '../deck.ts'
import { imageElement, lineElement, type Point, rotatePoint, shapeElement, textElement } from '../elements.ts'
import { defaultMaster, LAYOUT_NAMES, newSlide, PROMPTS } from '../layouts.ts'
import { MAX_COLUMNS, MAX_ROWS, settleSpans } from '../tables.ts'
import { bulletFor, isBlank, MAX_LEVEL, numberingFor, ownStyle, paragraphIndent, tidyRuns } from '../text.ts'
import { transitionFor } from '../transitions.ts'
import { colorIn, isColorElement, OFFICE_SCHEME, type Paint, type Palette, readColorMap, readScheme, SCHEME_NAMES, themeColor } from './color.ts'
import { imageSize } from './image-size.ts'
import { placeholderNames } from './placeholders.ts'
import { compareFooters, type FooterFound, footerFound, headerFooterFrom } from './read-footers.ts'
import { readGeometry } from './read-geometry.ts'
import { drawingId, drawingShapes, isLink, keptParts, relationshipIds, writtenXml } from './read-objects.ts'
import { base64, byId, Package, partOf, type Relationship, remember, resolveTarget, targetOf } from './read-package.ts'
import { readTransition, type TransitionRead } from './read-transitions.ts'
import { count, drop, emptyReport, type ImportReport, note, type ReportKind } from './report.ts'
import { attr, child, childrenNamed, descendants, elements, find, flagAttr, numberAttr, parseXml, textOf, xml, type XmlElement } from './xml.ts'

/*
 * Reading a PowerPoint file (.pptx, and .pptm the same way) into a Herald deck. Parts are found
 * through their relationships, as PowerPoint finds them. The master most slides use becomes the
 * deck's, with a layout for each of Herald's; each slide's shapes are read back to front with what
 * their placeholders, layout, master and theme lend them, and become Herald's text boxes, shapes,
 * lines and connectors, pictures, tables (their styles worked out into each cell) and the objects
 * it keeps as they were (charts, SmartArt, embedded objects). What Herald has no element for is
 * shown as the nearest thing it has (a pattern as one colour) or left out, and the report counts
 * every element once, as kept, approximated or left out, with the reasons.
 */

/** How deep groups may nest before what is deeper is left out. */
const MAX_DEPTH = 32

/** Why elements are approximated or left out, as the report lists them. */
const WHY = {
  hidden: 'hidden objects left out',
  unreadable: 'objects that could not be read left out',
  nested: 'groups nested too deeply left out',
  nearestShape: 'shapes Herald does not draw shown as the nearest shape it does',
  customShape: 'custom shapes drawn as rectangles',
  gradient: 'gradient lines and text shown in one colour',
  pattern: 'pattern fills shown as a solid colour',
  pictureShape: 'shapes filled with a picture shown as the picture',
  pictureFill: 'picture fills shown as a colour',
  effects: 'shadows and other effects left out',
  objectLinks: 'links on objects left out',
  lineText: 'text on lines left out',
  straight: 'connectors Herald does not draw shown straight',
  customDash: 'custom dashes shown as plain dashes',
  links: 'links kept as plain text',
  scripts: 'superscript and subscript shown as ordinary text',
  capitals: 'all caps kept as capital letters',
  smallCapitals: 'small capitals shown as ordinary letters',
  vertical: 'vertical text shown horizontally',
  columns: 'text in columns shown as one column',
  turnedText: 'text turned inside its shape shown upright',
  wordArt: 'WordArt shown as plain text',
  exactSpacing: 'exact line spacing shown as a multiple',
  numbering: 'list numbers shown in the nearest style Herald has',
  pictureBullets: 'picture bullets shown as dots',
  pictureCut: 'pictures cut to shapes shown as rectangles',
  tiled: 'tiled pictures shown stretched',
  inset: 'pictures inset in their frames shown filling them',
  pictureEffects: 'picture colour effects left out',
  video: 'videos shown as their poster frame',
  sound: 'sounds left out',
  ole: 'embedded objects shown as their picture',
  oleBox: 'embedded objects without a picture shown as a box (kept in the file as they were)',
  chartBox: 'charts shown as a box (kept in the file as they were)',
  diagramBox: 'SmartArt without a drawing shown as a box (kept in the file as it was)',
  format: 'pictures in formats Herald cannot show',
  missing: 'pictures missing from the file left out',
  linked: 'pictures linked from outside the file left out',
  emptyTables: 'tables without cells left out',
  bigTables: 'table rows and columns past 75 left out',
  tableStyles: 'table styles not in the file shown as the default table style',
  diagonals: 'diagonal lines in table cells left out',
  turnedTables: 'turned tables shown upright',
  backgroundStretch: 'background pictures fill the slide without stretching',
  backgroundTiles: 'tiled backgrounds shown as one picture',
  transitions: 'transitions shown as the nearest one Herald plays',
  footers: 'dates, footers and slide numbers shown as most slides have them',
  graphics: 'background graphics shown on slides that did not show them'
} as const

const FILLS: ReadonlySet<string> = new Set(['a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill'])

const each = <T extends string>(value: T, keys: string): Record<string, T> => Object.fromEntries(keys.split(' ').map((key) => [key, value]))

/** Property children that stand in for each other (one fill, one bullet…), so a later layer's replaces an earlier one's. */
const GROUPS: Record<string, string> = {
  ...each('fill', [...FILLS].join(' ')),
  ...each('geometry', 'a:prstGeom a:custGeom'),
  ...each('dash', 'a:prstDash a:custDash'),
  ...each('join', 'a:round a:bevel a:miter'),
  ...each('autofit', 'a:noAutofit a:normAutofit a:spAutoFit'),
  ...each('effect', 'a:effectLst a:effectDag'),
  ...each('underline', 'a:uLnTx a:uLn'),
  ...each('underlineFill', 'a:uFillTx a:uFill'),
  ...each('bulletColor', 'a:buClrTx a:buClr'),
  ...each('bulletSize', 'a:buSzTx a:buSzPct a:buSzPts'),
  ...each('bulletFont', 'a:buFontTx a:buFont'),
  ...each('bullet', 'a:buNone a:buAutoNum a:buChar a:buBlip')
}

/** Presets Herald does not draw, by the shape of its own they look most like (anything else is a rectangle). */
const NEAREST: Record<string, ShapeKind> = {
  round2DiagRect: 'round2SameRect',
  snip2DiagRect: 'snip2SameRect',
  snipRoundRect: 'snip1Rect',
  pieWedge: 'pie',
  flowChartOfflineStorage: 'flowChartMerge',
  ...each('trapezoid', 'nonIsoscelesTrapezoid funnel'),
  ...each('can', 'flowChartMagneticDrum flowChartDirectAccessStorage'),
  ...each('star8', 'star7 irregularSeal1 irregularSeal2'),
  ...each('star12', 'star16 star24 star32'),
  ...each('blockArc', 'circularArrow leftCircularArrow leftRightCircularArrow'),
  ...each(
    'wedgeRectCallout',
    'callout1 callout2 callout3 accentCallout1 accentCallout2 accentCallout3 borderCallout1 borderCallout2 borderCallout3 accentBorderCallout1 accentBorderCallout2 accentBorderCallout3'
  ),
  ...each('rightArrow', 'rightArrowCallout curvedRightArrow swooshArrow'),
  ...each('leftArrow', 'leftArrowCallout curvedLeftArrow'),
  ...each('upArrow', 'upArrowCallout curvedUpArrow bentUpArrow leftUpArrow'),
  ...each('downArrow', 'downArrowCallout curvedDownArrow'),
  ...each('leftRightArrow', 'leftRightArrowCallout'),
  ...each('upDownArrow', 'upDownArrowCallout'),
  ...each('quadArrow', 'quadArrowCallout leftRightUpArrow'),
  ...each('hexagon', 'gear6'),
  ...each('decagon', 'gear9'),
  ...each(
    'bevel',
    'actionButtonBlank actionButtonHome actionButtonHelp actionButtonInformation actionButtonForwardNext actionButtonBackPrevious actionButtonEnd actionButtonBeginning actionButtonReturn actionButtonDocument actionButtonSound actionButtonMovie'
  )
}

/** Presets drawn as a line from corner to corner of their box. */
const LINES: ReadonlySet<string> = new Set([
  'line',
  'lineInv',
  'straightConnector1',
  'bentConnector2',
  'bentConnector3',
  'bentConnector4',
  'bentConnector5',
  'curvedConnector2',
  'curvedConnector3',
  'curvedConnector4',
  'curvedConnector5'
])

const LAYOUT_TYPES: Record<string, LayoutId> = {
  ...each('title-content', 'obj tx objTx txAndObj objAndTx txAndChart chartAndTx txAndClipArt clipArtAndTx txAndMedia mediaAndTx objOverTx txOverObj objOnly tbl chart dgm vertTx vertTitleAndTx clipArtAndVertTx vertTitleAndTxOverChart'),
  ...each('two-content', 'twoObj twoColTx twoObjAndTx txAndTwoObj twoObjOverTx objAndTwoObj twoObjAndObj fourObj'),
  title: 'title',
  twoTxTwoObj: 'comparison',
  secHead: 'section',
  titleOnly: 'title-only',
  blank: 'blank',
  picTx: 'picture-caption'
}

/** Layouts by name, for layouts without a type: Herald's names (which the layouts it writes carry) and PowerPoint's own for its title slide. */
const LAYOUT_BY_NAME: Record<string, LayoutId> = { ...Object.fromEntries(LAYOUTS.map((id) => [LAYOUT_NAMES[id].toLowerCase(), id])), 'title slide': 'title' }

/** Placeholder types that hold a layout's content. */
const CONTENT: ReadonlySet<string> = new Set(['body', 'obj', 'chart', 'tbl', 'clipArt', 'dgm', 'media'])

/** Date, footer, slide number and header placeholders. */
const FOOTERS: ReadonlySet<string> = new Set(['dt', 'ftr', 'sldNum', 'hdr'])

/** The date, footer and slide number placeholders, by the role Herald gives each. */
const FOOTER_TYPES: Record<string, FooterRole> = { dt: 'date', ftr: 'footer', sldNum: 'number' }

/** What Herald's layouts call the body placeholders that PowerPoint's leave as plain text. */
const BODY_ROLES: Partial<Record<LayoutId, PlaceholderRole>> = { section: 'subtitle', comparison: 'heading', 'picture-caption': 'caption' }

const ALIGNS: Record<string, TextAlign> = { l: 'left', ctr: 'center', r: 'right', just: 'justify', justLow: 'justify', dist: 'justify', thaiDist: 'justify' }

const ANCHORS: Record<string, Anchor> = { t: 'top', ctr: 'middle', b: 'bottom' }

/** PowerPoint's list numbering, as Herald's own styles or the nearest of them. */
const NUMBERINGS: Record<string, NumberStyle> = {
  ...Object.fromEntries(NUMBER_STYLES.map((style) => [style, style])),
  alphaLcParenBoth: 'alphaLcParenR',
  alphaUcParenR: 'alphaUcPeriod',
  alphaUcParenBoth: 'alphaUcPeriod',
  arabicParenBoth: 'arabicParenR',
  romanLcParenR: 'romanLcPeriod',
  romanLcParenBoth: 'romanLcPeriod',
  romanUcParenR: 'romanUcPeriod',
  romanUcParenBoth: 'romanUcPeriod'
}

const DASH_PRESETS: Record<string, Dash> = {
  solid: 'solid',
  dash: 'dash',
  sysDash: 'dash',
  dot: 'dot',
  sysDot: 'dot',
  dashDot: 'dashDot',
  sysDashDot: 'dashDot',
  lgDashDot: 'dashDot',
  lgDashDotDot: 'dashDot',
  sysDashDotDot: 'dashDot',
  lgDash: 'longDash'
}

/** The bullets PowerPoint offers in Wingdings, as the characters they look like. */
const WINGDINGS: Record<string, string> = { '§': '▪', 'q': '❑', 'v': '❖', 'Ø': '➢', 'ü': '✓', 'l': '●', 'n': '■', 'u': '◆', 'Ÿ': '•', 'à': '➔' }

const SYMBOL_FONTS = /wingdings|webdings|symbol|marlett/i

/** Timing behaviours that animate something. */
const ANIMATIONS = ['p:anim', 'p:animClr', 'p:animEffect', 'p:animMotion', 'p:animRot', 'p:animScale', 'p:set', 'p:cmd']

const AUDIO = /\.(aac|aif|aiff|au|flac|m4a|mid|midi|mp3|oga|ogg|wav|wma)$/i

/** The main part's content types, presentations, shows and templates, with macros or without. */
const MAIN_TYPES = /presentationml\.(presentation|slideshow|template)\.main\+xml|powerpoint\.(presentation|slideshow|template|addin)\.macroEnabled\.main\+xml/

/** Shape tree children that are not shapes. */
const STRUCTURE: ReadonlySet<string> = new Set(['p:nvGrpSpPr', 'p:grpSpPr', 'p:extLst'])

const NODE_KINDS: Record<string, ReportKind> = { 'p:sp': 'shape', 'p:pic': 'picture', 'p:cxnSp': 'line', 'p:grpSp': 'group', 'p:contentPart': 'ink' }

const SOLID_PLACEHOLDER = xml('a:solidFill', {}, [xml('a:schemeClr', { val: 'phClr' })])

const THEME_LINE = xml('a:ln', { w: 12700 }, [SOLID_PLACEHOLDER])

const EMPTY_PARAGRAPH = xml('a:p')

/** A line with nothing to draw it with, kept so it can be given a colour. */
const UNSEEN: Stroke = { color: 'tx1', width: 0.75, dash: 'solid', alpha: 0 }

/** The theme's background colour as a background of its own, for a slide or layout showing it over one that differs. */
const THEME_BACKGROUND: Background = { kind: 'solid', color: 'bg1' }

/** The graphic frames Herald keeps as they were, as the object each becomes. */
const KEPT: Partial<Record<ReportKind, ObjectKind>> = { chart: 'chart', smartart: 'diagram', ole: 'ole' }

const round2 = (value: number): number => Math.round(value * 100) / 100 || 0

const pt = (emu: number): number => round2(emu / EMU_PER_POINT)

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

function degrees(value: number): number {
  const turned = round2(((value % 360) + 360) % 360)

  return turned === 360 ? 0 : turned
}

function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    // A structure too deep to walk counts as having nothing.
    return fallback
  }
}

interface ThemeInfo {
  name: string
  scheme: Record<string, string>
  fonts: { heading: string; body: string }
  fills: XmlElement[]
  lines: XmlElement[]
  effects: XmlElement[]
  backgrounds: XmlElement[]
}

function readTheme(root: XmlElement | undefined): ThemeInfo {
  const parts = child(root, 'a:themeElements')
  const fonts = child(parts, 'a:fontScheme')
  const formats = child(parts, 'a:fmtScheme')

  return {
    name: attr(root, 'name') || 'Imported theme',
    scheme: readScheme(child(parts, 'a:clrScheme')),
    fonts: { heading: attr(find(fonts, 'a:majorFont/a:latin'), 'typeface') || 'Calibri', body: attr(find(fonts, 'a:minorFont/a:latin'), 'typeface') || 'Calibri' },
    fills: elements(child(formats, 'a:fillStyleLst')),
    lines: childrenNamed(child(formats, 'a:lnStyleLst'), 'a:ln'),
    effects: childrenNamed(child(formats, 'a:effectStyleLst'), 'a:effectStyle'),
    backgrounds: elements(child(formats, 'a:bgFillStyleLst'))
  }
}

const themeOf = (theme: ThemeInfo, slots: Record<Slot, string>, id = 'imported'): Theme => ({
  id,
  name: theme.name,
  colors: Object.fromEntries(SLOTS.map((slot) => [slot, theme.scheme[slots[slot]] ?? OFFICE_SCHEME[slots[slot]] ?? '#000000'])) as Record<Slot, string>,
  fonts: { ...theme.fonts }
})

/** The scheme colour each slot holds under a colour map: the backgrounds and text as it maps them, the accents as themselves. */
const slotsOf = (map: Record<string, string>): Record<Slot, string> => Object.fromEntries(SLOTS.map((slot) => [slot, slot.startsWith('accent') ? slot : map[slot]])) as Record<Slot, string>

/** Graphic frames a markup choice offers that Herald keeps, by the `mc:AlternateContent` they were chosen from. */
const CHOSEN = new WeakMap<XmlElement, XmlElement>()

/** A markup choice's chart or SmartArt frame, which Herald keeps over the fallback's stand-in for it. */
function keptChoice(alternate: XmlElement): XmlElement | undefined {
  return childrenNamed(alternate, 'mc:Choice')
    .map((choice) => child(choice, 'p:graphicFrame'))
    .find((frame) => frame !== undefined && /\/(chart|chartex|diagram)$/.test(attr(find(frame, 'a:graphic/a:graphicData'), 'uri') ?? ''))
}

/** A shape tree's children, with markup-compatibility choices made: a chart or SmartArt Herald keeps, else the fallback where there is one, else the first choice. */
function treeChildren(tree: XmlElement | undefined, depth = 0): XmlElement[] {
  return elements(tree).flatMap((node) => {
    if (node.name !== 'mc:AlternateContent') {
      return [node]
    }

    const kept = keptChoice(node)

    if (kept) {
      CHOSEN.set(kept, node)

      return [kept]
    }

    return depth < MAX_DEPTH ? treeChildren(child(node, 'mc:Fallback') ?? child(node, 'mc:Choice'), depth + 1) : []
  })
}

/** The element holding a shape's non-visual properties (`p:nvSpPr`, `p:nvPicPr`…). */
const nonVisual = (node: XmlElement): XmlElement | undefined => elements(node).find((entry) => entry.name.startsWith('p:nv'))

interface PlaceholderShape {
  element: XmlElement
  ph: XmlElement
  type: string
  idx: number
}

function placeholdersOf(root: XmlElement | undefined): PlaceholderShape[] {
  return treeChildren(find(root, 'p:cSld/p:spTree')).flatMap((element) => {
    const ph = find(nonVisual(element), 'p:nvPr/p:ph')

    return ph ? [{ element, ph, type: attr(ph, 'type') ?? 'obj', idx: numberAttr(ph, 'idx', 0) }] : []
  })
}

/** A master's or layout's drawings: its shape tree's children that are not placeholders. */
const drawingsOf = (root: XmlElement | undefined): XmlElement[] => treeChildren(find(root, 'p:cSld/p:spTree')).filter((node) => !STRUCTURE.has(node.name) && !find(nonVisual(node), 'p:nvPr/p:ph'))

/** Whether a drawing shows the number of the slide it is on. */
const showsNumber = (node: XmlElement): boolean => descendants(node, 'a:fld').some((field) => attr(field, 'type') === 'slidenum')

type TextKind = 'title' | 'body' | 'other'

/** The scheme colours the deck theme's slots can hold: all but the two link colours. */
const SLOT_COLORS = SCHEME_NAMES.filter((name) => name !== 'hlink' && name !== 'folHlink')

/** A master's or layout's part and its drawings, which slides show behind their own. */
interface Template {
  path: string
  root: XmlElement | undefined
  relationships: Relationship[]
  drawings: XmlElement[]
  /** Those of its drawings that show the slide number, which each slide shows as its own (Herald's text has no fields). */
  numbered: XmlElement[]
}

interface Master extends Template {
  theme: ThemeInfo
  map: Record<string, string>
  /** The scheme colour each slot holds on its slides: the deck theme's, or its own theme's when its slides have a theme of their own. */
  slots: Record<Slot, string>
  /** The theme its slides have, when its theme is not the deck's. */
  own?: Theme
  placeholders: PlaceholderShape[]
  styles: Record<TextKind, XmlElement | undefined>
}

interface Layout extends Template {
  root: XmlElement
  master: Master
  map: Record<string, string>
  placeholders: PlaceholderShape[]
  /** Whether the master's own shapes show on this layout's slides. */
  showsMaster: boolean
  id: LayoutId
  /** Known by its name alone, as the layouts Herald writes are (they number their placeholders from 100, in Herald's order). */
  named: boolean
}

type Loaded = { src: string; natural: { width: number; height: number } } | { reason: string }

interface Context {
  pkg: Package
  report: ImportReport
  size: SlideSize
  /** The presentation's default text style, under every other. */
  defaults: XmlElement | undefined
  /** The deck theme, from the theme of the master most slides use. */
  theme: ThemeInfo
  /** The scheme colour each slot of the deck theme holds. */
  slots: Record<Slot, string>
  /** The master most slides use, which becomes the deck's; or a stand-in for a file without one. */
  main: Master
  masters: Map<string, Promise<Master | undefined>>
  layouts: Map<string, Promise<Layout | undefined>>
  pictures: Map<string, Promise<Loaded>>
  /** The table styles the file holds (`a:tblStyle`), by id. */
  tableStyles: Map<string, XmlElement>
  /** Masters and layouts whose shapes are counted already, and backgrounds whose approximations are. */
  counted: Set<string>
  /** The masters and layouts (by part) whose drawings the deck's master draws on slides of each layout. */
  drawn: Map<LayoutId, string[]>
  /** The background the deck's master gives slides of each layout; null is the theme's background colour. */
  backgrounds: Map<LayoutId, Background | null>
}

function masterOf(deck: Pick<Context, 'theme' | 'slots'>, path: string, root: XmlElement | undefined, relationships: Relationship[], theme: ThemeInfo): Master {
  const styles = child(root, 'p:txStyles')
  const map = readColorMap(child(root, 'p:clrMap'))
  const same = SLOT_COLORS.every((name) => theme.scheme[name] === deck.theme.scheme[name]) && theme.fonts.heading === deck.theme.fonts.heading && theme.fonts.body === deck.theme.fonts.body
  const slots = same ? deck.slots : slotsOf(map)
  const drawings = drawingsOf(root)

  return {
    path,
    root,
    relationships,
    theme,
    map,
    slots,
    ...(same ? {} : { own: themeOf(theme, slots, `imported-${path.slice(path.lastIndexOf('/') + 1).replace(/\.xml$/i, '')}`) }),
    placeholders: placeholdersOf(root),
    styles: { title: child(styles, 'p:titleStyle'), body: child(styles, 'p:bodyStyle'), other: child(styles, 'p:otherStyle') },
    drawings,
    numbered: drawings.filter(showsNumber)
  }
}

function masterAt(ctx: Context, path: string): Promise<Master | undefined> {
  return remember(ctx.masters, path, async () => {
    const root = await ctx.pkg.xml(path)

    if (root?.name !== 'p:sldMaster') {
      return undefined
    }

    const relationships = await ctx.pkg.relationships(path)
    const theme = await ctx.pkg.xml(targetOf(relationships, 'theme'))

    return masterOf(ctx, path, root, relationships, theme ? readTheme(theme) : ctx.theme)
  })
}

/** A part's colour map: its own override over `base`, or `base`. */
function mapOver(root: XmlElement, base: Record<string, string>): Record<string, string> {
  const override = find(root, 'p:clrMapOvr/a:overrideClrMapping')

  return override ? readColorMap(override, base) : base
}

/** The Herald layout for a layout whose type and name do not say, by the placeholders it has. */
function layoutFrom(placeholders: readonly PlaceholderShape[]): LayoutId {
  const types = placeholders.map((entry) => entry.type)

  if (types.includes('ctrTitle')) {
    return 'title'
  }

  return types.some((entry) => CONTENT.has(entry)) ? 'title-content' : types.includes('title') ? 'title-only' : 'blank'
}

function layoutAt(ctx: Context, path: string): Promise<Layout | undefined> {
  return remember(ctx.layouts, path, async () => {
    const root = await ctx.pkg.xml(path)

    if (root?.name !== 'p:sldLayout') {
      return undefined
    }

    const relationships = await ctx.pkg.relationships(path)
    const masterPath = targetOf(relationships, 'slideMaster')
    const master = (masterPath ? await masterAt(ctx, masterPath) : undefined) ?? ctx.main
    const placeholders = placeholdersOf(root)
    const type = attr(root, 'type')
    const byType = type ? LAYOUT_TYPES[type] : undefined
    const byName = LAYOUT_BY_NAME[(attr(child(root, 'p:cSld'), 'name') ?? '').trim().toLowerCase()]
    const drawings = drawingsOf(root)

    return {
      path,
      root,
      relationships,
      master,
      map: mapOver(root, master.map),
      placeholders,
      showsMaster: flagAttr(root, 'showMasterSp') !== false,
      id: byType ?? byName ?? layoutFrom(placeholders),
      named: !byType && byName !== undefined,
      drawings,
      numbered: drawings.filter(showsNumber)
    }
  })
}

interface LinkEnd {
  /** The shape's id in the file (`p:cNvPr`). */
  id: string
  site: number
}

/** A connector whose ends are glued to shapes, found once every shape it may name is read. */
interface Link {
  line: string
  start?: LinkEnd
  end?: LinkEnd
}

interface Scope {
  ctx: Context
  report: ImportReport
  /** The relationships of the part whose shapes these are, for its pictures. */
  relationships: Relationship[]
  palette: Palette
  /** Text's colour where nothing says: `tx1` under this colour map. */
  text: Color
  master: Master
  /** A slide's layout, or the layout whose own shapes these are. */
  layout: Layout | undefined
  /**
   * What the shapes are read as: a slide's own (its placeholders drawn with what they inherit, its
   * date, footer and slide number noted), a master's or layout's own (placeholders as the empty
   * places they are), or a master's or layout's drawings copied onto a slide (placeholders left out).
   */
  mode: 'slide' | 'template' | 'copy'
  /** The slide's number, for slide number fields. */
  number: number
  /** The part the shapes are in, as read, for keeping an object's XML as it was written. */
  part?: { path: string; root: XmlElement }
  /** Herald's id for each shape read, by its id in the file, for gluing connectors. */
  ids: Map<string, string>
  links: Link[]
  /** The date, footer and slide number placeholders a slide carries. */
  footers: FooterFound[]
}

/**
 * Property elements laid over each other, the most general first: each later one's attributes win,
 * and so do its children, a group at a time (a fill replaces any fill, a bullet any bullet).
 */
function overlay(name: string, layers: readonly (XmlElement | undefined)[], skip?: string): XmlElement {
  const attrs: Record<string, string> = {}
  const parts = new Map<string, XmlElement>()

  for (const layer of layers) {
    if (!layer) {
      continue
    }

    Object.assign(attrs, layer.attrs)

    for (const node of elements(layer)) {
      if (node.name !== skip) {
        parts.set(GROUPS[node.name] ?? node.name, node)
      }
    }
  }

  return { name, attrs, children: [...parts.values()] }
}

/** A shape's properties over what its placeholders lend it, the outline merged attribute by attribute. */
function shapeProps(layers: readonly (XmlElement | undefined)[]): XmlElement {
  const props = overlay('p:spPr', layers)
  const lines = layers.map((layer) => child(layer, 'a:ln')).filter((line): line is XmlElement => line !== undefined)

  return lines.length > 1 ? { ...props, children: elements(props).map((node) => (node.name === 'a:ln' ? overlay('a:ln', lines) : node)) } : props
}

interface Placement {
  x: number
  y: number
  width: number
  height: number
  /** Degrees clockwise. */
  rotation: number
  flipH: boolean
  flipV: boolean
}

/** How a group places its members: from its own coordinates onto its parent's, in points. */
type Transform = (placement: Placement) => Placement

function placementOf(xfrm: XmlElement | undefined): Placement {
  const offset = child(xfrm, 'a:off')
  const extent = child(xfrm, 'a:ext')

  return {
    x: numberAttr(offset, 'x', 0) / EMU_PER_POINT,
    y: numberAttr(offset, 'y', 0) / EMU_PER_POINT,
    width: Math.max(0, numberAttr(extent, 'cx', 0)) / EMU_PER_POINT,
    height: Math.max(0, numberAttr(extent, 'cy', 0)) / EMU_PER_POINT,
    rotation: numberAttr(xfrm, 'rot', 0) / 60000,
    flipH: flagAttr(xfrm, 'flipH') ?? false,
    flipV: flagAttr(xfrm, 'flipV') ?? false
  }
}

/** A group's members' placement on its parent: scaled from the group's child space to its box, flipped, then turned about its centre. */
function groupTransform(xfrm: XmlElement | undefined): Transform {
  const outer = placementOf(xfrm)
  const origin = child(xfrm, 'a:chOff')
  const extent = child(xfrm, 'a:chExt')
  const left = origin ? numberAttr(origin, 'x', 0) / EMU_PER_POINT : outer.x
  const top = origin ? numberAttr(origin, 'y', 0) / EMU_PER_POINT : outer.y
  const width = extent ? numberAttr(extent, 'cx', 0) / EMU_PER_POINT : outer.width
  const height = extent ? numberAttr(extent, 'cy', 0) / EMU_PER_POINT : outer.height
  const sx = width > 0 ? outer.width / width : 1
  const sy = height > 0 ? outer.height / height : 1
  const middle: Point = [outer.x + outer.width / 2, outer.y + outer.height / 2]

  return (inner) => {
    // A member turned nearer a quarter turn than upright lies across the group's scaling.
    const across = Math.abs((((inner.rotation % 180) + 180) % 180) - 90) < 45
    const w = inner.width * (across ? sy : sx)
    const h = inner.height * (across ? sx : sy)
    let cx = outer.x + (inner.x + inner.width / 2 - left) * sx
    let cy = outer.y + (inner.y + inner.height / 2 - top) * sy
    let rotation = inner.rotation

    if (outer.flipH) {
      cx = 2 * middle[0] - cx
      rotation = -rotation
    }

    if (outer.flipV) {
      cy = 2 * middle[1] - cy
      rotation = -rotation
    }

    const [x, y] = rotatePoint([cx, cy], middle, outer.rotation)

    return { x: x - w / 2, y: y - h / 2, width: w, height: h, rotation: rotation + outer.rotation, flipH: inner.flipH !== outer.flipH, flipV: inner.flipV !== outer.flipV }
  }
}

/** A placement through its groups' transforms, the innermost first. */
const place = (placement: Placement, at: readonly Transform[]): Placement => at.reduceRight((inner, transform) => transform(inner), placement)

const boxOf = (placement: Placement): Box => ({ x: round2(placement.x), y: round2(placement.y), width: round2(placement.width), height: round2(placement.height) })

const nameOf = (info: XmlElement | undefined): { name?: string } => {
  const name = attr(info, 'name')

  return name ? { name } : {}
}

const frameOf = (placement: Placement, info: XmlElement | undefined): { rotation: number; flipH?: boolean; flipV?: boolean; name?: string } => ({
  rotation: degrees(placement.rotation),
  ...(placement.flipH ? { flipH: true } : {}),
  ...(placement.flipV ? { flipV: true } : {}),
  ...nameOf(info)
})

/** Count an element once: kept, or approximated with every reason it was. */
function tally(report: ImportReport, kind: ReportKind, issues: ReadonlySet<string>): void {
  const [first, ...rest] = issues

  count(report, kind, first ? 'approximated' : 'imported', first)

  for (const reason of rest) {
    note(report, reason)
  }
}

/** Add reasons to the report once for what they belong to (a background many slides share). */
function noteOnce(ctx: Context, key: string, reasons: ReadonlySet<string>): void {
  if (ctx.counted.has(key)) {
    return
  }

  ctx.counted.add(key)

  for (const reason of reasons) {
    note(ctx.report, reason)
  }
}

interface Inherited {
  layout: XmlElement | undefined
  master: XmlElement | undefined
  type: string
  /** The master text style the placeholder's text starts from. */
  text: TextKind
  role: PlaceholderRole | undefined
  prompt: string
}

const titleLike = (type: string): boolean => type === 'title' || type === 'ctrTitle'

/** The kind a master's placeholder answers for: titles for titles, footers for their own kind, the body for the rest. */
const kindOf = (type: string): string => (titleLike(type) ? 'title' : FOOTERS.has(type) ? type : 'body')

function matching(shapes: readonly PlaceholderShape[], type: string, idx: number | undefined): PlaceholderShape | undefined {
  const same = idx === undefined ? undefined : shapes.find((shape) => shape.idx === idx)

  return same ?? shapes.find((shape) => shape.type === type) ?? shapes.find((shape) => kindOf(shape.type) === kindOf(type))
}

function roleOf(type: string, layout: LayoutId | undefined): PlaceholderRole | undefined {
  if (titleLike(type)) {
    return 'title'
  }

  if (FOOTERS.has(type)) {
    return undefined
  }

  if (type === 'subTitle') {
    return 'subtitle'
  }

  if (type === 'pic') {
    return 'picture'
  }

  return type === 'body' ? (BODY_ROLES[layout ?? 'title-content'] ?? 'body') : 'body'
}

/** The role of a placeholder in a layout Herald wrote, which numbers its placeholders from 100 in its own layout's order. */
function writtenRole(layout: Layout | undefined, shape: PlaceholderShape | undefined): PlaceholderRole | undefined {
  if (!layout?.named || !shape || shape.idx < 100) {
    return undefined
  }

  return placeholderNames(layout.id)[shape.idx - 100]?.role
}

const paragraphText = (paragraph: XmlElement): string =>
  treeChildren(paragraph)
    .map((node) => (node.name === 'a:br' ? '\n' : node.name === 'a:r' || node.name === 'a:fld' ? textOf(child(node, 'a:t')) : ''))
    .join('')

/** A layout placeholder's own prompt, where it has one ("Insert the company's name"). */
function customPrompt(shape: PlaceholderShape | undefined): string | undefined {
  if (!shape || !flagAttr(shape.ph, 'hasCustomPrompt')) {
    return undefined
  }

  return childrenNamed(child(shape.element, 'p:txBody'), 'a:p').map(paragraphText).join('\n').trim() || undefined
}

/** What a slide placeholder takes from its layout's (matched by index, then type) and its master's (matched by kind). */
function inheritance(ph: XmlElement, scope: Scope): Inherited {
  const idx = attr(ph, 'idx') === undefined ? undefined : numberAttr(ph, 'idx', 0)
  const layout = scope.layout ? matching(scope.layout.placeholders, attr(ph, 'type') ?? 'obj', idx) : undefined
  const type = attr(ph, 'type') ?? layout?.type ?? 'obj'
  const master = matching(scope.master.placeholders, layout?.type ?? type, undefined)
  const role = FOOTERS.has(type) ? undefined : (writtenRole(scope.layout, layout) ?? roleOf(type, scope.layout?.id))

  return {
    layout: layout?.element,
    master: master?.element,
    type,
    text: titleLike(type) ? 'title' : FOOTERS.has(type) ? 'other' : 'body',
    role,
    prompt: role ? (customPrompt(layout) ?? PROMPTS[role]) : ''
  }
}

/**
 * What a master's or layout's own placeholder takes: a layout's from its master's (matched by
 * kind), a master's from nothing but itself; its date, footer and slide number keep their roles.
 */
function templateInheritance(ph: XmlElement, scope: Scope): Inherited {
  const type = attr(ph, 'type') ?? 'obj'
  const own = scope.layout?.placeholders.find((shape) => shape.ph === ph)
  const master = scope.layout ? matching(scope.master.placeholders, type, undefined) : undefined
  const role = FOOTER_TYPES[type] ?? writtenRole(scope.layout, own) ?? roleOf(type, scope.layout?.id)

  return {
    layout: undefined,
    master: master?.element,
    type,
    text: titleLike(type) ? 'title' : FOOTERS.has(type) ? 'other' : 'body',
    role,
    prompt: role ? (FOOTER_TYPES[type] ? PROMPTS[role] : (customPrompt(own) ?? PROMPTS[role])) : ''
  }
}

const alphaOf = (paint: Paint): { alpha?: number } => (paint.alpha < 1 ? { alpha: Math.round(paint.alpha * 1000) / 1000 } : {})

const fillOf = (paint: Paint | null): Fill | null => (paint ? { color: paint.color, ...alphaOf(paint) } : null)

/** A style reference's theme fill: `idx` 1 to 999 picks a fill style, 1001 on a background fill style, and 0 none. */
function themeFill(ref: XmlElement | undefined, theme: ThemeInfo): XmlElement | undefined {
  const idx = Math.round(numberAttr(ref, 'idx', 0))

  if (idx >= 1001) {
    return theme.backgrounds[idx - 1001] ?? theme.backgrounds.at(-1) ?? SOLID_PLACEHOLDER
  }

  return idx > 0 ? (theme.fills[idx - 1] ?? theme.fills.at(-1) ?? SOLID_PLACEHOLDER) : undefined
}

/** The stop a gradient is shown as: the middle one of three or more, else the first. */
function gradientStop(gradient: XmlElement, palette: Palette, placeholder: Paint | null): Paint | null {
  const stops = childrenNamed(child(gradient, 'a:gsLst'), 'a:gs').sort((a, b) => numberAttr(a, 'pos', 0) - numberAttr(b, 'pos', 0))

  return colorIn(stops.length > 2 ? stops[Math.floor(stops.length / 2)] : stops[0], palette, placeholder)
}

/** A gradient's stops in order along it, each with its colour and opacity. */
function gradientStops(gradient: XmlElement, palette: Palette, placeholder: Paint | null): GradientStop[] {
  return childrenNamed(child(gradient, 'a:gsLst'), 'a:gs')
    .flatMap((stop) => {
      const paint = colorIn(stop, palette, placeholder)

      return paint ? [{ at: clamp01(numberAttr(stop, 'pos', 0) / 100000), color: paint.color, ...alphaOf(paint) }] : []
    })
    .sort((a, b) => a.at - b.at)
}

/** A gradient fill (`a:gradFill`) as Herald's: along its line's angle, or spreading from the middle for a path gradient; null with fewer than two stops. */
function gradientOf(fill: XmlElement, palette: Palette, placeholder: Paint | null): Gradient | null {
  const stops = gradientStops(fill, palette, placeholder)

  return stops.length > 1 ? { stops, angle: degrees(numberAttr(child(fill, 'a:lin'), 'ang', 5400000) / 60000), ...(child(fill, 'a:path') ? { radial: true } : {}) } : null
}

interface FillRead {
  fill: Fill | null
  /** A picture fill (`a:blipFill`), which only a picture can show. */
  picture?: XmlElement
}

/** A fill element as Herald's fill; `group` is the enclosing group's fill, for `a:grpFill`. */
function readFill(element: XmlElement | undefined, palette: Palette, placeholder: Paint | null, issues: Set<string>, group?: XmlElement): FillRead {
  if (element?.name === 'a:solidFill') {
    return { fill: fillOf(colorIn(element, palette, placeholder)) }
  }

  if (element?.name === 'a:gradFill') {
    const gradient = gradientOf(element, palette, placeholder)

    return { fill: gradient ? { color: gradient.stops[0].color, gradient } : fillOf(gradientStop(element, palette, placeholder)) }
  }

  if (element?.name === 'a:pattFill') {
    issues.add(WHY.pattern)

    return { fill: fillOf(colorIn(child(element, 'a:fgClr'), palette, placeholder)) }
  }

  if (element?.name === 'a:blipFill') {
    return { fill: null, picture: element }
  }

  return element?.name === 'a:grpFill' && group ? readFill(group, palette, placeholder, issues) : { fill: null }
}

/** A line style reference's theme line: `idx` 1 and up picks a line style, and 0 none. */
function themeLine(ref: XmlElement | undefined, theme: ThemeInfo): XmlElement | undefined {
  const idx = Math.round(numberAttr(ref, 'idx', 0))

  return idx > 0 ? (theme.lines[idx - 1] ?? theme.lines.at(-1) ?? THEME_LINE) : undefined
}

/** A shape's outline: its own over the theme line style its style refers to. */
function lineProps(props: XmlElement | undefined, style: XmlElement | undefined, theme: ThemeInfo): XmlElement | undefined {
  const themed = themeLine(child(style, 'a:lnRef'), theme)
  const own = child(props, 'a:ln')

  return themed || own ? overlay('a:ln', [themed, own]) : undefined
}

function dashOf(line: XmlElement, issues: Set<string>): Dash {
  if (child(line, 'a:custDash')) {
    issues.add(WHY.customDash)

    return 'dash'
  }

  return DASH_PRESETS[attr(child(line, 'a:prstDash'), 'val') ?? 'solid'] ?? 'solid'
}

/** An outline (`a:ln`) as Herald's stroke; null when nothing draws it. */
function readStroke(line: XmlElement | undefined, palette: Palette, placeholder: Paint | null, issues: Set<string>): Stroke | null {
  const fill = elements(line).find((node) => FILLS.has(node.name))
  let paint: Paint | null = null

  if (fill?.name === 'a:solidFill') {
    paint = colorIn(fill, palette, placeholder)
  } else if (fill?.name === 'a:gradFill') {
    paint = gradientStop(fill, palette, placeholder)
    issues.add(WHY.gradient)
  } else if (fill?.name === 'a:pattFill') {
    paint = colorIn(child(fill, 'a:fgClr'), palette, placeholder)
    issues.add(WHY.pattern)
  }

  if (!line || !paint) {
    return null
  }

  const width = numberAttr(line, 'w', 0)

  return { color: paint.color, width: width > 0 ? pt(width) : 0.75, dash: dashOf(line, issues), ...alphaOf(paint) }
}

const arrowOf = (end: XmlElement | undefined): ArrowHead => {
  const type = attr(end, 'type') as ArrowHead | undefined

  return type && ARROW_HEADS.includes(type) ? type : 'none'
}

/** Whether a shape has shadows, glows, reflections or bevels, its own or its style's. */
function hasEffects(props: XmlElement | undefined, style: XmlElement | undefined, theme: ThemeInfo): boolean {
  const own = elements(props).find((node) => GROUPS[node.name] === 'effect')
  const depth = child(props, 'a:sp3d')

  if (depth && (child(depth, 'a:bevelT') || child(depth, 'a:bevelB') || numberAttr(depth, 'extrusionH', 0) > 0)) {
    return true
  }

  if (own) {
    return own.name === 'a:effectDag' || elements(own).length > 0
  }

  const idx = Math.round(numberAttr(child(style, 'a:effectRef'), 'idx', 0))
  const themed = idx > 0 ? theme.effects[idx - 1] : undefined

  return elements(child(themed, 'a:effectLst')).length > 0 || child(child(themed, 'a:sp3d'), 'a:bevelT') !== undefined
}

interface TextSources {
  /** List styles (`a:lstStyle`, `p:titleStyle`…), the most general first. */
  styles: readonly (XmlElement | undefined)[]
  /** Body properties (`a:bodyPr`), the most general first. */
  bodies: readonly (XmlElement | undefined)[]
  /** Title text, in the heading font where nothing says otherwise. */
  title: boolean
}

/** A shape style's font reference as a list style: its colour, and the heading or body font. */
function fontRefStyle(style: XmlElement | undefined): XmlElement | undefined {
  const ref = child(style, 'a:fontRef')

  if (!ref) {
    return undefined
  }

  const color = elements(ref).find(isColorElement)
  const idx = attr(ref, 'idx')
  const props = [...(color ? [xml('a:solidFill', {}, [color])] : []), ...(idx === 'major' || idx === 'minor' ? [xml('a:latin', { typeface: idx === 'major' ? '+mj-lt' : '+mn-lt' })] : [])]

  return xml('a:lstStyle', {}, [xml('a:defPPr', {}, [xml('a:defRPr', {}, props)])])
}

/** Where a shape's text takes its look from: the presentation, the master's text style, its placeholders, its style and its own list style. */
function textSources(scope: Scope, from: Inherited | undefined, shape: XmlElement, style: XmlElement | undefined): TextSources {
  const kind = from?.text ?? 'other'
  const list = (element: XmlElement | undefined) => find(element, 'p:txBody/a:lstStyle')
  const body = (element: XmlElement | undefined) => find(element, 'p:txBody/a:bodyPr')

  return {
    styles: [scope.ctx.defaults, scope.master.styles[kind], list(from?.master), list(from?.layout), fontRefStyle(style), list(shape)],
    bodies: [body(from?.master), body(from?.layout), body(shape)],
    title: kind === 'title'
  }
}

/** A paragraph level's properties in each list style, and their default run properties. */
function levelLayers(styles: readonly (XmlElement | undefined)[], level: number): { paragraph: XmlElement[]; run: XmlElement[] } {
  const paragraph: XmlElement[] = []
  const run: XmlElement[] = []

  for (const style of styles) {
    for (const entry of [child(style, 'a:defPPr'), child(style, `a:lvl${level + 1}pPr`)]) {
      const defaults = child(entry, 'a:defRPr')

      if (entry) {
        paragraph.push(entry)
      }

      if (defaults) {
        run.push(defaults)
      }
    }
  }

  return { paragraph, run }
}

/** A run's whole look, every switch said either way. */
type RunLook = BodyStyle & { bold: boolean; italic: boolean; underline: boolean; strike: boolean }

interface Draft {
  text: string
  look: RunLook
}

/** A typeface as Herald's font: the theme's heading or body font (`+mj-lt`, `+mn-ea`…), or the family. */
function fontOf(typeface: string | undefined): FontRef | undefined {
  if (!typeface) {
    return undefined
  }

  if (typeface.startsWith('+mj')) {
    return '+heading'
  }

  return typeface.startsWith('+mn') ? '+body' : typeface
}

function readRun(text: string, props: XmlElement, sources: TextSources, scope: Scope, issues: Set<string>): Draft {
  const fill = elements(props).find((node) => FILLS.has(node.name))
  const paint = fill?.name === 'a:solidFill' ? colorIn(fill, scope.palette) : fill?.name === 'a:gradFill' ? gradientStop(fill, scope.palette, null) : fill?.name === 'a:pattFill' ? colorIn(child(fill, 'a:fgClr'), scope.palette) : null
  const size = numberAttr(props, 'sz', 0)
  const highlight = colorIn(child(props, 'a:highlight'), scope.palette)
  const cap = attr(props, 'cap')
  const look: RunLook = {
    font: fontOf(attr(child(props, 'a:latin'), 'typeface')) ?? (sources.title ? '+heading' : '+body'),
    size: size > 0 ? round2(size / 100) : 18,
    color: paint?.color ?? scope.text,
    bold: flagAttr(props, 'b') ?? false,
    italic: flagAttr(props, 'i') ?? false,
    underline: (attr(props, 'u') ?? 'none') !== 'none',
    strike: (attr(props, 'strike') ?? 'noStrike') !== 'noStrike'
  }

  if (highlight) {
    look.highlight = highlight.color
  }

  if (text.trim()) {
    const reasons = [
      fill?.name === 'a:gradFill' && WHY.gradient,
      fill?.name === 'a:pattFill' && WHY.pattern,
      numberAttr(props, 'baseline', 0) !== 0 && WHY.scripts,
      cap === 'all' && WHY.capitals,
      cap === 'small' && WHY.smallCapitals,
      child(props, 'a:hlinkClick') !== undefined && WHY.links,
      elements(child(props, 'a:effectLst')).length > 0 && WHY.effects
    ]

    for (const reason of reasons) {
      if (reason) {
        issues.add(reason)
      }
    }
  }

  return { text: cap === 'all' ? text.toUpperCase() : text, look }
}

/** A bullet's glyph as Herald can show it: a symbol font's character becomes what it looks like, or a dot. */
function glyphOf(char: string | undefined, font: string | undefined): string {
  const glyph = char || '•'
  const code = glyph.codePointAt(0) ?? 0
  // Symbol fonts' characters may be written 0xf000 above the letter, in the private use area.
  const letter = code >= 0xf000 && code <= 0xf0ff ? String.fromCharCode(code - 0xf000) : glyph

  if (font && /wingdings/i.test(font)) {
    return WINGDINGS[letter] ?? '•'
  }

  if ((font && SYMBOL_FONTS.test(font)) || (code >= 0xe000 && code <= 0xf8ff)) {
    return '•'
  }

  return font && /courier/i.test(font) && glyph === 'o' ? '◦' : glyph
}

/** Paragraph spacing in points: given in points, or as a share of the text's size. */
function spacingOf(spacing: XmlElement | undefined, size: number): number | undefined {
  const points = numberAttr(child(spacing, 'a:spcPts'), 'val')
  const share = numberAttr(child(spacing, 'a:spcPct'), 'val')

  return points !== undefined ? round2(points / 100) : share !== undefined ? round2((share / 100000) * size) : undefined
}

function paragraphProps(props: XmlElement, level: number, size: number, issues: Set<string>): Omit<Paragraph, 'runs'> {
  const out: Omit<Paragraph, 'runs'> = {}
  const align = ALIGNS[attr(props, 'algn') ?? 'l'] ?? 'left'
  const bullet = elements(props).find((node) => GROUPS[node.name] === 'bullet')
  const line = child(props, 'a:lnSpc')
  const share = numberAttr(child(line, 'a:spcPct'), 'val')
  const points = numberAttr(child(line, 'a:spcPts'), 'val')
  const before = spacingOf(child(props, 'a:spcBef'), size)
  const after = spacingOf(child(props, 'a:spcAft'), size)

  if (align !== 'left') {
    out.align = align
  }

  if (bullet?.name === 'a:buChar' || bullet?.name === 'a:buBlip') {
    const glyph = bullet.name === 'a:buChar' ? glyphOf(attr(bullet, 'char'), attr(child(props, 'a:buFont'), 'typeface')) : '•'
    out.list = 'bullet'

    if (bullet.name === 'a:buBlip') {
      issues.add(WHY.pictureBullets)
    }

    if (glyph !== bulletFor(level)) {
      out.bullet = glyph
    }
  } else if (bullet?.name === 'a:buAutoNum') {
    const type = attr(bullet, 'type') ?? 'arabicPeriod'
    const numbering = NUMBERINGS[type] ?? 'arabicPeriod'
    const startAt = Math.round(numberAttr(bullet, 'startAt', 1))
    out.list = 'number'

    if (!NUMBER_STYLES.includes(type as NumberStyle)) {
      issues.add(WHY.numbering)
    }

    if (numbering !== numberingFor(level)) {
      out.numbering = numbering
    }

    if (startAt !== 1) {
      out.startAt = startAt
    }
  }

  if (level) {
    out.level = level
  }

  if (share !== undefined && share > 0 && share !== 100000) {
    out.lineSpacing = round2(share / 100000)
  } else if (points !== undefined && points > 0 && size > 0) {
    out.lineSpacing = round2(points / 100 / (1.2 * size))
    issues.add(WHY.exactSpacing)
  }

  if (before) {
    out.spaceBefore = before
  }

  if (after) {
    out.spaceAfter = after
  }

  const margin = pt(numberAttr(props, 'marL', 0))
  const indent = pt(numberAttr(props, 'indent', 0))
  const usual = paragraphIndent({ ...out, runs: [] })

  if (Math.abs(margin - usual.margin) > 0.01 || Math.abs(indent - usual.indent) > 0.01) {
    out.margin = margin
    out.indent = indent
  }

  return out
}

function readParagraph(paragraph: XmlElement, sources: TextSources, scope: Scope, issues: Set<string>): { props: Omit<Paragraph, 'runs'>; runs: Draft[] } {
  const own = child(paragraph, 'a:pPr')
  const level = Math.min(MAX_LEVEL, Math.max(0, Math.round(numberAttr(own, 'lvl', 0))))
  const layers = levelLayers(sources.styles, level)
  // A paragraph's own default run properties are for text typed later, not for its runs.
  const props = overlay('a:pPr', [...layers.paragraph, own], 'a:defRPr')
  const look = (runProps: XmlElement | undefined): XmlElement => overlay('a:rPr', [...layers.run, runProps])
  const runs: Draft[] = []

  for (const node of treeChildren(paragraph)) {
    if (node.name === 'a:r' || node.name === 'a:fld') {
      const text = node.name === 'a:fld' && attr(node, 'type') === 'slidenum' ? String(scope.number) : textOf(child(node, 'a:t')).replace(/\v/g, '\n')
      runs.push(readRun(text, look(child(node, 'a:rPr')), sources, scope, issues))
    } else if (node.name === 'a:br') {
      const last = runs.at(-1)

      if (last) {
        last.text += '\n'
      } else {
        runs.push(readRun('\n', look(child(node, 'a:rPr')), sources, scope, issues))
      }
    }
  }

  if (!runs.length) {
    runs.push(readRun('', look(child(paragraph, 'a:endParaRPr')), sources, scope, issues))
  }

  return { props: paragraphProps(props, level, (runs.find((run) => run.text.trim()) ?? runs[0]).look.size, issues), runs }
}

/** The look most of a body's text has (by length), which runs then differ from. */
function sharedLook(drafts: readonly Draft[]): BodyStyle {
  const most = <K extends keyof RunLook>(key: K): RunLook[K] => {
    const weights = new Map<RunLook[K], number>()

    for (const draft of drafts) {
      weights.set(draft.look[key], (weights.get(draft.look[key]) ?? 0) + Math.max(1, draft.text.length))
    }

    return [...weights].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0]
  }

  const style: BodyStyle = { font: most('font'), size: most('size'), color: most('color') }

  for (const key of ['bold', 'italic', 'underline', 'strike'] as const) {
    if (most(key)) {
      style[key] = true
    }
  }

  const highlight = drafts[0]?.look.highlight

  if (highlight && drafts.every((draft) => draft.look.highlight === highlight)) {
    style.highlight = highlight
  }

  return style
}

const insetOf = (props: XmlElement, name: string, fallback: number): number => pt(Math.max(0, numberAttr(props, name, fallback)))

/** A text body (`p:txBody`) with what its sources lend it, as Herald's: paragraphs of runs over the look most of them share. */
function readBody(txBody: XmlElement | undefined, sources: TextSources, scope: Scope, issues: Set<string>): TextBody {
  const props = overlay('a:bodyPr', sources.bodies)
  const drafts = childrenNamed(txBody, 'a:p').map((paragraph) => readParagraph(paragraph, sources, scope, issues))

  if (!drafts.length) {
    drafts.push(readParagraph(EMPTY_PARAGRAPH, sources, scope, issues))
  }

  const style = sharedLook(drafts.flatMap((draft) => draft.runs))
  const vertical = attr(props, 'vert')
  const warp = attr(child(props, 'a:prstTxWarp'), 'prst')

  if (drafts.some((draft) => draft.runs.some((run) => run.text.trim()))) {
    const reasons = [
      vertical !== undefined && vertical !== 'horz' && WHY.vertical,
      numberAttr(props, 'numCol', 1) > 1 && WHY.columns,
      numberAttr(props, 'rot', 0) % 21600000 !== 0 && WHY.turnedText,
      warp !== undefined && warp !== 'textNoShape' && WHY.wordArt
    ]

    for (const reason of reasons) {
      if (reason) {
        issues.add(reason)
      }
    }
  }

  return {
    paragraphs: drafts.map((draft) => ({ ...draft.props, runs: tidyRuns(draft.runs.map((run) => ownStyle({ ...run.look, text: run.text }, { style }))) })),
    style,
    anchor: ANCHORS[attr(props, 'anchor') ?? 't'] ?? 'top',
    inset: [insetOf(props, 'lIns', 91440), insetOf(props, 'tIns', 45720), insetOf(props, 'rIns', 91440), insetOf(props, 'bIns', 45720)],
    fit: child(props, 'a:normAutofit') ? 'shrink' : child(props, 'a:spAutoFit') ? 'grow' : 'none',
    wrap: attr(props, 'wrap') !== 'none'
  }
}

async function readImage(pkg: Package, path: string): Promise<Loaded> {
  const bytes = await pkg.bytes(path)

  if (!bytes) {
    return { reason: WHY.missing }
  }

  const size = imageSize(bytes)

  return size ? { src: `data:${size.mime};base64,${base64(bytes)}`, natural: { width: size.width, height: size.height } } : { reason: WHY.format }
}

/** A blip's picture as a data URL with its pixel size, read once however many shapes show it; or why it cannot be shown. */
function loadPicture(scope: Scope, blip: XmlElement | undefined): Promise<Loaded> {
  const relationship = byId(scope.relationships, attr(blip, 'r:embed'))

  if (!relationship || relationship.external) {
    return Promise.resolve({ reason: relationship?.external || attr(blip, 'r:link') ? WHY.linked : WHY.missing })
  }

  return remember(scope.ctx.pictures, relationship.target, () => readImage(scope.ctx.pkg, relationship.target))
}

/** How much of a picture its frame cuts off; a negative side insets it, which Herald shows filling the frame. */
function cropOf(rect: XmlElement | undefined, issues: Set<string>): Crop | undefined {
  if (!rect) {
    return undefined
  }

  const sides = ['l', 't', 'r', 'b'].map((side) => numberAttr(rect, side, 0) / 100000)
  const [left, top, right, bottom] = sides.map((side) => Math.max(0, side))

  if (sides.some((side) => side < 0)) {
    issues.add(WHY.inset)
  }

  return left + right < 1 && top + bottom < 1 && (left || top || right || bottom) ? { left, top, right, bottom } : undefined
}

/** A line from corner to corner of its box, its turn folded into where it starts and ends. */
function lineFrom(placement: Placement, inverted: boolean): { from: Point; to: Point } {
  const { x, y, width, height, flipH } = placement
  const flipV = placement.flipV !== inverted
  const middle: Point = [x + width / 2, y + height / 2]
  const ends: Point[] = [
    [flipH ? x + width : x, flipV ? y + height : y],
    [flipH ? x : x + width, flipV ? y : y + height]
  ]
  const [from, to] = ends.map((end) => rotatePoint(end, middle, placement.rotation).map(round2) as Point)

  return { from, to }
}

const isConnector = (preset: string | undefined): preset is ConnectorPreset => CONNECTOR_PRESETS.includes(preset as ConnectorPreset)

/**
 * A line, or a connector when `connector` says how it runs: a straight one from corner to corner
 * of its box with its turn folded into its ends, a bent or curved one in its box as it is turned
 * and flipped, which its preset runs through.
 */
function readLine(props: XmlElement, style: XmlElement | undefined, info: XmlElement | undefined, placement: Placement, preset: string, scope: Scope, issues: Set<string>, connector?: ConnectorPreset): LineElement {
  const theme = scope.master.theme
  const outline = lineProps(props, style, theme)
  const stroke = readStroke(outline, scope.palette, colorIn(child(style, 'a:lnRef'), scope.palette), issues) ?? { ...UNSEEN }
  const look = { stroke, start: arrowOf(child(outline, 'a:headEnd')), end: arrowOf(child(outline, 'a:tailEnd')), ...nameOf(info) }
  const adjust = connector ? adjustOf(child(props, 'a:prstGeom')) : undefined
  let line: LineElement

  if (connector && connector !== 'straightConnector1') {
    line = { ...lineElement([0, 0], [0, 0], look), ...boxOf(placement), rotation: degrees(placement.rotation), flipH: placement.flipH, flipV: placement.flipV }
  } else {
    const { from, to } = lineFrom(placement, preset === 'lineInv')
    const straight = lineElement(from, to, look)
    line = { ...straight, x: round2(straight.x), y: round2(straight.y), width: round2(straight.width), height: round2(straight.height) }
  }

  if (hasEffects(props, style, theme)) {
    issues.add(WHY.effects)
  }

  tally(scope.report, 'line', issues)

  return connector ? { ...line, connector: { preset: connector, ...(adjust ? { adjust } : {}) } } : line
}

async function readShape(sp: XmlElement, given: Scope, at: readonly Transform[], group: XmlElement | undefined): Promise<SlideElement[]> {
  const nv = child(sp, 'p:nvSpPr')
  const info = child(nv, 'p:cNvPr')
  const ph = find(nv, 'p:nvPr/p:ph')
  const textBox = flagAttr(child(nv, 'p:cNvSpPr'), 'txBox') === true
  const template = ph !== undefined && given.mode === 'template'
  // A master's or layout's placeholders are places for slides' text, not elements a slide shows.
  const scope = template ? { ...given, report: emptyReport() } : given

  if (ph && scope.mode === 'copy') {
    return []
  }

  if (flagAttr(info, 'hidden')) {
    count(scope.report, textBox || ph ? 'text' : 'shape', 'skipped', WHY.hidden)

    return []
  }

  const from = ph ? (template ? templateInheritance(ph, scope) : inheritance(ph, scope)) : undefined
  const footer = from && scope.mode === 'slide' ? FOOTER_TYPES[from.type] : undefined

  if (template && !from?.role) {
    return []
  }

  if (footer) {
    const text = child(sp, 'p:txBody')
    const found = footerFound(footer, childrenNamed(text, 'a:p').map(paragraphText).join('\n'), descendants(text, 'a:fld').map((field) => attr(field, 'type') ?? ''))
    const own = find(sp, 'p:spPr/a:xfrm')
    const placed = [from?.layout, from?.master].map((layer) => find(layer, 'p:spPr/a:xfrm')).find((entry) => entry !== undefined)
    const moved = own !== undefined && JSON.stringify(boxOf(placementOf(own))) !== JSON.stringify(boxOf(placementOf(placed)))

    if (found) {
      scope.footers.push(moved ? { ...found, moved } : found)
    }

    return []
  }

  const layers = [from?.master, from?.layout, sp]
  const props = shapeProps(layers.map((layer) => child(layer, 'p:spPr')))
  const style = layers.map((layer) => child(layer, 'p:style')).findLast((entry) => entry !== undefined)
  const placement = place(placementOf(child(props, 'a:xfrm')), at)
  const custom = child(props, 'a:custGeom')
  const preset = custom ? undefined : (attr(child(props, 'a:prstGeom'), 'prst') ?? 'rect')
  const theme = scope.master.theme
  const issues = new Set<string>()

  if (preset && LINES.has(preset)) {
    if (textOf(child(sp, 'p:txBody')).trim()) {
      issues.add(WHY.lineText)
    }

    return [readLine(props, style, info, placement, preset, scope, issues, preset !== 'straightConnector1' && isConnector(preset) ? preset : undefined)]
  }

  const fillRef = child(style, 'a:fillRef')
  const read = readFill(elements(props).find((node) => FILLS.has(node.name)) ?? themeFill(fillRef, theme), scope.palette, colorIn(fillRef, scope.palette), issues, group)
  const stroke = readStroke(lineProps(props, style, theme), scope.palette, colorIn(child(style, 'a:lnRef'), scope.palette), issues)
  const body = readBody(template ? undefined : child(sp, 'p:txBody'), textSources(scope, from, sp, style), scope, issues)
  const box = boxOf(placement)
  const frame = frameOf(placement, info)
  const placeholder: Placeholder | undefined = from?.role ? { role: from.role, prompt: from.prompt } : undefined
  const picturePlaceholder = from?.role === 'picture'
  let fill = read.fill

  if (hasEffects(props, style, theme)) {
    issues.add(WHY.effects)
  }

  if (child(info, 'a:hlinkClick')) {
    issues.add(WHY.objectLinks)
  }

  if (read.picture) {
    const loaded = !custom && preset === 'rect' ? await loadPicture(scope, child(read.picture, 'a:blip')) : undefined

    if (loaded && 'src' in loaded) {
      const crop = cropOf(child(read.picture, 'a:srcRect'), issues)
      const out: SlideElement[] = [imageElement(loaded.src, loaded.natural, box, { ...frame, stroke, ...(crop ? { crop } : {}), ...(picturePlaceholder ? { placeholder } : {}) })]

      if (!picturePlaceholder) {
        issues.add(WHY.pictureShape)
      }

      if (!isBlank(body)) {
        out.push(textElement(box, body, { ...frame, ...(placeholder && !picturePlaceholder ? { placeholder } : {}) }))
      }

      tally(scope.report, picturePlaceholder ? 'picture' : 'shape', issues)

      return out
    }

    fill = fillOf(themeColor('accent1', scope.palette))
    issues.add(WHY.pictureFill)
  }

  if (picturePlaceholder) {
    tally(scope.report, 'picture', issues)

    return [imageElement('', { width: 0, height: 0 }, box, { ...frame, stroke, placeholder })]
  }

  const visible = fill !== null || stroke !== null
  const plain = !custom && preset === 'rect'

  if ((textBox || ph || !visible) && (plain || !visible)) {
    tally(scope.report, 'text', issues)

    return [textElement(box, body, { ...frame, fill, stroke, ...(placeholder ? { placeholder } : {}) })]
  }

  const known = preset !== undefined && SHAPE_KINDS.includes(preset as ShapeKind)
  const extent = find(props, 'a:xfrm/a:ext')
  const outline = custom ? readGeometry(custom, Math.max(0, numberAttr(extent, 'cx', 0)), Math.max(0, numberAttr(extent, 'cy', 0))) : null
  const kind: ShapeKind = known ? (preset as ShapeKind) : outline ? 'rect' : (NEAREST[preset ?? 'rect'] ?? 'rect')
  const adjust = known ? adjustOf(child(props, 'a:prstGeom')) : undefined

  if (!known && !outline) {
    issues.add(custom ? WHY.customShape : WHY.nearestShape)
  }

  tally(scope.report, 'shape', issues)

  return [shapeElement(kind, box, { ...frame, fill, stroke, body, ...(adjust ? { adjust } : {}), ...(outline ? { paths: outline } : {}), ...(placeholder ? { placeholder } : {}) })]
}

/** A preset's adjust values (`a:gd fmla="val 16667"`) by guide name. */
function adjustOf(geometry: XmlElement | undefined): Record<string, number> | undefined {
  const entries = childrenNamed(child(geometry, 'a:avLst'), 'a:gd').flatMap((guide) => {
    const name = attr(guide, 'name')
    const value = /^val\s+(-?\d+(?:\.\d+)?)$/.exec((attr(guide, 'fmla') ?? '').trim())

    return name && value ? [[name, Number(value[1])] as const] : []
  })

  return entries.length ? Object.fromEntries(entries) : undefined
}

function mediaOf(nvPr: XmlElement | undefined, scope: Scope): 'audio' | 'video' | null {
  if (child(nvPr, 'a:audioFile') || child(nvPr, 'a:wavAudioFile') || child(nvPr, 'a:audioCd')) {
    return 'audio'
  }

  if (child(nvPr, 'a:videoFile') || child(nvPr, 'a:quickTimeFile')) {
    return 'video'
  }

  const media = descendants(child(nvPr, 'p:extLst'), 'p14:media')[0]

  if (!media) {
    return null
  }

  return AUDIO.test(byId(scope.relationships, attr(media, 'r:embed') ?? attr(media, 'r:link'))?.target ?? '') ? 'audio' : 'video'
}

/** A picture (`p:pic`), or an embedded object's picture when `frame` is the object's frame. */
async function readPicture(pic: XmlElement, scope: Scope, at: readonly Transform[], as: 'picture' | 'ole', frame?: XmlElement): Promise<SlideElement[]> {
  const nv = child(pic, 'p:nvPicPr')
  const info = frame ? find(frame, 'p:nvGraphicFramePr/p:cNvPr') : child(nv, 'p:cNvPr')
  const ph = find(nv, 'p:nvPr/p:ph')

  if (ph && scope.mode !== 'slide') {
    return []
  }

  const media = mediaOf(child(nv, 'p:nvPr'), scope)
  const kind = media ?? as

  if (flagAttr(info, 'hidden') || media === 'audio') {
    count(scope.report, kind, 'skipped', flagAttr(info, 'hidden') ? WHY.hidden : WHY.sound)

    return []
  }

  const from = ph ? inheritance(ph, scope) : undefined
  const props = shapeProps([from?.master, from?.layout, pic].map((layer) => child(layer, 'p:spPr')))
  const placement = place(placementOf((frame && child(frame, 'p:xfrm')) ?? child(props, 'a:xfrm')), at)
  const fill = child(pic, 'p:blipFill')
  const blip = child(fill, 'a:blip')
  const loaded = await loadPicture(scope, blip)

  if ('reason' in loaded) {
    count(scope.report, kind, 'skipped', loaded.reason)

    return []
  }

  const style = child(pic, 'p:style')
  const theme = scope.master.theme
  const issues = new Set<string>(media === 'video' ? [WHY.video] : as === 'ole' ? [WHY.ole] : [])
  const crop = cropOf(child(fill, 'a:srcRect'), issues)
  const stroke = readStroke(lineProps(props, style, theme), scope.palette, colorIn(child(style, 'a:lnRef'), scope.palette), issues)
  const alt = attr(info, 'descr') || attr(child(nv, 'p:cNvPr'), 'descr')
  const geometry = attr(child(props, 'a:prstGeom'), 'prst') ?? 'rect'
  const placeholder: Placeholder | undefined = from?.role === 'picture' ? { role: 'picture', prompt: from.prompt } : undefined
  const reasons = [
    child(fill, 'a:tile') !== undefined && WHY.tiled,
    (child(props, 'a:custGeom') !== undefined || geometry !== 'rect') && WHY.pictureCut,
    elements(blip).some((node) => node.name !== 'a:extLst') && WHY.pictureEffects,
    hasEffects(props, style, theme) && WHY.effects,
    child(info, 'a:hlinkClick') !== undefined && WHY.objectLinks
  ]

  for (const reason of reasons) {
    if (reason) {
      issues.add(reason)
    }
  }

  tally(scope.report, kind, issues)

  return [imageElement(loaded.src, loaded.natural, boxOf(placement), { ...frameOf(placement, info), stroke, ...(crop ? { crop } : {}), ...(alt ? { alt } : {}), ...(placeholder ? { placeholder } : {}) })]
}

/** A connector (`p:cxnSp`): how it runs, and the shapes its ends are glued to, found once the slide's shapes are read. */
async function readConnector(connector: XmlElement, scope: Scope, at: readonly Transform[]): Promise<SlideElement[]> {
  const nv = child(connector, 'p:nvCxnSpPr')
  const info = child(nv, 'p:cNvPr')
  const props = child(connector, 'p:spPr') ?? xml('p:spPr')

  if (flagAttr(info, 'hidden')) {
    count(scope.report, 'line', 'skipped', WHY.hidden)

    return []
  }

  const placement = place(placementOf(child(props, 'a:xfrm')), at)
  const preset = child(props, 'a:custGeom') ? 'custom' : (attr(child(props, 'a:prstGeom'), 'prst') ?? 'line')
  const issues = new Set<string>()

  if (!isConnector(preset) && preset !== 'line' && preset !== 'lineInv') {
    issues.add(WHY.straight)
  }

  const line = readLine(props, child(connector, 'p:style'), info, placement, preset, scope, issues, isConnector(preset) ? preset : 'straightConnector1')
  const glued = child(nv, 'p:cNvCxnSpPr')
  const end = (name: string): LinkEnd | undefined => {
    const site = child(glued, name)
    const id = attr(site, 'id')

    return id ? { id, site: Math.max(0, Math.round(numberAttr(site, 'idx', 0))) } : undefined
  }
  const start = end('a:stCxn')
  const finish = end('a:endCxn')

  if (start || finish) {
    scope.links.push({ line: line.id, ...(start ? { start } : {}), ...(finish ? { end: finish } : {}) })
  }

  return [line]
}

/** A group's members, placed through its transform, each told it is in the group (and the groups around it). */
async function readGroup(group: XmlElement, scope: Scope, at: readonly Transform[], depth: number, fill: XmlElement | undefined): Promise<SlideElement[]> {
  const props = child(group, 'p:grpSpPr')
  const own = elements(props).find((node) => FILLS.has(node.name))

  if (flagAttr(find(group, 'p:nvGrpSpPr/p:cNvPr'), 'hidden')) {
    count(scope.report, 'group', 'skipped', WHY.hidden)

    return []
  }

  if (depth >= MAX_DEPTH) {
    count(scope.report, 'group', 'skipped', WHY.nested)

    return []
  }

  count(scope.report, 'group', 'imported')

  const id = newId('group')
  const members = await walk(treeChildren(group), scope, [...at, groupTransform(child(props, 'a:xfrm'))], depth + 1, own && own.name !== 'a:grpFill' ? own : fill)

  return members.map((member) => ({ ...member, group: [id, ...(member.group ?? [])] }))
}

/** Connectors glued to the shapes their ends name, among those read with them. */
function glue(elements: readonly SlideElement[], scope: Scope): SlideElement[] {
  const links = new Map(scope.links.map((link) => [link.line, link]))
  const end = (at: LinkEnd | undefined): ConnectorEnd | undefined => {
    const element = at ? scope.ids.get(at.id) : undefined

    return element && at ? { element, site: at.site } : undefined
  }

  return elements.map((element) => {
    const link = element.kind === 'line' && element.connector ? links.get(element.id) : undefined

    if (!link || element.kind !== 'line' || !element.connector) {
      return element
    }

    const start = end(link.start)
    const finish = end(link.end)

    return start || finish ? { ...element, connector: { ...element.connector, ...(start ? { start } : {}), ...(finish ? { end: finish } : {}) } } : element
  })
}

const frameKind = (uri: string): ReportKind =>
  uri.endsWith('/table') ? 'table' : /\/chart(ex)?$/.test(uri) ? 'chart' : uri.endsWith('/diagram') ? 'smartart' : uri.endsWith('/ole') ? 'ole' : 'other'

/** An embedded object's picture: its fallback's where it offers a choice, else any it holds. */
function olePicture(data: XmlElement | undefined): XmlElement | undefined {
  return treeChildren(data)
    .map((node) => child(node, 'p:pic'))
    .find((pic) => pic !== undefined) ?? descendants(data, 'p:pic')[0]
}

const TABLE_FLAGS = ['firstRow', 'lastRow', 'firstCol', 'lastCol', 'bandRow', 'bandCol'] as const

type TableFlags = Record<(typeof TABLE_FLAGS)[number], boolean>

const CELL_SIDES = ['a:lnL', 'a:lnR', 'a:lnT', 'a:lnB'] as const
const STYLE_SIDES = ['a:left', 'a:right', 'a:top', 'a:bottom', 'a:insideH', 'a:insideV'] as const

/** PowerPoint's default table style, Medium Style 2 in the first accent: PowerPoint knows it without a file holding it. */
const DEFAULT_TABLE_STYLE = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'

const styleLine = (width: number): string => `<a:ln w="${width}" cmpd="sng"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln>`
const styleFill = (tint?: number): string => `<a:fill><a:solidFill><a:schemeClr val="accent1">${tint ? `<a:tint val="${tint}"/>` : ''}</a:schemeClr></a:solidFill></a:fill>`
const styleEdge = (part: string, side?: string): string =>
  `<a:${part}><a:tcTxStyle b="on"><a:fontRef idx="minor"/><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle>${side ? `<a:tcBdr><a:${side}>${styleLine(38100)}</a:${side}></a:tcBdr>` : ''}${styleFill()}</a:tcStyle></a:${part}>`

const DEFAULT_STYLE = parseXml(
  `<a:tblStyle xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" styleId="${DEFAULT_TABLE_STYLE}"><a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"/><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr>${STYLE_SIDES.map((side) => `<${side}>${styleLine(12700)}</${side}>`).join('')}</a:tcBdr>${styleFill(20000)}</a:tcStyle></a:wholeTbl><a:band1H><a:tcStyle>${styleFill(40000)}</a:tcStyle></a:band1H><a:band1V><a:tcStyle>${styleFill(40000)}</a:tcStyle></a:band1V>${styleEdge('lastCol')}${styleEdge('firstCol')}${styleEdge('lastRow', 'top')}${styleEdge('firstRow', 'bottom')}</a:tblStyle>`
)

/** A cell's sides, in the order of its own lines (`a:lnL`, `a:lnR`, `a:lnT`, `a:lnB`). */
const SIDES = ['left', 'right', 'top', 'bottom'] as const

type Side = (typeof SIDES)[number]

/** A run of rows or columns, from the first to the last. */
type Span = [number, number]

/** A part of a table style and the block of cells it styles, whose outer sides take its outer lines and whose sides within take its inside lines. */
interface StylePart {
  part: XmlElement
  rows: Span
  columns: Span
}

/** The parts of a table style that reach a cell, the most general first, as PowerPoint lays them over each other. */
function styleParts(style: XmlElement | undefined, flags: TableFlags, row: number, column: number, rows: number, columns: number): StylePart[] {
  const firstRow = flags.firstRow && row === 0
  const lastRow = flags.lastRow && row === rows - 1
  const firstCol = flags.firstCol && column === 0
  const lastCol = flags.lastCol && column === columns - 1
  const across = row - (flags.firstRow ? 1 : 0)
  const down = column - (flags.firstCol ? 1 : 0)
  const allRows: Span = [0, rows - 1]
  const allColumns: Span = [0, columns - 1]
  const names: [string, Span, Span][] = [
    ['a:wholeTbl', allRows, allColumns],
    [flags.bandCol && !firstCol && !lastCol ? (down % 2 ? 'a:band2V' : 'a:band1V') : '', allRows, [column, column]],
    [flags.bandRow && !firstRow && !lastRow ? (across % 2 ? 'a:band2H' : 'a:band1H') : '', [row, row], allColumns],
    [firstCol ? 'a:firstCol' : '', allRows, [0, 0]],
    [lastCol ? 'a:lastCol' : '', allRows, [columns - 1, columns - 1]],
    [firstRow ? 'a:firstRow' : '', [0, 0], allColumns],
    [lastRow ? 'a:lastRow' : '', [rows - 1, rows - 1], allColumns]
  ]

  return names.flatMap(([name, spanRows, spanColumns]) => {
    const part = name ? child(style, name) : undefined

    return part ? [{ part, rows: spanRows, columns: spanColumns }] : []
  })
}

/** The line a table style gives a side of a cell reaching across `rows` and `columns`: the last part's that says, undefined when none does. */
function styleSide(parts: readonly StylePart[], side: Side, rows: Span, columns: Span, scope: Scope, issues: Set<string>): Stroke | null | undefined {
  for (const entry of [...parts].reverse()) {
    const edge = side === 'left' ? columns[0] === entry.columns[0] : side === 'right' ? columns[1] === entry.columns[1] : side === 'top' ? rows[0] === entry.rows[0] : rows[1] === entry.rows[1]
    const border = find(entry.part, `a:tcStyle/a:tcBdr/${edge ? `a:${side}` : side === 'left' || side === 'right' ? 'a:insideV' : 'a:insideH'}`)
    const ref = child(border, 'a:lnRef')
    const line = child(border, 'a:ln') ?? themeLine(ref, scope.master.theme)

    if (line) {
      return readStroke(line, scope.palette, colorIn(ref, scope.palette), issues)
    }
  }

  return undefined
}

/** A table style part's text look (`a:tcTxStyle`) as a list style, to lay under a cell's own. */
function partTextStyle(part: XmlElement): XmlElement | undefined {
  const text = child(part, 'a:tcTxStyle')

  if (!text) {
    return undefined
  }

  const color = elements(text).find(isColorElement)
  const font = attr(child(text, 'a:fontRef'), 'idx')
  const typeface = font === 'major' ? '+mj-lt' : font === 'minor' ? '+mn-lt' : attr(find(text, 'a:font/a:latin'), 'typeface')
  const toggle = (name: string): string | undefined => (attr(text, name) === 'on' ? '1' : attr(text, name) === 'off' ? '0' : undefined)

  return xml('a:lstStyle', {}, [xml('a:defPPr', {}, [xml('a:defRPr', { b: toggle('b'), i: toggle('i') }, [...(color ? [xml('a:solidFill', {}, [color])] : []), ...(typeface ? [xml('a:latin', { typeface })] : [])])])])
}

/** The fill the style gives a cell (the last of its parts with one), and what `phClr` stands for in it. */
function partFill(parts: readonly XmlElement[], scope: Scope): { element: XmlElement; placeholder: Paint | null } | undefined {
  for (const part of [...parts].reverse()) {
    const style = child(part, 'a:tcStyle')
    const own = elements(child(style, 'a:fill')).find((node) => FILLS.has(node.name))
    const ref = child(style, 'a:fillRef')
    const element = own ?? themeFill(ref, scope.master.theme)

    if (element) {
      return { element, placeholder: own ? null : colorIn(ref, scope.palette) }
    }
  }

  return undefined
}

/** About how tall a cell's text is, a line a paragraph: PowerPoint grows a row to its text, so a file may give a row less. */
function textHeight(body: TextBody): number {
  return body.paragraphs.reduce((sum, paragraph) => {
    const lines = 1 + paragraph.runs.reduce((breaks, run) => breaks + (run.text.match(/\n/g)?.length ?? 0), 0)
    const size = Math.max(...paragraph.runs.map((run) => run.size ?? body.style.size))

    return sum + lines * size * 1.2 * (paragraph.lineSpacing ?? 1)
  }, body.inset[1] + body.inset[3])
}

/** A table cell (`a:tc`) with what the table's style gives it, and the lines it says it has on each side (undefined where it says nothing). */
function readCell(tc: XmlElement | undefined, parts: readonly XmlElement[], back: XmlElement | undefined, scope: Scope, issues: Set<string>): { cell: TableCell; sides: (Stroke | null | undefined)[] } {
  const props = child(tc, 'a:tcPr') ?? xml('a:tcPr')
  const sources: TextSources = { styles: [scope.ctx.defaults, scope.master.styles.other, ...parts.map(partTextStyle), find(tc, 'a:txBody/a:lstStyle')], bodies: [], title: false }
  const text = readBody(child(tc, 'a:txBody'), sources, scope, issues)
  const own = elements(props).find((node) => FILLS.has(node.name))
  const styled = partFill(parts, scope)
  const read = own ? readFill(own, scope.palette, null, issues) : styled ? readFill(styled.element, scope.palette, styled.placeholder, issues) : readFill(back, scope.palette, null, issues)
  const vertical = attr(props, 'vert')
  const across = Math.round(numberAttr(tc, 'gridSpan', 1))
  const down = Math.round(numberAttr(tc, 'rowSpan', 1))

  if (read.picture) {
    issues.add(WHY.pictureFill)
  }

  if (vertical && vertical !== 'horz' && !isBlank(text)) {
    issues.add(WHY.vertical)
  }

  if (['a:lnTlToBr', 'a:lnBlToTr'].some((name) => readStroke(child(props, name), scope.palette, null, issues))) {
    issues.add(WHY.diagonals)
  }

  const body: TextBody = {
    ...text,
    anchor: ANCHORS[attr(props, 'anchor') ?? 't'] ?? 'top',
    inset: [insetOf(props, 'marL', 91440), insetOf(props, 'marT', 45720), insetOf(props, 'marR', 91440), insetOf(props, 'marB', 45720)],
    fit: 'none',
    wrap: true
  }

  return {
    cell: { body, fill: read.fill, ...(across > 1 ? { colSpan: across } : {}), ...(down > 1 ? { rowSpan: down } : {}) },
    sides: CELL_SIDES.map((side) => (child(props, side) ? readStroke(child(props, side), scope.palette, null, issues) : undefined))
  }
}

const strokeKey = (stroke: Stroke | null): string => (stroke ? `${stroke.color} ${stroke.width} ${stroke.dash} ${stroke.alpha ?? 1}` : 'none')

/**
 * A table (`a:tbl`) as Herald's: its grid, rows at least as tall as their text, and cells with
 * merged ones whole, the table's style worked out into each cell's fill, text and lines. The line
 * most sides have (a cell's own, else its style's) becomes the table's, and each cell keeps the
 * sides that differ from it.
 */
function readTable(frame: XmlElement, tbl: XmlElement, scope: Scope, at: readonly Transform[]): SlideElement[] {
  const info = find(frame, 'p:nvGraphicFramePr/p:cNvPr')
  const own = placementOf(child(frame, 'p:xfrm'))
  const placement = place(own, at)
  const grid = childrenNamed(child(tbl, 'a:tblGrid'), 'a:gridCol')
  const trs = childrenNamed(tbl, 'a:tr')
  const across = Math.min(MAX_COLUMNS, grid.length || Math.max(0, ...trs.map((tr) => childrenNamed(tr, 'a:tc').length)))
  const down = Math.min(MAX_ROWS, trs.length)
  const issues = new Set<string>()

  if (!across || !down) {
    count(scope.report, 'table', 'skipped', WHY.emptyTables)

    return []
  }

  const tblPr = child(tbl, 'a:tblPr')
  const styleId = textOf(child(tblPr, 'a:tableStyleId')).trim()
  const style = styleId ? (scope.ctx.tableStyles.get(styleId) ?? DEFAULT_STYLE) : undefined
  const flags = Object.fromEntries(TABLE_FLAGS.map((name) => [name, flagAttr(tblPr, name) === true])) as TableFlags
  const back = elements(tblPr).find((node) => FILLS.has(node.name))
  const sx = own.width ? placement.width / own.width : 1
  const sy = own.height ? placement.height / own.height : 1

  if (grid.length > MAX_COLUMNS || trs.length > MAX_ROWS) {
    issues.add(WHY.bigTables)
  }

  if (placement.rotation) {
    issues.add(WHY.turnedTables)
  }

  if (styleId && !scope.ctx.tableStyles.has(styleId) && styleId !== DEFAULT_TABLE_STYLE) {
    issues.add(WHY.tableStyles)
  }

  const reads = Array.from({ length: down }, (_, r) => {
    const tcs = childrenNamed(trs[r], 'a:tc')

    return Array.from({ length: across }, (_, c) => {
      const parts = styleParts(style, flags, r, c, down, across)

      return { ...readCell(tcs[c], parts.map((entry) => entry.part), back, scope, issues), parts }
    })
  })
  const settled = settleSpans(reads.map((row) => row.map((read) => read.cell)), across)
  const lines = settled.map((row, r) =>
    row.map((cell, c) => {
      const read = reads[r][c]
      const spanRows: Span = [r, r + (cell.rowSpan ?? 1) - 1]
      const spanColumns: Span = [c, c + (cell.colSpan ?? 1) - 1]

      return SIDES.map((side, index) => (read.sides[index] !== undefined ? read.sides[index] : (styleSide(read.parts, side, spanRows, spanColumns, scope, issues) ?? null)))
    })
  )
  const kinds = new Map<string, { stroke: Stroke; uses: number }>()

  for (const [r, row] of settled.entries()) {
    for (const [c, cell] of row.entries()) {
      for (const line of cell.merged ? [] : lines[r][c]) {
        if (line) {
          const kind = kinds.get(strokeKey(line)) ?? { stroke: line, uses: 0 }
          kind.uses++
          kinds.set(strokeKey(line), kind)
        }
      }
    }
  }

  const stroke = [...kinds.values()].sort((a, b) => b.uses - a.uses)[0]?.stroke ?? null
  const cells = settled.map((row, r) =>
    row.map((cell, c): TableCell => {
      const borders: CellBorders = {}

      SIDES.forEach((side, index) => {
        const line = lines[r][c][index]

        if (!cell.merged && strokeKey(line) !== strokeKey(stroke)) {
          borders[side] = line
        }
      })

      return Object.keys(borders).length ? { ...cell, borders } : cell
    })
  )
  const columns = Array.from({ length: across }, (_, c) => round2(Math.max(1, (grid[c] ? pt(numberAttr(grid[c], 'w', 0)) : own.width / across) * sx)))
  const rows = Array.from({ length: down }, (_, r) => {
    const needed = Math.max(0, ...settled[r].map((cell) => (cell.merged || (cell.rowSpan ?? 1) > 1 ? 0 : textHeight(cell.body))))

    return round2(Math.max(1, pt(numberAttr(trs[r], 'h', 0)) * sy, needed))
  })
  const table: TableElement = {
    id: newId('table'),
    kind: 'table',
    x: round2(placement.x),
    y: round2(placement.y),
    width: round2(columns.reduce((sum, width) => sum + width, 0)),
    height: round2(rows.reduce((sum, height) => sum + height, 0)),
    rotation: 0,
    ...nameOf(info),
    columns,
    rows,
    cells,
    stroke
  }

  tally(scope.report, 'table', issues)

  return [table]
}

/** A diagram's drawing (the shapes PowerPoint last laid it out as), read as a slide's shapes are but counted with the diagram. */
async function diagramShapes(scope: Scope, drawing: Relationship): Promise<SlideElement[]> {
  const root = await scope.ctx.pkg.xml(drawing.target)

  if (!root) {
    return []
  }

  const relationships = await scope.ctx.pkg.relationships(drawing.target)
  const shapes = await readTree(drawingShapes(root), { ...scope, relationships, report: emptyReport(), mode: 'copy', part: undefined, ids: new Map(), links: [] })

  return shapes.filter((shape) => shape.kind !== 'object')
}

/**
 * A chart, SmartArt or embedded object kept as it was: its frame's XML (with the markup choice
 * around it, if it came from one) and the parts it names, shown as its picture or drawing; null
 * when it cannot be kept, as it is then shown as before.
 */
async function readObject(frame: XmlElement, data: XmlElement | undefined, kind: ReportKind, scope: Scope, at: readonly Transform[]): Promise<SlideElement[] | null> {
  const object = KEPT[kind]
  const part = scope.part

  if (!object || !part) {
    return null
  }

  const pkg = scope.ctx.pkg
  const wrapper = CHOSEN.get(frame)
  const node = wrapper ?? frame
  const written = await pkg.source(part.path)
  const source = written ? writtenXml(part.root, written, node) : null

  if (!source) {
    return null
  }

  const diagram = object === 'diagram' ? await pkg.xml(partOf(scope.relationships, attr(child(data, 'dgm:relIds'), 'r:dm'))) : undefined
  const named = byId(scope.relationships, drawingId(diagram))
  const drawing = named && !named.external ? named : undefined
  const ids = relationshipIds(node)
  const links = ids.filter((id) => isLink(byId(scope.relationships, id)))
  const parts = await keptParts(pkg, scope.relationships, [...ids.filter((id) => !links.includes(id)), ...(drawing ? [drawing.id] : [])])

  if (!parts) {
    return null
  }

  const own = placementOf(child(frame, 'p:xfrm'))
  const placement = place(own, at)
  const info = find(frame, 'p:nvGraphicFramePr/p:cNvPr')
  const picture = object === 'ole' ? olePicture(data) : child(child(wrapper, 'mc:Fallback'), 'p:pic')
  const loaded = picture ? await loadPicture(scope, find(picture, 'p:blipFill/a:blip')) : undefined
  const preview = loaded && 'src' in loaded ? loaded : undefined
  const shapes = drawing ? await diagramShapes(scope, drawing) : []
  const issues = new Set<string>()

  if (object === 'diagram' ? !shapes.length : !preview) {
    issues.add(object === 'diagram' ? WHY.diagramBox : object === 'chart' ? WHY.chartBox : WHY.oleBox)
  }

  if (links.length) {
    issues.add(WHY.objectLinks)
  }

  tally(scope.report, kind, issues)

  return [
    {
      id: newId('object'),
      kind: 'object',
      ...boxOf(placement),
      ...frameOf(placement, info),
      object,
      ...(preview ? { preview } : {}),
      ...(shapes.length ? { shapes, drawnIn: { width: round2(own.width), height: round2(own.height) } } : {}),
      source: { xml: source, parts }
    }
  ]
}

async function readFrame(frame: XmlElement, scope: Scope, at: readonly Transform[], depth: number): Promise<SlideElement[]> {
  const data = find(frame, 'a:graphic/a:graphicData')
  const kind = frameKind(attr(data, 'uri') ?? '')
  const table = kind === 'table' ? child(data, 'a:tbl') : undefined

  if (flagAttr(find(frame, 'p:nvGraphicFramePr/p:cNvPr'), 'hidden')) {
    count(scope.report, kind, 'skipped', WHY.hidden)

    return []
  }

  if (table) {
    return readTable(frame, table, scope, at)
  }

  const kept = await readObject(frame, data, kind, scope, at)
  const fallback = child(CHOSEN.get(frame), 'mc:Fallback')

  if (kept) {
    return kept
  }

  // A markup choice Herald cannot keep is shown as its fallback, as other choices are.
  if (fallback) {
    return walk(treeChildren(fallback), scope, at, depth)
  }

  const picture = kind === 'ole' ? olePicture(data) : undefined

  if (picture) {
    return readPicture(picture, scope, at, 'ole', frame)
  }

  count(scope.report, kind, 'skipped', kind === 'table' ? WHY.emptyTables : undefined)

  return []
}

function kindGuess(node: XmlElement): ReportKind {
  if (node.name === 'p:graphicFrame') {
    return frameKind(attr(find(node, 'a:graphic/a:graphicData'), 'uri') ?? '')
  }

  return node.name === 'p:sp' && flagAttr(find(node, 'p:nvSpPr/p:cNvSpPr'), 'txBox') ? 'text' : (NODE_KINDS[node.name] ?? 'other')
}

async function readNode(node: XmlElement, scope: Scope, at: readonly Transform[], depth: number, group: XmlElement | undefined): Promise<SlideElement[]> {
  if (node.name === 'p:sp') {
    return readShape(node, scope, at, group)
  }

  if (node.name === 'p:pic') {
    return readPicture(node, scope, at, 'picture')
  }

  if (node.name === 'p:cxnSp') {
    return readConnector(node, scope, at)
  }

  if (node.name === 'p:grpSp') {
    return readGroup(node, scope, at, depth, group)
  }

  if (node.name === 'p:graphicFrame') {
    return readFrame(node, scope, at, depth)
  }

  // Elements in other namespaces are extensions PowerPoint itself may ignore.
  if (node.name.startsWith('p:') && !STRUCTURE.has(node.name)) {
    count(scope.report, node.name === 'p:contentPart' ? 'ink' : 'other', 'skipped')
  }

  return []
}

/** Shapes back to front as Herald's elements; one that cannot be read is counted as left out and the rest go on. */
async function walk(nodes: readonly XmlElement[], scope: Scope, at: readonly Transform[], depth: number, group?: XmlElement): Promise<SlideElement[]> {
  const out: SlideElement[] = []

  for (const node of nodes) {
    try {
      const read = await readNode(node, scope, at, depth, group)
      const id = node.name === 'p:grpSp' ? undefined : attr(child(nonVisual(node), 'p:cNvPr'), 'id')

      if (id && read[0]) {
        scope.ids.set(id, read[0].id)
      }

      out.push(...read)
    } catch {
      count(scope.report, kindGuess(node), 'skipped', WHY.unreadable)
    }
  }

  return out
}

/** Shapes read whole: back to front, with connectors glued to the shapes among them their ends name. */
async function readTree(nodes: readonly XmlElement[], scope: Scope): Promise<SlideElement[]> {
  return glue(await walk(nodes, scope, [], 0), scope)
}

/** Drawings of a master or layout copied onto a slide as its own, read in the slide's colours with its number; counted for the first slide only. */
async function copies(scope: Scope, template: Template, nodes: readonly XmlElement[], key: string): Promise<SlideElement[]> {
  const counted = scope.ctx.counted.has(key)
  scope.ctx.counted.add(key)

  return readTree(nodes, {
    ...scope,
    relationships: template.relationships,
    mode: 'copy',
    report: counted ? emptyReport() : scope.report,
    part: template.root ? { path: template.path, root: template.root } : undefined,
    ids: new Map(),
    links: []
  })
}

async function readBackground(bg: XmlElement, scope: Scope, notes: Set<string>): Promise<Background | null> {
  const props = child(bg, 'p:bgPr')
  const ref = child(bg, 'p:bgRef')
  const fill = props ? elements(props).find((node) => FILLS.has(node.name)) : themeFill(ref, scope.master.theme)
  const placeholder = props ? null : colorIn(ref, scope.palette)

  if (fill?.name === 'a:solidFill' || fill?.name === 'a:pattFill') {
    const paint = colorIn(fill.name === 'a:pattFill' ? child(fill, 'a:fgClr') : fill, scope.palette, placeholder)

    if (fill.name === 'a:pattFill') {
      notes.add(WHY.pattern)
    }

    return paint && paint.color !== 'bg1' ? { kind: 'solid', color: paint.color } : null
  }

  if (fill?.name === 'a:gradFill') {
    const gradient = gradientOf(fill, scope.palette, placeholder)
    const only = gradientStops(fill, scope.palette, placeholder)[0]

    return gradient ? { kind: 'gradient', ...gradient } : only ? { kind: 'solid', color: only.color } : null
  }

  if (fill?.name !== 'a:blipFill') {
    return null
  }

  const picture = await loadPicture(scope, child(fill, 'a:blip'))

  if ('reason' in picture) {
    notes.add(picture.reason)

    return null
  }

  const size = scope.ctx.size

  if (child(fill, 'a:tile')) {
    notes.add(WHY.backgroundTiles)
  } else if (Math.abs(picture.natural.width / picture.natural.height / (size.width / size.height) - 1) > 0.02) {
    notes.add(WHY.backgroundStretch)
  }

  return { kind: 'image', src: picture.src, natural: picture.natural }
}

interface Source {
  path: string
  root: XmlElement
  relationships: Relationship[]
}

/** A slide's background: its own, else its layout's, else its master's, in the slide's colours. */
async function backgroundOf(scope: Scope, sources: readonly Source[]): Promise<Background | null> {
  for (const source of sources) {
    const bg = find(source.root, 'p:cSld/p:bg')

    if (bg) {
      const notes = new Set<string>()
      const background = await readBackground(bg, { ...scope, relationships: source.relationships }, notes)
      noteOnce(scope.ctx, `background ${source.path}`, notes)

      return background
    }
  }

  return null
}

async function notesOf(ctx: Context, relationships: readonly Relationship[]): Promise<string> {
  const root = await ctx.pkg.xml(targetOf(relationships, 'notesSlide'))
  const body = treeChildren(find(root, 'p:cSld/p:spTree')).find((node) => node.name === 'p:sp' && attr(find(node, 'p:nvSpPr/p:nvPr/p:ph'), 'type') === 'body')

  return childrenNamed(child(body, 'p:txBody'), 'a:p').map(paragraphText).join('\n').replace(/\v/g, '\n').trimEnd()
}

function animated(root: XmlElement): boolean {
  const timings = [child(root, 'p:timing'), ...childrenNamed(root, 'mc:AlternateContent').map((node) => child(child(node, 'mc:Fallback') ?? child(node, 'mc:Choice'), 'p:timing'))]

  return timings.some((timing) => ANIMATIONS.some((name) => descendants(timing, name).length > 0))
}

async function commentsOf(ctx: Context, relationships: readonly Relationship[]): Promise<number> {
  let total = 0

  for (const relationship of relationships) {
    if (relationship.type === 'comments' && !relationship.external) {
      const root = await ctx.pkg.xml(relationship.target)
      total += root ? elements(root).filter((node) => node.name === 'cm' || node.name.endsWith(':cm')).length : 1
    }
  }

  return total
}

/** A master's or layout's own background and elements, its placeholders as the empty places they are; its drawings are counted here, once. */
async function readTemplate(ctx: Context, master: Master, layout?: Layout): Promise<{ background: Background | null; own: boolean; elements: SlideElement[] }> {
  const template: Template = layout ?? master
  const root = template.root
  const palette: Palette = { scheme: master.theme.scheme, map: layout?.map ?? master.map, slots: master.slots }
  const scope: Scope = {
    ctx,
    report: ctx.report,
    relationships: template.relationships,
    palette,
    text: themeColor('tx1', palette)?.color ?? 'tx1',
    master,
    layout,
    mode: 'template',
    number: 0,
    ...(root ? { part: { path: template.path, root } } : {}),
    ids: new Map(),
    links: [],
    footers: []
  }
  const bg = find(root, 'p:cSld/p:bg')
  const notes = new Set<string>()

  ctx.counted.add(template.path)

  const elements = await readTree(treeChildren(find(root, 'p:cSld/p:spTree')).filter((node) => !template.numbered.includes(node)), scope)
  const background = bg ? await readBackground(bg, scope, notes) : null
  noteOnce(ctx, `background ${template.path}`, notes)

  return { background, own: bg !== undefined, elements }
}

/** A master's layouts Herald keeps: for each of its own layouts, the first that maps to it; and how many others there are. */
async function layoutsOf(ctx: Context, master: Master): Promise<{ kept: Map<LayoutId, Layout>; others: number }> {
  const listed = childrenNamed(child(master.root, 'p:sldLayoutIdLst'), 'p:sldLayoutId').map((entry) => partOf(master.relationships, attr(entry, 'r:id')))
  const paths = listed.some((entry) => entry !== undefined) ? listed : master.relationships.filter((entry) => entry.type === 'slideLayout' && !entry.external).map((entry) => entry.target)
  const kept = new Map<LayoutId, Layout>()
  let others = 0

  for (const path of new Set(paths)) {
    const layout = path ? await layoutAt(ctx, path) : undefined

    if (layout?.master === master && kept.has(layout.id)) {
      others++
    } else if (layout?.master === master) {
      kept.set(layout.id, layout)
    }
  }

  return { kept, others }
}

/**
 * The deck's master: the background, elements and placeholders of the master most slides use, and
 * for each of Herald's layouts the first of its layouts that maps to it (Herald's own where none
 * does). Notes the drawings and background it gives slides of each layout, for each slide to add
 * what its own differ in.
 */
async function readMaster(ctx: Context): Promise<{ master: DeckMaster; others: number } | undefined> {
  const master = ctx.main

  if (!master.root) {
    return undefined
  }

  const own = await readTemplate(ctx, master)
  const drawn = own.elements.some((element) => !element.placeholder)
  const herald = defaultMaster(ctx.size)
  const { kept, others } = await layoutsOf(ctx, master)
  const layouts: SlideLayout[] = []

  for (const id of LAYOUTS) {
    const layout = kept.get(id)

    if (!layout) {
      layouts.push(herald.layouts.find((entry) => entry.id === id)!)
      ctx.drawn.set(id, drawn ? [master.path] : [])
      ctx.backgrounds.set(id, own.background)
      continue
    }

    const read = await readTemplate(ctx, master, layout)
    const background = read.own && !read.background && own.background ? THEME_BACKGROUND : read.background

    layouts.push({ id, name: (attr(child(layout.root, 'p:cSld'), 'name') ?? '').trim() || LAYOUT_NAMES[id], background, elements: read.elements, showMaster: layout.showsMaster })
    ctx.drawn.set(id, [...(layout.showsMaster && drawn ? [master.path] : []), ...(read.elements.some((element) => !element.placeholder) ? [layout.path] : [])])
    ctx.backgrounds.set(id, background ?? own.background)
  }

  return { master: { background: own.background, elements: own.elements, layouts }, others }
}

/**
 * The master's and layout's drawings a slide shows that the deck's master does not draw for its
 * layout, as the slide's own (and those showing the slide number always, numbered); noted when
 * the deck's master draws some the slide did not show.
 */
async function graphics(scope: Scope, root: XmlElement, layout: Layout | undefined, id: LayoutId): Promise<SlideElement[]> {
  const drawn = scope.ctx.drawn.get(id) ?? []
  const shown: Template[] = layout && flagAttr(root, 'showMasterSp') !== false ? [...(layout.showsMaster ? [layout.master] : []), layout] : []
  const out: SlideElement[] = []

  for (const template of shown) {
    const already = drawn.includes(template.path)
    const nodes = already ? template.numbered : template.drawings

    if (nodes.length) {
      out.push(...(await copies(scope, template, nodes, already ? `numbered ${template.path}` : template.path)))
    }
  }

  if (drawn.some((path) => !shown.some((template) => template.path === path))) {
    note(scope.ctx.report, WHY.graphics)
  }

  return out
}

function sameBackground(a: Background | null, b: Background | null): boolean {
  if (!a || !b) {
    return a === b
  }

  if (a.kind === 'image' || b.kind === 'image') {
    return a.kind === 'image' && b.kind === 'image' && a.src === b.src
  }

  return JSON.stringify(a) === JSON.stringify(b)
}

/** A slide's background: its own, or what it shows from its layout or master where the deck's master gives its layout another. */
async function slideBackground(scope: Scope, sources: readonly Source[], root: XmlElement, id: LayoutId): Promise<Background | null> {
  const shown = await backgroundOf(scope, sources)

  if (shown && find(root, 'p:cSld/p:bg')) {
    return shown
  }

  return sameBackground(shown, scope.ctx.backgrounds.get(id) ?? null) ? null : (shown ?? THEME_BACKGROUND)
}

interface SlideRead {
  slide: Slide
  transition: TransitionRead
  animated: boolean
  comments: number
  footers: FooterFound[]
}

async function readSlide(ctx: Context, path: string | undefined, index: number): Promise<SlideRead> {
  const root = await ctx.pkg.xml(path)

  if (!path || root?.name !== 'p:sld') {
    throw new Error('A slide could not be read')
  }

  const relationships = await ctx.pkg.relationships(path)
  const layoutPath = targetOf(relationships, 'slideLayout')
  const layout = layoutPath ? await layoutAt(ctx, layoutPath) : undefined
  const master = layout?.master ?? ctx.main
  const palette: Palette = { scheme: master.theme.scheme, map: mapOver(root, layout?.map ?? master.map), slots: master.slots }
  const scope: Scope = {
    ctx,
    report: ctx.report,
    relationships,
    palette,
    text: themeColor('tx1', palette)?.color ?? 'tx1',
    master,
    layout,
    mode: 'slide',
    number: index + 1,
    part: { path, root },
    ids: new Map(),
    links: [],
    footers: []
  }
  const id = layout?.id ?? layoutFrom(placeholdersOf(root))
  const sources: Source[] = [{ path, root, relationships }]

  if (layout) {
    sources.push({ path: layout.path, root: layout.root, relationships: layout.relationships })
  }

  if (master.root) {
    sources.push({ path: master.path, root: master.root, relationships: master.relationships })
  }

  const shown = await graphics(scope, root, layout, id)
  const own = await readTree(treeChildren(find(root, 'p:cSld/p:spTree')), scope)
  const transition = readTransition(root)

  return {
    slide: {
      id: newId('slide'),
      layout: id,
      background: await slideBackground(scope, sources, root, id),
      elements: [...shown, ...own],
      notes: await notesOf(ctx, relationships),
      hidden: flagAttr(root, 'show') === false,
      ...(transition.transition ? { transition: transition.transition } : {}),
      ...(master.own ? { theme: master.own } : {})
    },
    transition,
    animated: attempt(() => animated(root), false),
    comments: await commentsOf(ctx, relationships),
    footers: scope.footers
  }
}

const emptySlide = (): Slide => ({ id: newId('slide'), layout: 'blank', background: null, elements: [], notes: '', hidden: false })

/** The kind of transition most slides have (a slide without one counting as none), which slides without one of their own take. */
function deckTransition(reads: readonly (SlideRead | null)[]): Transition {
  const counts = new Map<Transition, number>()

  for (const read of reads) {
    const kind = read?.transition.transition?.kind ?? 'none'
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }

  return [...counts].reduce<[Transition, number]>((best, entry) => (entry[1] > best[1] ? entry : best), ['none', 0])[0]
}

/** The master most slides use through their layouts, the first listed of those tied, else the first listed. */
async function mainMaster(pkg: Package, slides: readonly (string | undefined)[], listed: readonly string[]): Promise<string | undefined> {
  const uses = new Map<string, number>(listed.map((path) => [path, 0]))

  for (const slide of slides) {
    const layout = slide ? targetOf(await pkg.relationships(slide), 'slideLayout') : undefined
    const master = layout ? targetOf(await pkg.relationships(layout), 'slideMaster') : undefined

    if (master) {
      uses.set(master, (uses.get(master) ?? 0) + 1)
    }
  }

  return [...uses].reduce<[string, number] | undefined>((best, entry) => (!best || entry[1] > best[1] ? entry : best), undefined)?.[0]
}

async function hasMacros(pkg: Package, relationships: readonly Relationship[]): Promise<boolean> {
  if (relationships.some((entry) => entry.type === 'vbaProject') || pkg.file('ppt/vbaProject.bin')) {
    return true
  }

  return elements(await pkg.xml('[Content_Types].xml')).some((entry) => /macroEnabled|vbaProject/i.test(attr(entry, 'ContentType') ?? ''))
}

async function presentationPath(pkg: Package): Promise<string | undefined> {
  const main = targetOf(await pkg.relationships(''), 'officeDocument')

  if (main) {
    return main
  }

  // Without the package's relationships, its content types still name the main part.
  const override = childrenNamed(await pkg.xml('[Content_Types].xml'), 'Override').find((entry) => MAIN_TYPES.test(attr(entry, 'ContentType') ?? ''))

  return override ? resolveTarget('', attr(override, 'PartName') ?? '') : undefined
}

function sizeOf(presentation: XmlElement): SlideSize {
  const size = child(presentation, 'p:sldSz')
  const width = numberAttr(size, 'cx', 0)
  const height = numberAttr(size, 'cy', 0)

  return width > 0 && height > 0 ? { width: pt(width), height: pt(height) } : { ...SLIDE_SIZES.wide }
}

/** A PowerPoint file's slides as a Herald deck, with what reading kept, approximated and left out. */
export async function importPresentation(zip: JSZip, title: string): Promise<{ deck: Deck; report: ImportReport }> {
  const pkg = new Package(zip)
  const path = await presentationPath(pkg)
  const presentation = await pkg.xml(path)

  if (!path || presentation?.name !== 'p:presentation') {
    throw new Error('This is not a PowerPoint presentation')
  }

  const relationships = await pkg.relationships(path)
  const slidePaths = childrenNamed(child(presentation, 'p:sldIdLst'), 'p:sldId').map((entry) => partOf(relationships, attr(entry, 'r:id')))
  const masterPaths = childrenNamed(child(presentation, 'p:sldMasterIdLst'), 'p:sldMasterId').flatMap((entry) => partOf(relationships, attr(entry, 'r:id')) ?? [])
  const mainPath = (await mainMaster(pkg, slidePaths, masterPaths)) ?? targetOf(relationships, 'slideMaster')
  const themePath = (mainPath && targetOf(await pkg.relationships(mainPath), 'theme')) || targetOf(relationships, 'theme')
  const theme = readTheme(await pkg.xml(themePath))
  const slots = slotsOf(readColorMap(child(await pkg.xml(mainPath), 'p:clrMap')))
  const report = emptyReport()
  const ctx: Context = {
    pkg,
    report,
    size: sizeOf(presentation),
    defaults: child(presentation, 'p:defaultTextStyle'),
    theme,
    slots,
    main: masterOf({ theme, slots }, '', undefined, [], theme),
    masters: new Map(),
    layouts: new Map(),
    pictures: new Map(),
    tableStyles: new Map(childrenNamed(await pkg.xml(targetOf(relationships, 'tableStyles')), 'a:tblStyle').map((style) => [attr(style, 'styleId') ?? '', style])),
    counted: new Set(),
    drawn: new Map(),
    backgrounds: new Map()
  }
  ctx.main = (mainPath ? await masterAt(ctx, mainPath) : undefined) ?? ctx.main
  const master = await readMaster(ctx)
  const reads: (SlideRead | null)[] = []

  for (const [index, slidePath] of slidePaths.entries()) {
    try {
      reads.push(await readSlide(ctx, slidePath, index))
    } catch {
      reads.push(null)
    }
  }

  const carried = reads.flatMap((read) => (read ? [{ layout: read.slide.layout, found: read.footers }] : []))
  const headerFooter = headerFooterFrom(carried)
  const transition = deckTransition(reads)

  for (const slide of carried) {
    const { same, added } = compareFooters(headerFooter, slide, master?.master ?? defaultMaster(ctx.size))

    for (const kept of same) {
      count(report, 'text', kept ? 'imported' : 'approximated', kept ? undefined : WHY.footers)
    }

    if (added) {
      note(report, WHY.footers, added)
    }
  }

  const nearest = reads.filter((read) => read?.transition.transition && !read.transition.exact).length
  const dropped: [string, number][] = [
    ['slides that could not be read', reads.filter((read) => !read).length],
    ['animations', reads.filter((read) => read?.animated).length],
    ['automatic slide timings', reads.filter((read) => read?.transition.timed).length],
    ['transition sounds', reads.filter((read) => read?.transition.sound).length],
    ['embedded fonts', childrenNamed(child(presentation, 'p:embeddedFontLst'), 'p:embeddedFont').length],
    ['macros', (await hasMacros(pkg, relationships)) ? 1 : 0],
    ['comments', reads.reduce((sum, read) => sum + (read?.comments ?? 0), 0)],
    ['sections', attempt(() => descendants(child(presentation, 'p:extLst'), 'p14:section').length, 0)],
    ['custom shows', childrenNamed(child(presentation, 'p:custShowLst'), 'p:custShow').length],
    ['slide masters besides the one most slides use', master ? masterPaths.filter((entry) => entry !== ctx.main.path).length : 0],
    ['slide layouts Herald has no place for', master?.others ?? 0]
  ]

  if (nearest) {
    note(report, WHY.transitions, nearest)
  }

  for (const [what, times] of dropped) {
    if (times) {
      drop(report, what, times)
    }
  }

  // A slide without a transition just appears, which slides take from the deck only when that is its transition too.
  const slides = reads.map((read) => read?.slide ?? emptySlide()).map((slide) => (slide.transition || transition === 'none' ? slide : { ...slide, transition: transitionFor('none') }))

  return {
    deck: {
      id: newId('deck'),
      title,
      size: ctx.size,
      theme: themeOf(theme, slots),
      transition,
      ...(master ? { master: master.master } : {}),
      ...(headerFooter ? { headerFooter } : {}),
      slides: slides.length ? slides : [newSlide('blank', ctx.size, master?.master)]
    },
    report
  }
}
