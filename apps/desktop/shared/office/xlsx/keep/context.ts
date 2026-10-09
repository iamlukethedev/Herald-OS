import type { CellRange } from '../address.ts'
import type { FinishContext, SourcePackage, WrittenSheet } from '../finish.ts'
import type { Relationship } from '../opc.ts'
import type { PackageSheet, XlsxPackage } from '../package.ts'
import { decodeXml, elementsOf, firstElement } from '../xml.ts'
import { SheetNames } from './formulas.ts'
import { PartCopier, type Transform } from './parts.ts'
import { StyleMerger } from './styles.ts'

/*
 * What keeping the source file's parts shares between its steps: the sheets that are still there
 * with what the source holds for them, the copier and the style sheet, what each step kept (later
 * steps keep slicers only for pivot tables kept, anchors only for slicers kept), and what each step
 * adds to the sheets and the workbook, written once at the end.
 */

export interface KeptSheet {
  /** The sheet as written. */
  written: WrittenSheet
  /** The worksheet of the source file it was read from. */
  source: PackageSheet
  /** That worksheet's relationships, their types in full. */
  relationships: Relationship[]
  /** That worksheet's XML without its cells. */
  xml: string
}

export interface DefinedName {
  name: string
  formula: string
  hidden?: boolean
}

export interface ChartSheet {
  name: string
  state: PackageSheet['state']
  /** Its relationship from the workbook. */
  id: string
  /** The written sheet it follows, by name; none to go first. */
  after: string | null
}

/** The source file's sheets by name, with the sheetId each has in a workbook's XML. */
export function sheetIds(workbookXml: string): Map<string, number> {
  return new Map(elementsOf(firstElement(workbookXml, 'sheets')?.inner ?? '', 'sheet').map(({ attributes }) => [(attributes.name ?? '').toLowerCase(), Number(attributes.sheetId)]))
}

const key = (sheet: string, name: string): string => `${sheet.toLowerCase()}\n${name.toLowerCase()}`

export class Keep {
  /** The pivot tables kept, by the source name of their sheet and their own. */
  private readonly pivotTables = new Set<string>()
  /** The ids (x14 pivotCacheId) of the pivot caches kept, which slicers and timelines name, and of those Herald would keep had their pivot tables stayed. */
  readonly pivotCacheIds = new Set<string>()
  readonly keepablePivotCacheIds = new Set<string>()
  /** Each kept pivot cache by its workbook cacheId: its definition in the source, and where it went. */
  readonly pivotCaches = new Map<string, { source: string; target: string }>()
  /** The tables kept, by id, with their names, and their ranges on each written sheet. */
  readonly tables = new Map<string, string[]>()
  readonly tableRanges = new Map<string, CellRange[]>()
  /** The slicer and timeline caches kept, by name. */
  readonly caches = new Set<string>()
  /** The slicers and timelines kept on each written sheet ("slicer:Region", "timeline:Date"), for their anchors. */
  readonly slicers = new Map<string, Set<string>>()
  readonly sheetAdditions = new Map<string, { elements: Map<string, string>; extensions: string[] }>()
  readonly workbookAdditions = { externals: [] as string[], extensions: [] as string[], names: [] as DefinedName[], chartSheets: [] as ChartSheet[] }

  private constructor(
    readonly ctx: FinishContext,
    readonly pkg: XlsxPackage,
    readonly copier: PartCopier,
    readonly styles: StyleMerger,
    readonly sheets: KeptSheet[],
    readonly names: SheetNames,
    /** The written workbook part, and its XML as ExcelJS and the steps before this one left it. */
    readonly workbookPath: string,
    readonly workbookXml: string,
    /** The relationships of the source's workbook part. */
    readonly sourceRelationships: Relationship[]
  ) {}

