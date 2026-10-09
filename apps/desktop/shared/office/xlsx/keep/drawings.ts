import { shownAnchors } from '../charts/index.ts'
import { drawingOf, type SourceDrawing } from '../drawing.ts'
import type { DrawingAnchor } from '../finish.ts'
import { decodeXml } from '../xml.ts'
import type { Keep } from './context.ts'
import type { Refusal } from './parts.ts'

/*
 * The anchors of a sheet's drawing that Herald does not show (pictures, shapes, charts it does not
 * draw, SmartArt, ink, slicers), carried into the sheet's drawing in the written file with the parts
 * they name. Anchors standing in for form controls and embedded objects go with those (the fidelity
 * report names them), and a slicer's anchor goes when its slicer does.
 */

const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const SLICER = /<(?:[\w.-]+:)?(slicer|timeslicer)\b[^>]*?\sname="([^"]*)"/

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** An anchor with `{{rel:N}}` for each relationship it names, and the parts those are, copied; why not when it cannot be kept. */
async function keptAnchor(keep: Keep, drawing: SourceDrawing, anchor: string): Promise<Pick<DrawingAnchor, 'xml' | 'relationships'> | Refusal['refused']> {
  const declared = [...Object.entries(drawing.namespaces), ...[...anchor.matchAll(/\s(xmlns:[\w.-]+)\s*=\s*"([^"]*)"/g)].map((found) => [found[1], found[2]] as const)]
  const prefixes = [...new Set(declared.filter(([, uri]) => uri === RELATIONSHIPS).map(([name]) => name.slice('xmlns:'.length)))]
  // Text that reads like one of the drawing builder's placeholders stays text.
  const xml = anchor.replace(/\{\{/g, '&#123;{')

  if (!prefixes.length) {
    return { xml, relationships: [] }
  }

  const pattern = new RegExp(`(\\s(?:${prefixes.map(escapeRegExp).join('|')}):[\\w.-]+\\s*=\\s*)(["'])(.*?)\\2`, 'g')
  const ids = [...new Set([...xml.matchAll(pattern)].map((found) => decodeXml(found[3])))]
  const rels = ids.map((id) => drawing.relationships.get(id))
  const relationships: DrawingAnchor['relationships'] = []

  for (const rel of rels) {
    const reason = !rel ? 'broken' : rel.external ? null : await keep.copier.check(rel.target)

    if (reason) {
      return reason
    }
  }

  for (const rel of rels) {
    if (rel) {
      relationships.push(rel.external ? { type: rel.type, target: rel.target, external: true } : { type: rel.type, target: (await keep.copier.copy(rel.target)) ?? '' })
    }
  }

  return { xml: xml.replace(pattern, (_whole, before: string, quote: string, id: string) => `${before}${quote}{{rel:${ids.indexOf(decodeXml(id))}}}${quote}`), relationships }
}

/** Give each sheet that is still there the anchors of its drawing that Herald does not show. */
export async function keepDrawings(keep: Keep): Promise<void> {
  for (const sheet of keep.sheets) {
    const drawing = await drawingOf(keep.pkg, sheet.source)

    if (!drawing) {
      continue
    }

    const shown = await shownAnchors(keep.pkg, sheet.source)
    const failed = new Set<Refusal['refused']>()

    for (const [index, anchor] of drawing.anchors.entries()) {
      const slicer = SLICER.exec(anchor)

      if (shown.has(index) || /compatExt\b/.test(anchor) || (slicer && !keep.slicers.get(sheet.written.id)?.has(`${slicer[1] === 'slicer' ? 'slicer' : 'timeline'}:${decodeXml(slicer[2])}`))) {
        continue
      }

      const kept = await keptAnchor(keep, drawing, anchor)

      if (typeof kept === 'string') {
        failed.add(kept)
      } else {
        keep.ctx.drawings.add(sheet.written.id, { ...kept, namespaces: drawing.namespaces, order: index })
      }
    }

    if (failed.has('gone')) {
      keep.loss(`Charts on ${sheet.written.name} that showed a deleted sheet’s data are not kept.`)
    }

    if (failed.has('broken') || failed.has('unsupported')) {
      keep.loss(`Some pictures, shapes or charts on ${sheet.written.name} could not be kept.`)
    }
  }
}
