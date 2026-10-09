import JSZip from 'jszip'
import { resolveTarget } from './package.ts'

/*
 * Changes to a Word package after the docx package has written it: parts added or replaced, with
 * their content types and the relationships that lead to them, written into [Content_Types].xml
 * and the relationship parts as text, the way the docx package writes them.
 */

const CONTENT_TYPES = '[Content_Types].xml'

const escaped = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

const unescaped = (value: string): string => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** The relationship part of a part ('' for the package's own). */
const relationshipsOf = (source: string): string => (source ? `${source.slice(0, source.lastIndexOf('/') + 1)}_rels/${source.slice(source.lastIndexOf('/') + 1)}.rels` : '_rels/.rels')

/** A path in the package as a relationship of `source` writes it. */
function relativeTarget(source: string, target: string): string {
  const from = source.split('/').slice(0, -1)
  const to = target.split('/')
  let shared = 0

  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) {
    shared++
  }

  return [...from.slice(shared).map(() => '..'), ...to.slice(shared)].join('/')
}

const attributeOf = (element: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(element)

  return match ? unescaped(match[1]) : undefined
}

export class Repack {
  private readonly texts = new Map<string, string>()

  private constructor(private readonly zip: JSZip) {}

  static async open(bytes: Uint8Array): Promise<Repack> {
    return new Repack(await JSZip.loadAsync(bytes))
  }

  has(path: string): boolean {
    return this.texts.has(path) || Boolean(this.zip.file(path))
  }

  async text(path: string): Promise<string | null> {
    return this.texts.get(path) ?? (await this.zip.file(path)?.async('string')) ?? null
  }

  setText(path: string, text: string): void {
    this.texts.set(path, text)
  }

  setBytes(path: string, bytes: Uint8Array): void {
    this.texts.delete(path)
    this.zip.file(path, bytes)
  }

  /** Names a part's content type, unless [Content_Types].xml names it so already. */
  async setContentType(path: string, type: string): Promise<void> {
    const types = (await this.text(CONTENT_TYPES)) ?? ''
    const name = `/${path}`
    const overrides = types.match(/<Override\b[^>]*\/>/g) ?? []
    const own = overrides.find((element) => attributeOf(element, 'PartName')?.toLowerCase() === name.toLowerCase())

    if (own && attributeOf(own, 'ContentType') === type) {
      return
    }

    const override = `<Override ContentType="${escaped(type)}" PartName="${escaped(name)}"/>`
    this.setText(CONTENT_TYPES, own ? types.replace(own, override) : types.replace('</Types>', `${override}</Types>`))
  }

  /** A relationship from `source` ('' for the package) to the part at `target`, unless one of its type already leads there; its id. */
  async relate(source: string, type: string, target: string): Promise<string> {
    const path = relationshipsOf(source)
    const xml = (await this.text(path)) ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
    const relationships = xml.match(/<Relationship\b[^>]*\/>/g) ?? []
    const same = relationships.find((element) => attributeOf(element, 'Type') === type && attributeOf(element, 'TargetMode') !== 'External' && resolveTarget(source, attributeOf(element, 'Target') ?? '') === target)

    if (same) {
      return attributeOf(same, 'Id') ?? ''
    }

    const ids = new Set(relationships.map((element) => attributeOf(element, 'Id')))
    let number = 1

    while (ids.has(`rIdHerald${number}`)) {
      number++
    }

    const id = `rIdHerald${number}`
    this.setText(path, xml.replace('</Relationships>', `<Relationship Id="${id}" Type="${escaped(type)}" Target="${escaped(relativeTarget(source, target))}"/></Relationships>`))

    return id
  }

  async bytes(): Promise<Uint8Array> {
    for (const [path, text] of this.texts) {
      this.zip.file(path, text)
    }

    return this.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  }
}
