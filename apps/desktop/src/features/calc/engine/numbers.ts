import { placeDigits } from './rational.ts'

/*
 * Numbers as people write them where they live: the locale's group and decimal characters for
 * reading "2.400,50" and for writing exact decimal strings in full, longer than a float holds.
 * Pure; nothing here loads math.js.
 */

export interface NumberSymbols {
  /** The locale as Intl resolved it. */
  locale: string
  group: string
  decimal: string
  minus: string
  /** The size of the last group, then of the ones before it: [3, 3], or [3, 2] in en-IN. */
  groups: readonly [number, number]
  /** Whether four-digit numbers are grouped (es and pl write 1234 but 12 345). */
  groupFour: boolean
  /** Group characters accepted in input: the locale's, and any space where it groups with one. */
  readGroups: string
  /** The decimal separator is a comma, so function arguments are separated by ";" or ", ". */
  commaDecimal: boolean
}

/** A locale Intl accepts ("en_AU" becomes "en-AU"); undefined for the system's. */
export function resolveLocale(locale?: string): string | undefined {
  if (!locale) {
    return undefined
  }

  try {
    return Intl.getCanonicalLocales(locale.replace(/_/g, '-'))[0]
  } catch {
    return undefined
  }
}

const symbolCache = new Map<string, NumberSymbols>()

/** The locale's number characters, read once from Intl. */
export function numberSymbols(locale?: string): NumberSymbols {
  const key = locale ?? ''
  let symbols = symbolCache.get(key)

  if (!symbols) {
    symbols = readSymbols(resolveLocale(locale))
    symbolCache.set(key, symbols)
  }

  return symbols
}

function readSymbols(locale: string | undefined): NumberSymbols {
  const format = new Intl.NumberFormat(locale, { numberingSystem: 'latn' })
  const parts = format.formatToParts(-1234567.5)
  const group = parts.find(part => part.type === 'group')?.value ?? ','
  const decimal = parts.find(part => part.type === 'decimal')?.value ?? '.'
  const minus = parts.find(part => part.type === 'minusSign')?.value ?? '-'
  const sizes = format
    .formatToParts(1234567890)
    .filter(part => part.type === 'integer')
    .map(part => part.value.length)
  const last = sizes.at(-1) ?? 3
  const before = sizes.length > 2 ? (sizes.at(-2) ?? last) : last
  const spaced = /\s/u.test(group)

  return {
    locale: format.resolvedOptions().locale,
    group,
    decimal,
    minus,
    groups: [last, before],
    groupFour: format.formatToParts(1234).some(part => part.type === 'group'),
    readGroups: spaced ? ' \u00a0\u202f' : group === '’' || group === "'" ? "'’" : group,
    commaDecimal: decimal === ','
  }
}

/** The region a locale implies ("en" → "US"), for which dollar "$" means. */
export function localeRegion(locale?: string): string {
  try {
    const resolved = resolveLocale(locale) ?? new Intl.NumberFormat().resolvedOptions().locale

    return new Intl.Locale(resolved).maximize().region ?? 'US'
  } catch {
    return 'US'
  }
}

interface DecimalParts {
  negative: boolean
  /** The digits without a point; the value is digits × 10^exponent. */
  digits: bigint
  exponent: number
}

function splitDecimal(text: string): DecimalParts | null {
  const match = /^(-?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text)

  if (!match || (!match[2] && !match[3])) {
    return null
  }

  const [, sign, int = '', frac = '', exp = '0'] = match

  return { negative: sign === '-', digits: BigInt(`${int}${frac}` || '0'), exponent: Number(exp) - frac.length }
}

/** A plain decimal string rounded half away from zero to `places` decimals. */
export function roundToPlaces(text: string, places: number): string {
  const parts = splitDecimal(text)

  if (!parts) {
    return text
  }

  if (-parts.exponent <= places) {
    return placeDigits(parts.negative ? -parts.digits : parts.digits, parts.exponent)
  }

  return cutDigits(parts, -parts.exponent - places)
}

/** A plain decimal string rounded to `significant` digits; integer digits are never rounded away unless `integers` is false. */
export function roundToSignificant(text: string, significant: number, integers = true): string {
  const parts = splitDecimal(text)

  if (!parts || parts.digits === 0n) {
    return text
  }

  let cut = parts.digits.toString().length - significant

  if (integers) {
    cut = Math.min(cut, -parts.exponent)
  }

  if (cut <= 0) {
    return placeDigits(parts.negative ? -parts.digits : parts.digits, parts.exponent)
  }

  return cutDigits(parts, cut)
}

function cutDigits(parts: DecimalParts, cut: number): string {
  const divisor = 10n ** BigInt(cut)
  let kept = parts.digits / divisor

  if ((parts.digits % divisor) * 2n >= divisor) {
    kept += 1n
  }

  return placeDigits(parts.negative ? -kept : kept, parts.exponent + cut)
}

/** Digits that carry meaning: "0.0025" has 2, "1500" has 4, "97.175" has 5. */
export function significantDigits(text: string): number {
  const digits = text.replace(/^-/, '').replace('.', '').replace(/^0+/, '')

  return Math.max(1, digits.length)
}

/** Digits before the decimal point; 0 for "0.25". */
export function integerDigits(text: string): number {
  const int = text.replace(/^-/, '').split('.')[0]

  return int === '0' ? 0 : int.length
}

export function isZeroText(text: string): boolean {
  return /^-?0*(\.0*)?$/.test(text)
}

/** An exact decimal string in the locale's characters: "-1234.5" as "-1,234.5", "-1.234,5" or "−1 234,5". */
export function writeDecimal(text: string, symbols: NumberSymbols, minFraction = 0): string {
  const negative = text.startsWith('-')
  const [int, frac = ''] = (negative ? text.slice(1) : text).split('.')
  const fraction = frac.padEnd(minFraction, '0')

  return `${negative ? symbols.minus : ''}${groupInteger(int, symbols)}${fraction ? symbols.decimal + fraction : ''}`
}

function groupInteger(int: string, symbols: NumberSymbols): string {
  if (int.length <= 3 || (int.length === 4 && !symbols.groupFour)) {
    return int
  }

  const [last, before] = symbols.groups
  const groups = [int.slice(-last)]
  let end = int.length - last

  while (end > 0) {
    groups.unshift(int.slice(Math.max(0, end - before), end))
    end -= before
  }

  return groups.join(symbols.group)
}

/** A decimal string in scientific notation with `significant` digits: "1.234e-7", "6.022e23". */
export function writeScientific(text: string, significant: number, symbols: NumberSymbols): string {
  const parts = splitDecimal(text)

  if (!parts || parts.digits === 0n) {
    return '0'
  }

  const digits = parts.digits.toString()
  const exponent = parts.exponent + digits.length - 1
  const mantissa = roundToSignificant(`${digits[0]}.${digits.slice(1)}`, significant, false)
  const [int, frac] = mantissa.split('.')
  const carried = int === '10'
  const lead = carried ? '1' : int
  const rest = carried ? '' : (frac ?? '')

  return `${parts.negative ? symbols.minus : ''}${lead}${rest ? symbols.decimal + rest : ''}e${exponent + (carried ? 1 : 0)}`
}
