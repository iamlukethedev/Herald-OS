import { ICommandService, IUndoRedoService } from '@univerjs/core'
import { cellName, rangeName } from '../../../../shared/office/xlsx/address.ts'
import { liveTarget } from '../sheets/live.ts'
import { readRange, type SheetsTarget } from '../sheets/model.ts'
import { sheetsSession } from '../sheets/store.ts'
import type { LiveDoc } from './ask.ts'
import { type CellSelection, MAX_GRID_COLUMNS, MAX_GRID_ROWS } from './prompts.ts'

/** The active cell on the sheet in front of an open workbook, and its formula. */
export function activeCell(docKey: string): { sheet: string; cell: string; formula: string | null } | null {
  const sheet = liveTarget(docKey)?.workbook.getActiveSheet()
  const current = sheet?.getSelection()?.getCurrentCell()

  if (!sheet || !current) {
    return null
  }

  return { sheet: sheet.getSheetName(), cell: cellName(current.actualRow, current.actualColumn), formula: sheet.getRange(current.actualRow, current.actualColumn).getFormula() || null }
}

function selectionOf(target: SheetsTarget): CellSelection | null {
  const sheet = target.workbook.getActiveSheet()
  const active = sheet.getSelection()?.getActiveRange()

  if (!active) {
    return null
  }

  const range = active.getRange()
  const cells = { startRow: Math.max(0, range.startRow), startColumn: Math.max(0, range.startColumn), endRow: Math.min(range.endRow, sheet.getMaxRows() - 1), endColumn: Math.min(range.endColumn, sheet.getMaxColumns() - 1) }
  const shown = { ...cells, endRow: Math.min(cells.endRow, cells.startRow + MAX_GRID_ROWS - 1), endColumn: Math.min(cells.endColumn, cells.startColumn + MAX_GRID_COLUMNS - 1) }
  const current = sheet.getSelection()?.getCurrentCell()
  const row = current?.actualRow ?? cells.startRow
  const column = current?.actualColumn ?? cells.startColumn
  let grid: string[][] = []

  try {
    grid = readRange(target, { range: rangeName(shown), sheet: sheet.getSheetName() }).text
  } catch {
    // A selection the reader turns down still has its reference and active cell to give.
  }

  return {
    kind: 'cells',
    sheet: sheet.getSheetName(),
    range: rangeName(cells),
    rows: cells.endRow - cells.startRow + 1,
    columns: cells.endColumn - cells.startColumn + 1,
    top: shown.startRow,
    left: shown.startColumn,
    grid,
    cell: cellName(row, column),
    formula: sheet.getRange(row, column).getFormula() || null
  }
}

/** A Herald Sheets workbook open in this window, for a request to Hermes: its selection and its history. */
export function sheetsLive(docKey: string): LiveDoc | null {
  const doc = sheetsSession.find(docKey)
  const target = liveTarget(docKey)

  if (!doc) {
    return null
  }

  if (!target) {
    return { name: doc.name, path: doc.path, selection: null, depth: () => null, watch: () => () => {}, undo: () => {}, unmark: () => {} }
  }

  const injector = target.univer.__getInjector()
  const history = injector.get(IUndoRedoService)
  const commands = injector.get(ICommandService)
  const unitId = target.workbook.getId()

  return {
    name: doc.name,
    path: doc.path,
    selection: selectionOf(target),
    depth: () => {
      // The workbook's engine goes when its view does (or a version from disk replaces it).
      try {
        return history.getUndoRedoStatus(unitId).undos
      } catch {
        return null
      }
    },
    watch: (listener) => {
      const subscription = commands.onCommandExecuted(() => listener())

      return () => subscription.dispose()
    },
    undo: () => doc.editor?.undo(),
    unmark: () => {}
  }
}
