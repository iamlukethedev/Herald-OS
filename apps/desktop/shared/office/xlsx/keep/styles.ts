import type { PackageWriter } from '../opc.ts'
import { elementsOf, encodeXml } from '../xml.ts'
import { childNamed, grown, placeChild, STYLESHEET_ORDER, withAttribute } from './markup.ts'

/*
 * What kept parts name in the style sheet: number formats by id (pivot fields), differential formats
 * by index (pivot table formats, table areas) and table styles by name. Herald writes a style sheet
 * of its own, so each one a kept part uses is added to it and the part is given its new id.
 */

const BUILT_IN_TABLE_STYLE = /^(?:Table|Pivot)Style(?:Light|Medium|Dark)\d+$/
const FIRST_CUSTOM_FORMAT = 164

interface StyleSheet {
  formats: Map<number, string>
  dxfs: string[]
  tableStyles: Map<string, string>
}

function readStyleSheet(xml: string | undefined): StyleSheet {
  const element = (name: string) => {
    const child = xml ? childNamed(xml, name) : undefined

    return child && xml ? xml.slice(child.start, child.end) : ''
  }

  return {
    formats: new Map(elementsOf(element('numFmts'), 'numFmt').map(({ attributes }) => [Number(attributes.numFmtId), attributes.formatCode ?? ''])),
    dxfs: elementsOf(element('dxfs'), 'dxf').map((dxf) => dxf.outer),
    tableStyles: new Map(elementsOf(element('tableStyles'), 'tableStyle').map((style) => [style.attributes.name ?? '', style.outer]))
  }
}

export class StyleMerger {
  private readonly source: StyleSheet
  private written: StyleSheet = { formats: new Map(), dxfs: [], tableStyles: new Map() }
  private path = ''
  private readonly formatIds = new Map<string, number>()
  private readonly dxfIds = new Map<number, number>()
  private readonly added = { numFmts: [] as string[], dxfs: [] as string[], tableStyles: [] as string[] }

  constructor(sourceXml: string | undefined) {
    this.source = readStyleSheet(sourceXml)
  }

  /** Read the style sheet of the package being finished. */
  async load(writer: PackageWriter, path: string): Promise<void> {
    this.path = path
    this.written = readStyleSheet(await writer.text(path))
    this.written.formats.forEach((code, id) => this.formatIds.set(code, id))
  }

  /** A number format id of the source file as the written file has it (built-in ids stay; one the source does not define becomes General). */
  numFmt(id: number): number {
    if (id < FIRST_CUSTOM_FORMAT) {
      return id
    }

    const code = this.source.formats.get(id)

    if (code === undefined) {
      return 0
    }

    let now = this.formatIds.get(code)

    if (now === undefined) {
      now = Math.max(FIRST_CUSTOM_FORMAT - 1, ...this.formatIds.values()) + 1
      this.formatIds.set(code, now)
      this.added.numFmts.push(`<numFmt numFmtId="${now}" formatCode="${encodeXml(code)}"/>`)
    }

    return now
  }

  /** A differential format of the source file as the written file has it; null when the source has none at that index. */
  dxf(id: number): number | null {
    const dxf = this.source.dxfs[id]

    if (dxf === undefined) {
      return null
    }

    let now = this.dxfIds.get(id)

    if (now === undefined) {
      now = this.written.dxfs.length + this.added.dxfs.length
      this.dxfIds.set(id, now)
      this.added.dxfs.push(dxf)
    }

    return now
  }

  /** Whether the written file has a table or pivot table style of this name: a built-in one, or the source file's own, added. */
  tableStyle(name: string): boolean {
    if (BUILT_IN_TABLE_STYLE.test(name) || this.written.tableStyles.has(name)) {
      return true
    }

    const style = this.source.tableStyles.get(name)

    if (!style) {
      return false
    }

    this.written.tableStyles.set(name, style)
    this.added.tableStyles.push(this.withStyleIds(style))

    return true
  }

  /** XML with the number format and differential format ids the source gave it changed to the written file's; a differential format the source lacks is dropped. */
  withStyleIds(xml: string): string {
    return xml
      .replace(/\s((?:\w*Dxf|dxf)Id)="(\d+)"/g, (_whole, name: string, id: string) => {
        const now = this.dxf(Number(id))

        return now === null ? '' : ` ${name}="${now}"`
      })
      .replace(/\snumFmtId="(\d+)"/g, (_whole, id: string) => ` numFmtId="${this.numFmt(Number(id))}"`)
  }

  /** Write the formats and styles kept parts brought into the style sheet. */
  async flush(writer: PackageWriter): Promise<void> {
    let xml = this.path ? await writer.text(this.path) : undefined

    if (!xml) {
      return
    }

    const totals = { numFmts: this.written.formats.size + this.added.numFmts.length, dxfs: this.written.dxfs.length + this.added.dxfs.length, tableStyles: this.written.tableStyles.size }
    let changed = false

    for (const name of ['numFmts', 'dxfs', 'tableStyles'] as const) {
      const entries = this.added[name].join('')

      if (!entries) {
        continue
      }

      const child = childNamed(xml, name)
      const count = (element: string) => element.replace(/^<[^>]*>/, (tag) => withAttribute(tag, 'count', String(totals[name])))
      xml = child ? `${xml.slice(0, child.start)}${count(grown(xml.slice(child.start, child.end), entries))}${xml.slice(child.end)}` : placeChild(xml, STYLESHEET_ORDER, name, `<${name} count="${totals[name]}">${entries}</${name}>`)
      changed = true
    }

    if (changed) {
      await writer.put(this.path, xml)
    }
  }
}
