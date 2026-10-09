import type JSZip from 'jszip'
import type { Background, Deck, KeptPart, SlideElement } from '../deck.ts'
import { normalizeDeck } from '../normalize.ts'
import { attr, childrenNamed, parseXml, serializeXml, xml } from './xml.ts'

/*
 * Herald's own copy of a deck inside a PowerPoint file it saved: `herald/deck.json`, a part with
 * its content type and a package relationship of its own, which PowerPoint, Keynote and LibreOffice
 * pass over. Reading it gives the deck back exactly. Nothing is stored twice: a picture (on a slide,
 * the master or a layout, or a kept object's) names the media part with the same bytes, and a kept
 * object's part the part it was copied to. It also records a fingerprint of the slides as written,
 * so a file changed by another app since is read from its slides instead.
 */

export const HERALD_PART = 'herald/deck.json'
export const HERALD_CONTENT_TYPE = 'application/vnd.herald-os.slides+json'
export const HERALD_RELATIONSHIP = 'urn:herald-os:slides:deck'
const FORMAT = 'herald-slides'
/** Version 2 may name kept objects' parts; version 1 copies are read as before. */
const VERSION = 2

/** A quick 53-bit hash, enough to notice a part that changed. */
function hash(text: string): string {
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

const slideNumber = (name: string): number => Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0)

/** The slides' XML as written, in order, as one fingerprint. */
export async function slidesFingerprint(zip: JSZip): Promise<string> {
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
  const parts = await Promise.all(names.map((name) => zip.file(name)!.async('string')))

  return `${names.length}:${hash(parts.join('\u0000'))}`
}

const MIME_BY_EXTENSION: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' }

const mimeOf = (name: string): string | undefined => MIME_BY_EXTENSION[name.split('.').pop()?.toLowerCase() ?? '']

interface Visits {
  /** A picture's source. */
  src: (src: string) => string
  /** A kept part's bytes. */
  data: (part: KeptPart) => string
}

const mapBackground = (background: Background | null, visit: Visits): Background | null => (background?.kind === 'image' ? { ...background, src: visit.src(background.src) } : background)

const mapPart = (part: KeptPart, visit: Visits): KeptPart => ({ ...part, data: visit.data(part), ...(part.parts ? { parts: part.parts.map((inner) => mapPart(inner, visit)) } : {}) })

function mapElement(element: SlideElement, visit: Visits): SlideElement {
  if (element.kind === 'image') {
    return element.src ? { ...element, src: visit.src(element.src) } : element
  }

  if (element.kind !== 'object') {
    return element
  }

  return {
    ...element,
    ...(element.preview ? { preview: { ...element.preview, src: visit.src(element.preview.src) } } : {}),
    ...(element.shapes ? { shapes: element.shapes.map((shape) => mapElement(shape, visit)) } : {}),
    source: { ...element.source, parts: element.source.parts.map((part) => mapPart(part, visit)) }
  }
}

/** The deck with every picture source and kept part passed through `visit`: on slides, the master and its layouts. */
function mapSources(deck: Deck, visit: Visits): Deck {
  return {
    ...deck,
    ...(deck.master
      ? {
          master: {
            ...deck.master,
            background: mapBackground(deck.master.background, visit),
            elements: deck.master.elements.map((element) => mapElement(element, visit)),
            layouts: deck.master.layouts.map((layout) => ({ ...layout, background: mapBackground(layout.background, visit), elements: layout.elements.map((element) => mapElement(element, visit)) }))
          }
        }
      : {}),
    slides: deck.slides.map((slide) => ({ ...slide, background: mapBackground(slide.background, visit), elements: slide.elements.map((element) => mapElement(element, visit)) }))
  }
}

const folderOf = (name: string): string => name.slice(0, name.lastIndexOf('/') + 1)

/** The folders kept parts were copied into (each keeps its folder under a fresh name). */
function partFolders(deck: Deck): Set<string> {
  const folders = new Set<string>()
  const visit: Visits = {
    src: (src) => src,
    data: (part) => {
      folders.add(folderOf(part.path.replace(/^\/+/, '')))

      return part.data
    }
  }
  mapSources(deck, visit)

  return folders
}

