import { describe, expect, it } from 'vitest'
import { mayOpenExternally } from './external-url.ts'

const PRIVACY = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension'

describe('mayOpenExternally', () => {
  it('opens web pages on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(mayOpenExternally('https://example.com/a?b=c', platform)).toBe(true)
      expect(mayOpenExternally('HTTP://example.com', platform)).toBe(true)
    }
  })

  it('opens Privacy & Security and its lists on macOS', () => {
    expect(mayOpenExternally(PRIVACY, 'darwin')).toBe(true)

    for (const anchor of ['Privacy_Microphone', 'Privacy_Camera', 'Privacy_Calendars', 'Privacy_ScreenCapture', 'Privacy_Accessibility', 'Privacy_Automation']) {
      expect(mayOpenExternally(`${PRIVACY}?${anchor}`, 'darwin')).toBe(true)
    }
  })

  it('refuses System Settings URLs where there is no System Settings', () => {
    expect(mayOpenExternally(`${PRIVACY}?Privacy_Microphone`, 'linux')).toBe(false)
    expect(mayOpenExternally(`${PRIVACY}?Privacy_Microphone`, 'win32')).toBe(false)
  })

  it('refuses other System Settings panes, and anything appended to a privacy one', () => {
    for (const url of [
      'x-apple.systempreferences:com.apple.Users-Groups-Settings.extension',
      'x-apple.systempreferences:com.apple.preference.security',
      'x-apple.systempreferences:',
      `${PRIVACY}?Privacy_Microphone&other=1`,
      `${PRIVACY}?Privacy_Microphone#x`,
      `${PRIVACY}?Other_Thing`,
      `${PRIVACY}/../com.apple.Users-Groups-Settings.extension`,
      ` ${PRIVACY}`,
      `${PRIVACY}\n`
    ]) {
      expect(mayOpenExternally(url, 'darwin'), url).toBe(false)
    }
  })

  it('refuses every other scheme', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.c', 'smb://server/share', 'x-apple.systempreferencesx:foo', 'ssh://host', '/etc/passwd', '']) {
      expect(mayOpenExternally(url, 'darwin'), url).toBe(false)
      expect(mayOpenExternally(url, 'linux'), url).toBe(false)
    }
  })

  it('refuses what is not a string', () => {
    expect(mayOpenExternally(undefined, 'darwin')).toBe(false)
    expect(mayOpenExternally({ toString: () => 'https://example.com' }, 'darwin')).toBe(false)
  })
})
