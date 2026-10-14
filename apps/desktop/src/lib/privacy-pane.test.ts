import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $env } from '../store/backend.ts'
import { canOpenPrivacyPanes, openPrivacyPane, privacyPaneActions } from './privacy-pane.ts'

const openExternal = vi.hoisted(() => {
  const fn = vi.fn(async (_url: string) => undefined)
  Object.assign(globalThis, { window: { heraldOS: { shell: { openExternal: fn } } } })

  return fn
})

const onPlatform = (platform: NodeJS.Platform) => $env.set({ platform, hermesHome: '/h/.hermes', homeDir: '/h', version: '0.0.0', isDev: false, shellMode: 'desktop' })

beforeEach(() => openExternal.mockClear())
afterEach(() => $env.set(null))

describe('openPrivacyPane', () => {
  it('opens the list for each permission in Privacy & Security', async () => {
    await openPrivacyPane('microphone')
    await openPrivacyPane('camera')
    await openPrivacyPane('calendars')

    expect(openExternal.mock.calls.map(([url]) => url)).toEqual([
      'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone',
      'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Camera',
      'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Calendars'
    ])
  })
})

describe('canOpenPrivacyPanes', () => {
  it('is true on macOS only', () => {
    onPlatform('darwin')
    expect(canOpenPrivacyPanes()).toBe(true)

    onPlatform('linux')
    expect(canOpenPrivacyPanes()).toBe(false)

    onPlatform('win32')
    expect(canOpenPrivacyPanes()).toBe(false)
  })
})

describe('privacyPaneActions', () => {
  it('offers a notification button that runs the pane command on macOS', () => {
    onPlatform('darwin')

    expect(privacyPaneActions('microphone')).toEqual([{ label: 'Open System Settings', command: 'privacy.openPane', args: { pane: 'microphone' } }])
  })

  it('offers nothing where there is no System Settings', () => {
    onPlatform('linux')

    expect(privacyPaneActions('microphone')).toBeUndefined()
  })
})
