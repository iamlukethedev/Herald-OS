import { type Relationship, rootNamespaces } from '../opc.ts'
import { attributesOf, elementsOf } from '../xml.ts'
import { type Keep, type KeptSheet, sheetIds } from './context.ts'
import { carried, extensionsOf, uriOf, withoutAttributes } from './markup.ts'
import { type Refusal, refused } from './parts.ts'

/*
 * Slicers and timelines with the pivot tables and tables they filter. Their caches are listed in the
 * workbook's extension list and named by defined names; each sheet lists its slicer and timeline
 * parts in its own extension list, and its drawing holds their anchors. A cache is kept when what it
 * filters is kept, a slicer when its cache is, and their extension elements come along whole, with
 * only the references to what is kept.
 */

/** The workbook's lists of slicer caches (pivot tables, then tables) and of timeline caches. */
const CACHE_LISTS = ['{BBE1A952-AA13-448e-AADC-164F8A28A991}', '{46BE6895-7355-4a93-B00E-2C351335B9C9}', '{D0CA8CA8-9F24-4464-BF8E-62219DCF47F9}']

/** A sheet's lists of slicers (on pivot tables, then on tables) and of timelines. */
const SHEET_LISTS = ['{A8765BA9-456A-4dab-B4F3-ACF838C121DE}', '{3A4CF648-6AED-40f4-86FF-DC5316D8AED3}', '{7E03D99C-DC04-49d9-9315-930204A7B6E9}']

const BUILT_IN_STYLE = /^(?:Time)?SlicerStyle(?:Light|Dark|Other)\d+$/
const REFERENCE = /<((?:[\w.-]+:)?)(slicer|slicerCache|timelineRef|timelineCacheRef)\b([^>]*?)\/>/g

const rootTag = (xml: string): string => /<(?![?!])[\w:.-]+\b[^>]*>/.exec(xml)?.[0] ?? ''

/** The relationship ids an extension's slicer or timeline references name. */
const referencesIn = (extension: string): string[] => [...extension.matchAll(REFERENCE)].flatMap((found) => attributesOf(found[3])['r:id'] ?? [])

/** An extension with its references' relationship ids as `ids` has them, references without one taken out; null when none is left. */
function withReferences(extension: string, ids: Map<string, string>): string | null {
  let left = 0
  const out = extension.replace(REFERENCE, (_whole, prefix: string, name: string, attributes: string) => {
    const now = ids.get(attributesOf(attributes)['r:id'] ?? '')

    if (!now) {
      return ''
    }

    left++

    return `<${prefix}${name}${attributes.replace(/(\sr:id=")[^"]*(")/, `$1${now}$2`)}/>`
  })

  return left ? out : null
}

/** A slicer or timeline cache as the written file has it: only the pivot tables kept, on their sheets' ids now; refused when what it filters is gone. */
export function slicerCachePart(keep: Keep, xml: string): string | Refusal {
  if (/<(?:[\w.-]+:)?olap\b/.test(xml)) {
    return refused('unsupported')
  }

  const table = /<(?:[\w.-]+:)?tableSlicerCache\b[^>]*>/.exec(xml)?.[0]

  if (table) {
    return keep.tables.has(attributesOf(table).tableId ?? '') ? xml : refused('gone')
  }

  const cacheId = /\spivotCacheId="(\d+)"/.exec(xml)?.[1]

  if (!cacheId || !keep.pivotCacheIds.has(cacheId)) {
    return refused(cacheId && keep.keepablePivotCacheIds.has(cacheId) ? 'gone' : 'unsupported')
  }

  const sourceNames = new Map([...sheetIds(keep.pkg.workbookXml)].map(([name, id]) => [id, name]))
  const writtenIds = sheetIds(keep.workbookXml)
  let left = 0
  const out = xml.replace(/<((?:[\w.-]+:)?)pivotTable\b([^>]*?)\/>/g, (_whole, prefix: string, attributes: string) => {
    const { tabId, name = '' } = attributesOf(attributes)
    const sourceName = sourceNames.get(Number(tabId))
    const sheet = sourceName ? keep.sheetFor(sourceName) : undefined
    const id = sheet ? writtenIds.get(sheet.written.name.toLowerCase()) : undefined

    if (!sourceName || id === undefined || !keep.hasPivotTable(sourceName, name)) {
      return ''
    }

    left++

    return `<${prefix}pivotTable${attributes.replace(/(\stabId=")\d+(")/, `$1${id}$2`)}/>`
  })

  return left ? out : refused('gone')
}

