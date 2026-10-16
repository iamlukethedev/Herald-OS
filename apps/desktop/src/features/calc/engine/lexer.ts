import type { NumberSymbols } from './numbers.ts'
import { Rational } from './rational.ts'
import { CURRENCY_SYMBOLS, SCALE_WORDS } from './words.ts'

/*
 * A line cut into numbers, words, symbols and currency signs, with where each sits in the line.
 * Numbers are read in the locale ("2.400,50" in de-DE, "1,00,000" in en-IN) and come out as plain
 * decimal strings; scale words fold into them ("3 million", "2.5k"). Pure; no math.js.
 */

export type TokenKind = 'number' | 'word' | 'symbol' | 'currency'

export interface Token {
  kind: TokenKind
  /** As written. */
  text: string
  from: number
  to: number
  /** Whitespace right before it. */
  gap: boolean
  /**
   * number: the value as a plain decimal ("2400.5"). word: the word as written. symbol: the
   * operator ("+", "*", "^", "->", "√"). currency: the ISO code, or "$", "¥" or "kr" for the locale
   * to settle.
   */
  value: string
  /** number: digits written after the decimal separator. */
  decimals?: number
  /** word: in lower case. */
  lower?: string
  /** number: too big to read. */
  invalid?: boolean
}

const SYMBOLS: Readonly<Record<string, string>> = {
  '+': '+',
  '-': '-',
  '−': '-',
  '*': '*',
  '×': '*',
  '·': '*',
  '∙': '*',
  '⋅': '*',
  '/': '/',
  '÷': '/',
  '∕': '/',
  '^': '^',
  '%': '%',
  '!': '!',
  '(': '(',
  ')': ')',
  '[': '(',
  ']': ')',
  ',': ',',
  ';': ';',
  '=': '=',
  '√': '√',
  '∛': '∛',
  '²': '²',
  '³': '³',
  '→': '->'
}

const PAIRS: Readonly<Record<string, string>> = { '**': '^', '->': '->', '=>': '->' }

/** Letters standing alone that read as their own word: degrees and primes. */
const WORD_SIGNS = new Set(['℃', '℉', '′', '″'])
const DEGREE_SIGNS = new Set(['°', 'º', '˚'])

const LETTER_CURRENCIES = Object.keys(CURRENCY_SYMBOLS)
  .filter(symbol => /^\p{L}/u.test(symbol))
  .sort((a, b) => b.length - a.length)

const SIGN_CURRENCIES = new Set(Object.keys(CURRENCY_SYMBOLS).filter(symbol => !/^\p{L}/u.test(symbol)))

const SUFFIX_SCALES: Readonly<Record<string, string>> = { k: '1000', K: '1000', M: '1000000', bn: '1000000000', Bn: '1000000000', BN: '1000000000' }

/** The tokens of `text`, positions counted from `offset`. */
export function lex(text: string, symbols: NumberSymbols, offset = 0): Token[] {
  const tokens: Token[] = []
  let i = 0
  let gap = false

  while (i < text.length) {
    const char = text[i]

    if (/\s/u.test(char)) {
      gap = true
      i++
      continue
    }

    const start = i
    const push = (kind: TokenKind, end: number, value: string, extra: Partial<Token> = {}): void => {
      tokens.push({ kind, text: text.slice(start, end), from: start + offset, to: end + offset, gap, value, ...extra })
      i = end
      gap = false
    }

    if (isDigit(char) || (isDecimalStart(text, i, symbols) && isDigit(text[i + 1] ?? ''))) {
      const number = readNumber(text, i, symbols)

      push('number', number.end, number.value, { decimals: number.decimals, invalid: number.invalid })
      continue
    }

    const letterCurrency = !isLetter(text[i - 1] ?? '') ? LETTER_CURRENCIES.find(symbol => text.startsWith(symbol, i)) : undefined

    if (letterCurrency && !isLetter(text[i + letterCurrency.length] ?? '')) {
      push('currency', i + letterCurrency.length, CURRENCY_SYMBOLS[letterCurrency])
      continue
    }

    if (SIGN_CURRENCIES.has(char)) {
      push('currency', i + 1, CURRENCY_SYMBOLS[char])
      continue
    }

    if (DEGREE_SIGNS.has(char)) {
      const next = text[i + 1] ?? ''
      const scale = /[cCfF]/.test(next) && !isLetter(text[i + 2] ?? '')
      const end = scale ? i + 2 : i + 1

      push('word', end, scale ? `°${next.toUpperCase()}` : '°', { lower: scale ? `°${next.toLowerCase()}` : '°' })
      continue
    }

    if (WORD_SIGNS.has(char)) {
      push('word', i + 1, char, { lower: char })
      continue
    }

    if ((char === "'" || char === '"') && tokens.at(-1)?.kind === 'number' && !gap) {
      push('word', i + 1, char, { lower: char })
      continue
    }

    if ((char === 'x' || char === 'X') && !gap && tokens.at(-1)?.kind === 'number' && isDigit(text[i + 1] ?? '')) {
      push('symbol', i + 1, '*')
      continue
    }

    if (isLetter(char)) {
      let end = i + 1

      while (end < text.length && (isLetter(text[end]) || isDigit(text[end]) || (isApostrophe(text[end]) && isLetter(text[end + 1] ?? '')))) {
        end++
      }

      const word = text.slice(i, end)

      if (text[end] === '.' && /^(Fr|Rs|kr)$/.test(word)) {
        end++
      }

      push('word', end, text.slice(i, end), { lower: text.slice(i, end).toLowerCase() })
      continue
    }

    const pair = PAIRS[text.slice(i, i + 2)]

    if (pair) {
      push('symbol', i + 2, pair)
      continue
    }

    push('symbol', i + 1, SYMBOLS[char] ?? char)
  }

  return foldScales(tokens, text, offset)
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9'
}

