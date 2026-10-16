/*
 * Exact rationals on BigInt for the engine's arithmetic: 0.1 + 0.2 is 3/10, 1/3 × 3 is 1, and 2^200
 * and 30! keep every digit. Pure; nothing here loads math.js.
 */

/** Numbers with more digits than this stop being exact and fall back to 64-digit decimals. */
export const MAX_EXACT_DIGITS = 4000
/** Written exponents beyond this ("1e99999") are refused. */
const MAX_EXPONENT = 10_000

/** A rational number in lowest terms with a positive denominator. */
export class Rational {
  readonly n: bigint
  readonly d: bigint

  constructor(n: bigint, d = 1n) {
    if (d === 0n) {
      throw new RangeError('division by zero')
    }

    const sign = d < 0n ? -1n : 1n
    const divisor = gcd(abs(n), abs(d))

    this.n = (sign * n) / divisor
    this.d = abs(d) / divisor
  }

  static readonly ZERO = new Rational(0n)
  static readonly ONE = new Rational(1n)
  static readonly HUNDRED = new Rational(100n)

  /** A plain or scientific decimal ("-12.5", "1e-7", "2.5E3"); null when the text is not one. */
  static parse(text: string): Rational | null {
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim())

    if (!match || (!match[2] && !match[3])) {
      return null
    }

    const [, sign, int = '', frac = '', exp = '0'] = match
    const exponent = Number(exp) - frac.length

    if (Math.abs(exponent) > MAX_EXPONENT) {
      return null
    }

    const digits = BigInt(`${int}${frac}` || '0') * (sign === '-' ? -1n : 1n)

