import { groupInteger, MINUS } from './format.ts'

/*
 * The programmer keypad's integer engine: two's complement words of 8 to 64 bits in BigInt. A value
 * is always kept as the word's bits, 0 to 2^bits − 1; signed or unsigned is only how it reads.
 */

export type WordSize = 8 | 16 | 32 | 64
export const WORD_SIZES: readonly WordSize[] = [8, 16, 32, 64]
export type Base = 'hex' | 'dec' | 'oct' | 'bin'
export const BASES: readonly Base[] = ['hex', 'dec', 'oct', 'bin']
export const RADIX: Record<Base, number> = { hex: 16, dec: 10, oct: 8, bin: 2 }

export interface Word {
  bits: WordSize
  signed: boolean
}

export type ProgrammerOp = 'add' | 'subtract' | 'multiply' | 'divide' | 'mod' | 'and' | 'or' | 'xor' | 'nand' | 'nor' | 'shl' | 'sar' | 'shr'
export type ProgrammerUnary = 'not' | 'negate' | 'rol' | 'ror'

/** The low `bits` bits of any integer: how every result wraps around. */
export function wrapWord(value: bigint, bits: WordSize): bigint {
  return BigInt.asUintN(bits, value)
}

/** The number a word's bits mean: two's complement when signed. */
export function readWord(value: bigint, word: Word): bigint {
  return word.signed ? BigInt.asIntN(word.bits, value) : BigInt.asUintN(word.bits, value)
}

export function shiftLeft(value: bigint, count: bigint, bits: WordSize): bigint {
  return count >= BigInt(bits) ? 0n : wrapWord(value << count, bits)
}

/** >>>: zeros come in from the top. */
export function shiftRightLogical(value: bigint, count: bigint, bits: WordSize): bigint {
  return count >= BigInt(bits) ? 0n : wrapWord(value, bits) >> count
}

/** >>: the sign bit is copied in from the top. */
export function shiftRightArithmetic(value: bigint, count: bigint, bits: WordSize): bigint {
  const signed = BigInt.asIntN(bits, value)
  const limit = BigInt(bits - 1)

  return wrapWord(signed >> (count > limit ? limit : count), bits)
}

export function rotateLeft(value: bigint, count: number, bits: WordSize): bigint {
  const turn = BigInt(((count % bits) + bits) % bits)
  const word = wrapWord(value, bits)

  return turn === 0n ? word : wrapWord((word << turn) | (word >> (BigInt(bits) - turn)), bits)
}

export function rotateRight(value: bigint, count: number, bits: WordSize): bigint {
  return rotateLeft(value, -count, bits)
}

/** a op b within the word; division and mod truncate toward zero and read the word's sign. */
export function operate(op: ProgrammerOp, a: bigint, b: bigint, word: Word): bigint {
  const { bits } = word

  switch (op) {
    case 'add':
      return wrapWord(a + b, bits)
    case 'subtract':
      return wrapWord(a - b, bits)
    case 'multiply':
      return wrapWord(a * b, bits)
    case 'divide':
    case 'mod': {
      const divisor = readWord(b, word)

      if (divisor === 0n) {
        throw new RangeError("Can't divide by zero")
      }

      const dividend = readWord(a, word)

      return wrapWord(op === 'divide' ? dividend / divisor : dividend % divisor, bits)
    }
    case 'and':
      return wrapWord(a & b, bits)
    case 'or':
      return wrapWord(a | b, bits)
    case 'xor':
      return wrapWord(a ^ b, bits)
    case 'nand':
      return wrapWord(~(a & b), bits)
    case 'nor':
      return wrapWord(~(a | b), bits)
    case 'shl':
      return shiftLeft(a, wrapWord(b, bits), bits)
    case 'sar':
      return shiftRightArithmetic(a, wrapWord(b, bits), bits)
    case 'shr':
      return shiftRightLogical(a, wrapWord(b, bits), bits)
  }
}

/** NOT flips the word's bits only, ± is two's complement, RoL and RoR turn by one bit. */
export function operateUnary(op: ProgrammerUnary, value: bigint, bits: WordSize): bigint {
  switch (op) {
    case 'not':
      return wrapWord(~value, bits)
    case 'negate':
      return wrapWord(-value, bits)
    case 'rol':
      return rotateLeft(value, 1, bits)
    case 'ror':
      return rotateRight(value, 1, bits)
  }
}

/** A word moved to another size: cut to its low bits, or widened keeping the number it reads as. */
export function resizeWord(value: bigint, from: WordSize, to: WordSize, signed: boolean): bigint {
  return wrapWord(signed ? BigInt.asIntN(from, value) : BigInt.asUintN(from, value), to)
}

export function toggleBit(value: bigint, index: number, bits: WordSize): bigint {
  return index >= 0 && index < bits ? wrapWord(value ^ (1n << BigInt(index)), bits) : value
}

export function bitAt(value: bigint, index: number): boolean {
  return ((value >> BigInt(index)) & 1n) === 1n
}

/** The digit's value, when the base has it. */
export function digitValue(digit: string, base: Base): number | null {
  const value = /^[0-9A-F]$/i.test(digit) ? Number.parseInt(digit, 16) : Number.NaN

  return value < RADIX[base] ? value : null
}

/** Whether typing `value` still fits: below 2^bits, and below 2^(bits − 1) in signed decimal. */
export function entryFits(value: bigint, base: Base, word: Word): boolean {
  const limit = 1n << BigInt(base === 'dec' && word.signed ? word.bits - 1 : word.bits)

  return value >= 0n && value < limit
}

/** The word in a base, without grouping: decimal reads the sign, the others show the bits. */
export function formatWord(value: bigint, base: Base, word: Word): string {
  return base === 'dec' ? readWord(value, word).toString(10) : wrapWord(value, word.bits).toString(RADIX[base]).toUpperCase()
}

/** Text in a base as a word; null when a digit does not belong or the number does not fit. */
export function parseWord(text: string, base: Base, word: Word): bigint | null {
  const clean = text.replace(/[\s_]/g, '').toUpperCase()
  const negative = clean.startsWith('-')
  const digits = negative ? clean.slice(1) : clean

  if (!digits || (negative && !(base === 'dec' && word.signed))) {
    return null
  }

  let value = 0n

  for (const digit of digits) {
    const next = digitValue(digit, base)

    if (next === null) {
      return null
    }

    value = value * BigInt(RADIX[base]) + BigInt(next)
  }

  const limit = 1n << BigInt(word.bits)
  const fits = base === 'dec' && word.signed ? (negative ? value <= limit >> 1n : value < limit >> 1n) : value < limit

  return fits ? wrapWord(negative ? -value : value, word.bits) : null
}

/** Digits in groups: hex and binary in fours, octal in threes, decimal as the locale groups it. */
export function groupDigits(text: string, base: Base, locale?: string): string {
  const negative = text.startsWith('-')
  const digits = negative ? text.slice(1) : text

  if (base === 'dec') {
    return `${negative ? MINUS : ''}${groupInteger(digits, locale)}`
  }

  const size = base === 'oct' ? 3 : 4
  const groups: string[] = []

  for (let end = digits.length; end > 0; end -= size) {
    groups.unshift(digits.slice(Math.max(0, end - size), end))
  }

  return groups.join(' ')
}
