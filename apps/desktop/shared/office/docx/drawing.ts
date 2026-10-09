import { dataUrl, type DocNode, hexColor, IMAGE_TYPES, points, round, type TextBoxAttrs } from '../document.ts'
import type { NoteKey } from './fidelity.ts'
import type { Relationship } from './package.ts'
import { intOf } from './styles.ts'
import { emusToPixels, pointsToPixels } from './units.ts'
import { attr, child, children, find, textOf, type XmlElement } from './xml.ts'

/*
 * Pictures, text boxes and shapes in a Word file's text. DrawingML and VML pictures, in the line or
 * placed beside the text, become pictures in the line; text boxes give back their content with
 * their size, place and colours, to be shown after the paragraph they sit in; charts and SmartArt
 * show the picture Word keeps of them when it keeps one; shapes without text are left out.
 */

export interface Picture {
  path: string
  bytes: Uint8Array
}

/** What a part holds: the body, a header or footer, or the notes of one kind. */
export type StoryKind = 'body' | 'header' | 'footnote' | 'endnote'

/** A part with text (the main document, the footnotes): its relationships and the pictures they point at. */
export interface Story {
  kind: StoryKind
  relationships: Map<string, Relationship>
  pictures: Map<string, Picture>
  /** Each picture's data URL once made, or null for one that cannot be shown. */
  sources: Map<string, string | null>
}

export interface Box {
  /** The box's text (w:txbxContent). */
  content: XmlElement
  attrs: TextBoxAttrs
  /** In the line of its paragraph, which places it, rather than placed beside the text. */
  inline: boolean
}

export interface Drawn {
  images: DocNode[]
  /** Text boxes, read as blocks after the paragraph they sit in. */
  boxes: Box[]
  /** A horizontal line, as Word's Horizontal Line button draws it. */
  rule: boolean
}

interface Placement {
  width: number | null
  height: number | null
  alt?: string
  title?: string
}

const SHOWN = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp', 'image/svg+xml'])

function sniff(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return 'image/png'
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'image/jpeg'
  }

  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif'
  }

  return bytes[0] === 0x42 && bytes[1] === 0x4d ? 'image/bmp' : null
}

const mimeOf = (picture: Picture): string | null => sniff(picture.bytes) ?? IMAGE_TYPES[picture.path.slice(picture.path.lastIndexOf('.') + 1).toLowerCase()] ?? null

function sourceOf(story: Story, id: string, found: Set<NoteKey>): string | null {
  if (!story.sources.has(id)) {
    const picture = story.pictures.get(id)
    const mime = picture ? mimeOf(picture) : null

    if (picture && !(mime && SHOWN.has(mime))) {
      found.add('unshownPictures')
    }

    story.sources.set(id, picture && mime && SHOWN.has(mime) ? dataUrl(picture.bytes, mime) : null)
  }

  return story.sources.get(id) ?? null
}

function imageOf(story: Story, found: Set<NoteKey>, embed: string | undefined, link: string | undefined, placement: Placement): DocNode | null {
  const relationship = embed ? story.relationships.get(embed) : undefined

  if (!embed || !relationship || relationship.external) {
    if (link || relationship?.external) {
      found.add('linkedPictures')
    }

    return null
  }

  const src = sourceOf(story, embed, found)

  if (!src) {
    return null
  }

  const attrs: Record<string, unknown> = { src }

  if (placement.alt) {
    attrs.alt = placement.alt
  }

  if (placement.title && placement.title !== placement.alt) {
    attrs.title = placement.title
  }

  if (placement.width) {
    attrs.width = placement.width
  }

  if (placement.height) {
    attrs.height = placement.height
  }

  return { type: 'image', attrs }
}

const pixels = (emus: string | undefined): number | null => {
  const amount = intOf(emus)

  return amount && amount > 0 ? emusToPixels(amount) : null
}

const extentOf = (extent: XmlElement | undefined): Pick<Placement, 'width' | 'height'> => ({ width: pixels(attr(extent, 'cx')), height: pixels(attr(extent, 'cy')) })

const hasText = (box: XmlElement): boolean => Boolean(textOf(box).trim() || find(box, 'w:drawing') || find(box, 'w:pict'))

/** Every element with this name in a drawing, leaving out what is inside its text boxes, which is read with their text. */
function outsideBoxes(element: XmlElement | undefined, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const node of children(element)) {
    if (node.name === name) {
      out.push(node)
    }

    if (node.name !== 'w:txbxContent') {
      outsideBoxes(node, name, out)
    }
  }

  return out
}

