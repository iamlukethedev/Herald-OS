import type { KeptPart } from '../deck.ts'
import { base64, byId, type Package, type Relationship } from './read-package.ts'
import { attr, child, childrenNamed, elements, find, serializeXml, xml, type XmlElement, type XmlNode } from './xml.ts'

/*
 * What Herald keeps of the objects it does not edit (charts, SmartArt, embedded objects): the XML
 * of each one's frame as the file wrote it, with the namespaces it is written in, and the parts it
 * names with the parts those name in turn, so a file saved again holds them as they were.
 */

/** The largest part an object may have and be kept, in bytes. */
const MOST_BYTES = 20 * 1024 * 1024

/** How deep parts may name parts and be kept: a deck carries five levels of them. */
const MOST_DEPTH = 4

/** How many parts one may name and be kept, as many as a deck carries at each level. */
const MOST_PARTS = 64

/** Relationships to the presentation's own parts (another slide, a layout, a link), which no object can carry with it. */
const STRUCTURAL: ReadonlySet<string> = new Set([
  'officeDocument',
  'slide',
  'slideLayout',
  'slideMaster',
  'notesSlide',
  'notesMaster',
  'handoutMaster',
  'theme',
  'presProps',
  'viewProps',
  'tableStyles',
  'commentAuthors',
  'comments',
  'hyperlink'
])

/** The namespace a diagram's drawing is written in. */
const DIAGRAM_DRAWING = 'http://schemas.microsoft.com/office/drawing/2008/diagram'

/** Every element of a tree, the root first, walked without recursion however deep it nests. */
function everyElement(root: XmlElement): XmlElement[] {
  const out: XmlElement[] = []
  const stack = [root]

  while (stack.length) {
    const node = stack.pop()!
    out.push(node)
    stack.push(...elements(node).reverse())
  }

  return out
}

/** Whether a relationship is a link to follow (a web address, another slide) rather than a part of what names it. */
export const isLink = (relationship: Relationship | undefined): boolean => relationship?.type === 'hyperlink' || relationship?.type === 'slide'

/** The relationship ids an element's XML names (`r:id`, `r:embed`, `r:dm`…), each once. */
export function relationshipIds(node: XmlElement): string[] {
  const ids = new Set<string>()

  for (const element of everyElement(node)) {
    for (const [name, value] of Object.entries(element.attrs)) {
      if (name.startsWith('r:') && value) {
        ids.add(value)
      }
    }
  }

  return [...ids]
}

/** Where an element is in a tree, as the index among its parent's children of each element on the way down; null when it is not there. */
function trailTo(root: XmlElement, target: XmlElement): number[] | null {
  const stack: { node: XmlElement; trail: number[] }[] = [{ node: root, trail: [] }]

  while (stack.length) {
    const { node, trail } = stack.pop()!

    if (node === target) {
      return trail
    }

    node.children.forEach((entry, index) => {
      if (typeof entry !== 'string') {
        stack.push({ node: entry, trail: [...trail, index] })
      }
    })
  }

  return null
}

/**
 * An element of a part as the file wrote it (`written` is the part parsed with its names as
 * written, `root` as read), with the namespaces declared above it declared on it, so it reads
 * the same on its own; null when it is not in the part.
 */
export function writtenXml(root: XmlElement, written: XmlElement, node: XmlElement): string | null {
  const trail = trailTo(root, node)
  const declared: Record<string, string> = {}
  let at: XmlNode | undefined = written

  if (!trail) {
    return null
  }

  for (const index of trail) {
    if (typeof at !== 'object') {
      return null
    }

    for (const [name, value] of Object.entries(at.attrs)) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) {
        declared[name] = value
      }
    }

    at = at.children[index]
  }

  return at && typeof at === 'object' ? serializeXml({ ...at, attrs: { ...declared, ...at.attrs } }, false) : null
}

/** A part's name as a kept part gives it, with anything but letters, digits and `_./-` made `_`. */
const keptPath = (name: string): string => name.replace(/[^\w./-]/g, '_').replace(/\.{2,}/g, '.')

/**
 * The parts an object names by the relationship ids it names them by in `relationships`, each with
 * the parts it names in turn; null when one is missing, outside the file, one of the
 * presentation's own or larger than Herald keeps, or when there are more or deeper than a deck
 * carries, as the object is then not kept.
 */
