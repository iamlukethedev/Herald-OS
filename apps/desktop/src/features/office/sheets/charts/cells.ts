import type { ICellData, Nullable } from '@univerjs/core'
import type { FWorkbook, FWorksheet } from '@univerjs/sheets/facade'
import type { ChartRange } from '../../../../../shared/office/charts.ts'
import { isHexColor, parseHex, toHex } from '../../../../../shared/theme.ts'
import { CELL_TYPE, type CellSnapshot, hasContent, plainTextOf } from '../../../../../shared/office/workbook.ts'
import type { CellRange } from '../../../../../shared/office/xlsx/address.ts'
import type { CellGrid, ChartCell } from './data.ts'
import { OFFICE_ACCENTS } from './option.ts'

/* What charts read from a workbook, live or loaded with nothing drawn: their cells, the table around a cell, and the theme's colours. */

/** The most cells a chart reads along one range. */
export const MAX_POINTS = 10000

function valueOf(cell: Nullable<ICellData>): ChartCell['v'] {
  if (!cell) {
    return null
  }

  if (cell.t === CELL_TYPE.boolean) {
    return cell.v === 1 || cell.v === true || String(cell.v).toUpperCase() === 'TRUE'
  }

  if (cell.v === undefined || cell.v === null || cell.v === '') {
    return cell.p ? plainTextOf(cell as CellSnapshot) || null : null
  }

  if (typeof cell.v === 'string' && cell.t === CELL_TYPE.number && cell.v.trim() && Number.isFinite(Number(cell.v))) {
    return Number(cell.v)
  }

  return typeof cell.v === 'number' || typeof cell.v === 'boolean' ? cell.v : String(cell.v)
}

/** Cells of a sheet as a chart reads them, at most `MAX_POINTS` along each side. */
export function readCells(sheet: FWorksheet, range: CellRange): CellGrid {
  // Cells past the sheet's last row and column with anything in them are empty: they are not read.
  const endRow = Math.min(range.endRow, sheet.getMaxRows() - 1, sheet.getLastRow(), range.startRow + MAX_POINTS - 1)
  const endColumn = Math.min(range.endColumn, sheet.getMaxColumns() - 1, sheet.getLastColumn(), range.startColumn + MAX_POINTS - 1)

  if (endRow < range.startRow || endColumn < range.startColumn) {
    return []
  }

  const cells = sheet.getRange(range.startRow, range.startColumn, endRow - range.startRow + 1, endColumn - range.startColumn + 1)
  const texts = cells.getDisplayValues()
  const formats = cells.getNumberFormats()
  const model = sheet.getSheet()

  return cells.getCellDatas().map((row, r) =>
    row.map((data, c) => {
      const format = formats[r]?.[c]
      const hidden = !model.getRowVisible(range.startRow + r) || !model.getColVisible(range.startColumn + c)

      return { v: valueOf(data), text: texts[r]?.[c] ?? '', ...(format && format !== 'General' ? { format } : {}), ...(hidden ? { hidden: true } : {}) }
    })
  )
}

/** A chart range's cells; null when its sheet is gone. */
export function readGrid(workbook: FWorkbook, range: ChartRange): CellGrid | null {
  const sheet = workbook.getSheetBySheetId(range.sheet)

  return sheet ? readCells(sheet, range) : null
}

/** The table around a cell: the block of filled cells it is in or beside, as Excel finds it; null when nothing is near. */
export function regionAround(sheet: FWorksheet, row: number, column: number): CellRange | null {
  const model = sheet.getSheet()
  const lastRow = sheet.getLastRow()
  const lastColumn = sheet.getLastColumn()
  const filled = (r: number, c: number) => r >= 0 && c >= 0 && r <= lastRow && c <= lastColumn && hasContent(model.getCellRaw(r, c) as CellSnapshot | undefined)
  const anyIn = (rows: [number, number], columns: [number, number]) => {
    for (let r = rows[0]; r <= rows[1]; r++) {
      for (let c = columns[0]; c <= columns[1]; c++) {
        if (filled(r, c)) {
          return true
        }
      }
    }

    return false
  }
  const box = { startRow: row, endRow: row, startColumn: column, endColumn: column }

  if (!anyIn([row - 1, row + 1], [column - 1, column + 1])) {
    return null
  }

  for (let grown = true; grown; ) {
    grown = false
    const wide: [number, number] = [box.startColumn - 1, box.endColumn + 1]
    const tall: [number, number] = [box.startRow - 1, box.endRow + 1]

    if (box.startRow > 0 && anyIn([box.startRow - 1, box.startRow - 1], wide)) {
      box.startRow--
      grown = true
    }

    if (box.endRow < lastRow && anyIn([box.endRow + 1, box.endRow + 1], wide)) {
      box.endRow++
      grown = true
    }

    if (box.startColumn > 0 && anyIn(tall, [box.startColumn - 1, box.startColumn - 1])) {
      box.startColumn--
      grown = true
    }

    if (box.endColumn < lastColumn && anyIn(tall, [box.endColumn + 1, box.endColumn + 1])) {
      box.endColumn++
      grown = true
    }
  }

  return box
}

/** "#rrggbb" for a colour written any way `isHexColor` takes. */
export const hexOf = (color: string): string => toHex(parseHex(color)!)

/** The colours a new chart takes: the accents of the theme of the file the workbook came from, or Excel's own. */
export function workbookPalette(workbook: FWorkbook): string[] {
  const accents = (workbook.getCustomMetadata() as { herald?: { theme?: { accents?: unknown } } } | undefined)?.herald?.theme?.accents

  return Array.isArray(accents) && accents.length > 0 && accents.every(isHexColor) ? accents.map(hexOf) : [...OFFICE_ACCENTS]
}
