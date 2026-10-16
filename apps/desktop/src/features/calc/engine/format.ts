import {
  integerDigits,
  isZeroText,
  localeRegion,
  numberSymbols,
  resolveLocale,
  roundToPlaces,
  roundToSignificant,
  significantDigits,
  writeDecimal,
  writeScientific,
  type NumberSymbols
} from './numbers.ts'
import type { CalcValue, FormatOptions } from './types.ts'
import { UNIT_BY_NAME } from './words.ts'

/*
 * Values as the notepad shows them and as Hermes says them: exact decimals in full with the
 * locale's characters, endless ones to ten digits, money at its minor units, units sensibly
 * rounded. Synchronous and free of math.js; Intl supplies the patterns and the names.
 */

/** A cut exact string has this many significant digits: the value never ends. */
const ENDLESS_DIGITS = 60
/** Integers longer than this switch to scientific notation. */
const LONGEST_INTEGER = 120

/** A value as the notepad shows it, or in words to speak with `units: 'long'`. Never throws. */
export function formatValue(value: CalcValue, options: FormatOptions = {}): string {
  try {
    return format(value, options)
  } catch {
    return value.unit ? `${value.exact} ${value.unit}` : value.exact
  }
}

function format(value: CalcValue, options: FormatOptions): string {
  const long = options.units === 'long'
  const symbols = numberSymbols(options.locale)

  switch (value.kind) {
    case 'number':
      return formatNumber(value.exact, symbols, { digits: options.digits, endless: Boolean(value.fraction) })
    case 'percent':
      return formatPercent(value.exact, options.locale, symbols, options.digits)
    case 'currency':
      return formatMoney(value.exact, value.unit ?? 'USD', options.locale, long)
    case 'unit':
      return formatUnit(value.exact, value.unit ?? '', options.locale, long, options.digits)
    case 'duration':
      return formatDuration(value.exact, value.unit ?? 'day', options.locale, long, options.digits)
    case 'date':
      return formatDate(value.exact, options.locale, long)
    case 'time':
      return formatTime(value.exact, value.zone, options.locale, long)
    default:
      return value.exact
  }
}

/** A plain number: exact short decimals in full, endless ones to `digits` significant digits, `places` decimals at least. */
export function formatNumber(exact: string, symbols: NumberSymbols, options: { digits?: number; endless?: boolean; places?: number } = {}): string {
  if (!/^-?\d+(\.\d+)?$/.test(exact)) {
    return exact
  }

  const digits = options.digits ?? 10
  const integer = !exact.includes('.')
  const sig = significantDigits(exact)
  let text = exact

  if (integer) {
    if (exact.replace('-', '').length > LONGEST_INTEGER) {
      return writeScientific(exact, digits, symbols)
    }
  } else if (options.endless || sig >= ENDLESS_DIGITS || sig > 20) {
    text = roundToSignificant(exact, digits)
  }

  if (isZeroText(text)) {
    return isZeroText(exact) || integerDigits(exact) > 0 ? '0' : writeScientific(exact, Math.min(digits, sig), symbols)
  }

  if (/^-?0\.0{6,}/.test(text)) {
    return writeScientific(text, Math.min(digits, significantDigits(text)), symbols)
  }

  return writeDecimal(text, symbols, options.places ?? 0)
}

interface Affixes {
  prefix: string
  suffix: string
}

const patternCache = new Map<string, Affixes & { negativePrefix: string; negativeSuffix: string; minor: number }>()

