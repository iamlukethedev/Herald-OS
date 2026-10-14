import { describe, expect, it } from 'vitest'
import { isPrivacyPane, isPrivacyPaneUrl, PRIVACY_PANE_NAMES, privacyPaneUrl } from './privacy-panes.ts'

describe('privacyPaneUrl', () => {
  it('points each permission at its list in Privacy & Security', () => {
    expect(Object.fromEntries(PRIVACY_PANE_NAMES.map(pane => [pane, privacyPaneUrl(pane)]))).toEqual({
      microphone: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone',
      camera: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Camera',
      calendars: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Calendars',
      screen: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture',
      accessibility: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility',
      automation: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Automation'
    })
  })

  it('builds only URLs the main process lets through', () => {
    for (const pane of PRIVACY_PANE_NAMES) {
      expect(isPrivacyPaneUrl(privacyPaneUrl(pane))).toBe(true)
    }
  })
})

describe('isPrivacyPane', () => {
  it('knows the panes by name, and nothing inherited', () => {
    expect(isPrivacyPane('camera')).toBe(true)
    expect(isPrivacyPane('Camera')).toBe(false)
    expect(isPrivacyPane('toString')).toBe(false)
    expect(isPrivacyPane(undefined)).toBe(false)
  })
})
