import type JSZip from 'jszip'
import { resolvePart } from './package.ts'
import { attributesOf, elementsOf, encodeXml } from './xml.ts'

/*
 * Finishing an .xlsx package after ExcelJS has written it: parts added with their content types,
 * relationships between parts, and elements put where the schema has them in a worksheet or the
 * workbook. Excel repairs a file whose parts have no content type, whose relationships point at
 * nothing, or whose elements are out of order, so every addition goes through here.
 */

const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types'
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** Relationship types by their last part, as Office writes them. */
export const REL = {
  drawing: `${OFFICE}/drawing`,
  chart: `${OFFICE}/chart`,
  image: `${OFFICE}/image`,
  comments: `${OFFICE}/comments`,
  vmlDrawing: `${OFFICE}/vmlDrawing`,
  pivotTable: `${OFFICE}/pivotTable`,
  pivotCacheDefinition: `${OFFICE}/pivotCacheDefinition`,
  pivotCacheRecords: `${OFFICE}/pivotCacheRecords`,
  table: `${OFFICE}/table`,
  threadedComment: 'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment',
  person: 'http://schemas.microsoft.com/office/2017/10/relationships/person'
} as const

/** The content types of the parts Herald writes itself. */
export const CONTENT_TYPE = {
  drawing: 'application/vnd.openxmlformats-officedocument.drawing+xml',
  chart: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  comments: 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml',
  vml: 'application/vnd.openxmlformats-officedocument.vmlDrawing',
  threadedComments: 'application/vnd.ms-excel.threadedcomments+xml',
  persons: 'application/vnd.ms-excel.person+xml'
} as const

export interface Relationship {
  id: string
  /** The full type URI. */
  type: string
  /** A part's path in the package, or the address of an external target. */
  target: string
  external: boolean
}

/** Where the relationships of `part` are kept ("" is the package itself). */
export function relsPathOf(part: string): string {
  const slash = part.lastIndexOf('/')

  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
}

/** A part's path as a relationship target from `from` ("../charts/chart1.xml"). */
export function relativeTarget(from: string, to: string): string {
  const base = from.split('/').slice(0, -1)
  const path = to.split('/')
  let same = 0

  while (same < base.length && same < path.length - 1 && base[same] === path[same]) {
    same++
  }

  return [...base.slice(same).map(() => '..'), ...path.slice(same)].join('/')
}

/** Read a .rels part's relationships, their targets as package paths. */
export function parseRelationships(part: string, xml: string | undefined): Relationship[] {
  return xml
    ? elementsOf(xml, 'Relationship').map(({ attributes }) => {
        const external = attributes.TargetMode === 'External'

        return { id: attributes.Id ?? '', type: attributes.Type ?? '', target: external ? (attributes.Target ?? '') : resolvePart(part, attributes.Target ?? ''), external }
      })
    : []
}

/** The parts and relationships of a package being finished; nothing is written back until `flush`. */
export class PackageWriter {
  private overrides: Map<string, string> | null = null
  private defaults: Map<string, string> | null = null
  private readonly rels = new Map<string, Relationship[]>()
  private readonly touched = new Set<string>()

  constructor(readonly zip: JSZip) {}

  files(): string[] {
    return Object.keys(this.zip.files).filter((name) => !this.zip.files[name].dir)
  }

  has(path: string): boolean {
    return Boolean(this.zip.file(path))
  }

  text(path: string): Promise<string | undefined> {
    return this.zip.file(path)?.async('string') ?? Promise.resolve(undefined)
  }

  bytes(path: string): Promise<Uint8Array | undefined> {
    return this.zip.file(path)?.async('uint8array') ?? Promise.resolve(undefined)
  }

