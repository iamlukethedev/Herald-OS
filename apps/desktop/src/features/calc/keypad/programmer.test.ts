import { describe, expect, it } from 'vitest'
import {
  bitAt,
  digitValue,
  entryFits,
  formatWord,
  groupDigits,
  operate,
  operateUnary,
  parseWord,
  readWord,
  resizeWord,
  rotateLeft,
  rotateRight,
  shiftLeft,
  shiftRightArithmetic,
  shiftRightLogical,
  toggleBit,
  type Word,
  wrapWord
} from './programmer.ts'

const S8: Word = { bits: 8, signed: true }
const U8: Word = { bits: 8, signed: false }
const S64: Word = { bits: 64, signed: true }
const U64: Word = { bits: 64, signed: false }

describe('words', () => {
  it('wraps any integer to the word size', () => {
    expect(wrapWord(256n, 8)).toBe(0n)
    expect(wrapWord(-1n, 8)).toBe(255n)
    expect(wrapWord(-1n, 16)).toBe(0xffffn)
    expect(wrapWord(1n << 64n, 64)).toBe(0n)
  })

  it('reads the bits signed or unsigned', () => {
    expect(readWord(0xffn, S8)).toBe(-1n)
    expect(readWord(0xffn, U8)).toBe(255n)
    expect(readWord(0x80n, S8)).toBe(-128n)
    expect(readWord(0x7fn, S8)).toBe(127n)
    expect(readWord(0xffff_ffff_ffff_ffffn, S64)).toBe(-1n)
    expect(readWord(0xffff_ffff_ffff_ffffn, U64)).toBe(18446744073709551615n)
  })
})

describe('arithmetic', () => {
  it('wraps around the word size', () => {
    expect(operate('add', 255n, 1n, U8)).toBe(0n)
    expect(operate('add', 200n, 100n, U8)).toBe(44n)
    expect(operate('subtract', 0n, 1n, U8)).toBe(255n)
    expect(operate('multiply', 16n, 16n, U8)).toBe(0n)
    expect(operate('multiply', 1n << 63n, 2n, U64)).toBe(0n)
    expect(operate('add', 0x7fn, 1n, S8)).toBe(0x80n)
  })

  it('divides and takes the remainder by the word sign, truncating toward zero', () => {
    const minusSeven = wrapWord(-7n, 8)

    expect(operate('divide', minusSeven, 2n, S8)).toBe(wrapWord(-3n, 8))
    expect(operate('divide', minusSeven, 2n, U8)).toBe(124n)
    expect(operate('mod', minusSeven, 2n, S8)).toBe(wrapWord(-1n, 8))
    expect(operate('mod', minusSeven, 2n, U8)).toBe(1n)
    expect(operate('divide', 0x80n, 0xffn, S8)).toBe(0x80n)
  })

  it('refuses to divide by zero', () => {
    expect(() => operate('divide', 1n, 0n, S8)).toThrow(RangeError)
    expect(() => operate('mod', 1n, 0n, U64)).toThrow(RangeError)
  })

  it('negates in two’s complement', () => {
    expect(operateUnary('negate', 1n, 8)).toBe(255n)
    expect(operateUnary('negate', 0n, 8)).toBe(0n)
    expect(operateUnary('negate', 0x80n, 8)).toBe(0x80n)
  })
})

describe('bitwise', () => {
  it('flips only the bits of the word with NOT', () => {
    expect(operateUnary('not', 0n, 8)).toBe(0xffn)
    expect(operateUnary('not', 0x0fn, 16)).toBe(0xfff0n)
    expect(operateUnary('not', 0n, 64)).toBe(0xffff_ffff_ffff_ffffn)
  })

  it('works out AND, OR, XOR, NAND and NOR', () => {
    expect(operate('and', 0b1100n, 0b1010n, U8)).toBe(0b1000n)
    expect(operate('or', 0b1100n, 0b1010n, U8)).toBe(0b1110n)
    expect(operate('xor', 0b1100n, 0b1010n, U8)).toBe(0b0110n)
    expect(operate('nand', 0xf0n, 0xffn, U8)).toBe(0x0fn)
    expect(operate('nor', 0xf0n, 0x0fn, U8)).toBe(0n)
    expect(operate('nor', 0n, 0n, { bits: 16, signed: true })).toBe(0xffffn)
  })
})

describe('shifts and rotates', () => {
  it('shifts left within the word', () => {
    expect(shiftLeft(1n, 7n, 8)).toBe(128n)
    expect(shiftLeft(1n, 8n, 8)).toBe(0n)
    expect(shiftLeft(0x81n, 1n, 8)).toBe(0x02n)
    expect(operate('shl', 1n, 63n, U64)).toBe(1n << 63n)
  })

  it('copies the sign bit in with >> and zeros with >>>', () => {
    expect(shiftRightArithmetic(0x80n, 1n, 8)).toBe(0xc0n)
    expect(shiftRightArithmetic(0x40n, 1n, 8)).toBe(0x20n)
    expect(shiftRightLogical(0x80n, 1n, 8)).toBe(0x40n)
    expect(shiftRightArithmetic(0x80n, 100n, 8)).toBe(0xffn)
    expect(shiftRightArithmetic(0x7fn, 100n, 8)).toBe(0n)
    expect(shiftRightLogical(0xffn, 8n, 8)).toBe(0n)
    expect(operate('sar', 0xffff_ffff_ffff_fff0n, 4n, U64)).toBe(0xffff_ffff_ffff_ffffn)
    expect(operate('shr', 0xffff_ffff_ffff_fff0n, 4n, U64)).toBe(0x0fff_ffff_ffff_ffffn)
  })

  it('rotates bits around the word', () => {
    expect(rotateLeft(0x81n, 1, 8)).toBe(0x03n)
    expect(rotateRight(0x81n, 1, 8)).toBe(0xc0n)
    expect(rotateLeft(0x81n, 8, 8)).toBe(0x81n)
    expect(rotateLeft(0x81n, 9, 8)).toBe(0x03n)
    expect(rotateRight(0x81n, -1, 8)).toBe(0x03n)
    expect(operateUnary('rol', 1n << 63n, 64)).toBe(1n)
    expect(operateUnary('ror', 1n, 16)).toBe(0x8000n)
  })
})

