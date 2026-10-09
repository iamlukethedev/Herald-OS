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
const WORKSHEET_ORDER = ['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter', 'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting', 'dataValidations', 'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst']

/** The order of the workbook's elements (CT_Workbook). */
const WORKBOOK_ORDER = ['fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews', 'sheets', 'functionGroups', 'externalReferences', 'definedNames', 'calcPr', 'oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing', 'fileRecoveryPr', 'webPublishObjects', 'extLst']

/** Where a top-level element of this name starts, or -1; the search stops at the extension list, whose children reuse names. */
function startOf(xml: string, name: string): number {
  const ext = name === 'extLst' ? -1 : xml.search(/<extLst[\s>]/)

  return (ext >= 0 ? xml.slice(0, ext) : xml).search(new RegExp(`<${name}[\\s/>]`))
}

function place(xml: string, order: string[], root: string, element: string, content: string): string {
  const after = order.slice(order.indexOf(element) + 1)
  const positions = after.map((name) => startOf(xml, name)).filter((index) => index >= 0)
  const position = positions.length ? Math.min(...positions) : xml.lastIndexOf(`</${root}>`)

  return `${xml.slice(0, position)}${content}${xml.slice(position)}`
}

/** Put a top-level element into a worksheet where CT_Worksheet has it (the caller makes sure there is none already). */
export const placeInWorksheet = (sheetXml: string, element: string, content: string): string => place(sheetXml, WORKSHEET_ORDER, 'worksheet', element, content)

/** Put a top-level element into the workbook where CT_Workbook has it (the caller makes sure there is none already). */
export const placeInWorkbook = (workbookXml: string, element: string, content: string): string => place(workbookXml, WORKBOOK_ORDER, 'workbook', element, content)

/** Whether a worksheet or workbook has a top-level element of this name. */
export const hasElement = (xml: string, element: string): boolean => startOf(xml, element) >= 0

/** A start tag's namespace declarations and Ignorable list, to carry into a part that takes its children. */
export function rootNamespaces(xml: string, root: string): Record<string, string> {
  const tag = new RegExp(`<(?:[\\w-]+:)?${root}\\b[^>]*>`).exec(xml)?.[0] ?? ''

  return Object.fromEntries(Object.entries(attributesOf(tag)).filter(([name]) => name.startsWith('xmlns') || name === 'mc:Ignorable'))
}
