import {
  CONSTANT_NAMES,
  CURRENCY_CODES,
  CURRENCY_LETTER_SYMBOLS,
  CURRENCY_NAMES,
  CURRENCY_SYMBOLS,
  FUNCTION_NAMES,
  LOWERCASE_CODES,
  NUMBER_WORDS,
  OPERATOR_WORDS,
  POUND_WORDS,
  SCALE_WORDS,
  UNITS
} from './words.ts'

/*
 * The words the engine reads, for the voice fast path's math grammar. Built from the engine's own
 * tables; plain data, so importing this never loads math.js.
 */

/** ISO codes that are everyday words, left out so plain sentences do not look like money. */
const WORD_CODES = new Set(['all', 'ang', 'bam', 'bob', 'cup', 'gel', 'lak', 'mad', 'mop', 'pen', 'ron', 'sos', 'top', 'try'])

/** Every word or symbol read as a unit ("km", "kilometres", "miles", "°f", "fahrenheit", "sq ft"), lower-case. */
export const UNIT_WORDS: ReadonlySet<string> = new Set([...UNITS.flatMap(unit => [...(unit.words ?? []), ...(unit.exact ?? [])]).map(word => word.toLowerCase()), ...POUND_WORDS])

/** The words of lengths ("cm", "metres", "feet", "light years"), lower-case: before one, the "in" of "12 in cm" is inches. */
export const LENGTH_WORDS: ReadonlySet<string> = new Set(UNITS.filter(unit => unit.measure === 'length').flatMap(unit => [...(unit.words ?? []), ...(unit.exact ?? [])].map(word => word.toLowerCase())))

/** Currency ISO codes, names and symbols ("usd", "dollars", "euro", "€", "reais"), lower-case. */
export const CURRENCY_WORDS: ReadonlySet<string> = new Set([
  ...[...CURRENCY_CODES].map(code => code.toLowerCase()).filter(code => !WORD_CODES.has(code)),
  ...LOWERCASE_CODES,
  ...Object.keys(CURRENCY_NAMES),
  ...Object.keys(CURRENCY_SYMBOLS).map(symbol => symbol.toLowerCase()),
  ...Object.keys(CURRENCY_LETTER_SYMBOLS).map(symbol => symbol.toLowerCase()),
  ...POUND_WORDS
])

/** Functions, constants and operator words ("sqrt", "square root", "sin", "pi", "plus", "divided by", "percent"), lower-case. */
export const MATH_WORDS: ReadonlySet<string> = new Set([
  ...Object.keys(FUNCTION_NAMES),
  ...Object.keys(CONSTANT_NAMES),
  ...Object.keys(OPERATOR_WORDS),
  ...Object.keys(SCALE_WORDS),
  ...Object.keys(NUMBER_WORDS),
  'percentage',
  'what percent',
  'split',
  'ways',
  'subtotal',
  'total'
])
