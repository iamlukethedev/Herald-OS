import { $location, $selectedPath } from '../features/files/files-store.ts'
import { describeScreen, type ScreenFacts } from '../lib/screen-context.ts'
import { $webWindows } from './web-windows.ts'
import { $focusedWindowId, $page } from './windows.ts'

/* The screen as Hermes needs it: what the Files page lists and selects, and the document in front. */

export function screenFacts(): ScreenFacts {
  const location = $location.get()
  const focused = $focusedWindowId.get()
  const viewer = focused ? Object.values($webWindows.get()).find(entry => entry.windowId === focused && entry.url.startsWith('file://')) : undefined

  return {
    page: $page.get(),
    files: location ? { folder: location.kind === 'dir' ? location.path : null, view: location.kind === 'dir' ? 'folder' : location.kind, selected: $selectedPath.get() } : null,
    viewerFile: viewer ? viewer.url.slice('file://'.length) : null
  }
}

/** One line for a spoken request ("Screen: the Files page shows the folder …"), or null. */
export function screenContextLine(): string | null {
  return describeScreen(screenFacts())
}

/** What Herald Office has open, for a spoken request ("Office: in front is Budget.xlsx …"), or null; the Office code loads on first use. */
export async function officeContextLine(): Promise<string | null> {
  try {
    const office = await import('../features/office/agent.ts')

    return await office.officeContextLine()
  } catch {
    return null
  }
}
