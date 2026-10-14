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
  /** For captions, notifications and the voice: never a secret; at most a link, shortened (see shownLink). */
  caption: string
  /** What it is, for Hermes ("a 2FA setup code for GitHub"). */
  description: string
  /** The full contents, only for ordinary links and text. */
  text?: string
  /** A link with the parts that looked secret taken out (the clipboard has the whole link). */
  link?: string
}

const KINDS: readonly QrKind[] = ['otp', 'wifi', 'link', 'secret', 'text']

export const QR_COPIED = 'QR code copied'
const SECRET_DESCRIPTION = 'something that looks like a password, key or recovery phrase'

/** Words that mark the text around them as a secret wherever they appear. */
const SECRET_WORDS = /(?<![a-z0-9])(pass(word|wd|code|phrase)s?|pwd|secret|token|api[ _-]?key|private[ _-]?key|recovery phrase|seed phrase|mnemonic)(?![a-z])/i
/** Shorter words that only count as a label: "pin: 4821", "key=…". */
const SECRET_LABELS = /\b(pass|pin|key|seed|code|otp)\b\s*[:=]/i
/**
 * Parameter names that carry secrets, matched word by word, so access_token, X-Amz-Signature and
 * AWSAccessKeyId count and keywords, author or zipcode do not.
 */
const SECRET_NAME_WORDS = new Set(['token', 'key', 'apikey', 'secret', 'pass', 'passcode', 'password', 'passwd', 'pwd', 'sig', 'signature', 'auth', 'session', 'sessionid', 'otp', 'code', 'credential', 'credentials', 'jwt', 'bearer'])
/** Runs of digits, single spaces or dashes allowed between them, that are not part of a longer word. */
const DIGIT_RUN = /(?<![A-Za-z0-9_-])[0-9](?:[ -]?[0-9])*(?![A-Za-z0-9_-])/g
/** Token formats that are secret however they look: Slack, GitLab, Stripe, GitHub, OpenAI-style and AWS keys. */
const KNOWN_TOKEN = /^(xox[bpa]-|glpat-|sk_(live|test)_|gh[po]_|github_pat_|sk-|AKIA)[A-Za-z0-9_-]{8,}/
/** An AWS secret access key is 40 characters of base64; a character or two either way still counts. */
const AWS_SECRET_KEY = /^[A-Za-z0-9/+]{38,42}$/
/** "aws" as a word of its own (AWS_SECRET, aws:), not inside "laws". */
const AWS = /(?<![a-z])aws(?![a-z])/i
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const JWT = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/
const SEED_WORD = /^[a-z]{3,8}$/

/** A word in plain text shorter than this is never a token (known prefixes aside). */
export const TEXT_TOKEN_MIN = 12
/** The same for a path segment or a parameter value, where tokens are shorter. */
export const URL_TOKEN_MIN = 8
/** Base32 (letters only, too) and hex with no digits are tokens from this length. */
export const ENCODED_TOKEN_MIN = 16
/**
 * Words are judged chunk by chunk (the letters and digits between separators), and a chunk only
 * counts as random from this length.
 */
export const RANDOM_CHUNK_MIN = 8
/** Letters and digits switching this often, with no CamelCase word in the chunk, are random ("abc123SECRET"). */
export const LETTER_DIGIT_SWITCHES_MIN = 2
/** This often, they are random even with a CamelCase word ("Hunter2Hunter2Hunter2"); names switch twice at most. */
export const CAMEL_SWITCHES_MIN = 4
/** This many irregular switches in a row are random ("aZbYcX", "4eC39H"). */
export const IRREGULAR_SWITCHES_MIN = 3
/**
 * Acronym-like runs glued to lowercase ("DEFghi") this often in one chunk, with CASE_SWITCHES_MIN
 * case switches and MIXED_CASE_MIN characters, are random ("abcDEFghiJKLmnoP"). CamelCase names
 * have at most one ("PostgreSQLMySQLiteDB": SQLite).
 */
export const ACRONYM_RUNS_MIN = 2
export const CASE_SWITCHES_MIN = 4
export const MIXED_CASE_MIN = 16
/**
 * Such a chunk only counts when its lower-case runs average under this many letters: names are
 * made of words ("XMLHttpRequestJSONParser"), random strings have short runs.
 */
