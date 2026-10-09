import type { OfficeCommand } from '../../shell/commands.ts'
import { activeKey } from '../active.ts'
import { openNameManager } from './NameManager.tsx'

/** The Data menu's named ranges. */
export function nameCommands(): OfficeCommand[] {
  return [
    {
      id: 'names',
      label: 'Named ranges…',
      dividerBefore: true,
      enabled: () => Boolean(activeKey()),
      run: () => {
        const key = activeKey()

        if (key) {
          openNameManager(key)
        }
      }
    }
  ]
}
