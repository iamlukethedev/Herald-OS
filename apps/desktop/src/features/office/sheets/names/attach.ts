import { CanceledError, ICommandService } from '@univerjs/core'
import type { SheetsEngine } from '../../univer/sheets.ts'
import { openNameManager } from './NameManager.tsx'

/** The name box's "Manage names" opens Univer's own sidebar with this command. */
const UNIVER_NAMES_SIDEBAR = 'sidebar.operation.defined-name'

/** Once a workbook is on screen: the formula bar's name box manages names in Herald's Name manager; gives what stops it. */
export function attachNames(engine: Pick<SheetsEngine, 'univer'>, docKey: string): () => void {
  const listener = engine.univer.__getInjector().get(ICommandService).beforeCommandExecuted((command) => {
    if (command.id === UNIVER_NAMES_SIDEBAR && (command.params as { value?: string } | undefined)?.value === 'open') {
      openNameManager(docKey)
      // Univer runs no command whose listener cancels it.
      throw new CanceledError()
    }
  })

  return () => listener.dispose()
}
