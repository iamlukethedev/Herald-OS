/*
 * Numbers as the keypads show them: Latin digits, grouped and marked the way the person's locale
 * writes them, cut to what fits, and in scientific notation once a value no longer does.
 */

export const MINUS = '\u2212'
/** The most digits the big display shows. */
export const DISPLAY_DIGITS = 16
/** Below 0.000000x a value is shown in scientific notation. */
const SMALLEST_POINT = -6

export interface NumberSymbols {
  group: string
  decimal: string
}

const formats = new Map<string, Intl.NumberFormat>()
const symbols = new Map<string, NumberSymbols>()

/** The locale's number format with Latin digits; the system's when the tag does not read. */
function numberFormat(locale?: string): Intl.NumberFormat {
  const key = locale ?? ''
  let format = formats.get(key)

  if (!format) {
    try {
      format = new Intl.NumberFormat(locale, { numberingSystem: 'latn' })
    } catch {
      format = new Intl.NumberFormat(undefined, { numberingSystem: 'latn' })
    }

    formats.set(key, format)
  }

  return format
}

export function numberSymbols(locale?: string): NumberSymbols {
  const key = locale ?? ''
  const known = symbols.get(key)

  if (known) {
    return known
  }

  const parts = numberFormat(locale).formatToParts(12345.6)
  const found = { group: parts.find(part => part.type === 'group')?.value ?? ',', decimal: parts.find(part => part.type === 'decimal')?.value ?? '.' }
  symbols.set(key, found)

  return found
}

/** Whole digits grouped the locale's way: "1,234,567", "12,34,567" in en-IN, "1234" in es. */
export function groupInteger(digits: string, locale?: string): string {
  return /^\d+$/.test(digits) ? numberFormat(locale).format(BigInt(digits)) : digits
}

/** A decimal as its significant digits and where the point falls: value = 0.digits × 10^point. */
interface Digits {
  negative: boolean
  /** No leading or trailing zeros; empty for zero. */
  digits: string
  point: number
}

const NUMBER = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i
const SPECIAL = new Map([
  ['Infinity', '∞'],
  ['+Infinity', '∞'],
  ['-Infinity', `${MINUS}∞`],
  ['NaN', 'Not a number']
])

function readDigits(value: string): Digits | null {
  const match = NUMBER.exec(value.trim())

  if (!match || `${match[2]}${match[3] ?? ''}` === '') {
    return null
  }

  const [, sign, whole, fraction = '', exponent = '0'] = match
  const all = `${whole}${fraction}`
  const leading = all.length - all.replace(/^0+/, '').length
  const digits = all.slice(leading).replace(/0+$/, '')

  return { negative: sign === '-' && digits !== '', digits, point: digits ? whole.length + Number(exponent) - leading : 0 }
}

/** `value` cut to `keep` significant digits, rounding half away from zero. */
function roundDigits(value: Digits, keep: number): Digits {
  if (value.digits.length <= keep) {
    return value
  }

  const up = keep >= 0 && value.digits[keep] >= '5'

  if (keep <= 0) {
    return up ? { ...value, digits: '1', point: value.point + 1 } : { negative: false, digits: '', point: 0 }
  }

  const head = value.digits.slice(0, keep)
  const rounded = up ? (BigInt(head) + 1n).toString() : head

  return { ...value, digits: rounded.replace(/0+$/, ''), point: value.point + (rounded.length > keep ? 1 : 0) }
}

/** `value` rounded to fit `max` digits written out in full, or null when it needs an exponent. */
function plain(value: Digits, max: number): Digits | null {
  if (!value.digits) {
    return value
  }

  if (value.point > max || value.point < SMALLEST_POINT) {
    return null
  }

  const rounded = roundDigits(value, value.point > 0 ? max : max - 1 + value.point)

  return rounded.digits && rounded.point <= max ? rounded : null
}

function printPlain(value: Digits, locale?: string): string {
  if (!value.digits) {
    return '0'
  }

  const { digits, point } = value
  const whole = point > 0 ? digits.slice(0, point).padEnd(point, '0') : '0'
  const fraction = point > 0 ? digits.slice(point) : `${'0'.repeat(-point)}${digits}`
  const text = `${groupInteger(whole, locale)}${fraction ? `${numberSymbols(locale).decimal}${fraction}` : ''}`

  return value.negative ? `${MINUS}${text}` : text
}

function printScientific(value: Digits, max: number, locale?: string): string {
  const exponent = value.point - 1
  const room = Math.max(1, max - String(Math.abs(exponent)).length - (exponent < 0 ? 2 : 1))
  const rounded = roundDigits(value, room)
  const power = rounded.point - 1
  const mantissa = rounded.digits.length > 1 ? `${rounded.digits[0]}${numberSymbols(locale).decimal}${rounded.digits.slice(1)}` : rounded.digits
  const sign = value.negative ? MINUS : ''

  return `${sign}${mantissa}e${power < 0 ? MINUS : ''}${Math.abs(power)}`
}

/**
 * An exact decimal ("1234.5", "-0.000001", "6.02214076e23") as the display shows it: "1,234.5",
 * "−0.000001", "6.02214076e23"; at most `digits` digits, rounded half away from zero.
 */
export function formatNumber(value: string, options: { locale?: string; digits?: number } = {}): string {
  const special = SPECIAL.get(value)

  if (special) {
    return special
  }

  const parsed = readDigits(value)

  if (!parsed) {
    return value
  }

  const max = options.digits ?? DISPLAY_DIGITS
  const fixed = plain(parsed, max)

  return fixed ? printPlain(fixed, options.locale) : printScientific(parsed, max, options.locale)
}

const ENTRY = /^(-?)(\d*)(\.?)(\d*)(e(-?)(\d*))?$/

/** A number being typed, kept as typed ("0.50", "12.", "6.02e−"), with the locale's grouping and decimal mark. */
export function formatEntry(text: string, locale?: string): string {
  const match = ENTRY.exec(text)

  if (!match) {
    return text
  }

  const [, sign, whole, point, fraction, exponent, exponentSign, exponentDigits] = match
  const mantissa = `${sign ? MINUS : ''}${groupInteger(whole || '0', locale)}${point ? numberSymbols(locale).decimal : ''}${fraction}`

  return exponent ? `${mantissa}e${exponentSign ? MINUS : ''}${exponentDigits}` : mantissa
}
