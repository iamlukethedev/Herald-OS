import { app } from 'electron'
import { log } from './log.ts'
import { isShellPage } from './paths.ts'

/*
 * The shell's windows report their faults on their own consoles (src/lib/report.ts). Main copies
 * each one's warnings and errors into the Herald OS log, so they are there after DevTools closes,
 * or when it never opened. Only the shell page itself is copied: web windows, Studio previews, file
 * viewers and plugin frames show pages that are not Herald's, whose consoles can be noisy or private.
 */

/** Where a longer message is cut, so that one message cannot swamp the log. */
export const MAX_MESSAGE = 4000
/** Lines one window may add in a minute: a window failing in a loop says so once a minute instead. */
export const PER_MINUTE = 30

/** A console message as Electron's `console-message` event gives it. */
export interface ConsoleMessage {
  level: string
  message: string
  lineNumber: number
  sourceId: string
}

/** Which surface a shell page draws: its `surface` parameter (panels mode, the emoji panel), else the one desktop window. */
export function surfaceOf(page: string): string {
  try {
    return new URL(page).searchParams.get('surface') || 'desktop'
  } catch {
    return 'desktop'
  }
}

/** The log line for a console message: its window, its level, the message cut to size, and where a one-line message came from. */
export function consoleLine(surface: string, { level, message, lineNumber, sourceId }: ConsoleMessage): string {
  const text = message.trimEnd()
  const cut = text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text
  const file = sourceId.split(/[?#]/)[0].split('/').pop()
  // A stack says where it was thrown; a one-line message gets the place that logged it.
  const where = file && !cut.includes('\n') ? ` (${file}:${lineNumber})` : ''

  return `${surface} ${level}: ${cut}${where}`
}

/** One window's share of the log: `log` while it is under the minute's budget, `full` for the first line over it, `drop` for the rest. */
export class LineBudget {
  private start = -Infinity
  private used = 0

  constructor(private readonly limit = PER_MINUTE, private readonly now: () => number = Date.now) {}

  take(): 'log' | 'full' | 'drop' {
    const at = this.now()

    if (at - this.start >= 60_000) {
      this.start = at
      this.used = 0
    }

    this.used++

    return this.used <= this.limit ? 'log' : this.used === this.limit + 1 ? 'full' : 'drop'
  }
}

/** Copy every shell window's warnings and errors into the log. Only contents created after the call are followed. */
export function forwardRendererConsole(): void {
  app.on('web-contents-created', (_event, contents) => {
    const budget = new LineBudget()

    contents.on('console-message', details => {
      if (details.level !== 'warning' && details.level !== 'error') {
        return
      }

      try {
        // A plugin's frame logs through the shell window's contents, under its own address.
        const page = details.frame?.url ?? contents.getURL()

        if (!isShellPage(page)) {
          return
        }

        const surface = surfaceOf(page)
        const verdict = budget.take()

        if (verdict === 'log') {
          log('renderer', consoleLine(surface, details))
        } else if (verdict === 'full') {
          log('renderer', `${surface}: more than ${PER_MINUTE} warnings and errors in a minute; the others from this minute are left out`)
        }
      } catch {
        // A frame that went away as it logged; the log does without its message.
      }
    })
  })
}
