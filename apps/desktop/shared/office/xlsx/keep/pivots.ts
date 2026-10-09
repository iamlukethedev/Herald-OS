import { REL } from '../opc.ts'
import { attributesOf } from '../xml.ts'
import type { Keep } from './context.ts'
import { withAttribute, withoutAttributes } from './markup.ts'
import { type Refusal, refused } from './parts.ts'

/*
 * Pivot tables on the sheets that are still there, with their caches (a cache several pivot tables
 * share is copied once) and the workbook's list of caches. A cache whose data is on a sheet that is
 * still there is refreshed when Excel opens the file, so its pivot tables show the cells as Herald
 * saved them; one whose sheet is gone, or whose name or table the file no longer has, is kept as it
 * was. Pivot tables fed by a data connection or the data model go (the fidelity report names them).
 */

export interface PivotSource {
  /** The cacheSource type: "worksheet" for a range of the workbook, "external" for a connection. */
  type: string
  sheet?: string
  ref?: string
  /** A defined name or table holding the data. */
  name?: string
  /** The range is in another workbook. */
  external: boolean
}

export function pivotSourceOf(cacheXml: string): PivotSource {
  const source = attributesOf(/<(?:[\w.-]+:)?cacheSource\b[^>]*>/.exec(cacheXml)?.[0] ?? '')
  const range = attributesOf(/<(?:[\w.-]+:)?worksheetSource\b[^>]*>/.exec(cacheXml)?.[0] ?? '')

  return { type: source.type ?? '', sheet: range.sheet, ref: range.ref, name: range.name, external: Boolean(range['r:id']) }
}

/** Whether Herald keeps the pivot tables of a cache: those over a range of a workbook, not a connection or the data model. */
export const keepsPivotCache = (cacheXml: string): boolean => pivotSourceOf(cacheXml).type === 'worksheet'

/** The id slicers and timelines give a pivot cache (its x14 pivotCacheId). */
export const pivotCacheIdOf = (cacheXml: string): string | undefined => /<(?:[\w.-]+:)?pivotCacheDefinition\b[^>]*?\spivotCacheId="(\d+)"/.exec(cacheXml)?.[1]

/** A pivot cache definition as the written file has it: its data's sheet by its name now, refreshed on opening when that sheet is still there. */
export function pivotCachePart(keep: Keep, xml: string): string | Refusal {
  const source = pivotSourceOf(xml)

  if (source.type !== 'worksheet') {
    return refused('unsupported')
  }

  let out = keep.styles.withStyleIds(xml)
  let refresh = false

  if (!source.external && source.sheet !== undefined) {
    const now = keep.names.kept(source.sheet)
    refresh = now !== null

    if (now !== null && now !== source.sheet) {
      out = out.replace(/<(?:[\w.-]+:)?worksheetSource\b[^>]*>/, (tag) => withAttribute(tag, 'sheet', now))
    }
  } else if (!source.external && source.name) {
    const formula = keep.writtenNames().get(source.name.toLowerCase())
    refresh = keep.hasTable(source.name) || (formula !== undefined && !formula.includes('#REF!'))
  }

  return refresh ? out.replace(/<(?:[\w.-]+:)?pivotCacheDefinition\b[^>]*>/, (tag) => withAttribute(tag, 'refreshOnLoad', '1')) : out
}

/** A pivot table part as the written file has it: its formats in the written style sheet, without conditional formats, which name the sheet's rules by priority. */
export function pivotTablePart(keep: Keep, xml: string): string {
  const out = keep.styles.withStyleIds(xml.replace(/<((?:[\w.-]+:)?)conditionalFormats\b(?:[^>]*\/>|[\s\S]*?<\/\1conditionalFormats>)/, ''))

  return out.replace(/<(?:[\w.-]+:)?pivotTableStyleInfo\b[^>]*>/, (tag) => {
    const name = attributesOf(tag).name

    return name && !keep.styles.tableStyle(name) ? withoutAttributes(tag, /^name$/) : tag
  })
}

/** Keep the pivot tables of each sheet that is still there, with their caches. */
export async function keepPivots(keep: Keep): Promise<void> {
  for (const rel of keep.sourceRelationships.filter((entry) => entry.type === REL.pivotCacheDefinition && !entry.external)) {
    const cacheXml = await keep.pkg.read(rel.target)
    const id = cacheXml && keepsPivotCache(cacheXml) ? pivotCacheIdOf(cacheXml) : undefined

    if (id) {
      keep.keepablePivotCacheIds.add(id)
    }
  }

  for (const sheet of keep.sheets) {
    for (const rel of sheet.relationships.filter((entry) => entry.type === REL.pivotTable && !entry.external)) {
      const xml = await keep.pkg.read(rel.target)
      const cache = (await keep.copier.relationships(rel.target)).find((entry) => entry.type === REL.pivotCacheDefinition && !entry.external)
      const cacheXml = cache ? await keep.pkg.read(cache.target) : undefined

      if (!xml || !cache || !cacheXml || !keepsPivotCache(cacheXml)) {
        continue
      }

      const { name = '', cacheId = '' } = attributesOf(/<(?:[\w.-]+:)?pivotTableDefinition\b[^>]*>/.exec(xml)?.[0] ?? '')
      const id = pivotCacheIdOf(cacheXml)
      const shared = keep.pivotCaches.get(cacheId)
      const target = !shared || shared.source === cache.target ? await keep.copier.copy(rel.target) : null

      if (!target) {
        keep.loss(`The pivot table ${name} on ${sheet.written.name} could not be kept: its cells stay as plain values.`)
        continue
      }

      await keep.ctx.writer.relate(sheet.written.path, REL.pivotTable, target)
      keep.pivotCaches.set(cacheId, { source: cache.target, target: keep.copier.copiedPath(cache.target) ?? '' })
      keep.keepPivotTable(sheet, name)

      if (id) {
        keep.pivotCacheIds.add(id)
      }
    }
  }
}
