import { describe, expect, it } from 'vitest'
import { overClipboardLimit, sanitizePaste } from './terminal-clipboard.ts'

const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/

describe('sanitizePaste', () => {
  it('keeps text, tabs and line breaks as they are', () => {
    expect(sanitizePaste('ls -la\tdocs\r\necho "héllo 世界 🙂"\n')).toBe('ls -la\tdocs\r\necho "héllo 世界 🙂"\n')
  })

  it('cannot end a bracketed paste early', () => {
    const pasted = sanitizePaste('echo safe\x1b[201~rm -rf ~\r')

    expect(pasted).toBe('echo safe[201~rm -rf ~\r')
    expect(pasted).not.toContain('\x1b[201~')
  })

  it('cannot start one either', () => {
    expect(sanitizePaste('\x1b[200~text')).toBe('[200~text')
  })

  it.each([
    ['another escape sequence', 'a\x1b]0;title\x07b\x1b[2Jc', 'a]0;titleb[2Jc'],
    ['the C1 control sequence introducer', 'a\x9b201~b', 'a201~b'],
    ['every C1 control', `a${String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 0x80 + i))}b`, 'ab'],
    ['DEL', 'a\x7fb', 'ab'],
    ['NUL and the other C0 controls', 'a\x00\x03\x04\x08\x0b\x0c\x0e\x1a\x1fb', 'ab']
  ])('drops %s', (_label, text, expected) => {
    expect(sanitizePaste(text)).toBe(expected)
    expect(sanitizePaste(text)).not.toMatch(CONTROLS)
  })

  it('keeps the letters just past the C1 range', () => {
    expect(sanitizePaste('\xa0\xe9')).toBe('\xa0\xe9')
  })
})

describe('overClipboardLimit', () => {
  it('counts UTF-8 bytes', () => {
    expect(overClipboardLimit('a'.repeat(8), 8)).toBe(false)
    expect(overClipboardLimit('a'.repeat(9), 8)).toBe(true)
    expect(overClipboardLimit('世界世', 8)).toBe(true)
  })

  it('takes a mebibyte by default', () => {
    expect(overClipboardLimit('a'.repeat(1024 * 1024))).toBe(false)
    expect(overClipboardLimit('a'.repeat(1024 * 1024 + 1))).toBe(true)
  })
})