const BOX_ALIGNS = new Set(['left', 'center', 'right'])

const boxAlign = (value: string | undefined): TextBoxAttrs['align'] => (value && BOX_ALIGNS.has(value.trim()) ? (value.trim() as TextBoxAttrs['align']) : null)

const emuPoints = (emus: string | undefined): number | null => {
  const amount = intOf(emus)

  return amount && amount > 0 ? round(amount / 12700) : null
}

/** A plain DrawingML colour; theme colours other than black and white, and changed ones, are not plain. */
function drawingColor(fill: XmlElement | undefined): string | null {
  const rgb = child(fill, 'a:srgbClr')
  const preset = child(fill, 'a:prstClr')
  const scheme = child(fill, 'a:schemeClr')

  if (rgb) {
    return hexColor(attr(rgb, 'val'))
  }

  if (preset) {
    return hexColor(attr(preset, 'val'))
  }

  const value = attr(scheme, 'val')

  return scheme && !children(scheme).length ? (value === 'lt1' || value === 'bg1' ? '#ffffff' : value === 'dk1' || value === 'tx1' ? '#000000' : null) : null
}

/** A DrawingML text box's size, place and colours; a box in a group has the size of its own shape. */
function drawingBox(shape: XmlElement, extent: XmlElement | undefined, frame: XmlElement): TextBoxAttrs {
  const properties = child(shape, 'wps:spPr')
  const line = child(properties, 'a:ln')

  return {
    width: emuPoints(attr(extent, 'cx')),
    height: emuPoints(attr(extent, 'cy')),
    align: frame.name === 'wp:anchor' ? boxAlign(textOf(child(child(frame, 'wp:positionH'), 'wp:align'))) : null,
    border: line && !child(line, 'a:noFill') ? drawingColor(child(line, 'a:solidFill')) : null,
    fill: drawingColor(child(properties, 'a:solidFill'))
  }
}

/** A DrawingML drawing (w:drawing): its pictures, text boxes and shapes. */
export function readDrawing(drawing: XmlElement, story: Story, found: Set<NoteKey>): Drawn {
  const out: Drawn = { images: [], boxes: [], rule: false }

  for (const frame of children(drawing)) {
    if (frame.name !== 'wp:inline' && frame.name !== 'wp:anchor') {
      continue
    }

    const data = child(child(frame, 'a:graphic'), 'a:graphicData')
    const docPr = child(frame, 'wp:docPr')
    const pictures = outsideBoxes(data, 'pic:pic')
    // A picture on its own takes the frame's size and alternative text; pictures in a group their own.
    const single = pictures.length === 1 && child(data, 'pic:pic') === pictures[0]

    for (const pic of pictures) {
      const blip = find(child(pic, 'pic:blipFill'), 'a:blip')
      const own = child(child(pic, 'pic:nvPicPr'), 'pic:cNvPr')
      const placement: Placement = single
        ? { ...extentOf(child(frame, 'wp:extent')), alt: attr(docPr, 'descr') || attr(docPr, 'title') || undefined, title: attr(docPr, 'title') || undefined }
        : { ...extentOf(find(child(pic, 'pic:spPr'), 'a:ext')), alt: attr(own, 'descr') || undefined }
      const image = imageOf(story, found, attr(blip, 'r:embed'), attr(blip, 'r:link'), placement)

      if (image) {
        out.images.push(image)

        if (frame.name === 'wp:anchor') {
          found.add('floatingPictures')
        }
      }
    }

    const shapes = outsideBoxes(data, 'wps:wsp')

    for (const shape of shapes) {
      const content = child(child(shape, 'wps:txbx'), 'w:txbxContent')

      if (content && hasText(content)) {
        const extent = child(data, 'wps:wsp') === shape ? child(frame, 'wp:extent') : find(child(shape, 'wps:spPr'), 'a:ext')
        out.boxes.push({ content, attrs: drawingBox(shape, extent, frame), inline: frame.name === 'wp:inline' })

        if (frame.name === 'wp:anchor') {
          found.add('textBoxes')
        }
      } else {
        found.add('shapes')
      }
    }

    if (!pictures.length && /chart|diagram/i.test(attr(data, 'uri') ?? '')) {
      found.add('charts')
    }
  }

  return out
}

const vmlStyle = (style: string, name: string): string | undefined => new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(style)?.[1].trim()

/** A VML length ("100pt", "1.5in") in points. */
function vmlPoints(style: string, name: string): number | null {
  const amount = points(vmlStyle(style, name))

  return amount && amount > 0 ? round(amount) : null
}

