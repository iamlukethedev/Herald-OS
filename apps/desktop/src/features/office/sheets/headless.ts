import '@univerjs/sheets/facade'
import '@univerjs/engine-formula/facade'
import '@univerjs/sheets-formula/facade'
import '@univerjs/sheets-numfmt/facade'
import '@univerjs/sheets-filter/facade'
import '@univerjs/sheets-sort/facade'
import '@univerjs/sheets-data-validation/facade'
import '@univerjs/sheets-conditional-formatting/facade'
import '@univerjs/sheets-hyper-link/facade'
import '@univerjs/sheets-drawing/facade'
import '@univerjs/thread-comment/facade'
import '@univerjs/sheets-thread-comment/facade'
import '@univerjs/sheets-note/facade'
import { type IWorkbookData, LifecycleService, LifecycleStages, LocaleType, LogLevel, Univer, UniverInstanceType } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverDataValidationPlugin } from '@univerjs/data-validation'
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverDrawingPlugin } from '@univerjs/drawing'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { IRenderManagerService } from '@univerjs/engine-render'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import type { FWorkbook } from '@univerjs/sheets/facade'
import { UniverSheetsConditionalFormattingPlugin } from '@univerjs/sheets-conditional-formatting'
import { UniverSheetsDataValidationPlugin } from '@univerjs/sheets-data-validation'
import { UniverSheetsDrawingPlugin } from '@univerjs/sheets-drawing'
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter'
import { CalculationMode, UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import { UniverSheetsHyperLinkPlugin } from '@univerjs/sheets-hyper-link'
import { UniverSheetsNotePlugin } from '@univerjs/sheets-note'
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt'
import { UniverSheetsSortPlugin } from '@univerjs/sheets-sort'
import { UniverSheetsThreadCommentPlugin } from '@univerjs/sheets-thread-comment'
import { UniverThreadCommentPlugin } from '@univerjs/thread-comment'
import { NEVER } from 'rxjs'
import type { WorkbookSnapshot } from '../../../../shared/office/workbook.ts'
import { trackChartRanges } from './charts/track.ts'

/*
 * A workbook in Univer with nothing drawn, for changing a file that is not open in a window. Every
 * plugin that keeps data in the workbook is here (validation, conditional formats, filters, links,
 * number formats, charts and other drawings, comments and notes): Univer leaves out of a saved
 * snapshot what no plugin loaded.
 */

/** Univer's chrome moves an instance on to Rendered and Steady; the formula engine waits for that. */
function settle(univer: Univer): void {
  const lifecycle = univer.__getInjector().get(LifecycleService)

  for (const stage of [LifecycleStages.Rendered, LifecycleStages.Steady]) {
    if (lifecycle.stage < stage) {
      lifecycle.stage = stage
    }
  }
}

export interface HeadlessSheets {
  univer: Univer
  api: FUniver
  workbook: FWorkbook
}

/** Run `work` on a workbook with its formulas worked out, then free it; the snapshot comes back with what `work` returned. */
export async function withHeadlessSheets<T>(snapshot: WorkbookSnapshot, work: (sheets: HeadlessSheets) => Promise<T> | T): Promise<{ result: T; snapshot: WorkbookSnapshot }> {
  const univer = new Univer({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: {} }, logLevel: LogLevel.ERROR })

  try {
    univer.registerPlugin(UniverDocsPlugin)
    univer.registerPlugin(UniverFormulaEnginePlugin)
    univer.registerPlugin(UniverSheetsPlugin)
    univer.registerPlugin(UniverSheetsFormulaPlugin, { initialFormulaComputing: CalculationMode.WHEN_EMPTY })
    univer.registerPlugin(UniverSheetsNumfmtPlugin)
    univer.registerPlugin(UniverSheetsFilterPlugin)
    univer.registerPlugin(UniverSheetsSortPlugin)
    univer.registerPlugin(UniverDataValidationPlugin)
    univer.registerPlugin(UniverSheetsDataValidationPlugin)
    univer.registerPlugin(UniverSheetsConditionalFormattingPlugin)
    univer.registerPlugin(UniverSheetsHyperLinkPlugin)
    univer.registerPlugin(UniverDrawingPlugin)
    univer.registerPlugin(UniverSheetsDrawingPlugin)
    univer.registerPlugin(UniverThreadCommentPlugin)
    univer.registerPlugin(UniverSheetsThreadCommentPlugin)
    univer.registerPlugin(UniverSheetsNotePlugin)
    // Univer works in the snapshot it is given (results go into its cells): it gets a copy.
    const { activeSheetId: _active, ...data } = structuredClone(snapshot)
    univer.createUnit(UniverInstanceType.UNIVER_SHEET, data as unknown as Partial<IWorkbookData>)
    settle(univer)
    // Once a window has shown a workbook, the Sheets UI facade is loaded and listens for this instance's renderers; it draws none.
    const injector = univer.__getInjector()

    if (!injector.has(IRenderManagerService)) {
      injector.add([IRenderManagerService, { useValue: { created$: NEVER } as unknown as IRenderManagerService }])
    }

    trackChartRanges(univer)
    const api = FUniver.newAPI(univer)
    const workbook = api.getWorkbook(snapshot.id) ?? api.getActiveWorkbook()

    if (!workbook) {
      throw new Error('The workbook did not load')
    }

    if (typeof snapshot.activeSheetId === 'string' && workbook.getSheetBySheetId(snapshot.activeSheetId)) {
      workbook.setActiveSheet(snapshot.activeSheetId)
    }

    const result = await work({ univer, api, workbook })
    // Results of formulas the change touched arrive after it; a workbook without formulas has none to wait for.
    await api.getFormula().onCalculationResultApplied(2000).catch(() => {})
    const saved = workbook.save() as unknown as WorkbookSnapshot

    return { result, snapshot: { ...saved, activeSheetId: workbook.getActiveSheet().getSheetId() } }
  } finally {
    // Plugins finish work they put off (comments, drawings) on a timer, which must not find the instance gone.
    await new Promise((resolve) => setTimeout(resolve, 50))
    univer.dispose()
  }
}
