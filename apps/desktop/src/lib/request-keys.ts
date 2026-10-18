import { hostPlatform } from './platform-labels.ts'

/*
 * The keys that move the focus to a waiting request's card. Neither reaches a terminal: Cmd chords
 * stay with the app on macOS, and on Herald OS Linux niri takes Super+Shift+A before any window does
 * (linux/niri/config.kdl runs `herald-os os requests.focus`). Herald's own Cmd+Shift+A (all
 * applications) and Office's Ctrl and Cmd chords leave both free.
 */

export interface RequestShortcut {
  /** For `aria-keyshortcuts`. */
  aria: string
  /** As the manual and spoken hints write it. */
  label: string
}

export function requestShortcut(platform: string = hostPlatform()): RequestShortcut {
  return platform === 'darwin' ? { aria: 'Meta+Alt+A', label: 'Cmd+Option+A' } : { aria: 'Meta+Shift+A', label: 'Super+Shift+A' }
}

/**
 * Whether a key press in a Herald window is the shortcut: Cmd+Option+A on macOS (by key code, as
 * Option turns the letter into another character), Super+Shift+A elsewhere for when no compositor
 * bind took it first.
 */
export function isRequestShortcut(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'code'>, platform: string = hostPlatform()): boolean {
  if (event.code !== 'KeyA' || !event.metaKey || event.ctrlKey) {
    return false
  }

  return platform === 'darwin' ? event.altKey && !event.shiftKey : event.shiftKey && !event.altKey
}