    return exponent >= 0 ? new Rational(digits * 10n ** BigInt(exponent)) : new Rational(digits, 10n ** BigInt(-exponent))
  }

  /** A float through its shortest decimal ("1.0823"), exactly as written. */
  static fromNumber(value: number): Rational | null {
    return Number.isFinite(value) ? Rational.parse(String(value)) : null
  }

  add(other: Rational): Rational {
    return new Rational(this.n * other.d + other.n * this.d, this.d * other.d)
  }

  sub(other: Rational): Rational {
    return new Rational(this.n * other.d - other.n * this.d, this.d * other.d)
  }

  mul(other: Rational): Rational {
    return new Rational(this.n * other.n, this.d * other.d)
  }

  div(other: Rational): Rational {
    return new Rational(this.n * other.d, this.d * other.n)
  }

  neg(): Rational {
    return new Rational(-this.n, this.d)
  }

  abs(): Rational {
    return this.n < 0n ? this.neg() : this
  }

  sign(): number {
    return this.n === 0n ? 0 : this.n < 0n ? -1 : 1
  }

  isZero(): boolean {
    return this.n === 0n
  }

  isInteger(): boolean {
    return this.d === 1n
  }

  cmp(other: Rational): number {
    const left = this.n * other.d
    const right = other.n * this.d

    return left === right ? 0 : left < right ? -1 : 1
  }

  /** Digits in the numerator and denominator together, to keep sizes in check. */
  size(): number {
    return abs(this.n).toString().length + this.d.toString().length
  }

  /** This to an integer power; throws a RangeError when the answer would be enormous. */
  pow(exponent: bigint): Rational {
    if (exponent === 0n) {
      return Rational.ONE
    }

    if (this.n === 0n) {
      if (exponent < 0n) {
        throw new RangeError('division by zero')
      }

      return Rational.ZERO
    }

    const magnitude = abs(exponent)
    const base = abs(this.n) === 1n && this.d === 1n ? 1 : this.size()

    if (base * Number(magnitude) > MAX_EXACT_DIGITS * 4) {
      throw new RangeError('too big')
    }

    const n = this.n ** magnitude
    const d = this.d ** magnitude

    return exponent > 0n ? new Rational(n, d) : new Rational(d, n)
  }

  /** The exact k-th root when there is one ("8" → 2 for k = 3), else null. */
  root(k: bigint): Rational | null {
    if (this.n < 0n && k % 2n === 0n) {
      return null
    }

    const n = integerRoot(abs(this.n), k)
    const d = integerRoot(this.d, k)

    if (n === null || d === null) {
      return null
    }

    return new Rational(this.n < 0n ? -n : n, d)
  }

  floor(): Rational {
    const quotient = this.n / this.d

    return new Rational(this.n < 0n && quotient * this.d !== this.n ? quotient - 1n : quotient)
  }

  ceil(): Rational {
    return this.neg().floor().neg()
  }

  trunc(): Rational {
    return new Rational(this.n / this.d)
  }

  /** Rounded half away from zero to `digits` decimal places. */
  round(digits = 0): Rational {
    const scale = 10n ** BigInt(Math.max(0, digits))
    const scaled = abs(this.n) * scale * 2n + this.d
    const rounded = scaled / (this.d * 2n)

    return new Rational(this.n < 0n ? -rounded : rounded, scale)
  }

  /** a mod b with the sign of b, as people expect of a calculator ("-7 mod 3" is 2). */
  mod(other: Rational): Rational {
    return this.sub(other.mul(this.div(other).floor()))
  }

  /** Whether the decimal expansion ends (the denominator is made of 2s and 5s). */
  terminates(): boolean {
    return stripTwosAndFives(this.d).rest === 1n
  }

  /** The exact decimal when it ends within reach, else rounded to `significant` digits. */
  toDecimal(significant = 64): { text: string; exact: boolean } {
    const { rest, places } = stripTwosAndFives(this.d)

    if (rest === 1n && places <= MAX_EXACT_DIGITS) {
      const scaled = (this.n * 10n ** BigInt(places)) / this.d

      return { text: placeDigits(scaled, -places), exact: true }
    }

    return { text: roundedDecimal(this.n, this.d, significant), exact: false }
  }

  toNumber(): number {
    if (abs(this.n) < 2n ** 53n && this.d < 2n ** 53n) {
      return Number(this.n) / Number(this.d)
    }

    return Number(this.toDecimal(20).text)
  }

  /** "n/d", or just "n" for an integer. */
  toFraction(): string {
    return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`
  }

  /** A fraction short enough to show ("1/3", "-7/12"), or null. */
  shortFraction(): string | null {
    if (this.d === 1n || this.terminates()) {
      return null
    }

    return abs(this.n).toString().length <= 9 && this.d.toString().length <= 9 ? this.toFraction() : null
  }
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a
  let y = b

  while (y !== 0n) {
    const rest = x % y

    x = y
    y = rest
  }

  return x === 0n ? 1n : x
}

function stripTwosAndFives(value: bigint): { rest: bigint; places: number } {
  let rest = value
  let twos = 0
  let fives = 0

  while (rest % 2n === 0n) {
    rest /= 2n
    twos++
  }

  while (rest % 5n === 0n) {
    rest /= 5n
    fives++
  }

  return { rest, places: Math.max(twos, fives) }
}

/** The integer k-th root of a non-negative value when it is exact, else null. */
function integerRoot(value: bigint, k: bigint): bigint | null {
  if (value < 2n) {
    return value
  }

  const degree = Number(k)
  const approximate = Number(value)
  let guess = Number.isFinite(approximate) ? BigInt(Math.max(1, Math.ceil(approximate ** (1 / degree)))) : 1n << BigInt(Math.ceil(value.toString(2).length / degree))

  while (guess ** k < value) {
    guess *= 2n
  }

  // Newton's method from above only ever comes down, to the floor of the root.
  for (;;) {
    const next = ((k - 1n) * guess + value / guess ** (k - 1n)) / k

    if (next >= guess) {
      break
    }

    guess = next
  }

  return guess ** k === value ? guess : null
}

/** n/d rounded half up to `significant` digits, as a plain decimal string. */
function roundedDecimal(n: bigint, d: bigint, significant: number): string {
  if (n === 0n) {
    return '0'
  }

  const magnitude = abs(n).toString().length - d.toString().length
  const scale = significant - magnitude + 2
  const scaled = scale >= 0 ? (abs(n) * 10n ** BigInt(scale)) / d : abs(n) / (d * 10n ** BigInt(-scale))
  const digits = scaled.toString()
  const cut = Math.max(0, digits.length - significant)
  let kept = cut > 0 ? BigInt(digits.slice(0, digits.length - cut)) : scaled

  if (cut > 0 && Number(digits[digits.length - cut]) >= 5) {
    kept += 1n
  }

  return placeDigits(n < 0n ? -kept : kept, cut - scale)
}

/** digits × 10^exponent as a plain decimal string without trailing fraction zeros. */
export function placeDigits(digits: bigint, exponent: number): string {
  const negative = digits < 0n
  const text = abs(digits).toString()
  let result: string

  if (exponent >= 0) {
    result = text === '0' ? '0' : text + '0'.repeat(exponent)
  } else {
    const point = text.length + exponent
    const int = point > 0 ? text.slice(0, point) : '0'
    const frac = (point < 0 ? '0'.repeat(-point) : '') + text.slice(Math.max(0, point))
    const trimmed = frac.replace(/0+$/, '')

    result = trimmed ? `${int}.${trimmed}` : int
  }

  return negative && result !== '0' ? `-${result}` : result
}
