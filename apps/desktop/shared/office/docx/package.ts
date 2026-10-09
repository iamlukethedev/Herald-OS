import JSZip from 'jszip'
import { attr, children, parseXml, type XmlElement } from './xml.ts'

/*
 * A Word file as the package it is: a zip of XML parts tied together by relationships. This opens
 * one, finds its main document through the package's relationships, and reads parts (with the
 * prefixes Herald matches on, whatever prefixes the file declared) and their relationships.
 */

export const NOT_WORD = 'This is not a Word document'

const TRANSITIONAL = 'http://schemas.openxmlformats.org'
const STRICT = 'http://purl.oclc.org/ooxml'

/** The prefix Herald reads each namespace with, transitional and strict. */
const PREFIXES: Readonly<Record<string, string>> = {
  [`${TRANSITIONAL}/wordprocessingml/2006/main`]: 'w',
  [`${STRICT}/wordprocessingml/main`]: 'w',
  [`${TRANSITIONAL}/officeDocument/2006/relationships`]: 'r',
  [`${STRICT}/officeDocument/relationships`]: 'r',
  [`${TRANSITIONAL}/drawingml/2006/wordprocessingDrawing`]: 'wp',
  [`${STRICT}/drawingml/wordprocessingDrawing`]: 'wp',
  [`${TRANSITIONAL}/drawingml/2006/main`]: 'a',
  [`${STRICT}/drawingml/main`]: 'a',
  [`${TRANSITIONAL}/drawingml/2006/picture`]: 'pic',
  [`${STRICT}/drawingml/picture`]: 'pic',
  [`${TRANSITIONAL}/drawingml/2006/chart`]: 'c',
  [`${STRICT}/drawingml/chart`]: 'c',
  [`${TRANSITIONAL}/drawingml/2006/diagram`]: 'dgm',
  [`${STRICT}/drawingml/diagram`]: 'dgm',
  [`${TRANSITIONAL}/officeDocument/2006/math`]: 'm',
  [`${STRICT}/officeDocument/math`]: 'm',
  [`${TRANSITIONAL}/markup-compatibility/2006`]: 'mc',
  [`${TRANSITIONAL}/package/2006/relationships`]: '',
  [`${TRANSITIONAL}/package/2006/content-types`]: '',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingShape': 'wps',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing': 'wp14',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup': 'wpg',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas': 'wpc',
  'http://schemas.microsoft.com/office/word/2010/wordml': 'w14',
  'http://schemas.microsoft.com/office/word/2012/wordml': 'w15',
  'urn:schemas-microsoft-com:vml': 'v',
  'urn:schemas-microsoft-com:office:office': 'o'
}

export interface Relationship {
  id: string
  type: string
  /** The part it points at (a path in the zip), or the address when it is external. */
  target: string
  external: boolean
}

export interface WordPackage {
  /** The main document's path in the zip, such as "word/document.xml". */
  main: string
  /** Whether the file carries macros. */
  macros: boolean
  has: (path: string) => boolean
  bytes: (path: string) => Promise<Uint8Array | null>
  xml: (path: string) => Promise<XmlElement | null>
  relationships: (part: string) => Promise<Map<string, Relationship>>
}

/** What a relationship is, from the end of its type ("styles", "image", "hyperlink"). */
export const relationshipKind = (relationship: Relationship): string => relationship.type.slice(relationship.type.lastIndexOf('/') + 1)

const directory = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1)

/** A relationship's target as a path in the zip, resolved against the part it belongs to. */
export function resolveTarget(source: string, target: string): string {
  let decoded = target

  try {
    decoded = decodeURIComponent(target)
  } catch {
    // A target with a stray percent sign is a path as it is.
  }

  const segments = (decoded.startsWith('/') ? decoded.slice(1) : directory(source) + decoded).split('/')
  const out: string[] = []

  for (const segment of segments) {
    if (segment === '..') {
      out.pop()
    } else if (segment !== '.' && segment !== '') {
      out.push(segment)
    }
  }

  return out.join('/')
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes)
  }

  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes)
  }

  return new TextDecoder().decode(bytes)
}

const relationshipsPath = (part: string): string => `${directory(part)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`

/** Opens a Word file; throws "This is not a Word document" when it is not one. */
export async function openPackage(bytes: Uint8Array): Promise<WordPackage> {
  let zip: JSZip

  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    throw new Error(NOT_WORD)
  }

  // Part names are not case-sensitive, though zip entries are.
  const names = new Map<string, string>()

  for (const name of Object.keys(zip.files)) {
    if (!zip.files[name].dir) {
      names.set(name.toLowerCase(), name)
    }
  }

  const has = (path: string): boolean => names.has(path.toLowerCase())

  const read = async (path: string): Promise<Uint8Array | null> => {
    const name = names.get(path.toLowerCase())

    return name ? zip.files[name].async('uint8array') : null
  }

  const xml = async (path: string): Promise<XmlElement | null> => {
    const data = await read(path)

    if (!data) {
      return null
    }

    try {
      return parseXml(decodeText(data), { prefixes: PREFIXES })
    } catch {
      return null
    }
  }

  const relationships = async (part: string): Promise<Map<string, Relationship>> => {
    const root = await xml(relationshipsPath(part))
    const out = new Map<string, Relationship>()

    for (const item of children(root ?? undefined, 'Relationship')) {
      const id = attr(item, 'Id')
      const target = attr(item, 'Target') ?? ''
      const external = attr(item, 'TargetMode') === 'External'

      if (id) {
        out.set(id, { id, type: attr(item, 'Type') ?? '', target: external ? target : resolveTarget(part, target), external })
      }
    }

    return out
  }

  const packageRelationships = await relationships('')
  const officeDocument = [...packageRelationships.values()].find((item) => relationshipKind(item) === 'officeDocument' && !item.external)
  const main = officeDocument?.target ?? (has('word/document.xml') ? 'word/document.xml' : null)

  if (!main || !has(main)) {
    throw new Error(NOT_WORD)
  }

  const types = await xml('[Content_Types].xml')
  const mainType = children(types ?? undefined, 'Override').find((item) => (attr(item, 'PartName') ?? '').replace(/^\//, '').toLowerCase() === main.toLowerCase())
  const macros = /macroEnabled/i.test(attr(mainType, 'ContentType') ?? '') || [...names.keys()].some((name) => name.endsWith('vbaproject.bin'))

  return { main: names.get(main.toLowerCase()) ?? main, macros, has, bytes: read, xml, relationships }
}