/** The text before and after the digits in an Intl format of 1 and of -1. */
function affixes(format: Intl.NumberFormat, cacheKey: string): Affixes & { negativePrefix: string; negativeSuffix: string; minor: number } {
  const cached = patternCache.get(cacheKey)

  if (cached) {
    return cached
  }

  const split = (value: number): Affixes => {
    const parts = format.formatToParts(value)
    const numeric = new Set(['integer', 'group', 'decimal', 'fraction'])
    const first = parts.findIndex(part => numeric.has(part.type))
    const last = parts.findLastIndex(part => numeric.has(part.type))

    return { prefix: parts.slice(0, first).map(part => part.value).join(''), suffix: parts.slice(last + 1).map(part => part.value).join('') }
  }

  const positive = split(1)
  const negative = split(-1)
  const pattern = {
    ...positive,
    negativePrefix: negative.prefix,
    negativeSuffix: negative.suffix,
    minor: format.resolvedOptions().maximumFractionDigits ?? 2
  }

  patternCache.set(cacheKey, pattern)

  return pattern
}

function formatPercent(exact: string, locale: string | undefined, symbols: NumberSymbols, digits?: number): string {
  const pattern = affixes(new Intl.NumberFormat(resolveLocale(locale), { style: 'percent', numberingSystem: 'latn' }), `percent|${locale ?? ''}`)
  const text = formatNumber(exact, symbols, { digits })

  return text.startsWith(symbols.minus) ? `${pattern.negativePrefix}${text.slice(symbols.minus.length)}${pattern.negativeSuffix}` : `${pattern.prefix}${text}${pattern.suffix}`
}

/** Digits after the point the currency is counted in: 2 for USD, 0 for JPY. */
export function currencyMinor(code: string, locale?: string): number {
  try {
    return affixes(currencyFormat(code, locale), `currency|${locale ?? ''}|${code}`).minor
  } catch {
    return 2
  }
}

function currencyFormat(code: string, locale?: string): Intl.NumberFormat {
  return new Intl.NumberFormat(resolveLocale(locale), { style: 'currency', currency: code, numberingSystem: 'latn' })
}

/** An amount at the currency's minor units: "$1,234.50", "1.234,50 €", "¥1,235"; in words with `long`. */
function formatMoney(exact: string, code: string, locale: string | undefined, long = false): string {
  const symbols = numberSymbols(locale)
  let pattern: ReturnType<typeof affixes>

  try {
    pattern = affixes(currencyFormat(code, locale), `currency|${locale ?? ''}|${code}`)
  } catch {
    return `${writeDecimal(roundToPlaces(exact, 2), symbols, 2)} ${code}`
  }

  const rounded = roundToPlaces(exact, pattern.minor)
  const negative = rounded.startsWith('-') && !isZeroText(rounded)
  const magnitude = rounded.replace(/^-/, '')

  if (long) {
    const whole = !magnitude.includes('.')
    const words = new Intl.NumberFormat(resolveLocale(locale), {
      style: 'currency',
      currency: code,
      currencyDisplay: 'name',
      numberingSystem: 'latn',
      minimumFractionDigits: whole ? 0 : pattern.minor,
      maximumFractionDigits: pattern.minor
    })

    return words.format(rounded as Intl.StringNumericLiteral)
  }

  const digits = writeDecimal(magnitude, symbols, pattern.minor)

  return negative ? `${pattern.negativePrefix}${digits}${pattern.negativeSuffix}` : `${pattern.prefix}${digits}${pattern.suffix}`
}

interface UnitDisplay {
  symbol: string
  names: readonly [string, string]
  intl?: string
}

const SUPERSCRIPT: Readonly<Record<string, string>> = { '2': '²', '3': '³', '4': '⁴' }

/** How the engine's unit ("km/h", "degC", "m^2", "kg m/s^2") is shown and spoken. */
export function unitDisplay(unit: string): UnitDisplay {
  const known = UNIT_BY_NAME.get(unit)

  if (known) {
    return known
  }

  const [top, bottom] = unit.split('/')
  const part = (piece: string): string =>
    piece
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(factor => {
        const [name, power] = factor.split('^')
        const symbol = UNIT_BY_NAME.get(name)?.symbol ?? name

        return power ? `${symbol}${SUPERSCRIPT[power] ?? `^${power}`}` : symbol
      })
      .join('·')
  const symbol = bottom ? `${part(top) || '1'}/${part(bottom)}` : part(top)

  return { symbol, names: [symbol, symbol] }
}

