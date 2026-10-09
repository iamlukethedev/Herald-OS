import type { OfficeCommand, OfficeMenu } from '../shell/commands.ts'

/** The menu items for reviewing: what Insert offers for comments and contents, and the Review menu. */
export function reviewMenuItems(): { insert: OfficeCommand[]; menu: OfficeMenu | null } {
  return { insert: [], menu: null }
}
