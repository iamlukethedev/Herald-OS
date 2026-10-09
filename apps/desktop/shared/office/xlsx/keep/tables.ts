import type { CellSnapshot } from '../../workbook.ts'
import { type CellRange, parseRange } from '../address.ts'
import { REL } from '../opc.ts'
import { readResource, RESOURCES, type UAutoFilter } from '../rules.ts'
import { attributesOf, elementsOf } from '../xml.ts'
import type { Keep, KeptSheet } from './context.ts'
import { withoutAttributes } from './markup.ts'
import { type Refusal, refused } from './parts.ts'

/*
 * Tables (ListObjects) on the sheets that are still there. Excel repairs a file whose table header
 * cells differ from its column names, or whose tables overlap a filter or merged cells, so a table
 * is kept only when none of that is so; otherwise its cells stay a plain range, which is reported.
 * Tables fed by a data connection or an XML map go with those (the fidelity report names them).
 */

export interface SourceTable {
  id: string
  name: string
  displayName: string
  ref: string
  headerRows: number
  columns: string[]
  /** "worksheet", or "queryTable" and "xml" for tables fed from elsewhere. */
  type: string
}

/** A table part's id, names, range and columns. */
export function readTable(xml: string): SourceTable {
  const root = attributesOf(/<(?:\w+:)?table\b[^>]*>/.exec(xml)?.[0] ?? '')

  return {
    id: root.id ?? '',
    name: root.name ?? root.displayName ?? '',
    displayName: root.displayName ?? root.name ?? '',
    ref: root.ref ?? '',
    headerRows: root.headerRowCount === undefined ? 1 : Number(root.headerRowCount),
    columns: elementsOf(xml, 'tableColumn').map(({ attributes }) => attributes.name ?? ''),
    type: root.tableType ?? 'worksheet'
  }
}

/** Text as a file escapes it (`_x000A_`), read back. */
const unescaped = (text: string): string => text.replace(/_x([0-9A-Fa-f]{4})_/g, (_whole, code: string) => String.fromCharCode(parseInt(code, 16)))

/** The text a cell holds, when it holds text (a table's header cells hold no formulas). */
function textOf(cell: CellSnapshot | undefined): string | null {
  if (cell?.f || typeof cell?.si === 'string') {
    return null
  }

  if (typeof cell?.v === 'string') {
    return cell.v
  }

  const stream = (cell?.p as { body?: { dataStream?: string } } | undefined)?.body?.dataStream

  return stream ? stream.replace(/\r?\n$/, '').replace(/\r\n?/g, '\n') : null
}

const overlaps = (a: CellRange, b: CellRange): boolean => a.startRow <= b.endRow && b.startRow <= a.endRow && a.startColumn <= b.endColumn && b.startColumn <= a.endColumn

/** What Herald writes on a sheet that a kept table or pivot table may not overlap: its filter, merged cells (unless asked to let them be), the tables kept. */
export function overlapping(keep: Keep, sheet: KeptSheet, range: CellRange, options: { merges: boolean }): string | null {
  const snapshot = keep.ctx.workbook.sheets[sheet.written.id]
  const filter = readResource<Record<string, UAutoFilter>>(keep.ctx.workbook.resources, RESOURCES.filter)?.[sheet.written.id]?.ref

  if (filter && overlaps(filter, range)) {
    return 'a filter overlaps it'
  }

  if (options.merges && ((snapshot?.mergeData ?? []) as CellRange[]).some((merge) => overlaps(merge, range))) {
    return 'merged cells overlap it'
  }

  return (keep.tableRanges.get(sheet.written.id) ?? []).some((table) => overlaps(table, range)) ? 'a table overlaps it' : null
}

/** Why a table cannot be kept on its sheet as Herald writes it; null when it can. */
function whyNot(keep: Keep, sheet: KeptSheet, table: SourceTable, range: CellRange): string | null {
  const snapshot = keep.ctx.workbook.sheets[sheet.written.id]

  if (table.headerRows > 0) {
    const headers = Array.from({ length: range.endColumn - range.startColumn + 1 }, (_, n) => textOf(snapshot?.cellData?.[range.startRow]?.[range.startColumn + n]))

    if (headers.length !== table.columns.length || headers.some((text, n) => text === null || unescaped(text) !== unescaped(table.columns[n]))) {
      return 'its headers changed'
    }
  }

  const overlap = overlapping(keep, sheet, range, { merges: true })

  if (overlap) {
    return overlap
  }

  if (keep.writtenNames().has(table.name.toLowerCase()) || keep.writtenNames().has(table.displayName.toLowerCase())) {
    return 'a defined name has its name'
  }

  return null
}

/** A table part as the written file has it: its formats in the written style sheet, and no style the file lacks. */
export function tablePart(keep: Keep, xml: string): string | Refusal {
  if (readTable(xml).type !== 'worksheet') {
    return refused('unsupported')
  }

  return keep.styles.withStyleIds(xml).replace(/<(?:\w+:)?tableStyleInfo\b[^>]*>/, (tag) => {
    const name = attributesOf(tag).name

    return name && !keep.styles.tableStyle(name) ? withoutAttributes(tag, /^name$/) : tag
  })
}

/** Keep the tables of each sheet that is still there, as far as Excel can take them. */
export async function keepTables(keep: Keep): Promise<void> {
  for (const sheet of keep.sheets) {
    const parts: string[] = []

    for (const rel of sheet.relationships.filter((entry) => entry.type === REL.table && !entry.external)) {
      const xml = await keep.pkg.read(rel.target)
      const table = xml ? readTable(xml) : null
      const range = table ? parseRange(table.ref) : null

      if (!table || !range || table.type !== 'worksheet') {
        continue
      }

      const reason = whyNot(keep, sheet, table, range)
      const target = reason ? null : await keep.copier.copy(rel.target)

      if (!target) {
        keep.loss(`The table ${table.displayName} on ${sheet.written.name} becomes a plain range${reason ? `: ${reason}` : ''}.`)
        continue
      }

      keep.tables.set(table.id, [table.name, table.displayName])
      keep.tableRanges.set(sheet.written.id, [...(keep.tableRanges.get(sheet.written.id) ?? []), range])
      parts.push(`<tablePart r:id="${await keep.ctx.writer.relate(sheet.written.path, REL.table, target)}"/>`)
    }

    if (parts.length) {
      keep.addToSheet(sheet, 'tableParts', `<tableParts count="${parts.length}">${parts.join('')}</tableParts>`)
    }
  }
}
