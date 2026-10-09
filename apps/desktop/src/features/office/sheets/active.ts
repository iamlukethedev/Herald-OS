import { messageOf } from '../../canvas/errors.ts'
import { liveTarget, selectionIn } from './live.ts'
import type { SheetsTarget } from './model.ts'
import { sheetsSession } from './store.ts'

/* The workbook a menu command acts on: the one in front, when its sheet is on screen (commands act on what the person sees). */

/** The active document's key, when its sheet is on screen. */
export const activeKey = (): string | null => {
  const doc = sheetsSession.active()

  return doc && liveTarget(doc.key) ? doc.key : null
}

/** The live workbook in front, with its document's key and the selection on its sheet in front. */
export function activeWorkbook(): { key: string; target: SheetsTarget; selection: { sheet: string; range: string } | null } | null {
  const key = activeKey()
  const target = key ? liveTarget(key) : null

  return key && target ? { key, target, selection: selectionIn(key) } : null
}

/** Tell the person a command did not work, in the window's notice. */
export const failed = (error: unknown): void => sheetsSession.notify(messageOf(error), 'error')