/** Add Herald's copy of `deck` to a PowerPoint file just written. */
export async function embedDeck(zip: JSZip, deck: Deck): Promise<void> {
  // What is already in the file is named by its part instead of copied: pictures among the media, kept parts in their folders.
  const folders = new Set(['ppt/media/', ...partFolders(deck)])
  const parts = new Map<string, string[]>()

  for (const name of Object.keys(zip.files).filter((entry) => !zip.files[entry].dir && folders.has(folderOf(entry)))) {
    const base64 = await zip.file(name)!.async('base64')
    parts.set(base64, [...(parts.get(base64) ?? []), name])
  }

  // A reference is made only where reading it gives back the very same text.
  const light = mapSources(deck, {
    src: (src) => {
      const payload = src.slice(src.indexOf(',') + 1)
      const part = parts.get(payload)?.find((name) => name.startsWith('ppt/media/') && src === `data:${mimeOf(name)};base64,${payload}`)

      return part ? `part:/${part}` : src
    },
    data: (kept) => {
      const folder = folderOf(kept.path.replace(/^\/+/, ''))
      const part = parts.get(kept.data)?.find((name) => folderOf(name) === folder)

      return part ? `part:/${part}` : kept.data
    }
  })
  const fingerprint = await slidesFingerprint(zip)
  zip.file(HERALD_PART, JSON.stringify({ format: FORMAT, version: VERSION, fingerprint, deck: light }))

  const types = parseXml((await zip.file('[Content_Types].xml')?.async('string')) ?? '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', { canonical: false })
  types.children = types.children.filter((node) => typeof node === 'string' || attr(node, 'PartName') !== `/${HERALD_PART}`)
  types.children.push(xml('Override', { PartName: `/${HERALD_PART}`, ContentType: HERALD_CONTENT_TYPE }))
  zip.file('[Content_Types].xml', serializeXml(types))

  const rels = parseXml((await zip.file('_rels/.rels')?.async('string')) ?? '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>', { canonical: false })
  rels.children = rels.children.filter((node) => typeof node === 'string' || attr(node, 'Type') !== HERALD_RELATIONSHIP)
  const taken = new Set(childrenNamed(rels, 'Relationship').map((node) => attr(node, 'Id')))
  let id = 1

  while (taken.has(`rIdHerald${id}`)) {
    id++
  }

  rels.children.push(xml('Relationship', { Id: `rIdHerald${id}`, Type: HERALD_RELATIONSHIP, Target: HERALD_PART }))
  zip.file('_rels/.rels', serializeXml(rels))
}

export type EmbeddedRead = { deck: Deck } | { stale: true } | null

/**
 * Herald's copy of the deck in a file, made safe: null when there is none (or it is not one this
 * version reads), `stale` when the slides changed after Herald wrote it.
 */
export async function readEmbeddedDeck(zip: JSZip, title: string): Promise<EmbeddedRead> {
  const part = zip.file(HERALD_PART)

  if (!part) {
    return null
  }

  let parsed: { format?: unknown; version?: unknown; fingerprint?: unknown; deck?: unknown }

  try {
    parsed = JSON.parse(await part.async('string'))
  } catch {
    return null
  }

  if (parsed.format !== FORMAT || typeof parsed.version !== 'number' || parsed.version > VERSION) {
    return null
  }

  if (parsed.fingerprint !== (await slidesFingerprint(zip))) {
    return { stale: true }
  }

  const bytes = new Map<string, string>()

  for (const name of new Set(JSON.stringify(parsed.deck ?? null).match(/part:\/[\w./-]+/g) ?? [])) {
    const file = zip.file(name.slice('part:/'.length))

    if (file) {
      bytes.set(name, await file.async('base64'))
    }
  }

  const resolved = JSON.parse(JSON.stringify(parsed.deck ?? null), (key, value) => {
    if (typeof value !== 'string' || !value.startsWith('part:/')) {
      return value
    }

    const base64 = bytes.get(value)
    const mime = mimeOf(value)

    return key === 'src' ? (base64 !== undefined && mime ? `data:${mime};base64,${base64}` : '') : key === 'data' ? (base64 ?? '') : value
  })

  try {
    return { deck: normalizeDeck(resolved, title) }
  } catch {
    return null
  }
}
