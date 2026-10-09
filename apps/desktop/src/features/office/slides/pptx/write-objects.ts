import type { KeptPart, ObjectElement } from '../deck.ts'
import { localName } from './write-groups.ts'
import { emu } from './write-drawingml.ts'
import { freshPart, type PackageWriter, relativeTarget, Relationships } from './write-package.ts'
import { elements, parseXml, xml, type XmlElement } from './xml.ts'

/*
 * Objects Herald keeps without editing them (charts, SmartArt, embedded objects): the frame's XML
 * goes back where the element is in the drawing order, moved and sized to its box, and the parts it
 * names are copied in under fresh names, each with its own relationships to the parts it names in
 * turn, so several objects copied from one file never share a part. The frame names its parts by
 * relationship ids, which are new in the part it goes into.
 */

const RELATIONSHIP_NAMESPACES = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'])

/** The namespaces a frame copied from another file may use, by the prefixes Office gives them. */
const NAMESPACES: Record<string, string> = {
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  dgm: 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  v: 'urn:schemas-microsoft-com:vml',
  o: 'urn:schemas-microsoft-com:office:office',
  p14: 'http://schemas.microsoft.com/office/powerpoint/2010/main',
  p15: 'http://schemas.microsoft.com/office/powerpoint/2012/main',
  p159: 'http://schemas.microsoft.com/office/powerpoint/2015/09/main',
  p188: 'http://schemas.microsoft.com/office/powerpoint/2018/8/main',
  a14: 'http://schemas.microsoft.com/office/drawing/2010/main',
  a15: 'http://schemas.microsoft.com/office/drawing/2012/main',
  a16: 'http://schemas.microsoft.com/office/drawing/2014/main',
  c14: 'http://schemas.microsoft.com/office/drawing/2007/8/2/chart',
  c16: 'http://schemas.microsoft.com/office/drawing/2014/chart',
  cx: 'http://schemas.microsoft.com/office/drawing/2014/chartex',
  cx1: 'http://schemas.microsoft.com/office/drawing/2015/9/8/chartex',
  cx2: 'http://schemas.microsoft.com/office/drawing/2015/10/21/chartex',
  cx4: 'http://schemas.microsoft.com/office/drawing/2016/5/10/chartex',
  dsp: 'http://schemas.microsoft.com/office/drawing/2008/diagram',
  asvg: 'http://schemas.microsoft.com/office/drawing/2016/SVG/main',
  aink: 'http://schemas.microsoft.com/office/drawing/2016/ink',
  am3d: 'http://schemas.microsoft.com/office/drawing/2017/model3d'
}

const prefixOf = (name: string): string | undefined => (name.includes(':') ? name.slice(0, name.indexOf(':')) : undefined)

/** Every element of a fragment, the fragment first. */
function walk(root: XmlElement): XmlElement[] {
  const out: XmlElement[] = []
  const stack = [root]

  while (stack.length) {
    const node = stack.pop()!
    out.push(node)
    stack.push(...elements(node).reverse())
  }

  return out
}

/**
 * Declare on the frame the namespaces it uses and does not declare itself (a frame cut out of a
 * file leaves its declarations behind on the file's root); `mc:Ignorable` and a choice's
 * `Requires` name prefixes that must be declared too. The part's root declares p, a and r.
 */
function declareNamespaces(frame: XmlElement): void {
  const declared = new Set(['p', 'a', 'r', 'xml', 'xmlns'])
  const used = new Set<string>()

  for (const node of walk(frame)) {
    for (const [name, value] of Object.entries(node.attrs)) {
      if (name.startsWith('xmlns:')) {
        declared.add(name.slice(6))
      } else if (localName(name) === 'Ignorable' || name === 'Requires') {
        value.split(/\s+/).forEach((prefix) => prefix && used.add(prefix))
      }

      const prefix = prefixOf(name)

      if (prefix && prefix !== 'xmlns') {
        used.add(prefix)
      }
    }

    const prefix = prefixOf(node.name)

    if (prefix) {
      used.add(prefix)
    }
  }

  for (const prefix of used) {
    if (!declared.has(prefix) && NAMESPACES[prefix]) {
      frame.attrs[`xmlns:${prefix}`] = NAMESPACES[prefix]
    }
  }
}

/** The prefixes that name relationships in a fragment: `r`, and any it binds to the relationships namespace. */
function relationshipPrefixes(frame: XmlElement): Set<string> {
  const prefixes = new Set(['r'])

  for (const node of walk(frame)) {
    for (const [name, value] of Object.entries(node.attrs)) {
      if (name.startsWith('xmlns:') && RELATIONSHIP_NAMESPACES.has(value)) {
        prefixes.add(name.slice(6))
      }
    }
  }

  return prefixes
}

