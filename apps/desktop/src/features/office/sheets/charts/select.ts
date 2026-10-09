import { ICommandService, Quantity } from '@univerjs/core'
import { SetDrawingSelectedOperation } from '@univerjs/drawing'
import { IRenderManagerService } from '@univerjs/engine-render'
import { ISheetDrawingService } from '@univerjs/sheets-drawing'
import { SheetCanvasFloatDomManagerService } from '@univerjs/sheets-drawing-ui'
import type { SheetsTarget } from '../model.ts'
import { chartsOf, type PlacedChart } from './drawings.ts'

/* The chart on screen that the menus act on, and selecting one as a click does. */

/** The chart selected on the sheet in front, or the only chart there. */
export function selectedChart(target: SheetsTarget): PlacedChart | null {
  const charts = chartsOf(target, target.workbook.getActiveSheet().getSheetId())
  const focused = target.univer.__getInjector().get(ISheetDrawingService).getFocusDrawings()

  return charts.find((chart) => focused.some((drawing) => drawing.drawingId === chart.id)) ?? (charts.length === 1 ? charts[0] : null)
}

/** Select a chart on the sheet in front, with the handles that move and size it. */
export function selectChart(target: SheetsTarget, id: string): void {
  const injector = target.univer.__getInjector()
  const unitId = target.workbook.getId()
  const info = injector.get(SheetCanvasFloatDomManagerService, Quantity.OPTIONAL)?.getFloatDomInfo(id)
  const transformer = injector.get(IRenderManagerService, Quantity.OPTIONAL)?.getRenderUnitById?.(unitId)?.scene.getTransformerByCreate()

  if (!info || !transformer) {
    return
  }

  transformer.clearSelectedObjects()
  transformer.setSelectedControl(info.rect)
  injector.get(ICommandService).syncExecuteCommand(SetDrawingSelectedOperation.id, [{ unitId, subUnitId: info.subUnitId, drawingId: id }])
}