export const WORD_RUN_MIN = 4
/**
 * A whole word, its letters and digits taken together whatever separates them, is random from
 * RANDOM_WORD_MIN of them when they switch between letters and digits LETTER_DIGIT_SWITCHES_MIN
 * times and between cases WORD_CASE_SWITCHES_MIN times ("aB3-xY9", "q7Wz2Lp9"). A CamelCase word
 * only excuses words of CAMEL_WORD_MIN or more ("iPhone15ProMax", not "Win10Pro").
 */
export const RANDOM_WORD_MIN = 6
export const WORD_CASE_SWITCHES_MIN = 2
export const CAMEL_WORD_MIN = 10
/** Groups of letters and digits ("A1B2-C3D4"), each at least KEY_GROUP_MIN long, make a key. */
export const KEY_GROUPS_MIN = 2
export const KEY_GROUP_MIN = 3
/** Digits from this many in a run (or grouped) are secret, whatever they are: card numbers, account numbers. */
export const LONG_DIGITS_MIN = 16
/** Shorter runs from this many digits are secret when they start like a card (2 to 6) and pass the Luhn check. */
export const LUHN_DIGITS_MIN = 13
const CARD_LEAD = /^[2-6]/
/**
 * Captions show this many characters of a link at most, cut with … but never inside scheme://host;
 * a host this long or longer is not treated as one.
 */
export const SHOWN_LINK_MAX = 100
/**
 * Code points that belong with the one before: combining marks, joiners, variation selectors, skin
 * tones and tags. Listed by hand, as Python's re has no \p{…}, so both cut links alike.
 */
const EXTEND = /^[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u200c\u200d\u20d0-\u20ff\ufe00-\ufe0f\ufe20-\ufe2f\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007f}]$/u
const regional = (char: string) => /^[\u{1f1e6}-\u{1f1ff}]$/u.test(char)

/** `cut` (in code points), moved back so it doesn't split a combining mark, ZWJ sequence, skin tone, tag or flag. */
export function graphemeCut(chars: string[], cut: number): number {
  let at = cut

  while (at > 0 && (EXTEND.test(chars[at]) || chars[at - 1] === '\u200d')) {
    at--
  }

  let flags = 0

  while (flags < at && regional(chars[at - 1 - flags])) {
    flags++
  }

  return flags % 2 === 1 && regional(chars[at]) ? at - 1 : at
}
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

/** How often the letters in a string switch between upper and lower case. */
export function caseSwitches(value: string): number {
  let last = ''
  let switches = 0

  for (const char of value) {
    const kind = /[A-Z]/.test(char) ? 'upper' : /[a-z]/.test(char) ? 'lower' : ''

    if (kind) {
      switches += last && kind !== last ? 1 : 0
      last = kind
    }
  }

  return switches
}

type CharClass = 'upper' | 'lower' | 'digit'

/** A chunk as runs of upper case, lower case and digits: "iPhone15" is i, P, hone, 15. */
function runs(chunk: string): { kind: CharClass; length: number }[] {
  const out: { kind: CharClass; length: number }[] = []

  for (const char of chunk) {
    const kind: CharClass = /[A-Z]/.test(char) ? 'upper' : /[a-z]/.test(char) ? 'lower' : 'digit'
    const last = out[out.length - 1]

    if (last && last.kind === kind) {
      last.length++
    } else {
      out.push({ kind, length: 1 })
    }
  }

  return out
}

/**
 * The longest stretch of irregular switches: leaving a run of one character ("aZbY", "M3"). A
 * capital starting a CamelCase word ("Phone") is not counted and does not break the stretch;
 * leaving a longer run does.
 */
export function irregularSwitches(chunk: string): number {
  const parts = runs(chunk)
  let current = 0
  let longest = 0

  for (let i = 0; i + 1 < parts.length; i++) {
    if (parts[i].kind === 'upper' && parts[i].length === 1 && parts[i + 1].kind === 'lower') {
      continue
    }

    current = parts[i].length === 1 ? current + 1 : 0
    longest = Math.max(longest, current)
  }

  return longest
}

/** Upper-case runs of 2+ glued to 2+ lower-case letters ("DEFghi"). */
export function acronymRuns(chunk: string): number {
  const parts = runs(chunk)

  return parts.filter((part, i) => part.kind === 'upper' && part.length >= 2 && parts[i + 1]?.kind === 'lower' && parts[i + 1].length >= 2).length
}

/** Lower-case runs averaging under WORD_RUN_MIN letters. */
export function shortLowerRuns(chunk: string): boolean {
  const lower = runs(chunk).filter(part => part.kind === 'lower')

  return lower.reduce((sum, part) => sum + part.length, 0) < WORD_RUN_MIN * lower.length
}

