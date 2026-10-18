import { focusRequestCard } from '../lib/request-focus.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { $pendingRequests } from '../store/requests.ts'
import { isMainSurface, isPanels, openSurface } from '../store/shell.ts'

/* The requests Hermes waits on (approvals, questions, passwords): going to the one shown. */

export const requestCommands: readonly OsCommand[] = [
  {
    id: 'requests.focus',
    title: 'Go to the waiting request',
    description: 'Move the keyboard focus to the card of the oldest approval, question or password Hermes is waiting on (Cmd+Option+A on macOS, Super+Shift+A on Herald OS Linux). Only the person can do this, never Hermes.',
    tier: 'read',
    args: [],
    phrases: ['go to the waiting request', 'go to the approval', 'show the approval', 'go to the question'],
    run: (_args, context) => {
      // The focus is the person's: Hermes and plugins never move it, least of all onto a request.
      if (context.source === 'agent' || context.source === 'plugin') {
        return fail('Only the person can go to a waiting request.')
      }

      if ($pendingRequests.get().length === 0) {
        return fail('Nothing is waiting for an answer.')
      }

      // Panels mode: the keys follow the compositor's focus, so bring the Hermes window forward too.
      if (isPanels && isMainSurface) {
        openSurface('main')
      }

      return focusRequestCard($pendingRequests.get().map(entry => entry.request.id)) ? ok('Went to the waiting request', { spoken: 'Here it is.' }) : fail('The waiting request is not on screen in this window.')
    }
  }
]
