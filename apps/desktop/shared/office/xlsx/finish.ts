import type JSZip from 'jszip'
import type { WorkbookSnapshot } from '../workbook.ts'
import { finishCharts } from './charts/index.ts'
import { finishComments } from './comments/index.ts'
import { writeHeraldPart } from './herald-part.ts'
import { finishKept } from './keep/index.ts'
import { CONTENT_TYPE, hasElement, PackageWriter, placeInWorksheet, REL } from './opc.ts'
import { openPackage, type PackageSheet, type XlsxPackage } from './package.ts'

/*
 * What Herald writes into an .xlsx package after ExcelJS: charts, comments and notes, the parts of
 * the file the workbook was opened from that Herald does not model (kept as they were where that is
 * safe), the Herald data of each sheet, and Herald's own part for what only Herald reads back. Each
 * feature adds to one context. A sheet has one drawing part, so the anchors features give a sheet
 * (charts, kept pictures and shapes) are written into it together at the end.
 */

export interface WrittenSheet {
  /** The sheet's id in the snapshot. */
  id: string
  /** Its name in the file. */
  name: string
  /** Its worksheet part, as "xl/worksheets/sheet1.xml". */
  path: string
}

/** The file a workbook was opened from. */
export interface SourcePackage {
  pkg: XlsxPackage
  /** The worksheet of the file a snapshot sheet was read from; none for a sheet added since. */
  sheetOf: (id: string) => PackageSheet | undefined
}

export interface FinishContext {
  workbook: WorkbookSnapshot
  writer: PackageWriter
  /** The sheets as written, in the workbook's order. */
  sheets: WrittenSheet[]
  source: SourcePackage | null
  /** What the file cannot keep of this workbook. */
  losses: Set<string>
  drawings: DrawingBuilder
  /** Sections of Herald's own part, by feature. */
  herald: Record<string, unknown>
}

export interface DrawingAnchor {
  /**
   * One anchor of a drawing part (an xdr:twoCellAnchor, xdr:oneCellAnchor or xdr:absoluteAnchor,
   * or an mc:AlternateContent holding one), with `{{rel:N}}` where it names its Nth relationship
   * and `{{id}}` where it needs a shape id of its own (each `{{id}}` gets a new one).
   */
  xml: string
  relationships: { type: string; target: string; external?: boolean }[]
  /** Namespace declarations (and mc:Ignorable) the anchor needs on the drawing's root. */
  namespaces?: Record<string, string>
  /** Its place in the source file's drawing, which keeps what is in front in front; new anchors go on top. */
  order?: number
}

const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** The drawing anchors each sheet gets, written as one drawing part per sheet. */
export class DrawingBuilder {
  private readonly anchors = new Map<string, DrawingAnchor[]>()

  add(sheetId: string, anchor: DrawingAnchor): void {
    this.anchors.set(sheetId, [...(this.anchors.get(sheetId) ?? []), anchor])
  }

  /** A sheet's anchors, back to front. */
  of(sheetId: string): readonly DrawingAnchor[] {
    return [...(this.anchors.get(sheetId) ?? [])].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
  }

