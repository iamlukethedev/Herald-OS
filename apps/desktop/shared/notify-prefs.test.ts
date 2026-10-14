import { describe, expect, it } from 'vitest'
import { LEGACY_NOTIFY_KEYS, NOTIFY_DEFAULTS, normalizeNotifyPrefs, readLegacyNotifyFlags } from './notify-prefs.ts'

const storage = (entries: Record<string, string>) => ({ getItem: (key: string) => entries[key] ?? null })

describe('normalizeNotifyPrefs', () => {
  it('turns every switch on when nothing, or something malformed, is stored', () => {
    expect(NOTIFY_DEFAULTS).toEqual({ toolCompletions: true, approvals: true, taskUpdates: true, nativeWhenUnfocused: true })
    expect(normalizeNotifyPrefs(undefined)).toEqual(NOTIFY_DEFAULTS)
    expect(normalizeNotifyPrefs('off')).toEqual(NOTIFY_DEFAULTS)
    expect(normalizeNotifyPrefs({ approvals: 'false', taskUpdates: 0 })).toEqual(NOTIFY_DEFAULTS)
  })

  it('keeps the switches stored as booleans and drops unknown keys', () => {
    expect(normalizeNotifyPrefs({ approvals: false, nativeWhenUnfocused: false, sound: false })).toEqual({ ...NOTIFY_DEFAULTS, approvals: false, nativeWhenUnfocused: false })
  })
})

describe('readLegacyNotifyFlags', () => {
  it('reads the localStorage keys the Settings page used, the way it read them', () => {
    expect(
      readLegacyNotifyFlags(
        storage({
          'herald-os.notify.tool-completions': 'false',
          'herald-os.notify.approvals': 'true',
          'herald-os.notify.task-updates': 'garbage',
          'herald-os.notify.native-unfocused': 'false'
        })
      )
    ).toEqual({ toolCompletions: false, approvals: true, taskUpdates: false, nativeWhenUnfocused: false })
  })

  it('returns only the switches that were saved, and null when none were', () => {
    expect(readLegacyNotifyFlags(storage({ [LEGACY_NOTIFY_KEYS.approvals]: 'false' }))).toEqual({ approvals: false })
    expect(readLegacyNotifyFlags(storage({ 'herald-os.contrast': 'true' }))).toBeNull()
  })
})
