import { type PackageWriter, parseRelationships, type Relationship, relativeTarget, relsPathOf } from '../opc.ts'
import type { XlsxPackage } from '../package.ts'
import { elementsOf, encodeXml } from '../xml.ts'

/*
 * A chart part of the file a workbook was opened from, copied into the package being finished as
 * it was, with everything it relates to (its style and colours, shapes drawn over it, embedded
 * workbooks, their pictures): each part under a fresh name with the content type the file gave it,
 * and its relationships, ids and all, pointing at the copies, so the chart's own XML stays as it was.
 */

interface SourcePart {
  path: string
  bytes: Uint8Array
  type: { type: string; byDefault: boolean }
  relationships: Relationship[]
}

const typesOf = new WeakMap<XlsxPackage, Promise<(path: string) => SourcePart['type'] | undefined>>()

/** The content type the file gives each part: its own (an Override), or its extension's. */
function contentTypes(pkg: XlsxPackage): Promise<(path: string) => SourcePart['type'] | undefined> {
  let types = typesOf.get(pkg)

  if (!types) {
    types = pkg.read('[Content_Types].xml').then((xml = '') => {
      const overrides = new Map(elementsOf(xml, 'Override').map(({ attributes }) => [(attributes.PartName ?? '').replace(/^\//, ''), attributes.ContentType ?? '']))
      const defaults = new Map(elementsOf(xml, 'Default').map(({ attributes }) => [(attributes.Extension ?? '').toLowerCase(), attributes.ContentType ?? '']))

      return (path: string) => {
        const own = overrides.get(path)
        const byExtension = defaults.get(path.split('.').pop()?.toLowerCase() ?? '')

        return own ? { type: own, byDefault: false } : byExtension ? { type: byExtension, byDefault: true } : undefined
      }
    })
    typesOf.set(pkg, types)
  }

  return types
}

/** A part and every part it relates to, itself first; null when one of them is missing or has no content type. */
async function partsFrom(pkg: XlsxPackage, path: string): Promise<SourcePart[] | null> {
  const typeOf = await contentTypes(pkg)
  const parts: SourcePart[] = []
  const seen = new Set<string>()
  const visit = async (part: string): Promise<boolean> => {
    if (seen.has(part)) {
      return true
    }

    seen.add(part)
    const bytes = await pkg.binary(part)
    const type = typeOf(part)

    if (!bytes || !type) {
      return false
    }

    const relationships = parseRelationships(part, await pkg.read(relsPathOf(part)))
    parts.push({ path: part, bytes, type, relationships })

    for (const relationship of relationships) {
      if (!relationship.external && !(await visit(relationship.target))) {
        return false
      }
    }

    return true
  }

  return (await visit(path)) ? parts : null
}

/** A free name in the package like the part's own: "xl/charts/style3.xml" for "xl/charts/style1.xml". */
function freshPath(writer: PackageWriter, path: string): string {
  const [, stem, extension = ''] = /^(.*?)\d*(\.[^./]+)?$/.exec(path) ?? [path, path]

  return writer.freshName((n) => `${stem}${n}${extension}`)
}

/**
 * Copy a chart part of the source file, and everything it relates to, into the package; its new
 * path and its XML, or null (and nothing copied) when a part it needs is missing from the file.
 */
export async function copyChartPart(writer: PackageWriter, pkg: XlsxPackage, path: string): Promise<{ path: string; xml: string } | null> {
  const parts = await partsFrom(pkg, path)
  const xml = parts ? await pkg.read(path) : undefined

  if (!parts || xml === undefined) {
    return null
  }

  const names = new Map<string, string>()

  // Each part is put as soon as it is named, so the next fresh name passes over it.
  for (const part of parts) {
    const fresh = freshPath(writer, part.path)
    names.set(part.path, fresh)
    await writer.put(fresh, part.bytes, part.type.byDefault ? undefined : part.type.type)
  }

  for (const part of parts) {
    const fresh = names.get(part.path)!

    if (part.type.byDefault) {
      await writer.setDefault(fresh.split('.').pop() ?? '', part.type.type)

      if ((await writer.contentType(fresh)) !== part.type.type) {
        await writer.put(fresh, part.bytes, part.type.type)
      }
    }

    if (part.relationships.length) {
      const entries = part.relationships.map(
        (relationship) =>
          `<Relationship Id="${encodeXml(relationship.id)}" Type="${encodeXml(relationship.type)}" Target="${encodeXml(relationship.external ? relationship.target : relativeTarget(fresh, names.get(relationship.target)!))}"${relationship.external ? ' TargetMode="External"' : ''}/>`
      )
      await writer.put(relsPathOf(fresh), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.join('')}</Relationships>`)
    }
  }

  return { path: names.get(path)!, xml }
}