describe('word sizes and bits', () => {
  it('widens keeping the number and narrows to the low bits', () => {
    expect(resizeWord(0xffn, 8, 16, true)).toBe(0xffffn)
    expect(resizeWord(0xffn, 8, 16, false)).toBe(0x00ffn)
    expect(resizeWord(0x1234n, 16, 8, true)).toBe(0x34n)
    expect(resizeWord(0x80n, 8, 64, true)).toBe(0xffff_ffff_ffff_ff80n)
  })

  it('flips and reads single bits inside the word only', () => {
    expect(toggleBit(0n, 3, 8)).toBe(8n)
    expect(toggleBit(8n, 3, 8)).toBe(0n)
    expect(toggleBit(0n, 8, 8)).toBe(0n)
    expect(toggleBit(0n, 63, 64)).toBe(1n << 63n)
    expect(bitAt(8n, 3)).toBe(true)
    expect(bitAt(8n, 2)).toBe(false)
  })
})

describe('bases', () => {
  it('knows which digits each base has', () => {
    expect(digitValue('F', 'hex')).toBe(15)
    expect(digitValue('f', 'hex')).toBe(15)
    expect(digitValue('F', 'dec')).toBeNull()
    expect(digitValue('8', 'oct')).toBeNull()
    expect(digitValue('7', 'oct')).toBe(7)
    expect(digitValue('1', 'bin')).toBe(1)
    expect(digitValue('2', 'bin')).toBeNull()
    expect(digitValue('G', 'hex')).toBeNull()
  })

  it('formats the bits in each base, decimal with its sign', () => {
    expect(formatWord(255n, 'hex', S8)).toBe('FF')
    expect(formatWord(255n, 'dec', S8)).toBe('-1')
    expect(formatWord(255n, 'dec', U8)).toBe('255')
    expect(formatWord(255n, 'oct', S8)).toBe('377')
    expect(formatWord(255n, 'bin', S8)).toBe('11111111')
    expect(formatWord(0n, 'bin', S8)).toBe('0')
  })

  it('parses text in a base, refusing digits it lacks and numbers that do not fit', () => {
    expect(parseWord('FF', 'hex', U8)).toBe(255n)
    expect(parseWord('ff', 'hex', U8)).toBe(255n)
    expect(parseWord('1FF', 'hex', U8)).toBeNull()
    expect(parseWord('G', 'hex', U8)).toBeNull()
    expect(parseWord('-1', 'dec', S8)).toBe(255n)
    expect(parseWord('-128', 'dec', S8)).toBe(0x80n)
    expect(parseWord('-129', 'dec', S8)).toBeNull()
    expect(parseWord('127', 'dec', S8)).toBe(127n)
    expect(parseWord('128', 'dec', S8)).toBeNull()
    expect(parseWord('255', 'dec', U8)).toBe(255n)
    expect(parseWord('256', 'dec', U8)).toBeNull()
    expect(parseWord('-1', 'dec', U8)).toBeNull()
    expect(parseWord('-1', 'hex', S8)).toBeNull()
    expect(parseWord('377', 'oct', U8)).toBe(255n)
    expect(parseWord('777', 'oct', U8)).toBeNull()
    expect(parseWord('1111 0000', 'bin', U8)).toBe(0xf0n)
    expect(parseWord('12', 'bin', U8)).toBeNull()
  })

  it('lets typing go on while the number fits', () => {
    expect(entryFits(127n, 'dec', S8)).toBe(true)
    expect(entryFits(128n, 'dec', S8)).toBe(false)
    expect(entryFits(255n, 'dec', U8)).toBe(true)
    expect(entryFits(255n, 'hex', S8)).toBe(true)
    expect(entryFits(256n, 'hex', S8)).toBe(false)
  })

  it('groups hex and binary in fours, octal in threes and decimal by the locale', () => {
    expect(groupDigits('FFFFFFFF', 'hex')).toBe('FFFF FFFF')
    expect(groupDigits('1FFFF', 'hex')).toBe('1 FFFF')
    expect(groupDigits('11111111', 'bin')).toBe('1111 1111')
    expect(groupDigits('101', 'bin')).toBe('101')
    expect(groupDigits('1234567', 'oct')).toBe('1 234 567')
    expect(groupDigits('1234567', 'dec', 'en-US')).toBe('1,234,567')
    expect(groupDigits('-1234', 'dec', 'en-US')).toBe('\u22121,234')
    expect(groupDigits('1234567', 'dec', 'de-DE')).toBe('1.234.567')
  })
})
