import type JSZip from 'jszip'
import { attr, childrenNamed, parseXml, serializeXml, xml, type XmlElement } from './xml.ts'

/*
 * The package around the parts Herald writes: each part's relationships, a content type for every
 * part, and fresh names for parts copied in, so a file stays whole however its parts were made.
 */

const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export const RELATIONSHIP_TYPES = {
  slideMaster: `${OFFICE}/slideMaster`,
  slideLayout: `${OFFICE}/slideLayout`,
  notesSlide: `${OFFICE}/notesSlide`,
  theme: `${OFFICE}/theme`
} as const

export const CONTENT_TYPES = {
  slideMaster: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  slideLayout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml'
} as const

/** Content types by extension, for parts named by their extension (`Default`) rather than one by one. */
export const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  bin: 'application/vnd.openxmlformats-officedocument.oleObject',
  xml: 'application/xml',
  rels: 'application/vnd.openxmlformats-package.relationships+xml'
}

export const extensionOf = (part: string): string => (/\.([^./]+)$/.exec(part)?.[1] ?? '').toLowerCase()

export const folderOf = (part: string): string => part.slice(0, part.lastIndexOf('/') + 1)

/** Where a part's relationships are kept. */
export const relationshipsPart = (part: string): string => `${folderOf(part)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`

/** A relationship's target as a part name, from the part it belongs to. */
export function resolveTarget(part: string, target: string): string {
  if (target.startsWith('/')) {
    return target.slice(1)
  }

  const names: string[] = []

  for (const segment of `${folderOf(part)}${target}`.split('/')) {
    if (segment === '..') {
      names.pop()
    } else if (segment && segment !== '.') {
      names.push(segment)
    }
  }

  return names.join('/')
}

/** The target a part names another part by: relative to its own folder. */
export function relativeTarget(from: string, to: string): string {
  const base = folderOf(from).split('/').filter(Boolean)
  const names = to.split('/')
  let common = 0

  while (common < base.length && common < names.length - 1 && base[common] === names[common]) {
    common++
  }

  return [...base.slice(common).map(() => '..'), ...names.slice(common)].join('/')
}

/** A name for a part copied in: `wanted` when it is free, else the same with the next free number before its extension (part names ignore case). */
export function freshPart(zip: JSZip, wanted: string): string {
  const taken = new Set(Object.keys(zip.files).map((name) => name.toLowerCase()))

  if (!taken.has(wanted.toLowerCase())) {
    return wanted
  }

  const [, stem, digits, extension = ''] = /^(.*?)(\d*)(\.[^./]*)?$/.exec(wanted) ?? ['', wanted, '', '']
  let n = digits ? Number(digits) + 1 : 1

  while (taken.has(`${stem}${n}${extension}`.toLowerCase())) {
    n++
  }

  return `${stem}${n}${extension}`
}

export interface Relationship {
  id: string
  type: string
  target: string
  external: boolean
}

/** A part's relationships, read from the package or made new, with fresh ids for what is added. */
export class Relationships {
  private constructor(readonly entries: Relationship[]) {}

  static empty(): Relationships {
    return new Relationships([])
  }

  static async read(zip: JSZip, part: string): Promise<Relationships> {
    const file = zip.file(relationshipsPart(part))

    if (!file) {
      return new Relationships([])
    }

    const root = parseXml(await file.async('string'), { canonical: false })

    return new Relationships(
      childrenNamed(root, 'Relationship').map((node) => ({ id: attr(node, 'Id') ?? '', type: attr(node, 'Type') ?? '', target: attr(node, 'Target') ?? '', external: attr(node, 'TargetMode') === 'External' }))
    )
  }

  get(id: string): Relationship | undefined {
    return this.entries.find((entry) => entry.id === id)
  }

  /** A relationship under an id no other has; returns the id. */
  add(type: string, target: string, external = false): string {
    const taken = this.entries.map((entry) => Number(/^rId(\d+)$/.exec(entry.id)?.[1] ?? 0))
    const id = `rId${Math.max(0, ...taken) + 1}`
    this.entries.push({ id, type, target, external })

    return id
  }

  /** A relationship under the id its part already names it by. */
  put(id: string, type: string, target: string): void {
    const at = this.entries.findIndex((entry) => entry.id === id)
    const entry = { id, type, target, external: false }

    if (at >= 0) {
      this.entries[at] = entry
    } else {
      this.entries.push(entry)
    }
  }

  write(zip: JSZip, part: string): void {
    const root = xml(
      'Relationships',
      { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' },
      this.entries.map((entry) => xml('Relationship', { Id: entry.id, Type: entry.type, Target: entry.target, TargetMode: entry.external ? 'External' : undefined }))
    )
    zip.file(relationshipsPart(part), serializeXml(root))
  }
}

/** `[Content_Types].xml`: a content type for each part, by its extension or its own. */
export class ContentTypes {
  private constructor(private readonly root: XmlElement) {}

  static async read(zip: JSZip): Promise<ContentTypes> {
    const text = (await zip.file('[Content_Types].xml')?.async('string')) ?? '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'

    return new ContentTypes(parseXml(text, { canonical: false }))
  }

  private named(kind: 'Default' | 'Override', key: 'Extension' | 'PartName', value: string): XmlElement | undefined {
    return childrenNamed(this.root, kind).find((node) => (attr(node, key) ?? '').toLowerCase() === value.toLowerCase())
  }

  typeOf(part: string): string | undefined {
    return attr(this.named('Override', 'PartName', `/${part}`), 'ContentType') ?? attr(this.named('Default', 'Extension', extensionOf(part)), 'ContentType')
  }

  /** Give a part its content type: by its extension where that is a media type no part has yet, else a content type of its own. */
  ensure(part: string, type: string): void {
    if (this.typeOf(part) === type) {
      return
    }

    const extension = extensionOf(part)

    if (extension && !this.named('Default', 'Extension', extension) && /^(image|audio|video)\//.test(type)) {
      this.root.children.unshift(xml('Default', { Extension: extension, ContentType: type }))

      return
    }

    this.override(part, type)
  }

  override(part: string, type: string): void {
    const found = this.named('Override', 'PartName', `/${part}`)

    if (found) {
      found.attrs.ContentType = type
    } else {
      this.root.children.push(xml('Override', { PartName: `/${part}`, ContentType: type }))
    }
  }

  /** Write it back: no content type for a part the package does not have, and one for every part it has. */
  write(zip: JSZip): void {
    this.root.children = this.root.children.filter((node) => typeof node === 'string' || node.name !== 'Override' || zip.file((attr(node, 'PartName') ?? '').slice(1)) !== null)

    for (const name of Object.keys(zip.files)) {
      if (!zip.files[name].dir && name !== '[Content_Types].xml' && !this.typeOf(name)) {
        this.ensure(name, EXTENSION_TYPES[extensionOf(name)] ?? 'application/octet-stream')
      }
    }

    zip.file('[Content_Types].xml', serializeXml(this.root))
  }
}

/** The package being written: its parts and their content types. */
export interface PackageWriter {
  zip: JSZip
  types: ContentTypes
}
