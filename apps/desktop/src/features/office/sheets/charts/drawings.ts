import { ICommandService, IUndoRedoService, Quantity, sequenceExecute } from '@univerjs/core'
import { IRenderManagerService } from '@univerjs/engine-render'
import { convertPositionCellToSheetOverGrid, SheetSkeletonService } from '@univerjs/sheets'
import { DrawingApplyType, InsertSheetDrawingCommand, ISheetDrawingService, RemoveSheetDrawingCommand, SetDrawingApplyMutation, SetSheetDrawingCommand } from '@univerjs/sheets-drawing'
import type { FWorksheet } from '@univerjs/sheets/facade'
import { CHART_COMPONENT, type CellOffset, type ChartDrawing, isChartData } from '../../../../../shared/office/charts.ts'
import type { CellRange } from '../../../../../shared/office/xlsx/address.ts'
import type { SheetsTarget } from '../model.ts'

/*
 * Charts as the floating objects of Univer's sheet drawings: finding them, placing them over cells,
 * and inserting, changing and removing them as one step to undo. In a window Univer's own drawing
 * commands do it; a workbook with nothing drawn has no selection handles for those commands to
 * refresh, so there the same change is made with their mutation and filed for undo here.
 */

export interface PlacedChart {
  id: string
  sheet: FWorksheet
  drawing: ChartDrawing
}

/** The charts of a workbook (or of one sheet), sheet by sheet, back to front. */
export function chartsOf(target: SheetsTarget, sheetId?: string): PlacedChart[] {
  const service = target.univer.__getInjector().get(ISheetDrawingService)
  const unitId = target.workbook.getId()

  return target.workbook
    .getSheets()
    .filter((sheet) => !sheetId || sheet.getSheetId() === sheetId)
    .flatMap((sheet) => {
      const data = service.getDrawingData(unitId, sheet.getSheetId()) as unknown as Record<string, ChartDrawing>
      const order = service.getDrawingOrder(unitId, sheet.getSheetId()).filter((id) => data[id])
      const ids = [...order, ...Object.keys(data).filter((id) => !order.includes(id))]

      return ids.map((id) => data[id]).filter((drawing) => drawing.componentKey === CHART_COMPONENT && isChartData(drawing.data)).map((drawing) => ({ id: drawing.drawingId, sheet, drawing }))
    })
}

type DrawingChange = 'insert' | 'update' | 'remove'

const COMMANDS: Record<DrawingChange, string> = { insert: InsertSheetDrawingCommand.id, update: SetSheetDrawingCommand.id, remove: RemoveSheetDrawingCommand.id }
const APPLY: Record<DrawingChange, [DrawingApplyType, DrawingApplyType]> = {
  insert: [DrawingApplyType.INSERT, DrawingApplyType.REMOVE],
  update: [DrawingApplyType.UPDATE, DrawingApplyType.UPDATE],
  remove: [DrawingApplyType.REMOVE, DrawingApplyType.INSERT]
}

export type DrawingInput = Partial<ChartDrawing> & Pick<ChartDrawing, 'unitId' | 'subUnitId' | 'drawingId'>

/** Insert, change or remove drawings of one sheet as one step to undo. */
export function applyDrawings(target: SheetsTarget, change: DrawingChange, drawings: DrawingInput[]): void {
  const injector = target.univer.__getInjector()
  const commands = injector.get(ICommandService)
  const unitId = target.workbook.getId()
  const subUnitId = drawings[0]?.subUnitId

  if (!subUnitId) {
    return
  }

  if (injector.get(IRenderManagerService, Quantity.OPTIONAL)) {
    if (!commands.syncExecuteCommand(COMMANDS[change], { unitId, subUnitId, drawings })) {
      throw new Error(`Univer did not ${change} the chart`)
    }

    return
  }

  const service = injector.get(ISheetDrawingService)
  const params = drawings as never[]
  const { undo, redo, objects } = (change === 'insert' ? service.getBatchAddOp(params) : change === 'update' ? service.getBatchUpdateOp(params) : service.getBatchRemoveOp(params)) as { undo: unknown; redo: unknown; objects: unknown }

  if (!redo) {
    return
  }

  const [forward, back] = APPLY[change]
  const redoMutations = [{ id: SetDrawingApplyMutation.id, params: { unitId, subUnitId, op: redo, objects, type: forward } }]
  const undoMutations = [{ id: SetDrawingApplyMutation.id, params: { unitId, subUnitId, op: undo, objects, type: back } }]

  if (!sequenceExecute(redoMutations, commands).result) {
    throw new Error(`Univer did not ${change} the chart`)
  }

  injector.get(IUndoRedoService).pushUndoRedo({ unitID: unitId, undoMutations, redoMutations })
}

