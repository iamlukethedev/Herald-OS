import { atom } from 'nanostores'
import { copiedNotice } from '../lib/typing-notice.ts'
import { performEdit, rememberFocusedEditable } from './edit-target.ts'
import { notify } from './notifications.ts'
import { closeThisSurface, isPanels, openSurface, relayToMain, surface } from './shell.ts'

const RECENT_KEY = 'herald-os:emoji-recent'
const RECENT_LIMIT = 24

/** Desktop mode: the picker overlay inside the Herald window. */
export const $emojiPicker = atom(false)

export function recentEmoji(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')

    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string').slice(0, RECENT_LIMIT) : []
  } catch {
    return []
  }
}

function remember(char: string): void {
  localStorage.setItem(RECENT_KEY, JSON.stringify([char, ...recentEmoji().filter(item => item !== char)].slice(0, RECENT_LIMIT)))
}

/** Panels mode opens the overlay window over the focused app; desktop mode opens it in Herald. */
export function openEmojiPicker(): void {
  if (isPanels) {
    openSurface('command', { type: 'emoji' })

    return
  }

  rememberFocusedEditable()
  $emojiPicker.set(true)
}

/** Put the emoji where the person was typing: the app under the overlay, or Herald's last field. */
export async function insertEmoji(char: string): Promise<void> {
  remember(char)

  // Panels mode's overlay window, or the macOS panel over another app.
  if (isPanels || surface === 'emoji') {
    // Main waits for the overlay to close so the keystrokes land in the app that had focus.
    const typing = window.heraldOS.dictation.type(char, { delayMs: 220 })
    closeThisSurface()
    const result = await typing.catch(() => null)

    // This window has just closed, so the Hermes window says where the emoji went.
    if (result?.copied) {
      const { title, body } = copiedNotice('emoji', char, result.missing)
      relayToMain({ type: 'notify', args: [title, body] })
    }

    return
  }

  $emojiPicker.set(false)

  try {
    await performEdit({ kind: 'insert', text: char }, { needsField: true })
  } catch {
    await navigator.clipboard.writeText(char).catch(() => undefined)
    notify({ title: `Copied ${char}`, body: 'No text field had focus, so it is on the clipboard.', level: 'info' })
  }
}