function isLetter(char: string): boolean {
  return char !== '' && (/\p{L}/u.test(char) || char === '_')
}

function isApostrophe(char: string): boolean {
  return char === "'" || char === '’'
}

function isDecimalStart(text: string, i: number, symbols: NumberSymbols): boolean {
  return text[i] === symbols.decimal || (symbols.commaDecimal && text[i] === '.')
}

function digitsAt(text: string, i: number): number {
  let end = i

  while (end < text.length && isDigit(text[end])) {
    end++
  }

  return end - i
}

interface ReadNumber {
  end: number
  value: string
  decimals: number
  invalid?: boolean
}

function readNumber(text: string, start: number, symbols: NumberSymbols): ReadNumber {
  const radix = /^0([xXbBoO])([0-9a-fA-F]+)/.exec(text.slice(start, start + 80))

  if (radix && !isLetter(text[start + radix[0].length] ?? '')) {
    const base = radix[1].toLowerCase()
    const valid = base === 'x' ? /^[0-9a-f]+$/i : base === 'b' ? /^[01]+$/ : /^[0-7]+$/

    if (valid.test(radix[2])) {
      return { end: start + radix[0].length, value: BigInt(`0${base}${radix[2]}`).toString(), decimals: 0 }
    }
  }

  let i = start
  let int = ''
  let frac = ''
  const first = digitsAt(text, i)

  if (first > 0) {
    int = text.slice(i, i + first)
    i += first

    const groups: string[] = []
    let end = i

    while (end < text.length && symbols.readGroups.includes(text[end])) {
      const run = digitsAt(text, end + 1)

      if (run === 0) {
        break
      }

      groups.push(text.slice(end + 1, end + 1 + run))
      end += 1 + run
    }

    if (groups.length && validGroups(int, groups, symbols)) {
      int += groups.join('')
      i = end
    }
  }

  if (isDecimalStart(text, i, symbols) && digitsAt(text, i + 1) > 0) {
    const run = digitsAt(text, i + 1)

    frac = text.slice(i + 1, i + 1 + run)
    i += 1 + run
  }

  let exponent = ''
  const scientific = /^[eE]([+-]?\d+)/.exec(text.slice(i, i + 12))

  if (scientific) {
    exponent = scientific[1]
    i += scientific[0].length
  }

  let value = Rational.parse(`${int || '0'}.${frac || '0'}e${exponent || '0'}`)
  const suffix = /^\p{L}+/u.exec(text.slice(i))?.[0]
  const scaled = Boolean(value && suffix && SUFFIX_SCALES[suffix])

  if (value && suffix && scaled) {
    value = value.mul(new Rational(BigInt(SUFFIX_SCALES[suffix])))
    i += suffix.length
  }

  if (!value) {
    return { end: i, value: '0', decimals: 0, invalid: true }
  }

  const textValue = value.toDecimal().text

  return { end: i, value: textValue, decimals: scaled || exponent ? (textValue.split('.')[1]?.length ?? 0) : frac.length }
}

function validGroups(int: string, groups: string[], symbols: NumberSymbols): boolean {
  const [last, before] = symbols.groups

  if (int.length > Math.max(3, before) || groups.at(-1)?.length !== last) {
    return false
  }

  return groups.slice(0, -1).every(group => group.length === before || group.length === last)
}

/** "3 million", "2 thousand", "4 bn": the scale word joins the number before it. */
function foldScales(tokens: Token[], text: string, offset: number): Token[] {
  const folded: Token[] = []

  for (const token of tokens) {
    const previous = folded.at(-1)
    const factor = token.kind === 'word' && token.gap ? SCALE_WORDS[token.lower ?? ''] : undefined

    if (previous?.kind === 'number' && !previous.invalid && factor && (token.lower !== 'k' || token.text === 'k')) {
      const value = Rational.parse(previous.value)?.mul(new Rational(BigInt(factor)))

      if (value) {
        const textValue = value.toDecimal().text

        folded[folded.length - 1] = {
          ...previous,
          to: token.to,
          text: text.slice(previous.from - offset, token.to - offset),
          value: textValue,
          decimals: textValue.split('.')[1]?.length ?? 0
        }
        continue
      }
    }

    folded.push(token)
  }

  return folded
}
