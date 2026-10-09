import { parseRelationships, type Relationship, relsPathOf, rootNamespaces } from './opc.ts'
import type { PackageSheet, XlsxPackage } from './package.ts'

/*
 * A worksheet's drawing part as the anchors it holds, in order: Herald reads charts from some of
 * them and carries the rest over untouched, and both count anchors the same way, by their place in
 * the part.
 */

export interface SourceDrawing {
  /** The drawing part, as "xl/drawings/drawing1.xml". */
  path: string
  /** Its relationships by id, their targets as package paths. */
  relationships: Map<string, Relationship>
  /** The root's namespace declarations and mc:Ignorable, which the anchors may use. */
  namespaces: Record<string, string>
  /** Each anchor whole (an xdr:twoCellAnchor, xdr:oneCellAnchor, xdr:absoluteAnchor or mc:AlternateContent), in order. */
  anchors: string[]
}

const escapeName = (name: string): string => name.replace(/[.-]/g, (char) => `\\${char}`)

/** The child elements of a part's root, whole and in order; elements of one name may nest, so their depth is counted. */
export function childElements(xml: string): string[] {
  const rootStart = xml.search(/<(?![?!])[\w:.-]+[\s>/]/)
  const start = rootStart < 0 ? -1 : xml.indexOf('>', rootStart) + 1
  const end = xml.lastIndexOf('</')
  const children: string[] = []
  let at = start

  while (start > 0 && at < end) {
    const open = xml.indexOf('<', at)

    if (open < 0 || open >= end) {
      break
    }

    if (xml.startsWith('<!--', open)) {
      at = xml.indexOf('-->', open) + 3
      continue
    }

    const name = /^<([\w:.-]+)/.exec(xml.slice(open, open + 256))?.[1]
    const tagEnd = xml.indexOf('>', open)

    if (!name || tagEnd < 0) {
      break
    }

    if (xml[tagEnd - 1] === '/') {
      children.push(xml.slice(open, tagEnd + 1))
      at = tagEnd + 1
      continue
    }

    const tags = new RegExp(`<(/?)${escapeName(name)}(?=[\\s/>])`, 'g')
    tags.lastIndex = tagEnd + 1
    let depth = 1
    let finish = xml.length

    while (depth > 0) {
      const tag = tags.exec(xml)

      if (!tag) {
        break
      }

      const close = xml.indexOf('>', tag.index)

      if (tag[1]) {
        depth--
      } else if (xml[close - 1] !== '/') {
        depth++
      }

      finish = close + 1
    }

    children.push(xml.slice(open, finish))
    at = finish
  }

  return children
}

/** The drawing part of a worksheet in a package, with its anchors; none when the sheet has no drawing. */
export async function drawingOf(pkg: XlsxPackage, sheet: PackageSheet): Promise<SourceDrawing | null> {
  const path = sheet.related.find((rel) => rel.type === 'drawing' && !rel.external)?.target
  const xml = path ? await pkg.read(path) : undefined

  if (!path || !xml) {
    return null
  }

  return {
    path,
    relationships: new Map(parseRelationships(path, await pkg.read(relsPathOf(path))).map((rel) => [rel.id, rel])),
    namespaces: rootNamespaces(xml, 'wsDr'),
    anchors: childElements(xml)
  }
}
