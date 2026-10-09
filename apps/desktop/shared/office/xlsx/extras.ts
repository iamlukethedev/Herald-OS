import { readCharts } from './charts/index.ts'
import { readComments } from './comments/index.ts'
import { readHeraldPart } from './herald-part.ts'
import type { XlsxPackage } from './package.ts'
import type { Resource } from './rules.ts'

/*
 * What Herald reads from an .xlsx package beside the cells ExcelJS reads: charts, comments and
 * notes, and Herald's own part, as Univer resources and Herald data for each sheet.
 */

export interface ReadContext {
  pkg: XlsxPackage
  /** The workbook's id in Univer. */
  unitId: string
  /** The snapshot id of each of the file's sheets, in the file's order; null where a sheet is not read (chart sheets). */
  ids: (string | null)[]
  /** The sections of Herald's own part, when the file has one Herald saved. */
  herald: Record<string, unknown> | null
  /** What Herald Sheets shows differently or drops, for the fidelity report. */
  notes: Set<string>
}

export interface ReadExtras {
  resources: Resource[]
  /** Herald data for sheets' custom data, by sheet id. */
  sheets: Record<string, Record<string, unknown>>
}

export async function readExtras(pkg: XlsxPackage, options: { unitId: string; ids: (string | null)[]; notes: Set<string> }): Promise<ReadExtras> {
  const herald = await readHeraldPart(pkg)
  const ctx: ReadContext = { pkg, unitId: options.unitId, ids: options.ids, herald, notes: options.notes }
  const resources = [...(await readComments(ctx)), ...(await readCharts(ctx))]
  const sheets: Record<string, Record<string, unknown>> = {}
  const saved = (herald?.sheets ?? {}) as Record<string, Record<string, unknown>>

  options.ids.forEach((id, index) => {
    const data = saved[pkg.sheets[index]?.name ?? '']

    if (id && data && typeof data === 'object') {
      sheets[id] = data
    }
  })

  return { resources, sheets }
}