  private async types(): Promise<{ overrides: Map<string, string>; defaults: Map<string, string> }> {
    if (!this.overrides || !this.defaults) {
      const xml = (await this.text('[Content_Types].xml')) ?? ''
      this.overrides = new Map(elementsOf(xml, 'Override').map(({ attributes }) => [String(attributes.PartName ?? '').replace(/^\//, ''), attributes.ContentType ?? '']))
      this.defaults = new Map(elementsOf(xml, 'Default').map(({ attributes }) => [String(attributes.Extension ?? '').toLowerCase(), attributes.ContentType ?? '']))
    }

    return { overrides: this.overrides, defaults: this.defaults }
  }

  /** Add or replace a part; with a content type, the part gets it as its own (an Override). */
  async put(path: string, content: string | Uint8Array, contentType?: string): Promise<void> {
    this.zip.file(path, content)

    if (contentType) {
      const { overrides } = await this.types()
      overrides.set(path, contentType)
    }
  }

  /** Take a part out, with its content type and its own relationships. */
  async remove(path: string): Promise<void> {
    const { overrides } = await this.types()
    this.zip.remove(path)
    this.zip.remove(relsPathOf(path))
    this.rels.delete(path)
    overrides.delete(path)
  }

  /** The content type a part has: its own, or its extension's. */
  async contentType(path: string): Promise<string | undefined> {
    const { overrides, defaults } = await this.types()

    return overrides.get(path) ?? defaults.get(path.split('.').pop()?.toLowerCase() ?? '')
  }

  /** Give every part with this extension a content type (pictures: png, jpeg, emf). */
  async setDefault(extension: string, contentType: string): Promise<void> {
    const { defaults } = await this.types()

    if (!defaults.has(extension.toLowerCase())) {
      defaults.set(extension.toLowerCase(), contentType)
    }
  }

  /** The relationships of a part ("" for the package's own). */
  async relationships(part: string): Promise<Relationship[]> {
    let list = this.rels.get(part)

    if (!list) {
      list = parseRelationships(part, await this.text(relsPathOf(part)))
      this.rels.set(part, list)
    }

    return list
  }

  /** Relate `from` to a part (or an external address); gives the new relationship's id. */
  async relate(from: string, type: string, target: string, options: { external?: boolean } = {}): Promise<string> {
    const list = await this.relationships(from)
    let n = list.length + 1

    while (list.some((rel) => rel.id === `rId${n}`)) {
      n++
    }

    const id = `rId${n}`
    list.push({ id, type, target, external: Boolean(options.external) })
    this.touched.add(from)

    return id
  }

  /** Drop relationships of `from` that `keep` says no to. */
  async unrelate(from: string, keep: (rel: Relationship) => boolean): Promise<void> {
    const list = await this.relationships(from)
    this.rels.set(from, list.filter(keep))
    this.touched.add(from)
  }

  /** The first free name `name(1)`, `name(2)`, … in the package. */
  freshName(name: (n: number) => string): string {
    let n = 1

    while (this.has(name(n))) {
      n++
    }

    return name(n)
  }

  /** Write the content types and every relationship part that changed. */
  async flush(): Promise<void> {
    for (const part of this.touched) {
      const list = this.rels.get(part) ?? []
      const path = relsPathOf(part)

      if (!list.length) {
        this.zip.remove(path)
        continue
      }

      const entries = list.map((rel) => `<Relationship Id="${encodeXml(rel.id)}" Type="${encodeXml(rel.type)}" Target="${encodeXml(rel.external ? rel.target : relativeTarget(part || '_', rel.target))}"${rel.external ? ' TargetMode="External"' : ''}/>`)
      this.zip.file(path, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${RELATIONSHIPS}">${entries.join('')}</Relationships>`)
    }

    this.touched.clear()

    if (this.overrides && this.defaults) {
      const defaults = [...this.defaults].map(([extension, type]) => `<Default Extension="${encodeXml(extension)}" ContentType="${encodeXml(type)}"/>`)
      const overrides = [...this.overrides].filter(([path]) => this.has(path)).map(([path, type]) => `<Override PartName="/${encodeXml(path)}" ContentType="${encodeXml(type)}"/>`)
      this.zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="${CONTENT_TYPES}">${defaults.join('')}${overrides.join('')}</Types>`)
    }
  }
}

/** The order of a worksheet's elements (CT_Worksheet). */
export const WORKSHEET_ORDER = ['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter', 'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting', 'dataValidations', 'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst']

/** The order of the workbook's elements (CT_Workbook). */
export const WORKBOOK_ORDER = ['fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews', 'sheets', 'functionGroups', 'externalReferences', 'definedNames', 'calcPr', 'oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing', 'fileRecoveryPr', 'webPublishObjects', 'extLst']

export interface Child {
  /** The element's name with its prefix, as "extLst" or "x14:slicerList". */
  name: string
  /** Where its start tag opens and where its end tag closes (one past it). */
  start: number
  end: number
}

export const localName = (name: string): string => name.slice(name.indexOf(':') + 1)

/** Where the tag opening at `open` ends (its ">"), passing over quoted attribute values; -1 when it does not. */
export function tagEnd(xml: string, open: number): number {
  let quote = ''

  for (let at = open + 1; at < xml.length; at++) {
    const char = xml[at]

    if (quote) {
      quote = char === quote ? '' : quote
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return at
    }
  }

  return -1
}

/**
 * The elements from `from` to the end tag of the element holding them, whole and in order. Nested
 * elements of any name are passed over (an extension list inside a conditional format is not the
 * sheet's own), and a sheetData without reading its cells.
 */
export function childrenFrom(xml: string, from: number): Child[] {
  const children: Child[] = []
  let depth = 0
  let current = { name: '', start: 0 }
  let at = from

  while (at < xml.length) {
    const open = xml.indexOf('<', at)

    if (open < 0) {
      break
    }

    const skip = xml.startsWith('<!--', open) ? '-->' : xml.startsWith('<?', open) ? '?>' : xml.startsWith('<![CDATA[', open) ? ']]>' : ''

    if (skip) {
      const end = xml.indexOf(skip, open)
      at = end < 0 ? xml.length : end + skip.length
      continue
    }

    const end = tagEnd(xml, open)

    if (end < 0) {
      break
    }

    const closing = xml[open + 1] === '/'
    const empty = !closing && xml[end - 1] === '/'

    if (closing) {
      if (depth === 0) {
        break
      }

      depth--

      if (depth === 0) {
        children.push({ ...current, end: end + 1 })
      }
    } else if (depth === 0) {
      const name = /^<([\w:.-]+)/.exec(xml.slice(open, open + 256))?.[1] ?? ''
      current = { name, start: open }

      if (empty) {
        children.push({ ...current, end: end + 1 })
      } else if (localName(name) === 'sheetData') {
        const close = xml.indexOf(`</${name}>`, end)
        const finish = close < 0 ? xml.length : close + name.length + 3
        children.push({ ...current, end: finish })
        at = finish
        continue
      } else {
        depth = 1
      }
    } else if (!empty) {
      depth++
    }

    at = end + 1
  }

  return children
}

/** Where the content of a part's root element starts: just after its start tag. */
export function rootContent(xml: string): number {
  const root = /<(?![?!])[\w:.-]+/.exec(xml)

  return root ? tagEnd(xml, root.index) + 1 : -1
}

/** The children of a part's root element, in order. */
export const childrenOf = (xml: string): Child[] => {
  const start = rootContent(xml)

  return start > 0 ? childrenFrom(xml, start) : []
}

/** The child of a part's root with this local name. */
export const childNamed = (xml: string, name: string): Child | undefined => childrenOf(xml).find((child) => localName(child.name) === name)

/** Put a child into a part's root where `order` has it: before the first child that comes after it, else at the end. */
export function placeChild(xml: string, order: string[], element: string, content: string): string {
  const rank = order.indexOf(element)
  const later = childrenOf(xml).find((child) => order.indexOf(localName(child.name)) > rank)
  const at = later ? later.start : xml.lastIndexOf('</')

  return `${xml.slice(0, at)}${content}${xml.slice(at)}`
}

/** Put a top-level element into a worksheet where CT_Worksheet has it (the caller makes sure there is none already). */
export const placeInWorksheet = (sheetXml: string, element: string, content: string): string => placeChild(sheetXml, WORKSHEET_ORDER, element, content)

/** Put a top-level element into the workbook where CT_Workbook has it (the caller makes sure there is none already). */
export const placeInWorkbook = (workbookXml: string, element: string, content: string): string => placeChild(workbookXml, WORKBOOK_ORDER, element, content)

/** Whether a worksheet or workbook has a top-level element of this name. */
export const hasElement = (xml: string, element: string): boolean => Boolean(childNamed(xml, element))

/** A start tag's namespace declarations and Ignorable list, to carry into a part that takes its children. */
export function rootNamespaces(xml: string, root: string): Record<string, string> {
  const tag = new RegExp(`<(?:[\\w-]+:)?${root}\\b[^>]*>`).exec(xml)?.[0] ?? ''

  return Object.fromEntries(Object.entries(attributesOf(tag)).filter(([name]) => name.startsWith('xmlns') || name === 'mc:Ignorable'))
}
