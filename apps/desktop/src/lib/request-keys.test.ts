import { describe, expect, it } from 'vitest'
import { isRequestShortcut, requestShortcut } from './request-keys.ts'

const press = (code: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({ code, metaKey: Boolean(mods.meta), ctrlKey: Boolean(mods.ctrl), altKey: Boolean(mods.alt), shiftKey: Boolean(mods.shift) })

describe('requestShortcut', () => {
  it('names Cmd+Option+A on macOS and Super+Shift+A elsewhere, for the manual and aria-keyshortcuts', () => {
    expect(requestShortcut('darwin')).toEqual({ aria: 'Meta+Alt+A', label: 'Cmd+Option+A' })
    expect(requestShortcut('linux')).toEqual({ aria: 'Meta+Shift+A', label: 'Super+Shift+A' })
  })
})

describe('isRequestShortcut', () => {
  it('is Cmd+Option+A on macOS, by key code since Option turns A into another letter', () => {
    expect(isRequestShortcut(press('KeyA', { meta: true, alt: true }), 'darwin')).toBe(true)
  })

  it('is Super+Shift+A elsewhere', () => {
    expect(isRequestShortcut(press('KeyA', { meta: true, shift: true }), 'linux')).toBe(true)
  })

  it("leaves Herald's All applications, Cmd+Shift+A on macOS and Ctrl+Shift+A on Linux", () => {
    expect(isRequestShortcut(press('KeyA', { meta: true, shift: true }), 'darwin')).toBe(false)
    expect(isRequestShortcut(press('KeyA', { ctrl: true, shift: true }), 'linux')).toBe(false)
  })

  it('takes no chord a terminal receives: Ctrl or Alt with A, with or without Shift', () => {
    for (const platform of ['darwin', 'linux']) {
      for (const mods of [{ ctrl: true }, { ctrl: true, shift: true }, { alt: true }, { alt: true, shift: true }, { ctrl: true, alt: true }]) {
        expect(isRequestShortcut(press('KeyA', mods), platform), `${platform} ${JSON.stringify(mods)}`).toBe(false)
      }
    }
  })

  it('takes nothing with Ctrl added, nor another key', () => {
    expect(isRequestShortcut(press('KeyA', { meta: true, alt: true, ctrl: true }), 'darwin')).toBe(false)
    expect(isRequestShortcut(press('KeyA', { meta: true, shift: true, ctrl: true }), 'linux')).toBe(false)
    expect(isRequestShortcut(press('KeyS', { meta: true, alt: true }), 'darwin')).toBe(false)
    expect(isRequestShortcut(press('KeyA', { meta: true }), 'darwin')).toBe(false)
  })
})
