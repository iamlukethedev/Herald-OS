import { focusRequestCard } from '../lib/request-focus.ts'
import { $windowState } from '../store/backend.ts'
import { type CommandSource, fail, ok, type OsCommand } from '../store/os-commands.ts'
import { $pendingRequests } from '../store/requests.ts'
import { isMainSurface, isPanels, openSurface } from '../store/shell.ts'

/* The requests Hermes waits on (approvals, questions, passwords): going to the one shown. */

/** The least time between two jumps, so a script cannot keep pulling the focus. */
export const REQUEST_FOCUS_EVERY_MS = 1000
/** The least time before the Hermes window is raised again for the same request. */
export const REQUEST_RAISE_EVERY_MS = 15_000

/**
 * Who may move the focus to a request: a key press in a Herald window, the command bar, voice and
 * Herald's own UI. The CLI only in panels mode, where niri's Super+Shift+A runs `herald-os os
 * requests.focus`; any process of the same user can run that too, which is why the jumps are rate
 * limited, raise the Hermes window once per request (again only after REQUEST_RAISE_EVERY_MS), and
 * land on the card itself with Deny first. Elsewhere no key binding needs the CLI, so it is refused, as are Hermes's own `os_ui` tool,
 * plugins and the follow view.
 */
export function mayFocusRequest(source: CommandSource, panels: boolean = isPanels): boolean {
  return source === 'shortcut' || source === 'palette' || source === 'voice' || source === 'ui' || (source === 'cli' && panels)
}

let lastJump = Number.NEGATIVE_INFINITY
let lastRaise: { id: string; at: number } | null = null

/** For tests: forget the last jump and the last raise. */
export function resetRequestFocus(): void {
  lastJump = Number.NEGATIVE_INFINITY
  lastRaise = null
}

export const requestCommands: readonly OsCommand[] = [
  {
    id: 'requests.focus',
    title: 'Go to the waiting request',
    description:
      'Move the keyboard focus to the card of the oldest approval, question or password Hermes is waiting on: the card itself, with Deny as its first answer (Cmd+Option+A on macOS, Super+Shift+A on Herald OS Linux). Runs from keys, the command bar and voice; Hermes, plugins and the CLI are refused, except the CLI in the Herald OS Linux session, which its key binding uses and which any program of the same user can therefore call. At most once a second; raises the Hermes window once per request.',
    tier: 'read',
    args: [],
    phrases: ['go to the waiting request', 'go to the approval', 'show the approval', 'go to the question'],
    run: (_args, context) => {
      if (!mayFocusRequest(context.source)) {
        return fail('Only your keys, the command bar or voice can go to a waiting request.')
      }

      const pending = $pendingRequests.get()

      if (pending.length === 0) {
        return fail('Nothing is waiting for an answer.')
      }

      const now = Date.now()

      if (now - lastJump < REQUEST_FOCUS_EVERY_MS) {
        return fail('Went to the waiting request a moment ago.')
      }

      lastJump = now

      // Panels mode: the keys follow the compositor's focus. Bring the Hermes window forward only when
      // it does not have it, once per request and again only after a while, so repeated calls cannot
      // keep pulling it up.
      const oldest = pending[0].request.id

      if (isPanels && isMainSurface && !$windowState.get().focused && (lastRaise?.id !== oldest || now - lastRaise.at >= REQUEST_RAISE_EVERY_MS)) {
        lastRaise = { id: oldest, at: now }
        openSurface('main')
      }

      return focusRequestCard(pending.map(entry => entry.request.id)) ? ok('Went to the waiting request', { spoken: 'Here it is.' }) : fail('The waiting request is not on screen in this window.')
    }
  }
]
