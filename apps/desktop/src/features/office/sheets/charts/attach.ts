import type { Univer } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import type { SheetsEngine } from '../../univer/sheets.ts'

/** Before a workbook loads into this Univer: register what draws its charts. */
export function setupCharts(_univer: Univer, _api: FUniver): void {}

/** Once a workbook is on screen: keep its charts in step with their data; gives what stops it. */
export function attachCharts(_engine: SheetsEngine, _docKey: string): () => void {
  return () => {}
}