  static async open(ctx: FinishContext, source: SourcePackage, transform: (keep: Keep, xml: string, path: string, contentType: string) => ReturnType<Transform>): Promise<Keep> {
    const { pkg } = source
    let keep: Keep | null = null
    const copier = new PartCopier(pkg, ctx.writer, (xml, path, contentType) => (keep ? transform(keep, xml, path, contentType) : xml))
    const sourceWorkbookPath = (await copier.relationships('')).find((rel) => rel.type.endsWith('/officeDocument'))?.target ?? 'xl/workbook.xml'
    const workbookPath = (await ctx.writer.relationships('')).find((rel) => rel.type.endsWith('/officeDocument'))?.target ?? 'xl/workbook.xml'
    const sheets: KeptSheet[] = []

    for (const written of ctx.sheets) {
      const sheet = source.sheetOf(written.id)

      if (sheet) {
        sheets.push({ written, source: sheet, relationships: await copier.relationships(sheet.path), xml: `${sheet.head}<sheetData/>${sheet.tail.replace(/^<\/sheetData>/, '')}` })
      }
    }

    const names = new SheetNames(
      sheets.map((sheet) => ({ from: sheet.source.name, to: sheet.written.name })),
      ctx.sheets.map((sheet) => sheet.name)
    )
    const styles = new StyleMerger(pkg.stylesXml)
    const stylesPath = (await ctx.writer.relationships(workbookPath)).find((rel) => rel.type.endsWith('/styles'))?.target

    if (stylesPath) {
      await styles.load(ctx.writer, stylesPath)
    }

    keep = new Keep(ctx, pkg, copier, styles, sheets, names, workbookPath, (await ctx.writer.text(workbookPath)) ?? '', await copier.relationships(sourceWorkbookPath))

    return keep
  }

  /** The defined names of the written workbook (those of the whole workbook, or of every scope), by name in lower case, with their formulas. */
  writtenNames(scopes: 'workbook' | 'all' = 'workbook'): Map<string, string> {
    return new Map(
      elementsOf(firstElement(this.workbookXml, 'definedNames')?.inner ?? '', 'definedName')
        .filter(({ attributes }) => scopes === 'all' || attributes.localSheetId === undefined)
        .map(({ attributes, inner }) => [(attributes.name ?? '').toLowerCase(), decodeXml(inner)])
    )
  }

  /** The written sheet a source worksheet became, by the name the source gave it. */
  sheetFor(sourceName: string): KeptSheet | undefined {
    return this.sheets.find((sheet) => sheet.source.name.toLowerCase() === sourceName.toLowerCase())
  }

  keepPivotTable(sheet: KeptSheet, name: string): void {
    this.pivotTables.add(key(sheet.source.name, name))
  }

  /** Whether a pivot table of the source was kept, by its sheet's source name and its own. */
  hasPivotTable(sheetName: string, name: string): boolean {
    return this.pivotTables.has(key(sheetName, name))
  }

  /** Whether a table was kept, by its name (or display name). */
  hasTable(name: string): boolean {
    return [...this.tables.values()].some((names) => names.some((entry) => entry.toLowerCase() === name.toLowerCase()))
  }

  /** A top-level element a written sheet gets (its tableParts, its picture), put where the schema has it at the end. */
  addToSheet(sheet: KeptSheet, element: string, xml: string): void {
    this.additionsOf(sheet).elements.set(element, xml)
  }

  /** An extension a written sheet's extension list gets. */
  extendSheet(sheet: KeptSheet, extension: string): void {
    this.additionsOf(sheet).extensions.push(extension)
  }

  private additionsOf(sheet: KeptSheet): { elements: Map<string, string>; extensions: string[] } {
    let additions = this.sheetAdditions.get(sheet.written.id)

    if (!additions) {
      additions = { elements: new Map(), extensions: [] }
      this.sheetAdditions.set(sheet.written.id, additions)
    }

    return additions
  }

  /** A defined name kept parts need (a slicer cache's, the ranges of a newer chart), added when the written workbook lacks it. */
  needName(name: DefinedName): void {
    if (!this.writtenNames().has(name.name.toLowerCase()) && !this.workbookAdditions.names.some((entry) => entry.name.toLowerCase() === name.name.toLowerCase())) {
      this.workbookAdditions.names.push(name)
    }
  }

  loss(text: string): void {
    this.ctx.losses.add(text)
  }
}
