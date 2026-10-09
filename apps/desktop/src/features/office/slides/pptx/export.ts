import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import type { Color, Deck, Fill, Paragraph, Slide, SlideElement, Stroke, TextBody, Theme } from '../deck.ts'
import { isSlot, resolveFont, themeOf } from '../themes.ts'
import { bulletFor, effectiveStyle, LIST_INDENT, numberingFor, paragraphIndent } from '../text.ts'
import { finishPresentation, type ShrinkOf } from './finish.ts'
import { embedDeck } from './herald-part.ts'
import { type DrawingSet, drawingSets, planMasters } from './write-masters.ts'

/*
 * A deck as a PowerPoint file. PptxGenJS writes the package: every slide with its text boxes and
 * placeholders' text (runs and lists), shapes as preset geometry, lines, pictures, tables,
 * backgrounds and notes. The masters' and layouts' drawings are written the same way on slides of
 * their own in a second package, with plain shapes standing for placeholders, and so are kept
 * objects on slides. A finishing pass then writes the masters, layouts and themes, and what
 * PptxGenJS gets wrong or cannot say, and Herald's own copy of the deck goes in for itself.
 */

const inches = (points: number): number => points / 72

/** A colour as PptxGenJS takes it: a theme slot by its name, or hex without the hash. */
export const pptxColor = (color: Color): string => (isSlot(color) ? color : color.slice(1).toUpperCase())

const transparency = (alpha: number | undefined): number | undefined => (alpha !== undefined && alpha < 1 ? Math.round((1 - alpha) * 100) : undefined)

const DASH_NAMES = { solid: 'solid', dash: 'dash', dot: 'sysDot', dashDot: 'dashDot', longDash: 'lgDash' } as const

function lineOptions(stroke: Stroke | null): PptxGenJS.ShapeLineProps | undefined {
  return stroke && stroke.width > 0 ? { color: pptxColor(stroke.color), width: stroke.width, dashType: DASH_NAMES[stroke.dash], transparency: transparency(stroke.alpha) } : undefined
}

const fillOptions = (fill: Fill | null): PptxGenJS.ShapeFillProps | undefined => (fill ? { color: pptxColor(fill.color), transparency: transparency(fill.alpha) } : undefined)

