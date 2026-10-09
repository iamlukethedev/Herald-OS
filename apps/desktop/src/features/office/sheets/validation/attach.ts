import { CanceledError, ICommandService, type IDisposable } from '@univerjs/core'
import { SheetsSelectionsService } from '@univerjs/sheets'
import { SheetCanvasPopManagerService } from '@univerjs/sheets-ui'
import { ComponentManager } from '@univerjs/ui'
import type { SheetsEngine } from '../../univer/sheets.ts'
import { InputMessage } from './InputMessage.tsx'
import { openValidationDialog } from './ValidationDialog.tsx'

/** Univer's own validation sidebar opens with this; its list dropdown's Edit opens it on the rule. */
const UNIVER_VALIDATION_PANEL = 'data-validation.operation.open-validation-panel'
const LIST_DROPDOWN = 'sheet.operation.show-data-validation-dropdown'
const INPUT_MESSAGE = 'herald-sheets-validation-input-message'

/**
 * Once a workbook is on screen: the selected cell's input message shows beside it (Univer keeps
 * them but does not show them), and Univer's validation sidebar opens Herald's Data validation
 * dialog instead; gives what stops both.
 */
export function attachValidation(engine: Pick<SheetsEngine, 'univer' | 'api' | 'unitId'>, docKey: string): () => void {
  const injector = engine.univer.__getInjector()
  const registered = injector.get(ComponentManager).register(INPUT_MESSAGE, InputMessage)
  const popups = injector.get(SheetCanvasPopManagerService)
  const selections = injector.get(SheetsSelectionsService)
  let shown: IDisposable | null = null
  const hide = () => {
    shown?.dispose()
    shown = null
  }
  const show = () => {
    hide()
    const workbook = engine.api.getWorkbook(engine.unitId)
    const sheet = workbook?.getActiveSheet()
    const cell = sheet?.getSelection()?.getCurrentCell()
    const rule = cell ? sheet!.getRange(cell.actualRow, cell.actualColumn).getDataValidation()?.rule : null

    if (workbook && sheet && cell && rule?.showInputMessage && (rule.promptTitle || rule.prompt)) {
      shown = popups.attachPopupToCell(cell.actualRow, cell.actualColumn, { componentKey: INPUT_MESSAGE, direction: 'bottom-left', offset: [0, 4], extraProps: { title: rule.promptTitle, message: rule.prompt } }, workbook.getId(), sheet.getSheetId()) ?? null
    }
  }
  const moved = selections.selectionMoveStart$.subscribe(hide)
  const changed = selections.selectionChanged$.subscribe(show)
  const commands = injector.get(ICommandService)
  const listener = commands.beforeCommandExecuted((command) => {
    if (command.id === LIST_DROPDOWN) {
      hide()
    } else if (command.id === UNIVER_VALIDATION_PANEL) {
      const sheet = engine.api.getWorkbook(engine.unitId)?.getActiveSheet()
      const range = sheet?.getSelection()?.getActiveRange()?.getA1Notation()

      if (sheet && range) {
        openValidationDialog(docKey, sheet.getSheetName(), range)
        // Univer runs no command whose listener cancels it.
        throw new CanceledError()
      }
    }
  })

  return () => {
    hide()
    moved.unsubscribe()
    changed.unsubscribe()
    listener.dispose()
    registered.dispose()
  }
}
