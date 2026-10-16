/*
 * Exact decimals as plain strings ("12.5", "-0.03", "6.02e23") for what the keypad works out on its
 * own: typed numbers and the memory. BigInt does the sums, so 0.1 + 0.2 stays 0.3 without the engine.
 */

/** A decimal as an integer and a power of ten: units × 10^-scale, scale never below zero. */
interface Scaled {
  units: bigint
  scale: number
}

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i

export function parseDecimal(text: string): Scaled | null {
  const match = DECIMAL.exec(text.trim())

  if (!match || `${match[2]}${match[3] ?? ''}` === '') {
    return null
  }

  const [, sign, whole, fraction = '', exponent = '0'] = match
  const units = BigInt(`${whole}${fraction}` || '0') * (sign === '-' ? -1n : 1n)
  const scale = fraction.length - Number(exponent)

  return scale < 0 ? { units: units * 10n ** BigInt(-scale), scale: 0 } : { units, scale }
}

/** A plain decimal without an exponent or trailing zeros: "-0.0015", "602000000000000000000000". */
function printScaled({ units, scale }: Scaled): string {
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0')
  const whole = scale > 0 ? digits.slice(0, -scale) : digits
  const fraction = scale > 0 ? digits.slice(-scale).replace(/0+$/, '') : ''
  const text = fraction ? `${whole}.${fraction}` : whole

  return negative ? `-${text}` : text
}

export function isZeroDecimal(text: string): boolean {
  return parseDecimal(text)?.units === 0n
}

/** The sum of two decimals, exactly; null when either does not read. */
export function addDecimals(a: string, b: string): string | null {
  const left = parseDecimal(a)
  const right = parseDecimal(b)

  if (!left || !right) {
    return null
  }

  const scale = Math.max(left.scale, right.scale)
  const units = left.units * 10n ** BigInt(scale - left.scale) + right.units * 10n ** BigInt(scale - right.scale)

  return printScaled({ units, scale })
}

export function negateDecimal(text: string): string {
  if (text.startsWith('-')) {
    return text.slice(1)
  }

  return isZeroDecimal(text) ? text : `-${text}`
}

/** A typed entry as a number: "12." is 12, "6.02e" is 6.02 and any zero is "0"; digits as typed otherwise. */
export function normalizeEntry(text: string): string {
  const value = text.replace(/e-?$/i, '').replace(/\.$/, '')

  if (value === '' || value === '-' || isZeroDecimal(value)) {
    return '0'
  }

  return parseDecimal(value) ? value : '0'
}
