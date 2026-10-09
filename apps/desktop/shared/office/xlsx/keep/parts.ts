import { type PackageWriter, parseRelationships, type Relationship, relativeTarget, relsPathOf } from '../opc.ts'
import type { XlsxPackage } from '../package.ts'
import { elementsOf, encodeXml } from '../xml.ts'

/*
 * Parts of the source file copied into the package being finished: each under a fresh name, with
 * its content type from the source's [Content_Types].xml and its relationships (the same ids, which
 * its XML names, pointing at the parts they point at, copied too, each once). A part that cannot
 * come whole (one it needs is missing, or its XML names a sheet that is gone) is not copied at all,
 * nor are the parts it would bring.
 */

/** Why a part is not kept: "gone" when it shows a sheet, pivot table or table that is gone, "broken" when the source does not hold it whole. */
export interface Refusal {
  refused: 'gone' | 'broken' | 'unsupported'
}

/** Changes a part's XML on its way into the package, or refuses it. */
export type Transform = (xml: string, path: string, contentType: string) => string | Refusal

export const refused = (reason: Refusal['refused']): Refusal => ({ refused: reason })

const isRefusal = (value: string | Refusal): value is Refusal => typeof value !== 'string'

/** Parts never copied: macros, controls and data connections go with the features Herald drops. */
const NEVER = /vbaProject|activeX|controlproperties|macrosheet|\.main\+xml$|spreadsheetml\.(?:connections|queryTable|worksheet|dialogsheet)\+xml/i

const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships'

type Prepared =
  | { ok: true; path: string; contentType: string; override: boolean; content: Uint8Array | string; relationships: Relationship[] }
  | { ok: false; reason: Refusal['refused'] }

/** The name series a part belongs to: "xl/media/image3.png" gives "xl/media/image1.png", "xl/media/image2.png" and so on. */
function series(path: string): (n: number) => string {
  const slash = path.lastIndexOf('/')
  const [, stem, extension] = /^(.*?)\d*(\.[^.]*)?$/.exec(path.slice(slash + 1)) ?? []

  return (n) => `${path.slice(0, slash + 1)}${stem ?? ''}${n}${extension ?? ''}`
}

const isXml = (path: string, contentType: string): boolean => /[+/]xml$/.test(contentType) || /\.(xml|vml)$/i.test(path)

export class PartCopier {
  private types: Promise<{ overrides: Map<string, string>; defaults: Map<string, string> }> | null = null
  private readonly prepared = new Map<string, Promise<Prepared>>()
  private readonly copied = new Map<string, string>()

  constructor(
    private readonly pkg: XlsxPackage,
    private readonly writer: PackageWriter,
    private readonly transform: Transform
  ) {}

  /** The relationships of a part of the source, their types in full. */
  async relationships(path: string): Promise<Relationship[]> {
    return parseRelationships(path, await this.pkg.read(relsPathOf(path)))
  }

