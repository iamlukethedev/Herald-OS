import { CommandType, ICommandService, Quantity, type Univer } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import { RemoveSheetDrawingCommand } from '@univerjs/sheets-drawing'
import { SheetCanvasPopManagerService } from '@univerjs/sheets-ui'
import { CHART_COMPONENT, CHART_DRAWING_TYPE } from '../../../../../shared/office/charts.ts'
import type { SheetsEngine } from '../../univer/sheets.ts'
import { failed } from '../active.ts'
import { liveTarget } from '../live.ts'
import { sheetsSession } from '../store.ts'
import { chartComponent } from './ChartView.tsx'
import { bindDocument } from './documents.ts'
import { chartsOf } from './drawings.ts'
import { closeChartPanels, openChartPanel } from './panel.tsx'
import { copyChartPicture } from './picture.ts'
import { trackChartRanges } from './track.ts'

const SETTINGS = 'herald.operation.chart-settings'
const COPY = 'herald.operation.chart-copy'

/** Before a workbook loads into this Univer: register what draws its charts. */
export function setupCharts(univer: Univer, api: FUniver): void {
  api.registerComponent(CHART_COMPONENT, chartComponent(univer, api))
}

/**
 * Once a workbook is on screen (Univer starts its sheet services with the workbook): keep its charts'
 * ranges on their cells as rows and columns move, open their settings beside it, and give a selected
 * chart's menu on the sheet a chart's actions rather than a picture's; gives what stops that.
 */
export function attachCharts(engine: SheetsEngine, docKey: string): () => void {
  const injector = engine.univer.__getInjector()
  const commands = injector.get(ICommandService)
  const forget = bindDocument(engine.unitId, docKey)
  const tracking = trackChartRanges(engine.univer)
  const registered = [
    commands.registerCommand({
      id: SETTINGS,
      type: CommandType.OPERATION,
      handler: (_accessor, params?: { drawingId?: string }) => {
        if (params?.drawingId) {
          openChartPanel(docKey, params.drawingId)
        }

        return true
      }
    }),
    commands.registerCommand({
      id: COPY,
      type: CommandType.OPERATION,
      handler: (_accessor, params?: { drawingId?: string }) => {
        const target = liveTarget(docKey)
        const chart = target ? chartsOf(target).find((entry) => entry.id === params?.drawingId) : undefined

        if (target && chart) {
          copyChartPicture(target, chart).then(() => sheetsSession.notify('Copied the chart as a picture'), failed)
        }

        return true
      }
    })
  ]

  injector.get(SheetCanvasPopManagerService, Quantity.OPTIONAL)?.registerFeatureMenu(CHART_DRAWING_TYPE, (unitId, subUnitId, drawingId, drawingType) => [
    { label: 'Chart settings…', index: 0, commandId: SETTINGS, commandParams: { drawingId }, disable: false },
    { label: 'Copy as picture', index: 1, commandId: COPY, commandParams: { drawingId }, disable: false },
    { label: 'Delete', index: 2, commandId: RemoveSheetDrawingCommand.id, commandParams: { unitId, drawings: [{ unitId, subUnitId, drawingId, drawingType }] }, disable: false }
  ])

  return () => {
    forget()
    tracking.dispose()
    registered.forEach((command) => command.dispose())
    closeChartPanels(docKey)
  }
}