export interface Placement {
  sheetTransform: { from: CellOffset; to: CellOffset }
  axisAlignSheetTransform: { from: CellOffset; to: CellOffset }
  transform: { left: number; top: number; width: number; height: number }
}

/** What sizes a sheet's cells: the drawn sheet's own measures in a window, else the widths and heights it keeps. */
function measuresOf(target: SheetsTarget, sheet: FWorksheet) {
  const skeleton = target.univer.__getInjector().get(SheetSkeletonService, Quantity.OPTIONAL)?.getSkeleton(target.workbook.getId(), sheet.getSheetId())
  const config = sheet.getSheet().getConfig()
  const header = { left: config.rowHeader?.hidden ? 0 : (config.rowHeader?.width ?? 46), top: config.columnHeader?.hidden ? 0 : (config.columnHeader?.height ?? 20) }
  const width = (column: number) => (sheet.getSheet().getColVisible(column) ? sheet.getColumnWidth(column) : 0)
  const height = (row: number) => (sheet.getSheet().getRowVisible(row) ? sheet.getRowHeight(row) : 0)
  const sum = (count: number, size: (i: number) => number) => Array.from({ length: count }, (_, i) => size(i)).reduce((total, value) => total + value, 0)
  // The cell `length` pixels on from a cell's corner, along one side of the sheet.
  const walk = (start: number, offset: number, length: number, size: (i: number) => number, last: number) => {
    let at = start
    let left = offset + length

    while (at < last && left > size(at)) {
      left -= size(at)
      at++
    }

    return { at, offset: left }
  }

  return { skeleton, header, width, height, sum, walk }
}

/** Where a chart `size` pixels big sits with its top-left corner over a cell (and an offset into it). */
export function placeAt(target: SheetsTarget, sheet: FWorksheet, corner: CellOffset, size: { width: number; height: number }): Placement {
  const { skeleton, header, width, height, sum, walk } = measuresOf(target, sheet)

  if (skeleton) {
    const { sheetTransform, transform } = convertPositionCellToSheetOverGrid(target.workbook.getId(), sheet.getSheetId(), corner, size.width, size.height, skeleton)

    return { sheetTransform, axisAlignSheetTransform: sheetTransform, transform }
  }

  const across = walk(corner.column, corner.columnOffset, size.width, width, sheet.getMaxColumns() - 1)
  const down = walk(corner.row, corner.rowOffset, size.height, height, sheet.getMaxRows() - 1)
  const sheetTransform = { from: { ...corner }, to: { column: across.at, columnOffset: across.offset, row: down.at, rowOffset: down.offset } }

  return {
    sheetTransform,
    axisAlignSheetTransform: sheetTransform,
    transform: { left: header.left + sum(corner.column, width) + corner.columnOffset, top: header.top + sum(corner.row, height) + corner.rowOffset, width: size.width, height: size.height }
  }
}

/** The size in pixels of a block of cells. */
export function sizeOfCells(target: SheetsTarget, sheet: FWorksheet, cells: CellRange): { width: number; height: number } {
  const { skeleton, width, height } = measuresOf(target, sheet)

  if (skeleton) {
    const start = skeleton.getNoMergeCellWithCoordByIndex(cells.startRow, cells.startColumn)
    const end = skeleton.getNoMergeCellWithCoordByIndex(cells.endRow, cells.endColumn)

    return { width: end.endX - start.startX, height: end.endY - start.startY }
  }

  const span = (from: number, to: number, size: (i: number) => number) => Array.from({ length: to - from + 1 }, (_, i) => size(from + i)).reduce((total, value) => total + value, 0)

  return { width: span(cells.startColumn, cells.endColumn, width), height: span(cells.startRow, cells.endRow, height) }
}

/** The cells a drawing covers, corner to corner. */
export const cellsUnder = (drawing: Pick<ChartDrawing, 'sheetTransform'>): CellRange => ({ startRow: drawing.sheetTransform.from.row, startColumn: drawing.sheetTransform.from.column, endRow: drawing.sheetTransform.to.row, endColumn: drawing.sheetTransform.to.column })
