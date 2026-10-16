import { decimalsOf } from './viewport.ts'

/* Numbers as the Graph view writes them, in the person's locale: tick labels and the trace's readout. */

const formats = new Map<string, Intl.NumberFormat>()

function numberFormat(locale: string | undefined, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`
  let format = formats.get(key)

  if (!format) {
    try {
      format = new Intl.NumberFormat(locale, options)
    } catch {
      format = new Intl.NumberFormat(undefined, options)
    }

    formats.set(key, format)
  }

  return format
}

const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹'

const superscript = (power: number): string => String(power).replace(/[-\d]/g, digit => (digit === '-' ? '⁻' : SUPERSCRIPTS[Number(digit)]))

/** "1.5 × 10⁶", for numbers too big or too small to write out; `digits` significant at most. */
function scientific(value: number, digits: number, locale?: string): string {
  let power = Math.floor(Math.log10(Math.abs(value)))
  let mantissa = value / 10 ** power

  if (Math.abs(Number(mantissa.toPrecision(digits))) >= 10) {
    mantissa /= 10
    power += 1
  }

  return `${numberFormat(locale, { maximumSignificantDigits: digits }).format(mantissa)} × 10${superscript(power)}`
}

/** A tick's label: as many decimals as its step needs, or a power of ten for very large and very small steps. */
export function formatTick(value: number, step: number, locale?: string): string {
  if (value === 0 || Math.abs(value) < step * 1e-6) {
    return numberFormat(locale, {}).format(0)
  }

  if (step >= 1e6 || step < 1e-4) {
    const digits = Math.floor(Math.log10(Math.abs(value)) + 1e-9) - Math.floor(Math.log10(step) + 1e-9) + 1

    return scientific(value, Math.min(21, Math.max(1, digits)), locale)
  }

  const decimals = decimalsOf(step)

  return numberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value)
}

/** A traced value to about 4 significant digits ("1.571"); whole numbers from a thousand up keep their digits. */
export function formatReadout(value: number, locale?: string): string {
  if (!Number.isFinite(value)) {
    return Number.isNaN(value) ? '—' : value > 0 ? '∞' : '−∞'
  }

  if (value === 0) {
    return numberFormat(locale, {}).format(0)
  }

  const size = Math.abs(value)

  if (size >= 1e7 || size < 1e-4) {
    return scientific(value, 4, locale)
  }

  return numberFormat(locale, size >= 1000 ? { maximumFractionDigits: 0 } : { maximumSignificantDigits: 4 }).format(value)
}