/** A part copied in under a fresh name in its folder, with its own relationships to the parts it names (under the ids it names them by). */
function copyPart(part: KeptPart, pkg: PackageWriter): string {
  const path = freshPart(pkg.zip, part.path.replace(/^\/+/, ''))
  pkg.zip.file(path, part.data.replace(/\s+/g, ''), { base64: true })
  pkg.types.ensure(path, part.contentType)

  if (part.parts?.length) {
    const rels = Relationships.empty()

    for (const inner of part.parts) {
      rels.put(inner.id, inner.type, relativeTarget(path, copyPart(inner, pkg)))
    }

    rels.write(pkg.zip, path)
  }

  return path
}

function decodeText(base64: string): string {
  const binary = atob(base64.replace(/\s+/g, ''))

  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

/**
 * SmartArt's data part names the drawing PowerPoint keeps for it (`dsp:dataModelExt relId`) by the
 * id of the slide's relationship to the drawing part, so that id is rewritten to the new one.
 */
function linkSmartArt(parts: readonly KeptPart[], copied: Map<KeptPart, string>, ids: Map<string, string>, pkg: PackageWriter): void {
  const data = parts.find((part) => /\/diagramData$/.test(part.type))
  const drawing = parts.find((part) => /\/diagramDrawing$/.test(part.type))
  const id = drawing ? ids.get(drawing.id) : undefined

  if (!data || !id) {
    return
  }

  const text = decodeText(data.data)
  const linked = text.replace(/(<(?:[\w.-]+:)?dataModelExt\b[^>]*?\srelId=)(["'])[^"']*\2/, (_, head: string, quote: string) => `${head}${quote}${id}${quote}`)

  if (linked !== text) {
    pkg.zip.file(copied.get(data)!, linked)
  }
}

/** The shapes a frame holds: itself, or each branch's of an `mc:AlternateContent`. */
const frameShapes = (frame: XmlElement): XmlElement[] => (localName(frame.name) === 'AlternateContent' ? elements(frame).flatMap((branch) => elements(branch)) : [frame])

const childNamed = (node: XmlElement | undefined, local: string): XmlElement | undefined => elements(node).find((entry) => localName(entry.name) === local)

/** A shape's transform moved and sized to the element's box, its rotation and flips the element's. */
function placeShape(shape: XmlElement, element: ObjectElement, name: string): void {
  const kind = localName(shape.name)
  const nonVisual = elements(shape).find((entry) => localName(entry.name).startsWith('nv'))
  const cNvPr = childNamed(nonVisual, 'cNvPr')
  const xfrm = kind === 'graphicFrame' ? childNamed(shape, 'xfrm') : childNamed(childNamed(shape, kind === 'grpSp' ? 'grpSpPr' : 'spPr'), 'xfrm')

  if (cNvPr) {
    cNvPr.attrs.name = name
  }

  if (!xfrm) {
    return
  }

  const prefix = prefixOf(elements(xfrm)[0]?.name ?? '') ?? 'a'
  const off = childNamed(xfrm, 'off') ?? xml(`${prefix}:off`)
  const ext = childNamed(xfrm, 'ext') ?? xml(`${prefix}:ext`)
  off.attrs = { x: emu(element.x), y: emu(element.y) }
  ext.attrs = { cx: emu(element.width), cy: emu(element.height) }
  xfrm.attrs = Object.fromEntries(Object.entries(xfrm.attrs).filter(([key]) => !['rot', 'flipH', 'flipV'].includes(key)))
  xfrm.children = [off, ext, ...elements(xfrm).filter((entry) => !['off', 'ext'].includes(localName(entry.name)))]

  if (element.rotation) {
    xfrm.attrs.rot = String(Math.round(element.rotation * 60000))
  }

  if (element.flipH) {
    xfrm.attrs.flipH = '1'
  }

  if (element.flipV) {
    xfrm.attrs.flipV = '1'
  }
}

/**
 * A kept object's frame for the part it goes into (`part`, whose relationships are `rels`): its
 * parts copied in, the frame naming them by its new relationship ids (a name for a part it did not
 * keep is emptied), placed at the element's box under `name`. Null when its XML is not XML.
 */
export function keptFrame(element: ObjectElement, name: string, part: string, rels: Relationships, pkg: PackageWriter): XmlElement | null {
  let frame: XmlElement

  try {
    frame = parseXml(element.source.xml, { canonical: false })
  } catch {
    return null
  }

  declareNamespaces(frame)
  const ids = new Map<string, string>()
  const copied = new Map<KeptPart, string>()

  for (const kept of element.source.parts) {
    const path = copyPart(kept, pkg)
    copied.set(kept, path)
    ids.set(kept.id, rels.add(kept.type, relativeTarget(part, path)))
  }

  const prefixes = relationshipPrefixes(frame)

  for (const node of walk(frame)) {
    for (const [attribute, value] of Object.entries(node.attrs)) {
      const prefix = prefixOf(attribute)

      if (prefix && prefixes.has(prefix) && value) {
        node.attrs[attribute] = ids.get(value) ?? ''
      }
    }
  }

  linkSmartArt(element.source.parts, copied, ids, pkg)
  frameShapes(frame).forEach((shape) => placeShape(shape, element, name))

  return frame
}
