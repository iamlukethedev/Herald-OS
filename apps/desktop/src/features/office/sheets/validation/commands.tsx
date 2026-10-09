import type { OfficeCommand } from '../../shell/commands.ts'
import { activeKey, activeWorkbook } from '../active.ts'
import { openValidationDialog } from './ValidationDialog.tsx'

/** The Data menu's validation. */
export function validationCommands(): OfficeCommand[] {
  return [
    {
      id: 'validation',
      label: 'Data validation…',
      dividerBefore: true,
      enabled: () => Boolean(activeKey()),
      run: () => {
        const active = activeWorkbook()

        if (active) {
          openValidationDialog(active.key, active.selection?.sheet ?? active.target.workbook.getActiveSheet().getSheetName(), active.selection?.range ?? 'A1')
        }
      }
    }
  ]
}