/** A CamelCase word: a capital and two or more lower-case letters ("Phone", "Pro"). */
const CAMEL_WORD = /[A-Z][a-z]{2,}/

function randomChunk(chunk: string): boolean {
  if (chunk.length >= RANDOM_CHUNK_MIN) {
    const switches = letterDigitSwitches(chunk)

    if (switches >= CAMEL_SWITCHES_MIN || (switches >= LETTER_DIGIT_SWITCHES_MIN && !CAMEL_WORD.test(chunk))) {
      return true
    }

    if (irregularSwitches(chunk) >= IRREGULAR_SWITCHES_MIN) {
      return true
    }
  }

  return chunk.length >= MIXED_CASE_MIN && caseSwitches(chunk) >= CASE_SWITCHES_MIN && acronymRuns(chunk) >= ACRONYM_RUNS_MIN && shortLowerRuns(chunk)
}

/** A whole word that looks random, judged on its letters and digits together (see RANDOM_WORD_MIN). */
export function randomWord(value: string): boolean {
  const word = value.replace(/[^A-Za-z0-9]/g, '')

  return (
    word.length >= RANDOM_WORD_MIN &&
    letterDigitSwitches(word) >= LETTER_DIGIT_SWITCHES_MIN &&
    caseSwitches(word) >= WORD_CASE_SWITCHES_MIN &&
    (word.length < CAMEL_WORD_MIN || !CAMEL_WORD.test(word))
  )
}

/** Shaped like an AWS secret access key: about 40 characters of base64, mixing upper case, lower case and digits. */
export function awsKey(word: string): boolean {
  return AWS_SECRET_KEY.test(word) && /[A-Z]/.test(word) && /[a-z]/.test(word) && /[0-9]/.test(word)
}

/**
 * A random-looking token: a known key format, an AWS secret key with / or +, a grouped key, a
 * random word (these at any length), or from `min` characters a JWT, base32, hex, or a chunk that
 * looks random (see randomChunk). Names stay text: "iPhone15ProMax", "NETGEAR-5G-Guest",
 * "TheQuickBrownFoxJumps", "ORDER-2026-000123456", "correct-horse-battery-staple-99".
 */
export function looksLikeToken(value: string, min: number): boolean {
  if (KNOWN_TOKEN.test(value) || (awsKey(value) && /[/+]/.test(value))) {
    return true
  }

  const chunks = value.split(/[^A-Za-z0-9]+/).filter(Boolean)
  const keyGroups = chunks.length >= KEY_GROUPS_MIN && chunks.every(chunk => chunk.length >= KEY_GROUP_MIN && /[A-Za-z]/.test(chunk) && /[0-9]/.test(chunk))

  if (keyGroups || randomWord(value)) {
    return true
  }

  if (value.length < min) {
    return false
  }

  if (JWT.test(value)) {
    return true
  }

  if (value.length >= ENCODED_TOKEN_MIN && (/^[A-Z2-7]+=*$/.test(value) || (/^[0-9a-f]+$/i.test(value) && /[a-f]/i.test(value)))) {
    return true
  }

  return chunks.some(randomChunk)
}

/** The Luhn checksum card numbers carry. */
export function luhn(digits: string): boolean {
  let sum = 0

  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i])

    if (i % 2 === 1) {
      digit *= 2
      digit -= digit > 9 ? 9 : 0
    }

    sum += digit
  }

  return sum % 10 === 0
}

/** An EAN-13 barcode's own checksum. */
export function ean13(digits: string): boolean {
  if (digits.length !== 13) {
    return false
  }

  let sum = 0

  for (let i = 0; i < 12; i++) {
    sum += Number(digits[i]) * (i % 2 === 1 ? 3 : 1)
  }

  return (sum + Number(digits[12])) % 10 === 0
}

/**
 * A card or account number: 16 or more digits, in a row or grouped (1234-5678-9012-3456-7890), or
 * 13 to 15 that start with 2 to 6, as cards do, and pass Luhn. An unbroken valid EAN-13 is a
 * product barcode and stays text. Phone numbers (15 digits at most) and short order numbers only
 * count when they happen to start that way and pass Luhn.
 */
export function digitsLookSecret(text: string): boolean {
  for (const run of text.match(DIGIT_RUN) ?? []) {
    const digits = run.replace(/[ -]/g, '')

    if (digits.length >= LONG_DIGITS_MIN) {
      return true
    }

    if (digits.length >= LUHN_DIGITS_MIN && CARD_LEAD.test(digits) && luhn(digits) && !(run === digits && ean13(digits))) {
      return true
    }
  }

  return false
}

