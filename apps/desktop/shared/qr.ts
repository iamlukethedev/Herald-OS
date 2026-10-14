/*
 * What a QR code says, described without giving it away. QR codes routinely carry secrets (the
 * otpauth:// URI behind a 2FA setup code, a Wi-Fi password), so captions, notifications, the voice
 * and Hermes get the kind of thing it is; the contents only go on the clipboard. Ordinary links and
 * text are passed on in full. linux/bin/herald-os has the same rules in Python; both are checked
 * against shared/qr-cases.json.
 */

export type QrKind = 'otp' | 'wifi' | 'link' | 'secret' | 'text'

export interface QrReading {
  kind: QrKind
  /** For captions, notifications and the voice: never the contents, only a link's host. */
  caption: string
  /** What it is, for Hermes ("a 2FA setup code for GitHub"). */
  description: string
  /** The full contents, only for ordinary links and text. */
  text?: string
}

const KINDS: readonly QrKind[] = ['otp', 'wifi', 'link', 'secret', 'text']

const COPIED = 'QR code copied'
const SENSITIVE_PARAM = /token|key|secret|pass|pwd|auth|code|sig|session|otp|credential/i
const LABELLED_SECRET = /\b(pass(word|wd|code|phrase)?|pwd|pin|secret|token|api[ _-]?key|private[ _-]?key|seed)\b\s*[:=]/i
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const RECOVERY_LENGTHS = new Set([12, 15, 18, 21, 24])

/** A name to show (an issuer, a network): trimmed, without control characters, and short. */
function label(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()

  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return value
  }
}

/** The query string's names and values, without relying on a URL parser's idea of the scheme. */
function params(query: string): Map<string, string> {
  const out = new Map<string, string>()

  for (const pair of query.split('&')) {
    if (!pair) {
      continue
    }

    const [name, ...rest] = pair.split('=')
    out.set(decode(name).toLowerCase(), decode(rest.join('=')))
  }

  return out
}

function describeOtp(text: string): QrReading {
  if (/^otpauth-migration:/i.test(text)) {
    return { kind: 'otp', caption: '2FA codes copied', description: 'a 2FA export from an authenticator app' }
  }

  const rest = text.replace(/^otpauth:\/\/[^/?#]*\/?/i, '')
  const [path, query = ''] = rest.split('?', 2)
  const fromLabel = decode(path).includes(':') ? decode(path).split(':')[0] : ''
  const issuer = label(params(query.split('#')[0]).get('issuer') ?? fromLabel)

  return { kind: 'otp', caption: '2FA setup code copied', description: issuer ? `a 2FA setup code for ${issuer}` : 'a 2FA setup code' }
}

/** WIFI:S:<name>;T:<WPA|WEP|nopass>;P:<password>;H:<true|false>;; with backslash escapes. */
export function wifiFields(text: string): Map<string, string> {
  const fields = new Map<string, string>()
  const body = text.replace(/^WIFI:/i, '')
  let current = ''
  let escaped = false

  const flush = () => {
    const at = current.indexOf(':')

    if (at > 0) {
      fields.set(current.slice(0, at).toUpperCase(), current.slice(at + 1))
    }

    current = ''
  }

  for (const char of body) {
    if (escaped) {
      current += char
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (char === ';') {
      flush()
    } else {
      current += char
    }
  }

  flush()

  return fields
}

function describeWifi(text: string): QrReading {
  const name = label(wifiFields(text).get('S') ?? '')

  return { kind: 'wifi', caption: 'Wi-Fi details copied', description: name ? `a Wi-Fi network called "${name}"` : 'Wi-Fi details' }
}

function describeLink(text: string): QrReading | null {
  let url: URL

  try {
    url = new URL(text)
  } catch {
    return null
  }

  const host = url.hostname

  if (!host) {
    return null
  }

  const named = [...params(url.search.slice(1)).keys(), ...params(url.hash.slice(1)).keys()]
  const carriesSecret = Boolean(url.username || url.password) || named.some(name => SENSITIVE_PARAM.test(name))

  return carriesSecret
    ? { kind: 'link', caption: `Link copied: ${host}`, description: `a link to ${host} that carries what looks like a password, key or sign-in token` }
    : { kind: 'link', caption: `Link copied: ${host}`, description: `a link to ${host}`, text }
}

/** A password, key or recovery phrase, as far as one can tell from the text alone. */
export function looksSecret(text: string): boolean {
  if (/PRIVATE KEY/.test(text) || LABELLED_SECRET.test(text)) {
    return true
  }

  const words = text.trim().split(/\s+/)

  if (RECOVERY_LENGTHS.has(words.length) && words.every(word => /^[a-z]{3,8}$/.test(word))) {
    return true
  }

  return /^\S{16,}$/.test(text) && !SCHEME.test(text) && !text.includes('@') && /[A-Za-z]/.test(text) && /\d/.test(text)
}

export function describeQr(raw: string): QrReading {
  const text = raw.trim()

  if (/^otpauth(-migration)?:/i.test(text)) {
    return describeOtp(text)
  }

  if (/^WIFI:/i.test(text)) {
    return describeWifi(text)
  }

  if (/^https?:\/\//i.test(text)) {
    const link = describeLink(text)

    if (link) {
      return link
    }
  }

  if (looksSecret(text)) {
    return { kind: 'secret', caption: COPIED, description: 'something that looks like a password, key or recovery phrase' }
  }

  return { kind: 'text', caption: COPIED, description: 'text', text }
}

/** The CLI's `capture qr --json` line, checked; null when it is anything else (an older CLI printed the contents). */
export function parseQrReading(output: string): QrReading | null {
  const line = output.trim().split('\n').pop() ?? ''

  try {
    const value = JSON.parse(line) as Partial<QrReading> | null

    if (!value || typeof value !== 'object' || !KINDS.includes(value.kind as QrKind) || typeof value.caption !== 'string' || typeof value.description !== 'string') {
      return null
    }

    return { kind: value.kind as QrKind, caption: value.caption, description: value.description, ...(typeof value.text === 'string' ? { text: value.text } : {}) }
  } catch {
    return null
  }
}