/** A unit's magnitude rounded for showing: short exact values in full, others to five digits; two decimals to speak. */
function roundMagnitude(exact: string, long: boolean, digits?: number): string {
  if (long) {
    return Math.abs(Number(exact)) >= 1 ? roundToPlaces(exact, 2) : roundToSignificant(exact, 3, false)
  }

  const sig = significantDigits(exact)

  return sig <= 6 && !digits ? exact : roundToSignificant(exact, digits ?? 5)
}

function localName(names: readonly [string, string], plural: boolean, locale?: string): string {
  const name = names[plural ? 1 : 0]

  return localeRegion(locale) === 'US' ? name.replace(/metre/g, 'meter').replace(/litre/g, 'liter') : name
}

function formatUnit(exact: string, unit: string, locale: string | undefined, long: boolean, digits?: number): string {
  const symbols = numberSymbols(locale)
  const display = unitDisplay(unit)
  const magnitude = roundMagnitude(exact, long, digits)
  const number = formatNumber(magnitude, symbols)

  if (long) {
    if (display.intl) {
      try {
        return new Intl.NumberFormat(resolveLocale(locale), { style: 'unit', unit: display.intl, unitDisplay: 'long', maximumFractionDigits: 20, numberingSystem: 'latn' }).format(
          magnitude as Intl.StringNumericLiteral
        )
      } catch {
        // Intl does not know every unit; the English names below stand in.
      }
    }

    return `${number} ${localName(display.names, magnitude !== '1', locale)}`
  }

  return display.symbol === '°' ? `${number}°` : `${number} ${display.symbol}`
}

const DURATION_SYMBOLS: Readonly<Record<string, string>> = { millisecond: 'ms', second: 's', minute: 'min', hour: 'h' }
const DURATION_INTL: Readonly<Record<string, string>> = { ms: 'millisecond', s: 'second', min: 'minute', h: 'hour' }

function formatDuration(exact: string, unit: string, locale: string | undefined, long: boolean, digits?: number): string {
  const singular = DURATION_INTL[unit] ?? unit.replace(/s$/, '')
  const magnitude = roundMagnitude(exact, long, digits)
  const symbols = numberSymbols(locale)

  if (!long && DURATION_SYMBOLS[singular]) {
    return `${formatNumber(magnitude, symbols)} ${DURATION_SYMBOLS[singular]}`
  }

  try {
    return new Intl.NumberFormat(resolveLocale(locale), { style: 'unit', unit: singular, unitDisplay: 'long', maximumFractionDigits: 20, numberingSystem: 'latn' }).format(
      magnitude as Intl.StringNumericLiteral
    )
  } catch {
    return `${formatNumber(magnitude, symbols)} ${singular}${magnitude === '1' ? '' : 's'}`
  }
}

function formatDate(exact: string, locale: string | undefined, long: boolean): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(exact)

  if (!match) {
    return exact
  }

  const year = Number(match[1])
  const thisYear = new Date().getUTCFullYear() === year
  const date = Date.UTC(year, Number(match[2]) - 1, Number(match[3]))

  return new Intl.DateTimeFormat(resolveLocale(locale), {
    weekday: long ? 'long' : 'short',
    month: long ? 'long' : 'short',
    day: 'numeric',
    year: thisYear ? undefined : 'numeric',
    timeZone: 'UTC'
  }).format(date)
}

function formatTime(exact: string, zone: string | undefined, locale: string | undefined, long: boolean): string {
  const date = new Date(exact)

  if (Number.isNaN(date.getTime())) {
    return exact
  }

  const time = new Intl.DateTimeFormat(resolveLocale(locale), { hour: 'numeric', minute: '2-digit', timeZone: zone }).format(date)
  const place = zone?.split('/').at(-1)?.replace(/_/g, ' ')

  if (!place) {
    return time
  }

  return long ? `${time} in ${place}` : `${time} ${place}`
}