/** A parameter name's words, lower case: "AWSAccessKeyId" is aws, access, key, id. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(word => word.toLowerCase())
}

const secretName = (name: string) => nameWords(name).some(word => SECRET_NAME_WORDS.has(word))

/**
 * Sites whose links carry public ids that look like tokens: a video, a commit, a product, a post, a
 * track, a shared file. Those ids are only checked for strong signs of a secret (see strongSecret).
 * A path segment is public when it follows one of `after` (or is the first, with `first`).
 */
interface PublicIds {
  host: RegExp
  after?: string[]
  first?: boolean
  segment?: RegExp
  params?: string[]
}

const PUBLIC_IDS: readonly PublicIds[] = [
  { host: /(^|\.)youtube\.com$/, after: ['shorts', 'embed', 'live'], params: ['v', 'list', 'si'] },
  { host: /^youtu\.be$/, first: true, params: ['si'] },
  { host: /^(www\.)?github\.com$/, after: ['commit', 'commits', 'blob', 'tree'], segment: /^[0-9a-f]{7,40}$/ },
  { host: /(^|\.)amazon(\.[a-z]{2,3}){1,2}$/, after: ['dp', 'product'] },
  { host: /(^|\.)instagram\.com$/, after: ['p', 'reel'], params: ['igsh'] },
  { host: /^open\.spotify\.com$/, after: ['track', 'album', 'playlist', 'artist', 'episode', 'show'], params: ['si'] },
  { host: /^(drive|docs)\.google\.com$/, after: ['d', 'folders'], params: ['id'] }
]

function publicSegment(rule: PublicIds | undefined, segments: string[], index: number): boolean {
  if (!rule) {
    return false
  }

  const placed = (rule.first === true && index === 0) || (index > 0 && (rule.after ?? []).includes(segments[index - 1]))

  return placed && (!rule.segment || rule.segment.test(segments[index]))
}

