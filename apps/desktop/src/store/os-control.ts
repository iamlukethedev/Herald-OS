import type { OsControlRequest } from '../../shared/ipc.ts'
import { appById } from '../shell/apps.ts'
import { listCommands, runCommand } from './os-commands.ts'
import { screenFacts } from './on-screen.ts'
import { isMainSurface } from './shell.ts'
import { $voice } from './voice.ts'
import { $webWindows } from './web-windows.ts'
import { $focusedWindowId, $page, $windows, MAIN_WINDOW_ID } from './windows.ts'

/*
 * Answers main's OS-control requests (from the agent's `os_ui` tool or the CLI): run a registry
 * command and send the result back, list the catalogue, or describe what is on screen.
 */

/** What the agent needs to know about the screen before acting. */
export function osState(): Record<string, unknown> {
  const page = $page.get()
  const focused = $focusedWindowId.get()
  const windows = Object.values($windows.get())
    .filter(w => w.phase !== 'closing')
    .map(w => ({
      id: w.id,
      app: w.appId,
      title: w.id === MAIN_WINDOW_ID ? `Hermes (${appById(page).name})` : w.title,
      minimized: w.phase === 'minimized',
      focused: w.id === focused
    }))
  const voice = $voice.get()
  const screen = screenFacts()

  return {
    page,
    pageTitle: appById(page).name,
    windows,
    webPages: Object.values($webWindows.get()).map(w => ({ id: w.id, url: w.url, title: w.title })),
    // "This folder" / "this file": what the Files page lists and selects while it is the page in view.
    files: page === 'files' ? screen.files : null,
    viewerFile: screen.viewerFile,
    voice: { state: voice.state, engine: voice.engine, muted: voice.muted }
  }
}

/** The documents open in Herald Docs, Sheets and Slides, the one in front first, with what is selected in each. */
async function officeState(): Promise<Record<string, unknown>[]> {
  try {
    const { openEntries } = await import('../features/office/agent.ts')

    return (await openEntries()).map(({ key: _key, ...entry }) => entry)
  } catch {
    return []
  }
}

let bound = false

export function bindOsControl(): () => void {
  const bridge = window.heraldOS?.osControl

  if (bound || !isMainSurface || !bridge) {
    return () => undefined
  }

  bound = true
  const off = bridge.onRequest(async (request: OsControlRequest) => {
    try {
      if (request.kind === 'run') {
        bridge.reply({ requestId: request.requestId, result: await runCommand(request.command, request.args, { source: request.source }) })
      } else if (request.kind === 'list') {
        bridge.reply({ requestId: request.requestId, result: listCommands({ includeHidden: true }) })
      } else {
        bridge.reply({ requestId: request.requestId, result: { ...osState(), office: await officeState() } })
      }
    } catch (error) {
      bridge.reply({ requestId: request.requestId, error: error instanceof Error ? error.message : String(error) })
    }
  })

  return () => {
    off()
    bound = false
  }
}