  private contentTypes(): Promise<{ overrides: Map<string, string>; defaults: Map<string, string> }> {
    this.types ??= this.pkg.read('[Content_Types].xml').then((xml = '') => ({
      overrides: new Map(elementsOf(xml, 'Override').map(({ attributes }) => [String(attributes.PartName ?? '').replace(/^\//, '').toLowerCase(), attributes.ContentType ?? ''])),
      defaults: new Map(elementsOf(xml, 'Default').map(({ attributes }) => [String(attributes.Extension ?? '').toLowerCase(), attributes.ContentType ?? '']))
    }))

    return this.types
  }

  /** The content type a part of the source has, and whether it is the part's own (an Override) rather than its extension's. */
  async contentType(path: string): Promise<{ type: string; override: boolean } | undefined> {
    const { overrides, defaults } = await this.contentTypes()
    const own = overrides.get(path.toLowerCase())
    const byExtension = defaults.get(path.split('.').pop()?.toLowerCase() ?? '')

    return own ? { type: own, override: true } : byExtension ? { type: byExtension, override: false } : undefined
  }

  private prepare(path: string, visiting: Set<string>): Promise<Prepared> {
    let pending = this.prepared.get(path)

    if (!pending) {
      pending = this.load(path, visiting)
      this.prepared.set(path, pending)
    }

    return pending
  }

  private async load(path: string, visiting: Set<string>): Promise<Prepared> {
    const bytes = await this.pkg.binary(path)
    const type = await this.contentType(path)

    if (!bytes || !type) {
      return { ok: false, reason: 'broken' }
    }

    if (NEVER.test(type.type)) {
      return { ok: false, reason: 'unsupported' }
    }

    let content: Uint8Array | string = bytes

    if (isXml(path, type.type)) {
      const changed = this.transform((await this.pkg.read(path)) ?? '', path, type.type)

      if (isRefusal(changed)) {
        return { ok: false, reason: changed.refused }
      }

      content = changed
    }

    const relationships: Relationship[] = []
    const inside = new Set([...visiting, path])

    for (const rel of await this.relationships(path)) {
      if (rel.external || inside.has(rel.target)) {
        relationships.push(rel)
        continue
      }

      // A relationship to a part the source lacks goes, unless the part's XML names it.
      if (!this.pkg.files.includes(rel.target) && !(typeof content === 'string' && content.includes(`"${rel.id}"`))) {
        continue
      }

      const child = await this.prepare(rel.target, inside)

      if (!child.ok) {
        return { ok: false, reason: child.reason }
      }

      relationships.push(rel)
    }

    return { ok: true, path, contentType: type.type, override: type.override, content, relationships }
  }

  /** Whether a part can be copied with all it brings; why not when it cannot. */
  async check(path: string): Promise<Refusal['refused'] | null> {
    const part = await this.prepare(path, new Set())

    return part.ok ? null : part.reason
  }

  /** Copy a part of the source under a fresh name, with the parts it relates to (each once); its path in the package, or null when it is not kept. */
  async copy(path: string): Promise<string | null> {
    const done = this.copied.get(path)

    if (done) {
      return done
    }

    const part = await this.prepare(path, new Set())

    return part.ok ? this.write(part, this.writer.freshName(series(path))) : null
  }

  /** Copy a part's content to a given path of the package, over what is there, with the parts it relates to. */
  async copyTo(path: string, target: string): Promise<boolean> {
    const part = await this.prepare(path, new Set())

    if (part.ok) {
      await this.write(part, target)
    }

    return part.ok
  }

  /** Where a part of the source was copied, when it was. */
  copiedPath(path: string): string | undefined {
    return this.copied.get(path)
  }

  private async write(part: Extract<Prepared, { ok: true }>, target: string): Promise<string> {
    this.copied.set(part.path, target)
    // The part goes in first, so the parts it brings take other names.
    await this.writer.put(target, part.content)
    const entries: string[] = []

    for (const rel of part.relationships) {
      const to = rel.external ? rel.target : (this.copied.get(rel.target) ?? (await this.copy(rel.target)))

      if (to !== null) {
        entries.push(`<Relationship Id="${encodeXml(rel.id)}" Type="${encodeXml(rel.type)}" Target="${encodeXml(rel.external ? to : relativeTarget(target, to))}"${rel.external ? ' TargetMode="External"' : ''}/>`)
      }
    }

    if (entries.length) {
      await this.writer.put(relsPathOf(target), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${RELATIONSHIPS}">${entries.join('')}</Relationships>`)
    }

    if (part.override) {
      await this.writer.put(target, part.content, part.contentType)
    } else {
      await this.writer.setDefault(target.split('.').pop() ?? '', part.contentType)

      if ((await this.writer.contentType(target)) !== part.contentType) {
        await this.writer.put(target, part.content, part.contentType)
      }
    }

    return target
  }
}