/** Signs of a secret that count even in a site's public ids. */
function strongSecret(value: string): boolean {
  return KNOWN_TOKEN.test(value) || JWT.test(value) || digitsLookSecret(value) || /otpauth/i.test(decodeDeep(value))
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

/** The host of scheme://[user@]host[:port]/…, lower case; '' when it is not a plain host name short enough to show. */
function hostOf(authority: string | null): string {
  const host = (authority ?? '').split('@').pop()!.replace(/:\d*$/, '').toLowerCase()

  return /^[a-z0-9.-]+$/.test(host) && /[a-z0-9]/.test(host) && host.length < SHOWN_LINK_MAX ? host : ''
}

export interface LinkCheck {
  /** A secret in the path, or one that cannot be cut out: only the host may be shown. */
  hostOnly: boolean
  /** Credentials, parameters or a fragment were cut out of `link`. */
  removed: boolean
  /** The link without the parts that looked secret; the link itself when nothing was. */
  link: string
}

/**
 * What in a link (any scheme) looks secret. Credentials and secret query or fragment parameters
 * can be cut out; a secret path segment cannot, so then only the host may be shown.
 */
export function checkLink(uri: string, depth = 0): LinkCheck {
  const { authority, path, query, fragment } = uriParts(uri)
  const rule = PUBLIC_IDS.find(entry => entry.host.test(hostOf(authority)))
  const at = authority === null ? -1 : authority.lastIndexOf('@')
  // user:password@, with the colon written out or URL-encoded.
  const credentials = at >= 0 && decodeDeep(authority!.slice(0, at)).includes(':')

  const secretPart = (value: string, isPublic: boolean) =>
    strongSecret(value) || (!isPublic && (looksLikeToken(value, URL_TOKEN_MIN) || (depth < 3 && SCHEME.test(value) && uriLooksSecret(value, depth + 1))))
  const keepPair = (pair: string) => {
    const [name, ...rest] = pair.split('=')
    const isPublic = (rule?.params ?? []).includes(detect(name))

    return !secretName(detect(name)) && !secretPart(detect(rest.join('=')), isPublic)
  }

  const segments = path.split('/').filter(Boolean)
  const pairs = query.split('&').filter(Boolean)
  const kept = pairs.filter(keepPair)
  const fragmentPairs = fragment.includes('=') ? fragment.split('&').filter(Boolean) : []
  const keptFragment = fragment.includes('=')
    ? fragmentPairs.filter(keepPair).join('&')
    : fragment.split('/').some(part => part && secretPart(detect(part), false)) ? '' : fragment
  const removed = credentials || kept.length !== pairs.length || keptFragment !== fragment

  const scheme = (uri.match(SCHEME) ?? [''])[0]
  const link = removed
    ? `${scheme}${authority === null ? '' : `//${authority.slice(at + 1)}`}${path}${kept.length > 0 ? `?${kept.join('&')}` : ''}${keptFragment ? `#${keptFragment}` : ''}`
    : uri
  const hostOnly = segments.some((segment, index) => secretPart(detect(segment), publicSegment(rule, segments, index))) || /otpauth/i.test(decodeDeep(link))

  return { hostOnly, removed, link }
}

/** Whether a link (any scheme) carries something secret: credentials, a token, a 2FA code. */
export function uriLooksSecret(uri: string, depth = 0): boolean {
  const { hostOnly, removed } = checkLink(uri, depth)

  return hostOnly || removed
}

/** A password, key, recovery phrase or credentialled link, as far as one can tell from the text. */
export function looksSecret(text: string): boolean {
  if (/private key/i.test(text) || SECRET_WORDS.test(text) || SECRET_LABELS.test(text) || /otpauth/i.test(decodeDeep(text)) || digitsLookSecret(text)) {
    return true
  }

  const words = text.split(/[\s,]+/).filter(Boolean)

  if (words.length >= RECOVERY_WORDS.min && words.length <= RECOVERY_WORDS.max && words.every(word => SEED_WORD.test(word.toLowerCase()))) {
    return true
  }

  if (AWS.test(text) && text.split(/\s+/).some(word => [word, ...labelParts(word)].some(awsKey))) {
    return true
  }

  return text
    .split(/\s+/)
    .filter(Boolean)
    .some(
      word =>
        (SCHEME.test(word) ? uriLooksSecret(word) : !word.includes('@') && looksLikeToken(word, TEXT_TOKEN_MIN)) ||
        (!word.includes('@') && labelParts(word).some(part => looksLikeToken(part, TEXT_TOKEN_MIN)))
    )
}

/** A name=value or name:value word in its parts (AWS_SECRET_ACCESS_KEY=…); none for scheme://… links. */
export function labelParts(word: string): string[] {
  if (SCHEME.test(word) && word.replace(SCHEME, '').startsWith('//')) {
    return []
  }

  return /[=:]/.test(word) ? word.split(/[=:]/).filter(Boolean) : []
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

/**
 * A link for the caption: at most SHOWN_LINK_MAX characters (code points, as in Python), cut with …
 * after scheme://host at the earliest; the host alone and … when even that is too long.
 */
export function shownLink(link: string, host: string): string {
  const chars = Array.from(link)

  if (chars.length <= SHOWN_LINK_MAX) {
    return link
  }

  const authority = link.match(/^[^:]*:\/\/[^/?#]*/)

  if (authority && Array.from(authority[0]).length >= SHOWN_LINK_MAX) {
    return `${host}…`
  }

  return `${chars.slice(0, graphemeCut(chars, SHOWN_LINK_MAX - 1)).join('')}…`
}

/**
 * Ordinary links are shown in full. A link that carries a secret is shown without it when it can be
 * cut out (credentials, a parameter, the fragment), and as its host alone when it cannot. Captions
 * shorten long links (see shownLink); `text` and `link` keep them whole.
 */
function describeLink(text: string): QrReading | null {
  const host = /^https?:\/\/\S+$/i.test(text) ? hostOf(uriParts(text).authority) : ''

  if (!host) {
    return null
  }

  const { hostOnly, removed, link } = checkLink(text)

  if (hostOnly) {
    return { kind: 'link', caption: `Link copied: ${host}`, description: `a link to ${host} that carries what looks like a password, key or sign-in token` }
  }

  return removed
    ? { kind: 'link', caption: `Link copied: ${shownLink(link, host)}`, description: `a link to ${host}, with the parts that looked secret removed`, link }
    : { kind: 'link', caption: `Link copied: ${shownLink(text, host)}`, description: `a link to ${host}`, text }
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

    return {
      kind: value.kind as QrKind,
      caption: value.caption,
      description: value.description,
      ...(typeof value.text === 'string' ? { text: value.text } : {}),
      ...(typeof value.link === 'string' ? { link: value.link } : {})
    }
  } catch {
    return null
  }
}
