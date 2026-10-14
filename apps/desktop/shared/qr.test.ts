import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { describeQr, parseQrReading, SHOWN_LINK_MAX, wifiFields } from './qr.ts'

interface QrCase {
  text: string
  kind: string
  caption: string
  description: string
  full?: boolean
  hidden?: string[]
  link?: string
}

// linux/tests/test_cli.py checks the CLI's Python copy of these rules against the same cases.
const cases = JSON.parse(fs.readFileSync(new URL('./qr-cases.json', import.meta.url), 'utf8')) as QrCase[]

describe('describeQr', () => {
  it.each(cases)('$kind: $text', ({ text, kind, caption, description, full, hidden, link }) => {
    const reading = describeQr(text)

    expect(reading).toMatchObject({ kind, caption, description })
    expect(reading.link).toBe(link)

    if (full) {
      expect(reading.text).toBe(text.trim())
    } else {
      expect(reading).not.toHaveProperty('text')

      for (const secret of hidden ?? []) {
        expect(JSON.stringify(reading)).not.toContain(secret)
      }
    }
  })

  it('covers every kind', () => {
    expect(new Set(cases.map(entry => entry.kind))).toEqual(new Set(['otp', 'wifi', 'link', 'secret', 'text']))
  })

  it('reads Wi-Fi fields with their escapes', () => {
    expect(Object.fromEntries(wifiFields('WIFI:S:a\\;b\\:c;P:p\\\\w;;'))).toEqual({ S: 'a;b:c', P: 'p\\w' })
  })

  it('keeps captions short and the link whole', () => {
    const long = `https://example.com/${'x'.repeat(1980)}`
    const shown = describeQr(long)

    expect(long).toHaveLength(2000)
    expect(shown.caption).toBe(`Link copied: ${long.slice(0, SHOWN_LINK_MAX - 1)}…`)
    expect(shown.caption.length).toBeLessThanOrEqual(13 + SHOWN_LINK_MAX)
    expect(shown.text).toBe(long)

    const cut = describeQr(`${long}?token=abc`)

    expect(cut.caption).toBe(shown.caption)
    expect(cut.link).toBe(long)
  })

  it('keeps names short and printable', () => {
    expect(describeQr(`otpauth://totp/x?secret=A&issuer=${'Long'.repeat(20)}`).description).toBe(`a 2FA setup code for ${'Long'.repeat(10).slice(0, 39)}…`)
    expect(describeQr('WIFI:S:Ho\u0007me;;').description).toBe('a Wi-Fi network called "Home"')
  })
})

describe('parseQrReading', () => {
  it('takes the CLI line that describes the code', () => {
    expect(parseQrReading('{"kind": "otp", "caption": "2FA setup code copied", "description": "a 2FA setup code"}\n')).toEqual({ kind: 'otp', caption: '2FA setup code copied', description: 'a 2FA setup code' })
    expect(parseQrReading('{"kind": "link", "caption": "Link copied: example.com", "description": "a link to example.com", "text": "https://example.com"}')).toMatchObject({ text: 'https://example.com' })
  })

  it('keeps a link with its secret parts taken out', () => {
    expect(parseQrReading('{"kind": "link", "caption": "Link copied: https://a.example/j/1", "description": "a link to a.example, with the parts that looked secret removed", "link": "https://a.example/j/1"}')).toEqual({
      kind: 'link',
      caption: 'Link copied: https://a.example/j/1',
      description: 'a link to a.example, with the parts that looked secret removed',
      link: 'https://a.example/j/1'
    })
    expect(parseQrReading('{"kind": "link", "caption": "x", "description": "y", "link": 3}')).not.toHaveProperty('link')
  })

  it('refuses anything else, such as an older CLI printing the contents', () => {
    expect(parseQrReading('otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP')).toBeNull()
    expect(parseQrReading('{"kind": "otp"}')).toBeNull()
    expect(parseQrReading('{"kind": "password", "caption": "x", "description": "y"}')).toBeNull()
    expect(parseQrReading('null')).toBeNull()
    expect(parseQrReading('')).toBeNull()
  })
})