export async function keptParts(pkg: Package, relationships: readonly Relationship[], ids: readonly string[], depth = 0, trail: readonly string[] = []): Promise<KeptPart[] | null> {
  const parts: KeptPart[] = []

  if ((depth > MOST_DEPTH && ids.length) || ids.length > MOST_PARTS) {
    return null
  }

  for (const id of ids) {
    const relationship = byId(relationships, id)

    if (!relationship || relationship.external || STRUCTURAL.has(relationship.type) || trail.includes(relationship.target)) {
      return null
    }

    const bytes = await pkg.bytes(relationship.target)

    if (!bytes || bytes.length > MOST_BYTES) {
      return null
    }

    const own = await pkg.relationships(relationship.target)
    const inner = await keptParts(pkg, own, own.map((entry) => entry.id), depth + 1, [...trail, relationship.target])

    if (!inner) {
      return null
    }

    parts.push({
      id,
      type: relationship.uri,
      path: keptPath(pkg.name(relationship.target)),
      contentType: await pkg.contentType(relationship.target),
      data: base64(bytes),
      ...(inner.length ? { parts: inner } : {})
    })
  }

  return parts
}

/** The relationship id a diagram's data names its drawing by (one of the slide's). */
export function drawingId(data: XmlElement | undefined): string | undefined {
  const extension = childrenNamed(child(data, 'dgm:extLst'), 'a:ext')
    .flatMap(elements)
    .find((node) => node.name === 'dataModelExt' || node.name.endsWith(':dataModelExt'))

  return attr(extension, 'relId') || undefined
}

/** A drawing's elements under the names of their slide counterparts (`dsp:sp` as `p:sp`), which read the same. */
function renamed(element: XmlElement, prefix: string, depth: number): XmlElement {
  const own = prefix ? element.name.startsWith(`${prefix}:`) : !element.name.includes(':')

  return {
    name: own ? `p:${element.name.slice(prefix ? prefix.length + 1 : 0)}` : element.name,
    attrs: element.attrs,
    children: depth < 128 ? element.children.map((node) => (typeof node === 'string' ? node : renamed(node, prefix, depth + 1))) : []
  }
}

const boxKey = (xfrm: XmlElement | undefined): string => [attr(xfrm, 'rot') ?? '0', attr(child(xfrm, 'a:off'), 'x'), attr(child(xfrm, 'a:off'), 'y'), attr(child(xfrm, 'a:ext'), 'cx'), attr(child(xfrm, 'a:ext'), 'cy')].join(' ')

/** A drawing's shape whose text it places apart from the shape (`dsp:txXfrm`) as the shape, then its text in a box of its own over it. */
function textApart(node: XmlElement): XmlElement[] {
  const frame = child(node, 'p:txXfrm')
  const body = child(node, 'p:txBody')

  if (node.name !== 'p:sp' || !frame) {
    return [node]
  }

  if (!body || boxKey(frame) === boxKey(find(node, 'p:spPr/a:xfrm'))) {
    return [{ ...node, children: node.children.filter((entry) => entry !== frame) }]
  }

  const style = child(node, 'p:style')
  const text = xml('p:sp', {}, [
    xml('p:nvSpPr', {}, [xml('p:cNvPr', { id: 0, name: '' }), xml('p:cNvSpPr', { txBox: 1 }), xml('p:nvPr')]),
    xml('p:spPr', {}, [{ ...frame, name: 'a:xfrm' }, xml('a:prstGeom', { prst: 'rect' }, [xml('a:avLst')]), xml('a:noFill'), xml('a:ln', {}, [xml('a:noFill')])]),
    ...(style ? [style] : []),
    body
  ])

  return [{ ...node, children: node.children.filter((entry) => entry !== frame && entry !== body) }, text]
}

/** A diagram drawing's shapes (`dsp:drawing`) as a slide's shape tree holds shapes, to be read as a slide's are. */
export function drawingShapes(root: XmlElement): XmlElement[] {
  const declared = Object.entries(root.attrs).find(([name, value]) => value === DIAGRAM_DRAWING && (name === 'xmlns' || name.startsWith('xmlns:')))?.[0]
  const prefix = declared ? declared.slice(6) : root.name.includes(':') ? root.name.slice(0, root.name.indexOf(':')) : ''

  return elements(child(renamed(root, prefix, 0), 'p:spTree')).flatMap(textApart)
}
