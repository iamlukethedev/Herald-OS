import { CELL_TYPE, type CellMatrix, type CellSnapshot, newSheet, newWorkbook, type SheetSnapshot, type WorkbookSnapshot } from '../../../../../shared/office/workbook.ts'
import { withHeadlessSheets } from '../headless.ts'
import { type SheetsTarget, settled } from '../model.ts'

/* Workbooks the data tools' tests work on, made here: made-up sales, and text as people paste it. */

export type Value = string | number | boolean | null

/** A value as Univer's cell: text, a number, true or false, a formula for text starting with "=". */
export function cellOf(value: Value, style?: string): CellSnapshot | null {
  if (value === null) {
    return null
  }

  const s = style ? { s: style } : {}

  if (typeof value === 'number') {
    return { v: value, t: CELL_TYPE.number, ...s }
  }

  if (typeof value === 'boolean') {
    return { v: value ? 1 : 0, t: CELL_TYPE.boolean, ...s }
  }

  return value.startsWith('=') ? { f: value, ...s } : { v: value, t: CELL_TYPE.string, ...s }
}

/** Rows of values as a sheet's cells from its first cell, with a style id for some columns. */
export function matrixOf(rows: Value[][], styles: Record<number, string> = {}, from = { row: 0, column: 0 }): CellMatrix {
  const matrix: CellMatrix = {}

  rows.forEach((row, r) =>
    row.forEach((value, c) => {
      const cell = cellOf(value, r > 0 ? styles[c] : undefined)

      if (cell) {
        matrix[from.row + r] = { ...matrix[from.row + r], [from.column + c]: cell }
      }
    })
  )

  return matrix
}

export const SALES_HEADERS = ['Region', 'Product', 'Quarter', 'Amount']

/** Made-up sales: a region typed in lower case, one left empty, and a product whose name has an asterisk. */
export const SALES: Value[][] = [
  ['East', 'Apples', 'Q1', 120],
  ['West', 'Pears', 'Q1', 80],
  ['East', 'Pears', 'Q2', 45.5],
  ['North', 'Apples', 'Q2', 200],
  ['west', 'Apples', 'Q1', 60],
  [null, 'Pears', 'Q2', 30],
  ['East', 'Mixed*', 'Q1', 15],
  ['North', 'Pears', 'Q1', 75],
  ['West', 'Apples', 'Q2', 90],
  ['East', 'Apples', 'Q2', 110]
]

/** A workbook with the sales on "Sales" (Amount as #,##0.00) and an empty "Notes" sheet. */
export function salesBook(rows: Value[][] = SALES, sheets: SheetSnapshot[] = []): WorkbookSnapshot {
  const sales = newSheet('sales', 'Sales', matrixOf([SALES_HEADERS, ...rows], { 3: 'money' }), { rows: rows.length + 1, columns: 4 })

  return { ...newWorkbook('book', 'Sales', [sales, newSheet('notes', 'Notes'), ...sheets]), styles: { money: { n: { pattern: '#,##0.00' } } } }
}

/** JSON with object keys in order, so equal snapshots compare equal however Univer orders their keys. */
export const stable = (value: unknown): string => JSON.stringify(value, (_key, entry) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry))

/**
 * Run `change` on a workbook headlessly, its formulas worked out first; give back what it returned,
 * the workbook after it, whether it changed nothing, and whether one undo put it back.
 */
export async function changeAndUndo<T>(book: WorkbookSnapshot, change: (target: SheetsTarget) => Promise<T>) {
  const { result } = await withHeadlessSheets(book, async ({ univer, workbook }) => {
    await settled({ univer, workbook })
    const before = workbook.save()
    const value = await change({ univer, workbook })
    await settled({ univer, workbook })
    const after = workbook.save()
    const unchanged = stable(after.sheets) === stable(before.sheets) && stable(after.sheetOrder) === stable(before.sheetOrder)

    if (!unchanged) {
      workbook.undo()
      await settled({ univer, workbook })
    }

    const undone = workbook.save()

    return { value, after, unchanged, undone: stable(undone.sheets) === stable(before.sheets) && stable(undone.sheetOrder) === stable(before.sheetOrder) }
  })

  return result
}
