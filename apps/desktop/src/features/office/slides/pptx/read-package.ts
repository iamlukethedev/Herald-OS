import type JSZip from 'jszip'
import { attr, childrenNamed, parseXml, type XmlElement } from './xml.ts'

/*
 * A PowerPoint file's package: its parts, each read and parsed once, and the relationships that
 * lead from one part to another, as PowerPoint follows them.
 */

export interface Relationship {
  id: string
  /** The type URI's last segment, such as `slide`, `image` or `notesSlide`. */
  type: string
  /** The type URI whole. */
  uri: string
  /** The target's path in the zip, or its URL when it is outside the file. */
  target: string
  external: boolean
}

export function remember<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  let entry = cache.get(key)

  if (!entry) {
    entry = make()
    cache.set(key, entry)
  }

  return entry
}

/** Where a relationship's target is in the zip: from its source part's folder, or from the root when it starts with `/`. */
export function resolveTarget(source: string, target: string): string {
  const path = target.replace(/\\/g, '/')
  const parts = path.startsWith('/') ? [] : source.split('/').slice(0, -1)

  for (const piece of path.split('/')) {
    if (piece === '..') {
      parts.pop()
    } else if (piece && piece !== '.') {
      parts.push(piece)
    }
  }

  return parts.join('/')
}

function relationshipsPart(part: string): string {
  const slash = part.lastIndexOf('/')

  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
}

function readRelationships(root: XmlElement | undefined, part: string): Relationship[] {
  return childrenNamed(root, 'Relationship').flatMap((entry) => {
    const id = attr(entry, 'Id')
    const type = attr(entry, 'Type') ?? ''
    const target = attr(entry, 'Target')
    const external = attr(entry, 'TargetMode') === 'External'

    return id && target ? [{ id, type: type.slice(type.lastIndexOf('/') + 1), uri: type, target: external ? target : resolveTarget(part, target), external }] : []
  })
}

export const targetOf = (relationships: readonly Relationship[], type: string): string | undefined => relationships.find((entry) => entry.type === type && !entry.external)?.target

export const byId = (relationships: readonly Relationship[], id: string | undefined): Relationship | undefined => (id ? relationships.find((entry) => entry.id === id) : undefined)

export const partOf = (relationships: readonly Relationship[], id: string | undefined): string | undefined => {
  const relationship = byId(relationships, id)

  return relationship && !relationship.external ? relationship.target : undefined
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    // A `%` that starts no escape is part of the name.
    return path
  }
}

export function base64(bytes: Uint8Array): string {
  let binary = ''

  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }

  return btoa(binary)
}

/** The zip's parts, each read and parsed once. */
export class Package {
  private readonly parsed = new Map<string, Promise<XmlElement | undefined>>()
  private readonly written = new Map<string, Promise<XmlElement | undefined>>()
  private readonly related = new Map<string, Promise<Relationship[]>>()
  private lowerCase: Map<string, string> | null = null

  constructor(private readonly zip: JSZip) {}

  /** A file by its path, or by the same path URL-decoded or in other letter case (as some tools write names). */
  file(path: string): JSZip.JSZipObject | null {
    if (!path) {
      return null
    }

    const plain = decodePath(path)
    const exact = this.zip.file(path) ?? this.zip.file(plain)

    if (exact) {
      return exact
    }

    this.lowerCase ??= new Map(Object.keys(this.zip.files).map((name) => [name.toLowerCase(), name]))
    const name = this.lowerCase.get(path.toLowerCase()) ?? this.lowerCase.get(plain.toLowerCase())

    return name ? this.zip.file(name) : null
  }

  /** The name a part has in the zip, which may differ from the path that led to it in case or escapes. */
  name(path: string): string {
    return this.file(path)?.name ?? path
  }

  /** A part's XML, or nothing when it is missing or is not XML. */
  xml(path: string | undefined): Promise<XmlElement | undefined> {
    return path ? remember(this.parsed, path, () => this.parse(path, true)) : Promise.resolve(undefined)
  }

  /** A part's XML with its names as the file wrote them, for passing a piece of it on as it was. */
  source(path: string): Promise<XmlElement | undefined> {
    return remember(this.written, path, () => this.parse(path, false))
  }

  /** A part's relationships with their targets resolved; none when it has no relationships part. */
  relationships(part: string): Promise<Relationship[]> {
    return remember(this.related, part, async () => readRelationships(await this.xml(relationshipsPart(part)), part))
  }

  /** A part's bytes; none when it is missing or cannot be read. */
  async bytes(path: string): Promise<Uint8Array | undefined> {
    return this.file(path)
      ?.async('uint8array')
      .catch(() => undefined)
  }

  /** A part's content type, as the package's content types give it by its name or else by its extension. */
  async contentType(path: string): Promise<string> {
    const types = await this.xml('[Content_Types].xml')
    const name = decodePath(`/${this.name(path)}`).toLowerCase()
    const own = childrenNamed(types, 'Override').find((entry) => decodePath(attr(entry, 'PartName') ?? '').toLowerCase() === name)
    const extension = name.slice(name.lastIndexOf('.') + 1)
    const shared = childrenNamed(types, 'Default').find((entry) => (attr(entry, 'Extension') ?? '').toLowerCase() === extension)

    return attr(own, 'ContentType') ?? attr(shared, 'ContentType') ?? 'application/octet-stream'
  }

  private async parse(path: string, canonical: boolean): Promise<XmlElement | undefined> {
    const file = this.file(path)

    if (!file) {
      return undefined
    }

    try {
      return parseXml(await file.async('string'), { canonical })
    } catch {
      return undefined
    }
  }
}
