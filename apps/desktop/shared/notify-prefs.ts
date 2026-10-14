// Alert switch defaults, shared by Electron main (prefs.json) and the renderer ($prefs seed).
import type { NotifyPrefs } from './ipc.ts'

export const NOTIFY_DEFAULTS: NotifyPrefs = {
  toolCompletions: true,
  approvals: true,
  taskUpdates: true,
  nativeWhenUnfocused: true
}

const FIELDS = Object.keys(NOTIFY_DEFAULTS) as (keyof NotifyPrefs)[]

/** Merge a possibly partial or malformed stored value onto the defaults. */
export function normalizeNotifyPrefs(raw: unknown): NotifyPrefs {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof NotifyPrefs, unknown>>
  const flag = (field: keyof NotifyPrefs): boolean => {
    const value = source[field]

    return typeof value === 'boolean' ? value : NOTIFY_DEFAULTS[field]
  }

  return { toolCompletions: flag('toolCompletions'), approvals: flag('approvals'), taskUpdates: flag('taskUpdates'), nativeWhenUnfocused: flag('nativeWhenUnfocused') }
}

/** Where the Settings page kept each switch in localStorage before they moved to prefs.json. */
export const LEGACY_NOTIFY_KEYS: Record<keyof NotifyPrefs, string> = {
  toolCompletions: 'herald-os.notify.tool-completions',
  approvals: 'herald-os.notify.approvals',
  taskUpdates: 'herald-os.notify.task-updates',
  nativeWhenUnfocused: 'herald-os.notify.native-unfocused'
}

/** The switches saved in localStorage, read the way the Settings page read them; null when there are none. */
export function readLegacyNotifyFlags(storage: Pick<Storage, 'getItem'>): Partial<NotifyPrefs> | null {
  const found: Partial<NotifyPrefs> = {}

  for (const field of FIELDS) {
    const raw = storage.getItem(LEGACY_NOTIFY_KEYS[field])

    if (raw !== null) {
      found[field] = raw === 'true'
    }
  }

  return Object.keys(found).length ? found : null
}