/** A VML length in CSS pixels. */
function vmlLength(style: string, name: string): number | null {
  const amount = vmlPoints(style, name)

  return amount ? Math.round(pointsToPixels(amount)) : null
}

const vmlOff = (value: string | undefined): boolean => /^(f|false|0|off)$/i.test(value?.trim() ?? '')

/** A VML colour ("#4472c4", "red", "white [3212]"); system colours are not plain. */
const vmlColor = (value: string | undefined): string | null => hexColor((value ?? '').replace(/\s*\[\d+\]\s*$/, ''))

/** A VML text box's size, place and colours: VML draws a black line and a white fill unless told otherwise. */
function vmlBox(shape: XmlElement, style: string, absolute: boolean): TextBoxAttrs {
  const stroked = !vmlOff(attr(shape, 'stroked')) && !vmlOff(attr(child(shape, 'v:stroke'), 'on'))
  const filled = !vmlOff(attr(shape, 'filled')) && !vmlOff(attr(child(shape, 'v:fill'), 'on'))

  return {
    width: vmlPoints(style, 'width'),
    height: vmlPoints(style, 'height'),
    align: absolute ? boxAlign(vmlStyle(style, 'mso-position-horizontal')) : null,
    border: stroked ? (vmlColor(attr(shape, 'strokecolor')) ?? '#000000') : null,
    fill: filled ? (vmlColor(attr(shape, 'fillcolor') ?? attr(child(shape, 'v:fill'), 'color')) ?? '#ffffff') : null
  }
}

/** VML drawing (w:pict, or the shape of w:object): pictures, text boxes, horizontal lines and shapes. */
export function readVml(pict: XmlElement, story: Story, found: Set<NoteKey>, picturesOnly = false): Drawn {
  const out: Drawn = { images: [], boxes: [], rule: false }

  const visit = (element: XmlElement): void => {
    for (const shape of children(element)) {
      if (shape.name === 'v:group') {
        visit(shape)
        continue
      }

      if (!shape.name.startsWith('v:') || shape.name === 'v:shapetype') {
        continue
      }

      const imagedata = child(shape, 'v:imagedata')
      const box = child(child(shape, 'v:textbox'), 'w:txbxContent')
      const style = attr(shape, 'style') ?? ''

      if (imagedata) {
        const placement: Placement = { width: vmlLength(style, 'width'), height: vmlLength(style, 'height'), alt: attr(shape, 'alt') || attr(imagedata, 'o:title') || undefined }
        const image = imageOf(story, found, attr(imagedata, 'r:id') ?? attr(imagedata, 'o:relid'), attr(imagedata, 'r:href'), placement)

        if (image) {
          out.images.push(image)

          if (!picturesOnly && /position\s*:\s*absolute/i.test(style)) {
            found.add('floatingPictures')
          }
        }
      } else if (picturesOnly) {
        continue
      } else if (attr(shape, 'o:hr') === 't' || attr(shape, 'o:hr') === 'true') {
        out.rule = true
      } else if (box && hasText(box)) {
        const absolute = /position\s*:\s*absolute/i.test(style)
        out.boxes.push({ content: box, attrs: vmlBox(shape, style, absolute), inline: !absolute })

        if (absolute) {
          found.add('textBoxes')
        }
      } else {
        found.add('shapes')
      }
    }
  }

  visit(pict)

  return out
}

/** An embedded object (w:object): only the picture Word shows of it. */
export function readObject(object: XmlElement, story: Story, found: Set<NoteKey>): Drawn {
  found.add('objects')
  const drawing = child(object, 'w:drawing')

  return drawing ? { ...readDrawing(drawing, story, found), boxes: [] } : readVml(object, story, found, true)
}

const pictured = (element: XmlElement | undefined): boolean => Boolean(find(element, 'a:blip') || find(element, 'v:imagedata'))

const readable = (element: XmlElement | undefined): boolean => pictured(element) || Boolean(find(element, 'w:txbxContent') || find(element, 'w:t'))

/**
 * Which side of mc:AlternateContent to read: Word's choice, never both, unless the choice is
 * something Herald cannot show (a chart, ink) and the fallback has a picture of it.
 */
export function alternative(element: XmlElement): XmlElement | undefined {
  const choice = child(element, 'mc:Choice')
  const fallback = child(element, 'mc:Fallback')

  return choice && !(fallback && !readable(choice) && pictured(fallback)) ? choice : fallback
}
