import type { Univer } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import type { SheetsEngine } from '../univer/sheets.ts'
import { attachCharts, setupCharts } from './charts/attach.ts'
import { setupComments } from './comments/attach.ts'

/* What Herald Sheets' features add to a workbook's Univer when its window shows it. */

/** Before the workbook loads: what features register with its Univer (the chart component, the comments' author). */
export function setupFeatures(univer: Univer, api: FUniver): void {
  setupCharts(univer, api)
  setupComments(univer, api)
}

/** Once the workbook is on screen; gives what stops them. */
export function attachFeatures(engine: SheetsEngine, docKey: string): () => void {
  const stops = [attachCharts(engine, docKey)]

  return () => stops.forEach((stop) => stop())
}
