import { keepsPivotCache, pivotCacheIdOf } from './keep/pivots.ts'
import { readTable } from './keep/tables.ts'
import { parseRelationships, relsPathOf } from './opc.ts'
import type { XlsxPackage } from './package.ts'

/*
 * What an .xlsx file holds that Herald Sheets drops, found by looking at the package's parts
 * rather than at what ExcelJS happened to read: macros, protection, print settings, form controls,
 * data connections and the rest. What Herald shows or carries into the file it saves (charts,
 * pictures, shapes, pivot tables, slicers, tables, sparklines, chart sheets, links to other
 * workbooks) has no note, but for the kinds fed by a data connection, which go with it. Each note
 * says what happens to the thing, for the fidelity report before the first save.
 */

/** "one chart", "3 charts". */
export function counted(n: number, singular: string, plural = `${singular}s`): string {
  return n === 1 ? `one ${singular}` : `${n.toLocaleString('en-US')} ${plural}`
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

export interface PackageReport {
  notes: string[]
  /** The file has macros (a VBA project), which no saved copy keeps. */
  macros: boolean
}

/** The pivot tables, tables, and slicer and timeline caches fed by a data connection or the data model, which Herald does not keep. */
async function fedFromElsewhere(pkg: XlsxPackage): Promise<{ pivotTables: number; tables: number; slicers: number }> {
  const relationships = async (part: string) => parseRelationships(part, await pkg.read(relsPathOf(part)))
  const worksheets = pkg.sheets.filter((sheet) => sheet.kind === 'worksheet')
  const keptCaches = new Set<string>()
  const keptTables = new Set<string>()
  let pivotTables = 0
  let tables = 0
  let slicers = 0

  for (const sheet of worksheets) {
    for (const rel of sheet.related.filter((entry) => entry.type === 'pivotTable' && !entry.external)) {
      const cache = (await relationships(rel.target)).find((entry) => entry.type.endsWith('/pivotCacheDefinition') && !entry.external)
      const xml = cache ? await pkg.read(cache.target) : undefined
      const id = xml && keepsPivotCache(xml) ? pivotCacheIdOf(xml) : undefined

      if (id) {
        keptCaches.add(id)
      }

      pivotTables += xml && keepsPivotCache(xml) ? 0 : 1
    }

    for (const rel of sheet.related.filter((entry) => entry.type === 'table' && !entry.external)) {
      const table = readTable((await pkg.read(rel.target)) ?? '')

      if (table.type === 'worksheet') {
        keptTables.add(table.id)
      } else {
        tables++
      }
    }
  }

  for (const file of pkg.files.filter((name) => /^xl\/(slicerCaches|timelineCaches)\/[^/]+\.xml$/i.test(name))) {
    const xml = (await pkg.read(file)) ?? ''
    const table = /<(?:[\w.-]+:)?tableSlicerCache\b[^>]*?\stableId="(\d+)"/.exec(xml)?.[1]
    const cache = /\spivotCacheId="(\d+)"/.exec(xml)?.[1]
    slicers += !/<(?:[\w.-]+:)?olap\b/.test(xml) && (table ? keptTables.has(table) : cache !== undefined && keptCaches.has(cache)) ? 0 : 1
  }

  return { pivotTables, tables, slicers }
}

export async function inspectPackage(pkg: XlsxPackage, extension = '.xlsx'): Promise<PackageReport> {
  const notes: string[] = []
  const files = pkg.files
  const count = (pattern: RegExp) => files.filter((file) => pattern.test(file)).length
  const macros = files.some((file) => /(^|\/)vbaProject\.bin$/i.test(file)) || extension === '.xlsm'

  if (macros) {
    notes.push('Macros (VBA) are not kept: Herald Sheets does not run them, and a copy it saves has none.')
  }

  const otherSheets = pkg.sheets.filter((sheet) => sheet.kind === 'dialogsheet' || sheet.kind === 'macrosheet' || sheet.kind === 'other').length

  if (otherSheets) {
    notes.push(`${capital(counted(otherSheets, 'dialog or Excel 4.0 macro sheet'))} ${otherSheets === 1 ? 'is' : 'are'} left out.`)
  }

  const fed = await fedFromElsewhere(pkg)

  if (fed.pivotTables) {
    notes.push(`${capital(counted(fed.pivotTables, 'pivot table'))} fed by a data connection or the data model: ${fed.pivotTables === 1 ? 'its' : 'their'} cells stay as plain values, without the pivot table that made them.`)
  }

  if (fed.tables) {
    notes.push(`${capital(counted(fed.tables, 'table'))} fed by a data connection or an XML map ${fed.tables === 1 ? 'becomes a plain range' : 'become plain ranges'}: data and formatting stay.`)
  }

  if (fed.slicers) {
    notes.push('Slicers and timelines on a data connection or the data model are not kept.')
  }

  const sheetParts = pkg.sheets.map((sheet) => `${sheet.head}${sheet.tail}`).join('\n')

  if (/<(?:\w+:)?(sheetProtection|protectedRange)[\s>]/.test(sheetParts) || /<(?:\w+:)?(workbookProtection|fileSharing)[\s>]/.test(pkg.workbookXml)) {
    notes.push('Protection (locked sheets, structure or a password to open for editing) is not kept: a saved copy is unprotected.')
  }

  if (/<(?:\w+:)?(rowBreaks|colBreaks)[\s>]/.test(sheetParts) || pkg.definedNames.some((name) => /^_xlnm\.(Print_Area|Print_Titles)$/i.test(name.name))) {
    notes.push('Print areas, print titles and page breaks are not kept; page size, orientation, margins, scaling and headers stay.')
  }

  if (/outlineLevel(?:Row|Col)="[1-9]/.test(sheetParts) || /<(?:\w+:)?col\s[^>]*outlineLevel="[1-9]/.test(sheetParts)) {
    notes.push('Grouped rows and columns are shown ungrouped; rows and columns that were collapsed stay hidden.')
  }

  if (count(/^xl\/(ctrlProps|activeX)\//i) || /<(?:\w+:)?controls[\s>]/.test(sheetParts)) {
    notes.push('Form controls (buttons, check boxes, lists) are not kept.')
  }

  // Embedded workbooks that charts show from come along with the charts; objects on sheets do not.
  if (/<(?:\w+:)?oleObjects[\s>]/.test(sheetParts) || pkg.sheets.some((sheet) => sheet.related.some((rel) => rel.type === 'oleObject' || rel.type === 'package'))) {
    notes.push('Embedded objects (other documents inside the workbook) are not kept.')
  }

  if (count(/^xl\/(connections\.xml|queryTables\/)/i) || count(/^xl\/model\//i)) {
    notes.push('Data connections, queries and the data model are not kept; their last results stay as values.')
  }

  if (count(/^xl\/richData\//i)) {
    notes.push('Pictures in cells and linked data types (such as stocks) are shown as plain values.')
  }

  if (/fDynamic="(1|true)"/.test((await pkg.read('xl/metadata.xml')) ?? '')) {
    notes.push('Formulas that spill (dynamic arrays) are saved as fixed-size array formulas.')
  }

  if (/<(?:\w+:)?customSheetViews[\s>]/.test(sheetParts)) {
    notes.push('Custom views are not kept.')
  }

  if (/<(?:\w+:)?scenarios[\s>]/.test(sheetParts)) {
    notes.push('What-if scenarios are not kept.')
  }

  if (count(/^xl\/revisions\//i)) {
    notes.push('The shared workbook’s change history is not kept.')
  }

  if (count(/^_xmlsignatures\//i)) {
    notes.push('The digital signature does not survive saving: a saved copy is unsigned.')
  }

  return { notes, macros }
}
