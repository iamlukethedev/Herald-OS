import { describe, expect, it } from 'vitest'
import { overClipboardLimit, sanitizePaste } from './terminal-clipboard.ts'

const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/

describe('sanitizePaste', () => {
  it('keeps text, tabs and line breaks as they are', () => {
    const text = 'ls -la\tdocs\r\necho "héllo 世界 🙂"\nprintf "a\\tb"\r\n\tindented\n'

    expect(sanitizePaste(text)).toBe(text)
  })

  it.each([
    ['at the start', '\x1b[201~echo pwned\r', 'echo pwned\r'],
    ['in the middle', 'echo safe\x1b[201~echo pwned\r', 'echo safe' + 'echo pwned\r'],
    ['at the end', 'echo safe\x1b[201~', 'echo safe'],
    ['opening a paste', '\x1b[200~echo pwned\x1b[201~\r', 'echo pwned\r'],
    ['twice', 'a\x1b[201~b\x1b[200~c\x1b[201~', 'abc']
  ])('takes out a bracketed-paste marker %s, leaving nothing of it', (_label, text, expected) => {
    expect(sanitizePaste(text)).toBe(expected)
    expect(sanitizePaste(text)).not.toMatch(/20[01]~/)
  })

  it.each([
    ['at the start', '\x9b201~echo pwned\r', 'echo pwned\r'],
    ['in the middle', 'echo safe\x9b200~x\x9b201~echo pwned\r', 'echo safexecho pwned\r']
  ])('takes out the 8-bit CSI marker %s', (_label, text, expected) => {
    expect(sanitizePaste(text)).toBe(expected)
  })

  it.each([
    ['a bare ESC', 'a\x1bb\x1b', 'ab'],
    ['ESC left after a marker', '\x1b\x1b[201~x', 'x'],
    ['another escape sequence', 'a\x1b]0;title\x07b\x1b[2Jc', 'a]0;titleb[2Jc'],
    ['the C1 control sequence introducer', 'a\x9b2Jb', 'a2Jb'],
    ['every C1 control', `a${String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 0x80 + i))}b`, 'ab'],
    ['DEL', 'a\x7fb', 'ab'],
    ['NUL, ^C, ^D, ^Z and the other C0 controls', 'a\x00\x03\x04\x08\x0b\x0c\x0e\x1a\x1fb', 'ab']
  ])('drops %s', (_label, text, expected) => {
    expect(sanitizePaste(text)).toBe(expected)
    expect(sanitizePaste(text)).not.toMatch(CONTROLS)
  })

  it('leaves a nested marker as plain text, with no ESC left to act on', () => {
    expect(sanitizePaste('echo safe\x1b[20\x1b[201~1~echo pwned\r')).toBe('echo safe[201~echo pwned\r')
    expect(sanitizePaste('\x9b20\x9b201~1~x')).toBe('201~x')
  })

  it('cannot be fooled by a marker split across two pastes', () => {
    const joined = sanitizePaste('echo safe\x1b') + sanitizePaste('[201~echo pwned\r')

    expect(joined).not.toMatch(CONTROLS)
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