/** A paragraph's text as PptxGenJS text objects: one a run (or a line of one), the last one ending the paragraph. */
function paragraphObjects(paragraph: Paragraph, body: TextBody, theme: Theme, last: boolean): PptxGenJS.TextProps[] {
  const level = paragraph.level ?? 0
  const { indent } = paragraphIndent(paragraph)
  const hang = indent < 0 ? -indent : LIST_INDENT
  const bullet: PptxGenJS.TextPropsOptions['bullet'] =
    paragraph.list === 'bullet'
      ? { characterCode: (paragraph.bullet || bulletFor(level)).codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'), indent: hang }
      : paragraph.list === 'number'
        ? ({ type: 'number', style: paragraph.numbering ?? numberingFor(level), numberStartAt: paragraph.startAt ?? 1, indent: hang } as PptxGenJS.TextPropsOptions['bullet'])
        : false
  const shared: PptxGenJS.TextPropsOptions = { align: paragraph.align ?? 'left', indentLevel: level, lineSpacingMultiple: paragraph.lineSpacing ?? 1 }
  const segments: { text: string; run: Paragraph['runs'][number]; soft: boolean }[] = []

  for (const run of paragraph.runs) {
    run.text.split('\n').forEach((text, index) => segments.push({ text, run, soft: index > 0 }))
  }

  if (!segments.length) {
    segments.push({ text: '', run: { text: '' }, soft: false })
  }

  return segments.map((segment, index) => {
    const style = effectiveStyle(segment.run, body)

    return {
      text: segment.text,
      options: {
        ...shared,
        bullet: index === 0 ? bullet : false,
        softBreakBefore: segment.soft,
        bold: Boolean(style.bold),
        italic: Boolean(style.italic),
        underline: style.underline ? { style: 'sng' } : undefined,
        strike: style.strike ? 'sngStrike' : undefined,
        color: pptxColor(style.color),
        highlight: style.highlight ? pptxColor(style.highlight) : undefined,
        fontFace: resolveFont(style.font, theme),
        fontSize: Math.round(style.size * 100) / 100,
        breakLine: index === segments.length - 1 && !last
      }
    }
  })
}

export function textObjects(body: TextBody, theme: Theme): PptxGenJS.TextProps[] {
  return body.paragraphs.flatMap((paragraph, index) => paragraphObjects(paragraph, body, theme, index === body.paragraphs.length - 1))
}

function frameOptions(element: SlideElement) {
  return {
    x: inches(element.x),
    y: inches(element.y),
    w: inches(element.width),
    h: inches(element.height),
    rotate: element.rotation || undefined,
    flipH: element.flipH || undefined,
    flipV: element.flipV || undefined,
    objectName: element.id
  }
}

/** A plain shape standing for an element the finishing pass writes itself (a kept object, a master's placeholder, an empty picture placeholder). */
function addStandIn(target: PptxGenJS.Slide, element: SlideElement): void {
  target.addShape('rect' as PptxGenJS.ShapeType, frameOptions(element))
}

function addElement(target: PptxGenJS.Slide, element: SlideElement, theme: Theme): void {
  if (element.kind === 'image') {
    if (element.src) {
      target.addImage({ data: element.src, ...frameOptions(element), altText: element.alt ?? '' })
    } else {
      addStandIn(target, element)
    }

    return
  }

  if (element.kind === 'line') {
    const { stroke } = element
    target.addShape('line' as PptxGenJS.ShapeType, {
      ...frameOptions(element),
      rotate: undefined,
      line: { color: pptxColor(stroke.color), width: stroke.width, dashType: DASH_NAMES[stroke.dash], transparency: transparency(stroke.alpha), beginArrowType: element.start, endArrowType: element.end }
    })

    return
  }

  if (element.kind === 'table') {
    // Every cell goes in as a cell of its own, covered ones too, so each row has one for every column; the finishing pass merges them.
    const rows = element.cells.map((row) => row.map((cell) => ({ text: textObjects(cell.body, theme), options: { fontFace: resolveFont(cell.body.style.font, theme), fontSize: cell.body.style.size } })))
    target.addTable(rows, { x: inches(element.x), y: inches(element.y), w: inches(element.width), h: inches(element.height), colW: element.columns.map(inches), rowH: element.rows.map(inches), objectName: element.id })

    return
  }

  if (element.kind === 'object') {
    addStandIn(target, element)

    return
  }

  const body = element.body
  const anchor = body.anchor === 'middle' ? 'middle' : body.anchor === 'bottom' ? 'bottom' : 'top'

  target.addText(textObjects(body, theme), {
    ...frameOptions(element),
    shape: (element.kind === 'shape' ? element.shape : 'rect') as PptxGenJS.ShapeType,
    fill: fillOptions(element.fill),
    line: lineOptions(element.stroke),
    margin: [body.inset[0], body.inset[2], body.inset[3], body.inset[1]],
    valign: anchor,
    wrap: body.wrap,
    fontFace: resolveFont(body.style.font, theme),
    fontSize: body.style.size,
    color: pptxColor(body.style.color),
    isTextBox: element.kind === 'text'
  })
}

function addSlide(pptx: PptxGenJS, slide: Slide, deck: Deck): void {
  const target = pptx.addSlide()
  const background = slide.background
  const theme = themeOf(deck, slide)

  if (background?.kind === 'solid') {
    target.background = { color: pptxColor(background.color) }
  } else if (background?.kind === 'image') {
    target.background = { data: background.src }
  } else if (background) {
    // A placeholder colour; the finishing pass puts the gradient in.
    target.background = { color: pptxColor(background.stops[0]?.color ?? 'bg1') }
  }

  if (slide.hidden) {
    target.hidden = true
  }

  for (const element of slide.elements) {
    addElement(target, element, theme)
  }

  if (slide.notes) {
    target.addNotes(slide.notes)
  }
}

function presentation(deck: Deck): PptxGenJS {
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'HERALD', width: inches(deck.size.width), height: inches(deck.size.height) })
  pptx.layout = 'HERALD'
  pptx.theme = { headFontFace: deck.theme.fonts.heading, bodyFontFace: deck.theme.fonts.body }
  pptx.title = deck.title
  pptx.author = ''
  pptx.company = ''

  return pptx
}

/** The masters' and layouts' drawings, a slide each, with their picture backgrounds; placeholders are plain shapes in their place. */
async function writeDrawings(deck: Deck, sets: readonly DrawingSet[]): Promise<JSZip> {
  const pptx = presentation(deck)

  for (const set of sets) {
    const target = pptx.addSlide()

    if (set.background?.kind === 'image') {
      target.background = { data: set.background.src }
    }

    for (const element of set.elements) {
      if (element.placeholder) {
        addStandIn(target, element)
      } else {
        addElement(target, element, set.theme)
      }
    }
  }

  return JSZip.loadAsync((await pptx.write({ outputType: 'uint8array' })) as Uint8Array)
}

export interface PptxOptions {
  /** Put Herald's own copy of the deck in (the default), so Herald reads the file back exactly. */
  embed?: boolean
  /** How much each shrinking text box's text was shrunk when last drawn. */
  shrink?: ShrinkOf
  /** The day the date fields show (today). */
  now?: Date
}

/** A deck as the bytes of a .pptx file. */
export async function writePptx(deck: Deck, options: PptxOptions = {}): Promise<Uint8Array> {
  const pptx = presentation(deck)

  for (const slide of deck.slides) {
    addSlide(pptx, slide, deck)
  }

  const plans = planMasters(deck)
  const zip = await JSZip.loadAsync((await pptx.write({ outputType: 'uint8array' })) as Uint8Array)
  const drawings = await writeDrawings(deck, drawingSets(plans))
  await finishPresentation(zip, deck, { plans, drawings, shrink: options.shrink, now: options.now })

  if (options.embed !== false) {
    await embedDeck(zip, deck)
  }

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
}
