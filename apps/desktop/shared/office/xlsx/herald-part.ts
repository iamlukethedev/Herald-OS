import type { XlsxPackage } from './package.ts'
import { parseRelationships, type PackageWriter } from './opc.ts'

/*
 * Herald's own part in an .xlsx file it saved: `herald/sheets.json`, with a content type and a
 * package relationship of its own, which Excel, Numbers and LibreOffice pass over. It holds what
 * only Herald Sheets reads back, by feature: a chart's exact spec, how a summary was made, the
 * Herald data of each sheet. A section that depends on parts another app may have changed since
 * carries a fingerprint of them, and its reader checks it.
 */

export const HERALD_PART = 'herald/sheets.json'
export const HERALD_CONTENT_TYPE = 'application/vnd.herald-os.sheets+json'
export const HERALD_RELATIONSHIP = 'urn:herald-os:sheets:extras'
const FORMAT = 'herald-sheets'
const VERSION = 1

/** A quick 53-bit hash, enough to notice a part or a spec that changed. */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** JSON with object keys in order, so equal values give equal text whatever order their keys were set in. */
export const stableJson = (value: unknown): string => JSON.stringify(value, (_key, entry) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry))

/** The sections of a file's Herald part; null when it has none, or one Herald cannot read. */
export async function readHeraldPart(pkg: XlsxPackage): Promise<Record<string, unknown> | null> {
  const related = parseRelationships('', await pkg.read('_rels/.rels')).find((rel) => rel.type === HERALD_RELATIONSHIP)
  const text = related ? await pkg.read(related.target) : undefined

  if (!text) {
    return null
  }

  try {
    const part = JSON.parse(text) as { format?: string; version?: number; sections?: Record<string, unknown> }

    return part.format === FORMAT && part.version === VERSION && part.sections && typeof part.sections === 'object' ? part.sections : null
  } catch {
    return null
  }
}

/** Write the Herald part with the sections features gave; none, no part. */
export async function writeHeraldPart(writer: PackageWriter, sections: Record<string, unknown>): Promise<void> {
  const filled = Object.fromEntries(Object.entries(sections).filter(([, value]) => value !== undefined && value !== null && (typeof value !== 'object' || Object.keys(value).length > 0)))

  if (!Object.keys(filled).length) {
    return
  }

  await writer.put(HERALD_PART, JSON.stringify({ format: FORMAT, version: VERSION, sections: filled }), HERALD_CONTENT_TYPE)
  await writer.relate('', HERALD_RELATIONSHIP, HERALD_PART)
}
