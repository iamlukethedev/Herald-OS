import { afterEach, describe, expect, it } from 'vitest'
import { $env } from '../store/backend.ts'
import { isLinux, shortcutLabel, voiceKeyLabel } from './platform-labels.ts'

const onPlatform = (platform: NodeJS.Platform) => $env.set({ platform, hermesHome: '/h/.hermes', homeDir: '/h', version: '0.0.0', isDev: false, shellMode: 'panels' })

afterEach(() => $env.set(null))

describe('shortcutLabel', () => {
  it('spells shortcuts the Mac way on macOS', () => {
    onPlatform('darwin')

    expect(shortcutLabel('1')).toBe('⌘1')
    expect(shortcutLabel('A', { shift: true })).toBe('⌘⇧A')
  })

  it('names Ctrl on Herald OS Linux, which has no Command key', () => {
    onPlatform('linux')

    expect(shortcutLabel('K')).toBe('Ctrl+K')
    expect(shortcutLabel('A', { shift: true })).toBe('Ctrl+Shift+A')
  })
})

describe('voiceKeyLabel', () => {
  it('names the session hotkey on Linux, whatever the Electron hotkey says', () => {
    onPlatform('linux')

    expect(voiceKeyLabel('Alt+Space')).toBe('Super+V')
  })

  it('names the configured hotkey on macOS, and nothing when it is cleared', () => {
    onPlatform('darwin')

    expect(voiceKeyLabel('Alt+Space')).toBe('Alt+Space')
    expect(voiceKeyLabel(' ')).toBeUndefined()
  })
})

describe('isLinux', () => {
  it('is true on Linux only, and false until main reports the platform', () => {
    expect(isLinux()).toBe(false)

    for (const [platform, linux] of [['linux', true], ['darwin', false], ['win32', false], ['freebsd', false]] as const) {
      onPlatform(platform)

      expect(isLinux()).toBe(linux)
    }
  })
})
