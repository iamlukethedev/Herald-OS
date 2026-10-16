import { useLayoutEffect, useRef } from 'react'
import type { ShellCommand, WmWindow } from '../../../shared/ipc.ts'
import type { FloatingAppId } from '../apps.ts'
import { onShellCommand } from '../../store/shell.ts'

/**
 * Subscribe to inbound `ShellCommand`s for the lifetime of a component. Registered in a layout
 * effect so commands queued before the (lazy) surface mounted are replayed before the first paint.
 */
export function useShellCommands(handler: (command: ShellCommand) => void): void {
  const latest = useRef(handler)
  latest.current = handler

  useLayoutEffect(() => onShellCommand(command => latest.current(command)), [])
}

/** Window titles main gives our own floating windows (see electron/shell/mode.ts); they double as identity. */
const OUR_FLOATING_TITLES: Record<string, FloatingAppId> = {
  'Herald OS · Terminal': 'terminal',
  'Herald OS · System': 'system',
  'Herald OS · Chat': 'chat-popout',
  'Herald OS · Studio': 'studio',
  'Herald OS · Canvas': 'canvas',
  'Herald OS · Docs': 'docs',
  'Herald OS · Sheets': 'sheets',
  'Herald OS · Slides': 'slides',
  'Herald OS · Pet Room': 'room',
  'Herald OS · Calc': 'calc'
}

export const OUR_MAIN_TITLE = 'Herald OS'

/** Which floating Hermes app one of our compositor windows hosts, when it is one. */
export function ourFloatingAppId(win: WmWindow): FloatingAppId | null {
  return win.ours ? (OUR_FLOATING_TITLES[win.title] ?? null) : null
}

/** A short human label for a compositor window: its title, else its app id. */
export function windowLabel(win: WmWindow): string {
  return win.title.trim() || win.appId || 'Window'
}

/** The line prepended to a prompt when it was asked about a specific window. */
export function contextLine(context: WmWindow): string {
  return `Context: the focused window is "${windowLabel(context)}" (${context.appId || 'unknown app'}).`
}

/** The prompt text for a question asked about a window; its attachments travel with sendPrompt. */
export function composePrompt(text: string, context?: WmWindow | null): string {
  const parts: string[] = []

  if (context) {
    parts.push(contextLine(context))
  }

  const body = text.trim()

  if (body) {
    parts.push(body)
  }

  return parts.join('\n')
}
