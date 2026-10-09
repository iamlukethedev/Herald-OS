import type { Univer } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import { CHART_COMPONENT } from '../../../../../shared/office/charts.ts'
import type { SheetsEngine } from '../../univer/sheets.ts'
import { chartComponent } from './ChartView.tsx'
import { bindDocument } from './documents.ts'
import { closeChartPanels } from './panel.tsx'
import { trackChartRanges } from './track.ts'

/** Before a workbook loads into this Univer: register what draws its charts. */
export function setupCharts(univer: Univer, api: FUniver): void {
  api.registerComponent(CHART_COMPONENT, chartComponent(univer, api))
}

/**
 * Once a workbook is on screen (Univer starts its sheet services with the workbook): keep its charts'
 * ranges on their cells as rows and columns move, and open their settings beside it; gives what stops that.
 */
export function attachCharts(engine: SheetsEngine, docKey: string): () => void {
  const forget = bindDocument(engine.unitId, docKey)
  const tracking = trackChartRanges(engine.univer)

  return () => {
    forget()
    tracking.dispose()
    closeChartPanels(docKey)
  }
}
