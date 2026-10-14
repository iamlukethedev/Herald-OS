/*
 * What a QR code says, described without giving it away. QR codes routinely carry secrets (the
 * otpauth:// URI behind a 2FA setup code, a Wi-Fi password, a sign-in link), so captions,
 * notifications, the voice and Hermes get the kind of thing it is; the contents only go on the
 * clipboard. Ordinary links and text are passed on in full. When in doubt it hides: a harmless code
 * described vaguely costs little, a leaked secret a lot.
 *
 * linux/bin/herald-os has the same rules in Python, written to match line for line (no URL parser,
 * no locale-dependent decoding); both are checked against shared/qr-cases.json.
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

export const QR_COPIED = 'QR code copied'
const SECRET_DESCRIPTION = 'something that looks like a password, key or recovery phrase'

/** Words that mark the text around them as a secret wherever they appear. */
const SECRET_WORDS = /\b(pass(word|wd|code|phrase)s?|pwd|secret|token|api[ _-]?key|private[ _-]?key|recovery phrase|seed phrase|mnemonic)\b/i
/** Shorter words that only count as a label: "pin: 4821", "key=…". */
const SECRET_LABELS = /\b(pass|pin|key|seed|code|otp)\b\s*[:=]/i
/** Query and fragment parameter names that carry secrets. */
const SECRET_PARAM = /token|key|secret|pass|pwd|auth|code|sig|session|otp|credential/i
/** Path segments that make a link personal (an invitation, a reset, a sign-in). */
const SECRET_PATH = /invite|invitation|reset|verify|confirm|activate|magic|login|signin|sign-in|token|password|unsubscribe|redeem/i
/** scheme://user:password@… for any scheme. */
const CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s@]*:[^/?#\s@]*@/i
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const JWT = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/
const SEED_WORD = /^[a-z]{3,8}$/

/** A word in plain text this long (or longer) that mixes letters and digits is a token. */
export const TEXT_TOKEN_MIN = 12
/** The same for a path segment or a parameter value, where tokens are shorter. */
export const URL_TOKEN_MIN = 8
/** Base32 (letters only, too) and hex with no digits are tokens from this length. */
export const ENCODED_TOKEN_MIN = 16
/** Recovery phrases: 12 to 24 words; 11 still hides a phrase missing a word. */
export const RECOVERY_WORDS = { min: 11, max: 24 } as const

/** A name to show (an issuer, a network): trimmed, without control characters, and short. */
function label(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()

  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean
}

/** %xx as single bytes (Latin-1), the same in both implementations whatever the input. */
function percentBytes(value: string): string {
  return value.replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

/** Undo up to three rounds of URL encoding, enough to see otpauth%253A… for what it is. */
function decodeDeep(value: string): string {
  let out = value

  for (let round = 0; round < 3; round++) {
    out = percentBytes(out)
  }

  return out
}

/** For names shown to the person (an issuer): UTF-8 when it decodes, else as it was. */
function decodeLabel(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return value
  }
}

function params(query: string, decode: (value: string) => string): [string, string][] {
  return query
    .split('&')
    .filter(Boolean)
    .map(pair => {
      const [name, ...rest] = pair.split('=')

      return [decode(name), decode(rest.join('='))]
    })
}

const detect = (value: string) => percentBytes(value.replace(/\+/g, ' '))

/** How often a string switches between letters and digits, ignoring everything else. */
export function letterDigitSwitches(value: string): number {
  let last = ''
  let switches = 0

  for (const char of value) {
    const kind = /[A-Za-z]/.test(char) ? 'letter' : /[0-9]/.test(char) ? 'digit' : ''

    if (kind) {
      switches += last && kind !== last ? 1 : 0
      last = kind
    }
  }

  return switches
}

/**
 * A random-looking token: a JWT, base32, hex, or letters and digits switching back and forth
 * ("4eC39HqL…", "abc123SECRET"). Words and numbers joined up ("ORDER-2026-000123456",
 * "correct-horse-battery-staple-99") switch at most once and are left alone.
 */
export function looksLikeToken(value: string, min: number): boolean {
  if (value.length < min) {
    return false
  }

  if (JWT.test(value)) {
    return true
  }

  if (value.length >= ENCODED_TOKEN_MIN && (/^[A-Z2-7]+=*$/.test(value) || (/^[0-9a-f]+$/i.test(value) && /[a-f]/i.test(value)))) {
    return true
  }

  return letterDigitSwitches(value) >= 2
}

interface UriParts {
  authority: string | null
  path: string
  query: string
  fragment: string
}

function uriParts(uri: string): UriParts {
  let rest = uri.replace(SCHEME, '')
  let authority: string | null = null

  if (rest.startsWith('//')) {
    const end = rest.slice(2).search(/[/?#]/)
    authority = end < 0 ? rest.slice(2) : rest.slice(2, end + 2)
    rest = end < 0 ? '' : rest.slice(end + 2)
  }

  const hashAt = rest.indexOf('#')
  const fragment = hashAt < 0 ? '' : rest.slice(hashAt + 1)
  const beforeHash = hashAt < 0 ? rest : rest.slice(0, hashAt)
  const queryAt = beforeHash.indexOf('?')

  return {
    authority,
    path: queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt),
    query: queryAt < 0 ? '' : beforeHash.slice(queryAt + 1),
    fragment
  }
}

/** The host of scheme://[user@]host[:port]/…, lower case; '' when it is not a plain host name. */
function uriHost(uri: string): string {
  const { authority } = uriParts(uri)
  const host = (authority ?? '').split('@').pop()!.replace(/:\d*$/, '').toLowerCase()

  return /^[a-z0-9.-]+$/.test(host) && /[a-z0-9]/.test(host) ? host : ''
}

/** Whether a link (any scheme) carries something personal: credentials, a token, a 2FA code. */
export function uriLooksSecret(uri: string, depth = 0): boolean {
  if (CREDENTIALS.test(uri) || /otpauth/i.test(decodeDeep(uri))) {
    return true
  }

  const { path, query, fragment } = uriParts(uri)
  const segments = [...path.split('/'), ...(fragment.includes('=') ? [] : fragment.split('/'))].map(detect).filter(Boolean)

  if (segments.some(segment => SECRET_PATH.test(segment) || looksLikeToken(segment, URL_TOKEN_MIN))) {
    return true
  }

  const pairs = [...params(query, detect), ...(fragment.includes('=') ? params(fragment, detect) : [])]

  return pairs.some(([name, value]) => SECRET_PARAM.test(name) || looksLikeToken(value, URL_TOKEN_MIN) || (depth < 3 && SCHEME.test(value) && uriLooksSecret(value, depth + 1)))
}

/** A password, key, recovery phrase or credentialled link, as far as one can tell from the text. */
export function looksSecret(text: string): boolean {
  if (/private key/i.test(text) || SECRET_WORDS.test(text) || SECRET_LABELS.test(text) || /otpauth/i.test(decodeDeep(text))) {
    return true
  }

  const words = text.split(/[\s,]+/).filter(Boolean)

  if (words.length >= RECOVERY_WORDS.min && words.length <= RECOVERY_WORDS.max && words.every(word => SEED_WORD.test(word.toLowerCase()))) {
    return true
  }

  return text
    .split(/\s+/)
    .filter(Boolean)
    .some(word => (SCHEME.test(word) ? uriLooksSecret(word) : !word.includes('@') && looksLikeToken(word, TEXT_TOKEN_MIN)))
}

function describeOtp(text: string): QrReading {
  if (/^otpauth-migration:/i.test(text)) {
    return { kind: 'otp', caption: '2FA codes copied', description: 'a 2FA export from an authenticator app' }
  }

  const rest = text.replace(/^otpauth:\/\/[^/?#]*\/?/i, '')
  const queryAt = rest.indexOf('?')
  const name = decodeLabel(queryAt < 0 ? rest : rest.slice(0, queryAt))
  const query = queryAt < 0 ? '' : rest.slice(queryAt + 1).split('#')[0]
  const issuerParam = params(query, decodeLabel).find(([key]) => key.toLowerCase() === 'issuer')
  const issuer = label(issuerParam ? issuerParam[1] : name.includes(':') ? name.split(':')[0] : '')

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
  const host = /^https?:\/\/\S+$/i.test(text) ? uriHost(text) : ''

  if (!host) {
    return null
  }

  return uriLooksSecret(text)
    ? { kind: 'link', caption: `Link copied: ${host}`, description: `a link to ${host} that carries what looks like a password, key or sign-in token` }
    : { kind: 'link', caption: `Link copied: ${host}`, description: `a link to ${host}`, text }
}

/** A code with several lines is hidden whole when any line, or the whole, would be. */
function describeLines(text: string): QrReading {
  if (looksSecret(text)) {
    return { kind: 'secret', caption: QR_COPIED, description: SECRET_DESCRIPTION }
  }

  for (const line of text.split(/\r?\n/).map(part => part.trim()).filter(Boolean)) {
    const reading = describeQr(line)

    if (reading.text === undefined) {
      return { kind: reading.kind, caption: QR_COPIED, description: `text that includes ${reading.description}` }
    }
  }

  return { kind: 'text', caption: QR_COPIED, description: 'text', text }
}

/** One code's contents, described. Several codes are refused before this (see the readers). */
export function describeQr(raw: string): QrReading {
  const text = raw.trim()

  if (/[\r\n]/.test(text)) {
    return describeLines(text)
  }

  if (/^otpauth(-migration)?:/i.test(text)) {
    return describeOtp(text)
  }

  if (/^WIFI:/i.test(text)) {
    return describeWifi(text)
  }

  const link = describeLink(text)

  if (link) {
    return link
  }

  if (looksSecret(text)) {
    return { kind: 'secret', caption: QR_COPIED, description: SECRET_DESCRIPTION }
  }

  return { kind: 'text', caption: QR_COPIED, description: 'text', text }
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
