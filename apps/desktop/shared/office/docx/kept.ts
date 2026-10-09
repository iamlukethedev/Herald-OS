import { base64ToBytes, bytesToBase64 } from '../document.ts'
import { type Relationship, relationshipKind, type WordPackage } from './package.ts'
import type { Repack } from './repack.ts'
import { attr, children, localName, textOf, type XmlElement } from './xml.ts'

/*
 * What Herald keeps of a Word file without showing it, to write back when it saves: custom XML
 * data parts (with their properties), the file's custom properties, the people who commented, and
 * the title, subject, author, keywords and description. Nothing Herald writes refers to these, so
 * they stay whole. Parts tied to what Herald writes anew are dropped on purpose: the glossary
 * (building blocks), comment ids and dates of Word's own, embedded fonts, web settings, macros.
 */

export interface KeptPart {
  /** Its path in the package, such as "customXml/item1.xml". */
  path: string
  /** The content type [Content_Types].xml names for it, or null when its extension's is right. */
  type: string | null
  /** Its bytes, in base64. */
  data: string
}

export interface KeptRelationship {
  /** Whose relationship it is: the package's own, or the main document's. */
  from: 'package' | 'document'
  type: string
  /** The part it leads to, by its path in the package. */
  target: string
}

export interface KeptProperties {
  title?: string
  subject?: string
  creator?: string
  keywords?: string
  description?: string
}

/** What a document keeps of the Word file it was opened from, in doc.attrs.kept. */
export interface KeptWord {
  parts: KeptPart[]
  relationships: KeptRelationship[]
  properties: KeptProperties
}

/** The relationships whose parts are kept, by kind and whose they are. */
const KEPT_KINDS: Readonly<Record<string, KeptRelationship['from']>> = { customXml: 'document', people: 'document', 'custom-properties': 'package' }

const PROPERTIES: readonly (keyof KeptProperties)[] = ['title', 'subject', 'creator', 'keywords', 'description']

const relationshipsPath = (part: string): string => `${part.slice(0, part.lastIndexOf('/') + 1)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`

/** What to keep of a Word file, or null when there is nothing. */
export async function readKept(pkg: WordPackage, relationships: Map<string, Relationship>): Promise<KeptWord | null> {
  const own = await pkg.relationships('')
  const candidates = [...[...own.values()].map((item) => ({ item, from: 'package' as const })), ...[...relationships.values()].map((item) => ({ item, from: 'document' as const }))].filter(
    ({ item, from }) => !item.external && KEPT_KINDS[relationshipKind(item)] === from && pkg.has(item.target)
  )
  // Custom properties without a property, as Herald itself writes them, are nothing to keep.
  const empty = await Promise.all(candidates.map(async ({ item }) => relationshipKind(item) === 'custom-properties' && !children((await pkg.xml(item.target)) ?? undefined).length))
  const found = candidates.filter((_, index) => !empty[index])
  const types = await pkg.xml('[Content_Types].xml')
  const overrides = new Map(children(types ?? undefined, 'Override').map((item) => [(attr(item, 'PartName') ?? '').replace(/^\//, '').toLowerCase(), attr(item, 'ContentType') ?? null]))
  const paths = new Set<string>()

  // A custom XML part's properties are a part of its own, led to by its relationships.
  for (const { item } of found) {
    paths.add(item.target)

    if (relationshipKind(item) === 'customXml' && pkg.has(relationshipsPath(item.target))) {
      paths.add(relationshipsPath(item.target))

      for (const inner of (await pkg.relationships(item.target)).values()) {
        if (!inner.external && pkg.has(inner.target)) {
          paths.add(inner.target)
        }
      }
    }
  }

  const parts = await Promise.all(
    [...paths].map(async (path): Promise<KeptPart | null> => {
      const bytes = await pkg.bytes(path)

      return bytes ? { path, type: overrides.get(path.toLowerCase()) ?? null, data: bytesToBase64(bytes) } : null
    })
  )
  const core = [...own.values()].find((item) => !item.external && relationshipKind(item) === 'core-properties')
  const properties: KeptProperties = {}

  for (const element of children((core ? await pkg.xml(core.target) : null) ?? undefined)) {
    const name = localName(element.name) as keyof KeptProperties
    const value = textOf(element as XmlElement).trim()

    if (PROPERTIES.includes(name) && value) {
      properties[name] = value
    }
  }

  const kept: KeptWord = {
    parts: parts.filter((part): part is KeptPart => part !== null),
    relationships: found.map(({ item, from }) => ({ from, type: item.type, target: item.target })),
    properties
  }

  return kept.parts.length || Object.keys(properties).length ? kept : null
}

/** The kept parts of a document, if its attrs hold any in the shape Herald gave them. */
export function keptOf(value: unknown): KeptWord | null {
  const kept = value as Partial<KeptWord> | null | undefined

  if (!kept || typeof kept !== 'object' || !Array.isArray(kept.parts) || !Array.isArray(kept.relationships)) {
    return null
  }

  const properties = kept.properties && typeof kept.properties === 'object' ? kept.properties : {}

  return {
    parts: kept.parts.filter((part) => typeof part?.path === 'string' && typeof part.data === 'string' && /^[\w-]+(\/[\w.-]+)+$/.test(part.path) && !part.path.includes('..')),
    relationships: kept.relationships.filter((item) => typeof item?.type === 'string' && typeof item.target === 'string' && (item.from === 'package' || item.from === 'document')),
    properties: Object.fromEntries(PROPERTIES.filter((name) => typeof properties[name] === 'string').map((name) => [name, properties[name]]))
  }
}

/** The part the docx package always writes, empty, which a kept one replaces. */
const CUSTOM_PROPERTIES = 'docProps/custom.xml'

/** Writes kept parts back into a package, with their content types and the relationships that lead to them; never over a part Herald wrote. */
export async function writeKept(repack: Repack, kept: KeptWord, main: string): Promise<void> {
  const written = kept.parts.filter((part) => part.path === CUSTOM_PROPERTIES || !repack.has(part.path))

  for (const part of written) {
    repack.setBytes(part.path, base64ToBytes(part.data))

    if (part.type) {
      await repack.setContentType(part.path, part.type)
    }
  }

  for (const item of kept.relationships) {
    if (written.some((part) => part.path === item.target)) {
      await repack.relate(item.from === 'package' ? '' : main, item.type, item.target)
    }
  }
}