/** A sheet's slicer or timeline part with only the slicers whose caches are kept, without styles the written file lacks; refused when none is left. */
export function slicersPart(keep: Keep, xml: string): string | Refusal {
  let left = 0
  const out = xml.replace(/<((?:[\w.-]+:)?)(slicer|timeline)\b([^>]*?)(\/>|>[\s\S]*?<\/\1\2>)/g, (_whole, prefix: string, name: string, attributes: string, rest: string) => {
    const { cache = '', style } = attributesOf(attributes)

    if (!keep.caches.has(cache)) {
      return ''
    }

    left++

    return `<${prefix}${name}${style && !BUILT_IN_STYLE.test(style) ? withoutAttributes(attributes, /^style$/) : attributes}${rest}`
  })

  return left ? out : refused('gone')
}

/** Keep the slicer and timeline caches of what is kept, and on each sheet that is still there, the slicers and timelines of those caches. */
export async function keepSlicers(keep: Keep): Promise<void> {
  const parts: { sheet: KeptSheet; rel: Relationship; kind: 'slicer' | 'timeline'; entries: Record<string, string>[] }[] = []

  for (const sheet of keep.sheets) {
    for (const rel of sheet.relationships.filter((entry) => !entry.external && /\/(slicer|timeline)$/.test(entry.type))) {
      const kind = rel.type.endsWith('/slicer') ? 'slicer' : 'timeline'
      parts.push({ sheet, rel, kind, entries: elementsOf((await keep.pkg.read(rel.target)) ?? '', kind).map(({ attributes }) => attributes) })
    }
  }

  const shownCaches = new Set(parts.flatMap((part) => part.entries.map((entry) => entry.cache ?? '')))
  const ids = new Map<string, string>()
  const gone = new Map<string, string>()

  for (const extension of extensionsOf(keep.pkg.workbookXml).filter((entry) => CACHE_LISTS.includes(uriOf(entry)))) {
    for (const reference of referencesIn(extension)) {
      const rel = keep.sourceRelationships.find((entry) => entry.id === reference && !entry.external)
      const xml = rel ? await keep.pkg.read(rel.target) : undefined

      if (!rel || !xml) {
        continue
      }

      const name = attributesOf(rootTag(xml)).name ?? ''
      const reason = await keep.copier.check(rel.target)

      if (reason === 'gone') {
        gone.set(name, /tableSlicerCache/.test(xml) ? 'the table it filtered is not kept' : 'the pivot table it filtered is gone')
      }

      // A cache whose slicers are all on sheets that are gone goes with them.
      const target = !reason && shownCaches.has(name) ? await keep.copier.copy(rel.target) : null

      if (!target) {
        continue
      }

      ids.set(reference, await keep.ctx.writer.relate(keep.workbookPath, rel.type, target))
      keep.caches.add(name)
      const defined = keep.pkg.definedNames.find((entry) => entry.localSheetId === undefined && entry.name.toLowerCase() === name.toLowerCase())
      keep.needName({ name, formula: defined?.formula ?? '#N/A' })
    }

    const kept = withReferences(extension, ids)

    if (kept) {
      keep.workbookAdditions.extensions.push(carried(kept, rootNamespaces(keep.pkg.workbookXml, 'workbook')))
    }
  }

  for (const sheet of keep.sheets) {
    const sheetIdsNow = new Map<string, string>()
    const shown = new Set<string>()

    for (const { rel, kind, entries } of parts.filter((part) => part.sheet === sheet)) {
      const before = shown.size

      for (const { cache = '', name = '', caption } of entries) {
        if (keep.caches.has(cache)) {
          shown.add(`${kind}:${name}`)
        } else if (gone.has(cache)) {
          keep.loss(`The ${kind} ${caption ?? name} on ${sheet.written.name} is not kept: ${gone.get(cache)}.`)
        }
      }

      const target = shown.size > before ? await keep.copier.copy(rel.target) : null

      if (target) {
        sheetIdsNow.set(rel.id, await keep.ctx.writer.relate(sheet.written.path, rel.type, target))
      }
    }

    keep.slicers.set(sheet.written.id, shown)

    for (const extension of extensionsOf(sheet.xml).filter((entry) => SHEET_LISTS.includes(uriOf(entry)))) {
      const kept = withReferences(extension, sheetIdsNow)

      if (kept) {
        keep.extendSheet(sheet, carried(kept, rootNamespaces(sheet.xml, 'worksheet')))
      }
    }
  }
}
