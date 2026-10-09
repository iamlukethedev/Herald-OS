import type { LineElement, SlideElement } from '../deck.ts'
import { boundsOfAll } from '../elements.ts'
import { emu, presetGeometryXml, setGeometry } from './write-drawingml.ts'
import { child, elements, xml, type XmlElement, type XmlNode } from './xml.ts'

/*
 * A shape tree's structure: grouped elements nested in the groups they are in, every shape with an
 * id of its own (shapes that are alternatives of each other share theirs), and connectors glued to
 * the shapes they join by those ids.
 */

/** An element's finished shape in a tree, or a shape no element drew (kept as it is). */
export interface Placed {
  element: SlideElement | null
  node: XmlElement
}

export const localName = (name: string): string => name.slice(name.indexOf(':') + 1)

/**
 * Shapes nested in their groups (`p:grpSp`), outermost first: each group sits where its first
 * member is in the drawing order and holds its members in their order. A group's box is its members'
 * bounds, as its children's too, so they keep their places. Placeholders are never grouped.
 */
export function groupShapes(placed: readonly Placed[], names: Map<string, number>): XmlNode[] {
  const top: XmlNode[] = []
  const groups = new Map<string, { node: XmlElement; members: SlideElement[] }>()

  for (const { element, node } of placed) {
    let into = top
    let key = ''

    for (const id of element && !element.placeholder ? (element.group ?? []) : []) {
      key = key ? `${key}/${id}` : id
      let group = groups.get(key)

      if (!group) {
        const n = (names.get('Group') ?? 0) + 1
        names.set('Group', n)
        group = { node: xml('p:grpSp', {}, [xml('p:nvGrpSpPr', {}, [xml('p:cNvPr', { id: '', name: `Group ${n}` }), xml('p:cNvGrpSpPr'), xml('p:nvPr')]), xml('p:grpSpPr')]), members: [] }
        groups.set(key, group)
        into.push(group.node)
      }

      group.members.push(element!)
      into = group.node.children
    }

    into.push(node)
  }

  for (const { node, members } of groups.values()) {
    const bounds = boundsOfAll(members)!
    const off = { x: emu(bounds.x), y: emu(bounds.y) }
    const ext = { cx: emu(bounds.width), cy: emu(bounds.height) }
    child(node, 'p:grpSpPr')!.children = [xml('a:xfrm', {}, [xml('a:off', off), xml('a:ext', ext), xml('a:chOff', off), xml('a:chExt', ext)])]
  }

  return top
}

/**
 * Every shape in a tree with an id of its own, as PowerPoint requires. The branches of an
 * `mc:AlternateContent` are one shape written two ways, so a later branch takes the ids the first
 * branch's shapes got.
 */
export function uniqueIds(tree: XmlElement): void {
  const all: XmlElement[] = []
  const collect = (node: XmlElement) => {
    for (const entry of elements(node)) {
      if (localName(entry.name) === 'cNvPr') {
        all.push(entry)
      }

      collect(entry)
    }
  }
  collect(tree)

  const seen = new Set<string>()
  let next = Math.max(0, ...all.map((node) => Number(node.attrs.id) || 0)) + 1
  const claim = (cNvPr: XmlElement) => {
    if (!/^\d+$/.test(cNvPr.attrs.id ?? '') || seen.has(cNvPr.attrs.id)) {
      cNvPr.attrs.id = String(next++)
    }

    seen.add(cNvPr.attrs.id)
  }
  const visit = (node: XmlElement) => {
    for (const entry of elements(node)) {
      if (localName(entry.name) === 'AlternateContent') {
        const given = new Map<string, string>()

        elements(entry).forEach((branch, index) => {
          const shapes: XmlElement[] = []
          const gather = (at: XmlElement) => {
            for (const inner of elements(at)) {
              if (localName(inner.name) === 'cNvPr') {
                shapes.push(inner)
              }

              gather(inner)
            }
          }
          gather(branch)

          for (const cNvPr of shapes) {
            const before = cNvPr.attrs.id ?? ''

            if (index > 0 && given.has(before)) {
              cNvPr.attrs.id = given.get(before)!
            } else {
              claim(cNvPr)
              given.set(before, cNvPr.attrs.id)
            }
          }
        })

        continue
      }

      if (localName(entry.name) === 'cNvPr') {
        claim(entry)
      }

      visit(entry)
    }
  }
  visit(tree)
}

/** The id a shape goes by: its (first) `cNvPr`'s. */
export function shapeId(node: XmlElement): string | undefined {
  const stack = [node]

  while (stack.length) {
    const at = stack.shift()!

    if (localName(at.name) === 'cNvPr') {
      return at.attrs.id
    }

    stack.push(...elements(at))
  }

  return undefined
}

/** A line written as a shape made a connector (`p:cxnSp`): the same box, flips and line, its preset's geometry and no text. */
export function connectorShape(node: XmlElement, line: LineElement): XmlElement {
  const nv = child(node, 'p:nvSpPr')
  const spPr = child(node, 'p:spPr') ?? xml('p:spPr')
  const style = child(node, 'p:style')
  setGeometry(spPr, presetGeometryXml(line.connector!.preset, line.connector!.adjust))

  return xml('p:cxnSp', {}, [xml('p:nvCxnSpPr', {}, [child(nv, 'p:cNvPr') ?? xml('p:cNvPr', { id: '', name: '' }), xml('p:cNvCxnSpPr'), child(nv, 'p:nvPr') ?? xml('p:nvPr')]), spPr, ...(style ? [style] : [])])
}

/** Each connector's ends glued to the shapes it joins, by their ids (once the ids are final) and connection sites. */
export function glueConnectors(placed: readonly Placed[]): void {
  const nodes = new Map(placed.flatMap(({ element, node }) => (element ? [[element.id, node] as const] : [])))

  for (const { element, node } of placed) {
    if (element?.kind !== 'line' || !element.connector || node.name !== 'p:cxnSp') {
      continue
    }

    const props = child(child(node, 'p:nvCxnSpPr'), 'p:cNvCxnSpPr')
    const end = (name: string, at: { element: string; site: number } | undefined): XmlElement[] => {
      const target = at ? nodes.get(at.element) : undefined
      const id = target ? shapeId(target) : undefined

      return id && at ? [xml(name, { id, idx: Math.max(0, Math.round(at.site)) })] : []
    }

    if (props) {
      props.children = [...end('a:stCxn', element.connector.start), ...end('a:endCxn', element.connector.end)]
    }
  }
}
