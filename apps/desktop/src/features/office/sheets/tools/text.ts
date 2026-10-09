/*
 * Text as the data tools read it, with no workbook involved: numbers written with separators,
 * currency symbols, percent signs and accountants' negatives; dates in a given order of day, month
 * and year; parts split at a delimiter; and text cleaned or put in another case. Numbers and dates
 * are read as Herald Sheets' locale writes them (en-US: 1,234.50).
 */

/** Spaces that look like one: tabs, line breaks, non-breaking and thin spaces. */
const SPACES = /[\t\n\r\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g
/** Characters that print nothing: controls, the soft hyphen, zero-width spaces, the byte-order mark. */
const NON_PRINTING = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B\u2060\uFEFF]/g

/** Text trimmed, its inner runs of spaces made one, and characters that print nothing taken out. */
export function cleanText(text: string): string {
  return text.replace(SPACES, ' ').replace(NON_PRINTING, '').replace(/ {2,}/g, ' ').trim()
}

export type TextCase = 'upper' | 'lower' | 'title' | 'sentence'

export const TEXT_CASES: readonly TextCase[] = ['upper', 'lower', 'title', 'sentence']

/** Text in UPPER, lower, Title Case (each word's first letter) or Sentence case (each sentence's first letter). */
export function changeCaseOf(text: string, to: TextCase): string {
  if (to === 'upper') {
    return text.toUpperCase()
  }

  const lower = text.toLowerCase()

  if (to === 'lower') {
    return lower
  }

  // A letter after an apostrophe or a digit goes on a word ("don't", "2nd").
  const first = to === 'title' ? /(^|[^\p{L}\p{N}'’])(\p{L})/gu : /(^[^\p{L}\p{N}]*|[.!?]\s+)(\p{L})/gu

  return lower.replace(first, (_whole, before: string, letter: string) => before + letter.toUpperCase())
}

const CURRENCY = '$€£¥₹₩₽₺₪₫฿₦₱¢'
const NUMBER = new RegExp(
  `^(?<sign>[-+−])?\\s*(?<before>[${CURRENCY}])?\\s*(?<inner>[-+−])?\\s*(?<digits>\\d[\\d, '\\u202F]*(?:\\.\\d*)?|\\.\\d+)(?:[eE](?<exponent>[-+]?\\d{1,3}))?\\s*(?<after>[${CURRENCY}])?\\s*(?<percent>%)?\\s*(?<trailing>[-−])?$`
)
/** Groups of three digits, all set apart by the same separator. */
const GROUPED = /^\d{1,3}(?:([, '\u202F])\d{3}(?:\1\d{3})*)?(?:\.\d*)?$/

/**
 * A number written as text: thousands separators, a currency symbol before or after, a percent
 * sign, a minus before or after or parentheses around for a negative; with the number format that
 * shows it the same way ("$1,234.50" is 1234.5 in "$"#,##0.00), or null when General shows it so.
 * Null when the text is not a number.
 */
export function parseNumberText(input: string): { value: number; format: string | null } | null {
  let text = input.replace(SPACES, ' ').replace(NON_PRINTING, '').trim()
  let negative = false
  const parenthesised = /^\((.+)\)$/.exec(text)

  if (parenthesised) {
    negative = true
    text = parenthesised[1].trim()
  }

  const match = NUMBER.exec(text)
  const parts = match?.groups

  if (!parts) {
    return null
  }

  const signs = [parts.sign, parts.inner, parts.trailing].filter(Boolean)

  if (signs.length > 1 || (negative && signs.length) || (parts.before && parts.after) || ((parts.before || parts.after) && parts.percent) || !GROUPED.test(parts.digits.trim())) {
    return null
  }

  negative ||= signs.length === 1 && signs[0] !== '+'
  const digits = parts.digits.replace(/[, '\u202F]/g, '')
  const exponent = Number(parts.exponent ?? 0) - (parts.percent ? 2 : 0)
  const value = Number(`${digits}e${exponent}`) * (negative ? -1 : 1)

  if (!Number.isFinite(value)) {
    return null
  }

  const decimals = digits.includes('.') ? digits.length - digits.indexOf('.') - 1 : 0
  const fraction = decimals ? `.${'0'.repeat(Math.min(decimals, 10))}` : ''
  const symbol = parts.before || parts.after
  let format: string | null = null

  if (parts.percent) {
    format = `0${fraction}%`
  } else if (symbol) {
    format = parts.before ? `"${symbol}"#,##0${fraction}` : `#,##0${fraction} "${symbol}"`
  } else if (/[, '\u202F]/.test(parts.digits.trim())) {
    format = `#,##0${fraction}`
  }

  return { value: Object.is(value, -0) ? 0 : value, format }
}

export type DateOrder = 'DMY' | 'MDY' | 'YMD'

export const DATE_ORDERS: readonly DateOrder[] = ['DMY', 'MDY', 'YMD']

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAY = /^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i
const TIME = /(?:^|[\sT])(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(?:([ap])\.?m\.?)?$/i
const DAY_MS = 86400000
const EPOCH = Date.UTC(1899, 11, 30)

/** A day as Excel counts it from 1 January 1900 (which is 1, with Excel's 29 February 1900 before 1 March); null before then. */
export function dateSerial(year: number, month: number, day: number): number | null {
  const days = (Date.UTC(year, month - 1, day) - EPOCH) / DAY_MS
  // Excel counts a 29 February 1900 that never was, so days before March are one fewer.
  const serial = days < 61 ? days - 1 : days

  return serial >= 1 ? serial : null
}

const MONTH_NAMES = 'january february march april may june july august september october november december sept'.split(' ')

/** A month's name or its first three letters (with a full stop or not) as its number; 0 for other words. */
const monthOf = (word: string): number => {
  const name = word.toLowerCase().replace(/\.$/, '')
  const index = MONTHS.indexOf(name.slice(0, 3))

  return index >= 0 && (name.length === 3 || MONTH_NAMES.includes(name)) ? index + 1 : 0
}

const fullYear = (text: string): number => {
  const year = Number(text)

  // Two digits are 1930 to 2029, as in Excel.
  return text.length <= 2 ? (year < 30 ? 2000 + year : 1900 + year) : year
}

/**
 * A date written as text, in `order` when it is all numbers ("31/12/2025" in DMY), or with the
 * month's name ("31 Dec 2025", "Dec 31, 2025"); a year written first with four digits reads as
 * year, month, day whatever the order. A time may follow ("14:30", "2:30 pm"). The result is a
 * date serial, whole days and the time as a fraction, and the time's format ("" for none); null
 * when the text is not a date.
 */
export function parseDateText(input: string, order: DateOrder): { serial: number; time: '' | 'hh:mm' | 'hh:mm:ss' } | null {
  let text = cleanText(input).replace(WEEKDAY, '')
  const time = TIME.exec(text)
  let fraction = 0

  if (time) {
    let hours = Number(time[1])
    const minutes = Number(time[2])
    const seconds = Number(time[3] ?? 0)
    const half = time[4]?.toLowerCase()

    if (minutes > 59 || seconds > 59 || (half ? hours < 1 || hours > 12 : hours > 23)) {
      return null
    }

    hours = half ? (hours % 12) + (half === 'p' ? 12 : 0) : hours
    fraction = (hours * 3600 + minutes * 60 + seconds) / 86400
    text = text.slice(0, time.index).trim()
  }

  if (!/^[\p{L}\d]+(?:(?:[\s/.,-]+|,\s*)[\p{L}\d]+){2}\.?$/u.test(text)) {
    return null
  }

  const tokens = text.match(/[\p{L}]+\.?|\d+/gu) ?? []
  const words = tokens.filter((token) => !/^\d+$/.test(token))
  const numbers = tokens.filter((token) => /^\d+$/.test(token))
  let year: string
  let month: number
  let day: string

  if (words.length === 1 && numbers.length === 2) {
    // With the month named, a four-digit or too large number is the year; else the order says whether a leading number is.
    const [first, second] = numbers
    const firstIsYear = first.length === 4 || Number(first) > 31 || (order === 'YMD' && tokens[0] === first && second.length <= 2)
    month = monthOf(words[0])
    year = firstIsYear ? first : second
    day = firstIsYear ? second : first
  } else if (numbers.length === 3 && !words.length) {
    const [a, b, c] = numbers
    const [y, m, d] = a.length === 4 || order === 'YMD' ? [a, b, c] : order === 'DMY' ? [c, b, a] : [c, a, b]
    year = y
    month = Number(m)
    day = d
  } else {
    return null
  }

  if ((year.length !== 2 && year.length !== 4) || day.length > 2) {
    return null
  }

  const y = fullYear(year)
  const d = Number(day)
  const days = new Date(Date.UTC(y, month, 0)).getUTCDate()

  if (month < 1 || month > 12 || d < 1 || d > days) {
    return null
  }

  const serial = dateSerial(y, month, d)

  return serial === null ? null : { serial: serial + fraction, time: !time ? '' : time[3] ? 'hh:mm:ss' : 'hh:mm' }
}

export const DELIMITERS = { comma: ',', semicolon: ';', tab: '\t', space: ' ' } as const

export type Delimiter = keyof typeof DELIMITERS | 'other'

/**
 * Text cut at a delimiter. A part in double quotes keeps the delimiters inside it (and "" for a
 * quote), as CSV writes them; parts are trimmed; with `consecutive`, runs of the delimiter count as
 * one and empty parts go.
 */
export function splitParts(text: string, delimiter: string, consecutive: boolean): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  let i = 0

  while (i < text.length) {
    const char = text[i]

    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        current += '"'
        i += 2
      } else if (char === '"') {
        quoted = false
        i++
      } else {
        current += char
        i++
      }

      continue
    }

    if (char === '"' && !current.trim()) {
      quoted = true
      current = ''
      i++
    } else if (text.startsWith(delimiter, i)) {
      parts.push(current)
      current = ''
      i += delimiter.length
    } else {
      current += char
      i++
    }
  }

  parts.push(current)
  const trimmed = parts.map((part) => (delimiter.trim() ? part.trim() : part))

  return consecutive ? trimmed.filter((part) => part !== '') : trimmed
}

/** A part as a cell holds it: a plain number as a number (not one with leading zeros, which is kept as written), empty as nothing. */
export function typedPart(part: string): string | number | null {
  if (!part) {
    return null
  }

  return /^[-+]?(?:(?:0|[1-9]\d*)(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(part) && Number.isFinite(Number(part)) ? Number(part) : part
}