  async write(ctx: Pick<FinishContext, 'writer' | 'sheets'>): Promise<void> {
    for (const sheet of ctx.sheets) {
      const anchors = this.of(sheet.id)
      const sheetXml = anchors.length ? await ctx.writer.text(sheet.path) : undefined

      if (!sheetXml || hasElement(sheetXml, 'drawing')) {
        continue
      }

      const path = ctx.writer.freshName((n) => `xl/drawings/drawing${n}.xml`)
      // Shape ids an anchor brings stay as they are (connectors name shapes by them); new ones come after the highest.
      let next = Math.max(0, ...anchors.flatMap((anchor) => [...anchor.xml.matchAll(/<(?:\w+:)?cNvPr\b[^>]*?\sid="(\d+)"/g)].map((match) => Number(match[1])))) + 1
      const body: string[] = []
      const namespaces: Record<string, string> = { 'xmlns:xdr': XDR, 'xmlns:a': A, 'xmlns:r': R }
      const ignorable = new Set<string>()

      for (const anchor of anchors) {
        const ids: string[] = []

        for (const rel of anchor.relationships) {
          ids.push(await ctx.writer.relate(path, rel.type, rel.target, { external: rel.external }))
        }

        body.push(anchor.xml.replace(/\{\{rel:(\d+)\}\}/g, (_whole, n: string) => ids[Number(n)] ?? '').replace(/\{\{id\}\}/g, () => String(next++)))

        for (const [name, value] of Object.entries(anchor.namespaces ?? {})) {
          if (name === 'mc:Ignorable') {
            value.split(/\s+/).filter(Boolean).forEach((prefix) => ignorable.add(prefix))
          } else if (!(name in namespaces)) {
            namespaces[name] = value
          }
        }
      }

      const declared = [...ignorable].filter((prefix) => `xmlns:${prefix}` in namespaces)
      const attributes = [...Object.entries(namespaces).map(([name, value]) => `${name}="${value}"`), ...(declared.length ? [`mc:Ignorable="${declared.join(' ')}"`] : [])]

      if (declared.length && !('xmlns:mc' in namespaces)) {
        attributes.push('xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"')
      }

      await ctx.writer.put(path, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr ${attributes.join(' ')}>${body.join('')}</xdr:wsDr>`, CONTENT_TYPE.drawing)
      const id = await ctx.writer.relate(sheet.path, REL.drawing, path)
      await ctx.writer.put(sheet.path, placeInWorksheet(withRelationshipNamespace(sheetXml), 'drawing', `<drawing r:id="${id}"/>`))
    }
  }
}

/** A worksheet whose root declares the `r:` prefix its relationship ids use. */
export function withRelationshipNamespace(sheetXml: string): string {
  return /<worksheet\b[^>]*\sxmlns:r=/.test(sheetXml) ? sheetXml : sheetXml.replace(/<worksheet\b/, `<worksheet xmlns:r="${R}"`)
}

/** The file a workbook was read from, when its bytes still open as a package. */
async function openSource(bytes: Uint8Array): Promise<SourcePackage | null> {
  try {
    const pkg = await openPackage(bytes)

    return {
      pkg,
      sheetOf: (id) => {
        // Reading names each worksheet by its place in the file.
        const index = Number(/^sheet-(\d+)$/.exec(id)?.[1] ?? 0) - 1
        const sheet = pkg.sheets[index]

        return sheet?.kind === 'worksheet' ? sheet : undefined
      }
    }
  } catch {
    return null
  }
}

/** Herald data of each sheet (its custom data but what the file holds itself), by the sheet's name in the file. */
function sheetData(workbook: WorkbookSnapshot, sheets: WrittenSheet[]): Record<string, unknown> {
  const data: Record<string, unknown> = {}

  for (const sheet of sheets) {
    const { page: _page, ...rest } = ((workbook.sheets[sheet.id]?.custom as { herald?: Record<string, unknown> } | undefined)?.herald ?? {}) as Record<string, unknown>

    if (Object.keys(rest).length) {
      data[sheet.name] = rest
    }
  }

  return data
}

/** Write what ExcelJS left out into the package it wrote. */
export async function finishPackage(zip: JSZip, workbook: WorkbookSnapshot, sheets: WrittenSheet[], options: { original?: Uint8Array; losses: Set<string> }): Promise<void> {
  const writer = new PackageWriter(zip)
  const source = options.original ? await openSource(options.original) : null
  const ctx: FinishContext = { workbook, writer, sheets, source, losses: options.losses, drawings: new DrawingBuilder(), herald: { sheets: sheetData(workbook, sheets) } }
  await finishComments(ctx)
  await finishCharts(ctx)
  await finishKept(ctx)
  await ctx.drawings.write(ctx)
  await writeHeraldPart(writer, ctx.herald)
  await writer.flush()
}
