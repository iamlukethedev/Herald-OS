import type { Token } from './lexer.ts'
import { localeRegion, numberSymbols, type NumberSymbols } from './numbers.ts'
import {
  CONSTANT_NAMES,
  CURRENCY_CODES,
  CURRENCY_LETTER_SYMBOLS,
  CURRENCY_NAMES,
  FUNCTION_NAMES,
  LOWERCASE_CODES,
  NUMBER_WORDS,
  OPERATOR_WORDS,
  POUND_WORDS,
  UNIT_BY_NAME,
  findUnit,
  type UnitWord
} from './words.ts'

/*
 * Herald's own expression grammar over the tokens: operator words, implicit multiplication, units
 * and currencies before or after amounts, percentages, conversions with in/to/as/->. Pure; the
 * evaluator brings math.js.
 */

export interface UnitRef {
  /** The unit as math.js reads it ("km", "km/h", "m^2"). */
  unit: string
  /** What the notepad shows ("km", "km/h", "m²"). */
  symbol: string
  /** "pounds": a weight unless the other side is money, then sterling. */
  pound?: boolean
}

export type BinaryOp = '+' | '-' | '*' | '/' | '^' | 'mod' | 'of' | 'off' | 'on' | 'juxt'

export type Target = { type: 'unit'; unit: UnitRef } | { type: 'currency'; code: string } | { type: 'percent' }

interface Span {
  from: number
  to: number
}

export type Node =
  | ({ type: 'number'; value: string; decimals: number } & Span)
  | ({ type: 'name'; name: string; key: string; unit?: UnitRef; code?: string } & Span)
  | ({ type: 'quantity'; value: Node; unit: UnitRef } & Span)
  | ({ type: 'money'; value: Node; code: string } & Span)
  | ({ type: 'percent'; value: Node } & Span)
  | ({ type: 'negate'; value: Node } & Span)
  | ({ type: 'factorial'; value: Node } & Span)
  | ({ type: 'group'; value: Node } & Span)
  | ({ type: 'binary'; op: BinaryOp; left: Node; right: Node } & Span)
  | ({ type: 'call'; fn: string; args: Node[] } & Span)
  | ({ type: 'convert'; value: Node; target: Target } & Span)

/** A gentle message for a line that does not read, and where. */
export class ParseError extends Error {
  readonly at: number

  constructor(message: string, at: number) {
    super(message)
    this.at = at
  }
}

export interface ParseContext {
  symbols: NumberSymbols
  /** What "$" and "dollars" mean here. */
  dollar: string
  /** What "¥" means here. */
  yen: string
  /** What "kr" means here. */
  krona: string
  /** What "krone" means here. */
  krone: string
}

const contextCache = new Map<string, ParseContext>()

/** The locale's number characters and what its "$", "¥" and "kr" mean. */
export function parseContext(locale?: string): ParseContext {
  const key = locale ?? ''
  let context = contextCache.get(key)

  if (!context) {
    const region = localeRegion(locale)
    const dollars: Readonly<Record<string, string>> = { AU: 'AUD', CA: 'CAD', NZ: 'NZD', SG: 'SGD', HK: 'HKD', MX: 'MXN' }
    const kronor: Readonly<Record<string, string>> = { NO: 'NOK', DK: 'DKK', FO: 'DKK', GL: 'DKK', IS: 'ISK' }

    context = {
      symbols: numberSymbols(locale),
      dollar: dollars[region] ?? 'USD',
      yen: region === 'CN' ? 'CNY' : 'JPY',
      krona: kronor[region] ?? 'SEK',
      krone: region === 'DK' || region === 'FO' || region === 'GL' ? 'DKK' : 'NOK'
    }
    contextCache.set(key, context)
  }

  return context
}

/** The code a currency word or sign stands for here ("$" → "AUD" in en-AU). */
function settleCode(code: string, context: ParseContext): string {
  return code === '$' ? context.dollar : code === '¥' ? context.yen : code === 'kr' ? context.krona : code === 'krone' ? context.krone : code
}

/** Words that are never names, so they end an implicit product. */
const STOP_WORDS = new Set([
  'in',
  'into',
  'to',
  'as',
  'and',
  'or',
  'than',
  'plus',
  'minus',
  'less',
  'times',
  'multiplied',
  'divided',
  'over',
  'raised',
  'mod',
  'modulo',
  'percent',
  'pct',
  'per',
  'squared',
  'cubed',
  'factorial',
  'negative',
  'of',
  'off',
  'on',
  'with',
  'what',
  'is',
  'split',
  'ways',
  'way',
  'between',
  'among',
  'from',
  'by'
])

/** Units that are words too often to stand alone without an amount ("in", "min", "cup"). */
const STANDALONE_BLOCKED = new Set(['in', 'pt', 'ha', 'ac', 'kn', 'kt', 'mo', 'ly', 'cc', 'ms', 'min', 'sec', 'bar', 'cup', 'cal', 'gal', 'st', 'yd', 'mi', 'mb'])

/** The expression the tokens spell; throws a ParseError when they do not read. */
export function parseTokens(tokens: readonly Token[], context: ParseContext): Node {
  return new Parser(tokens, context).parse()
}

interface UnitMatch {
  ref: UnitRef
  end: number
}

class Parser {
  private pos = 0
  private readonly tokens: readonly Token[]
  private readonly context: ParseContext

  constructor(tokens: readonly Token[], context: ParseContext) {
    this.tokens = tokens
    this.context = context
  }

  parse(): Node {
    if (!this.tokens.length) {
      throw new ParseError('There is nothing to work out', 0)
    }

    const node = this.conversion()

    if (this.pos < this.tokens.length) {
      throw this.unexpected()
    }

    return node
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset]
  }

  private word(offset = 0): string | undefined {
    const token = this.peek(offset)

    return token?.kind === 'word' ? token.lower : undefined
  }

  private symbol(offset = 0): string | undefined {
    const token = this.peek(offset)

    return token?.kind === 'symbol' ? token.value : undefined
  }

  /** Whether the next words are `words`, each a whole token. */
  private phrase(words: readonly string[], offset = 0): boolean {
    return words.every((word, index) => this.word(offset + index) === word)
  }

  private unexpected(): ParseError {
    const token = this.peek()

    if (!token) {
      const last = this.tokens.at(-1)

      return new ParseError(last ? `Something is missing after “${last.text}”` : 'There is nothing to work out', last?.to ?? 0)
    }

    if (token.kind === 'symbol' && token.value === ')') {
      return new ParseError('There is a “)” without its “(”', token.from)
    }

    return new ParseError(`“${token.text}” doesn't fit here`, token.from)
  }

  private conversion(): Node {
    let node = this.additive()

    for (;;) {
      const keyword = this.word()
      const arrow = this.symbol() === '->'

      if (!arrow && keyword !== 'in' && keyword !== 'into' && keyword !== 'to' && keyword !== 'as') {
        break
      }

      const save = this.pos

      this.pos++

      const target = this.target()

      if (!target) {
        const unknown = this.peek()

        if (unknown?.kind === 'word' && this.pos === this.tokens.length - 1) {
          throw new ParseError(`Herald doesn't know the unit “${unknown.text}”`, unknown.from)
        }

        this.pos = save
        break
      }

      const value = keyword === 'in' && target.target.type === 'unit' && isLength(target.target.unit) ? inInches(node, this.tokens[save].to) : node

      node = { type: 'convert', value, target: target.target, from: node.from, to: target.to }
    }

    return node
  }

  private target(): { target: Target; to: number } | null {
    if ((this.word() === 'a' || this.word() === 'an') && this.isPercentWord(1)) {
      this.pos++
    }

    if (this.isPercentWord(0)) {
      const token = this.peek() as Token

      this.pos++

      return { target: { type: 'percent' }, to: token.to }
    }

    const currency = this.matchCurrency(this.pos, false)

    if (currency) {
      this.pos = currency.end

      return { target: { type: 'currency', code: currency.code }, to: this.tokens[currency.end - 1].to }
    }

    const unit = this.matchUnit(this.pos, 'target')

    if (unit) {
      this.pos = unit.end

      return { target: { type: 'unit', unit: unit.ref }, to: this.tokens[unit.end - 1].to }
    }

    const unknown = this.matchCurrency(this.pos, true)

    if (unknown) {
      this.pos = unknown.end

      return { target: { type: 'currency', code: unknown.code }, to: this.tokens[unknown.end - 1].to }
    }

    return null
  }

  private isPercentWord(offset: number): boolean {
    const word = this.word(offset)

    return this.symbol(offset) === '%' || word === 'percent' || word === 'percentage' || word === 'pct'
  }

  private additive(): Node {
    let left = this.multiplicative()

    for (;;) {
      const symbol = this.symbol()
      const word = this.word()
      const op = symbol === '+' || word === 'plus' ? '+' : symbol === '-' || word === 'minus' || word === 'less' ? '-' : null

      if (!op) {
        break
      }

      this.pos++

      const right = this.multiplicative()

      left = { type: 'binary', op, left, right, from: left.from, to: right.to }
    }

    return left
  }

  private multiplicative(): Node {
    let left = this.unary()

    for (;;) {
      const op = this.multiplicativeOp()

      if (!op) {
        break
      }

      this.pos += op.length

      const bare = op.per ? this.bareUnit() : null
      const right = bare ?? this.unary()

      left = { type: 'binary', op: op.op, left, right, from: left.from, to: right.to }
    }

    return left
  }

  private multiplicativeOp(): { op: BinaryOp; length: number; per?: boolean } | null {
    const symbol = this.symbol()
    const word = this.word()

    if (symbol === '*') {
      return { op: '*', length: 1 }
    }

    if (symbol === '/') {
      return { op: '/', length: 1, per: true }
    }

    if (symbol === '%') {
      return { op: 'mod', length: 1 }
    }

    if (word === 'times') {
      return { op: '*', length: 1 }
    }

    if (this.phrase(['multiplied', 'by'])) {
      return { op: '*', length: 2 }
    }

    if (this.phrase(['divided', 'by'])) {
      return { op: '/', length: 2 }
    }

    if (word === 'over') {
      return { op: '/', length: 1 }
    }

    if (word === 'per') {
      return { op: '/', length: 1, per: true }
    }

    if (word === 'mod' || word === 'modulo') {
      return { op: 'mod', length: 1 }
    }

    if (word === 'of' || word === 'off' || word === 'on') {
      return { op: word, length: 1 }
    }

    if (word === 'x' && this.startsAmount(1)) {
      return { op: '*', length: 1 }
    }

    return null
  }

  /** "per hour", "/ h": a unit with no amount after "per" or "/". */
  private bareUnit(): Node | null {
    const token = this.peek()

    if (token?.kind !== 'word' || this.matchCurrency(this.pos, false)) {
      return null
    }

    const unit = this.matchUnit(this.pos, 'target')

    if (!unit) {
      return null
    }

    this.pos = unit.end

    const to = this.tokens[unit.end - 1].to
    const one: Node = { type: 'number', value: '1', decimals: 0, from: token.from, to: token.from }

    return { type: 'quantity', value: one, unit: unit.ref, from: token.from, to }
  }

  private unary(): Node {
    const token = this.peek()
    const symbol = this.symbol()
    const word = this.word()

    if (token && (symbol === '-' || word === 'minus' || word === 'negative')) {
      this.pos++

      const value = this.unary()

      return { type: 'negate', value, from: token.from, to: value.to }
    }

    if (symbol === '+') {
      this.pos++

      return this.unary()
    }

    return this.implicit()
  }

  private implicit(): Node {
    let left = this.power()

    while (this.startsOperand(0)) {
      const right = this.power()

      left = { type: 'binary', op: 'juxt', left, right, from: left.from, to: right.to }
    }

    return left
  }

  /** Whether the token at `offset` can begin an operand of an implicit product. */
  private startsOperand(offset: number): boolean {
    const token = this.peek(offset)

    if (!token) {
      return false
    }

    if (token.kind === 'number' || token.kind === 'currency') {
      return true
    }

    if (token.kind === 'symbol') {
      return token.value === '(' || token.value === '√' || token.value === '∛'
    }

    const word = token.lower ?? ''

    if (STOP_WORDS.has(word) || (word === 'x' && this.startsAmount(offset + 1))) {
      return false
    }

    return /^[\p{L}_]/u.test(token.text)
  }

  /** Whether the token at `offset` begins an amount: a number, a bracket or a currency. */
  private startsAmount(offset: number): boolean {
    const token = this.peek(offset)

    return token?.kind === 'number' || token?.kind === 'currency' || (token?.kind === 'symbol' && token.value === '(')
  }

  private power(): Node {
    const base = this.postfix()
    let length = 0

    if (this.symbol() === '^') {
      length = 1
    } else if (this.phrase(['to', 'the', 'power', 'of'])) {
      length = 4
    } else if (this.phrase(['raised', 'to', 'the', 'power', 'of'])) {
      length = 5
    } else if (this.phrase(['raised', 'to'])) {
      length = 2
    }

    if (!length) {
      return base
    }

    this.pos += length

    const exponent = this.exponent()

    return { type: 'binary', op: '^', left: base, right: exponent, from: base.from, to: exponent.to }
  }

  private exponent(): Node {
    const token = this.peek()

    if (token && this.symbol() === '-') {
      this.pos++

      const value = this.exponent()

      return { type: 'negate', value, from: token.from, to: value.to }
    }

    if (this.symbol() === '+') {
      this.pos++

      return this.exponent()
    }

    return this.power()
  }

  private postfix(): Node {
    let node = this.primary()

    for (;;) {
      const token = this.peek()

      if (!token) {
        break
      }

      const symbol = this.symbol()
      const word = this.word()

      if (symbol === '!' && this.symbol(1) !== '=') {
        this.pos++
        node = { type: 'factorial', value: node, from: node.from, to: token.to }
        continue
      }

      if (word === 'factorial') {
        this.pos++
        node = { type: 'factorial', value: node, from: node.from, to: token.to }
        continue
      }

      if (symbol === '%') {
        const next = this.peek(1)

        if (next && (next.kind === 'number' || (next.kind === 'symbol' && next.value === '('))) {
          break
        }

        this.pos++
        node = { type: 'percent', value: node, from: node.from, to: token.to }
        continue
      }

      if (word === 'percent' || word === 'pct' || this.phrase(['per', 'cent'])) {
        const length = word === 'per' ? 2 : 1
        const to = this.tokens[this.pos + length - 1].to

        this.pos += length
        node = { type: 'percent', value: node, from: node.from, to }
        continue
      }

      if (word === 'squared' || word === 'cubed' || ((symbol === '²' || symbol === '³') && !token.gap)) {
        const power = word === 'squared' || symbol === '²' ? 2 : 3

        this.pos++

        if (node.type === 'quantity' && !node.unit.unit.includes('/')) {
          node = { ...node, unit: poweredUnit(node.unit, power), to: token.to }
        } else {
          const exponent: Node = { type: 'number', value: String(power), decimals: 0, from: token.from, to: token.to }

          node = { type: 'binary', op: '^', left: node, right: exponent, from: node.from, to: token.to }
        }

        continue
      }

      if (token.kind === 'word' && token.text === '°' && !token.gap) {
        this.pos++
        node = { type: 'quantity', value: node, unit: { unit: 'deg', symbol: '°' }, from: node.from, to: token.to }
        continue
      }

      if (takesUnit(node)) {
        const suffix = this.amountSuffix(node)

        if (suffix) {
          node = suffix
          continue
        }
      }

      break
    }

    return node
  }

  /** A currency or unit written after an amount: "5 USD", "20 euros", "5 km", "3 ft". */
  private amountSuffix(value: Node): Node | null {
    const currency = this.matchCurrency(this.pos, false)

    if (currency) {
      this.pos = currency.end

      return { type: 'money', value, code: currency.code, from: value.from, to: this.tokens[currency.end - 1].to }
    }

    const unit = this.matchUnit(this.pos, 'amount')

    if (unit) {
      this.pos = unit.end

      return { type: 'quantity', value, unit: unit.ref, from: value.from, to: this.tokens[unit.end - 1].to }
    }

    const unknown = this.matchCurrency(this.pos, true)

    if (unknown) {
      this.pos = unknown.end

      return { type: 'money', value, code: unknown.code, from: value.from, to: this.tokens[unknown.end - 1].to }
    }

    return null
  }

  private primary(): Node {
    const token = this.peek()

    if (!token) {
      throw this.unexpected()
    }

    if (token.kind === 'number') {
      if (token.invalid) {
        throw new ParseError('That number is too big to work with', token.from)
      }

      this.pos++

      return { type: 'number', value: token.value, decimals: token.decimals ?? 0, from: token.from, to: token.to }
    }

    if (token.kind === 'currency') {
      this.pos++

      return this.prefixedMoney(settleCode(token.value, this.context), token)
    }

    if (token.kind === 'symbol') {
      if (token.value === '(') {
        this.pos++

        const value = this.conversion()
        const close = this.peek()

        if (close?.kind !== 'symbol' || close.value !== ')') {
          throw close ? this.unexpected() : new ParseError('A “(” is never closed', token.from)
        }

        this.pos++

        return { type: 'group', value, from: token.from, to: close.to }
      }

      if (token.value === '√' || token.value === '∛') {
        this.pos++

        const value = this.operand()

        return { type: 'call', fn: token.value === '√' ? 'sqrt' : 'cbrt', args: [value], from: token.from, to: value.to }
      }

      throw this.unexpected()
    }

    return this.wordPrimary(token)
  }

  private wordPrimary(token: Token): Node {
    const word = token.lower ?? ''
    const prefix = this.matchCurrency(this.pos, false)

    if (prefix && this.startsAmount(prefix.end - this.pos)) {
      this.pos = prefix.end

      return this.prefixedMoney(prefix.code, token)
    }

    if (this.phrase(['square', 'root', 'of']) || this.phrase(['cube', 'root', 'of']) || this.phrase(['square', 'root']) || this.phrase(['cube', 'root'])) {
      const fn = word === 'square' ? 'sqrt' : 'cbrt'

      this.pos += this.word(2) === 'of' ? 3 : 2

      const value = this.operand()

      return { type: 'call', fn, args: [value], from: token.from, to: value.to }
    }

    if ((word === 'a' || word === 'an') && NUMBER_WORDS[this.word(1) ?? '']) {
      this.pos++

      return this.wordPrimary(this.peek() as Token)
    }

    const part = NUMBER_WORDS[word]

    if (part) {
      this.pos++

      const [n, d] = part.split('/')
      const one: Node = { type: 'number', value: n, decimals: 0, from: token.from, to: token.to }
      const node: Node = d ? { type: 'binary', op: '/', left: one, right: { ...one, value: d }, from: token.from, to: token.to } : one

      if (this.word() !== 'of' && this.startsOperand(0)) {
        const value = this.power()

        return { type: 'binary', op: '*', left: node, right: value, from: token.from, to: value.to }
      }

      return node
    }

    const fn = FUNCTION_NAMES[word]

    if (fn && (this.symbol(1) === '(' || (this.word(1) === 'of' && this.startsOperand(2)) || (this.word(1) !== 'of' && this.startsOperand(1)))) {
      this.pos++

      if (this.word() === 'of') {
        this.pos++
      }

      if (this.symbol() === '(') {
        const { args, to } = this.arguments()

        return { type: 'call', fn, args, from: token.from, to }
      }

      const value = this.operand()

      return { type: 'call', fn, args: [value], from: token.from, to: value.to }
    }

    if (STOP_WORDS.has(word) || !/^[\p{L}_][\p{L}\p{N}_'’]*$/u.test(token.text)) {
      throw this.unexpected()
    }

    if (CONSTANT_NAMES[token.text] || CONSTANT_NAMES[word]) {
      this.pos++

      return { type: 'name', name: token.text, key: CONSTANT_NAMES[token.text] ?? CONSTANT_NAMES[word], from: token.from, to: token.to }
    }

    const unit = this.matchUnit(this.pos, 'alone')

    if (unit && unit.end - this.pos > 1) {
      const last = this.tokens[unit.end - 1]
      const name = this.tokens
        .slice(this.pos, unit.end)
        .map(part => part.text)
        .join(' ')

      this.pos = unit.end

      return { type: 'name', name, key: name.toLowerCase().replace(/\s+/g, '_'), unit: unit.ref, from: token.from, to: last.to }
    }

    this.pos++

    return { type: 'name', name: token.text, key: word, unit: unit?.ref, code: prefix?.code, from: token.from, to: token.to }
  }

  /** The amount after a currency sign or code: "$5", "€ 2,50", "USD 100"; a lone sign means one unit. */
  private prefixedMoney(code: string, token: Token): Node {
    if (this.startsAmount(0) || this.symbol() === '-') {
      const value = this.symbol() === '-' ? this.unary() : this.power()

      return { type: 'money', value, code, from: token.from, to: value.to }
    }

    const one: Node = { type: 'number', value: '1', decimals: 0, from: token.from, to: token.from }

    return { type: 'money', value: one, code, from: token.from, to: token.to }
  }

  /** The operand of a prefix function or root, signs allowed: "sqrt 16", "√-4", "square root of x". */
  private operand(): Node {
    const token = this.peek()

    if (token && this.symbol() === '-') {
      this.pos++

      const value = this.operand()

      return { type: 'negate', value, from: token.from, to: value.to }
    }

    return this.power()
  }

  private arguments(): { args: Node[]; to: number } {
    const open = this.peek() as Token
    const args: Node[] = []

    this.pos++

    if (this.symbol() === ')') {
      const close = this.peek() as Token

      this.pos++

      return { args, to: close.to }
    }

    for (;;) {
      args.push(this.conversion())

      const next = this.peek()

      if (next?.kind === 'symbol' && (next.value === ',' || next.value === ';')) {
        this.pos++
        continue
      }

      if (next?.kind === 'symbol' && next.value === ')') {
        this.pos++

        return { args, to: next.to }
      }

      throw next ? this.unexpected() : new ParseError('A “(” is never closed', open.from)
    }
  }

  /**
   * A unit at `start`. `amount`: right after an amount, where bare C and F are temperatures and
   * "in" is an inch unless a unit follows it. `target`: after in/to/as. `alone`: no amount at all.
   */
  private matchUnit(start: number, place: 'amount' | 'target' | 'alone'): UnitMatch | null {
    const first = this.tokens[start]

    if (first?.kind !== 'word') {
      return null
    }

    if (first.lower === 'in' && place === 'amount' && this.convertsAt(start)) {
      return null
    }

    for (const size of [3, 2]) {
      const words = this.wordsAt(start, size)
      const entry = words ? findUnit(words) : undefined

      if (entry && words?.includes(' ')) {
        return this.unitTail(start + size, refOf(entry))
      }
    }

    const quantifier = first.lower === 'sq' || first.lower === 'square' ? 2 : first.lower === 'cubic' || first.lower === 'cu' ? 3 : 0

    if (quantifier) {
      const next = this.tokens[start + 1]
      const entry = next?.kind === 'word' && next.gap ? findUnit(next.text) : undefined

      if (entry?.measure === 'length') {
        return this.unitTail(start + 2, poweredUnit(refOf(entry), quantifier))
      }
    }

    if (place === 'alone' && (first.text.length < 2 || STANDALONE_BLOCKED.has(first.lower ?? ''))) {
      return null
    }

    const entry = findUnit(first.text)

    if (entry) {
      return this.unitTail(start + 1, refOf(entry))
    }

    if (POUND_WORDS.has(first.lower ?? '')) {
      return this.unitTail(start + 1, { unit: 'lb', symbol: 'lb', pound: true })
    }

    if (place !== 'alone' && /^[cfCF]$/.test(first.text)) {
      const celsius = first.lower === 'c'

      return { ref: { unit: celsius ? 'degC' : 'degF', symbol: celsius ? '°C' : '°F' }, end: start + 1 }
    }

    return null
  }

  /** Powers, "/unit" and "per unit" after a unit: "m²", "m^2", "km/h", "km per hour". */
  private unitTail(start: number, ref: UnitRef): UnitMatch {
    let end = start
    let current = ref
    const power = this.tokens[end]

    if (power?.kind === 'symbol' && !power.gap && !current.unit.includes('/')) {
      const exponent = this.tokens[end + 1]

      if (power.value === '²' || power.value === '³') {
        current = poweredUnit(current, power.value === '²' ? 2 : 3)
        end++
      } else if (power.value === '^' && exponent?.kind === 'number' && !exponent.gap && /^[2-4]$/.test(exponent.value)) {
        current = poweredUnit(current, Number(exponent.value))
        end += 2
      }
    }

    const slash = this.tokens[end]
    const after = this.tokens[end + 1]

    if (slash?.kind === 'symbol' && slash.value === '/' && !slash.gap && after?.kind === 'word' && !after.gap && !current.pound) {
      const before = this.tokens[start - 1]
      const whole = end === start && before?.kind === 'word' ? findUnit(`${before.text}/${after.text}`) : undefined
      const second = whole ? null : this.matchUnit(end + 1, 'target')

      if (whole) {
        current = refOf(whole)
        end += 2
      } else if (second && !second.ref.pound && !second.ref.unit.includes('/')) {
        current = dividedUnit(current, second.ref)
        end = second.end
      }
    } else if (this.tokens[end]?.kind === 'word' && this.tokens[end].lower === 'per' && !current.pound) {
      const second = this.matchUnit(end + 1, 'target')

      if (second && !second.ref.pound && !second.ref.unit.includes('/') && !current.unit.includes('/')) {
        current = dividedUnit(current, second.ref)
        end = second.end
      }
    }

    return { ref: current, end }
  }

  /** Whether "in" at `start` is a conversion: a unit, a currency or a percent sign follows it. */
  private convertsAt(start: number): boolean {
    const next = this.tokens[start + 1]

    if (!next || (next.kind === 'word' && next.lower === 'in')) {
      return false
    }

    if (next.kind === 'currency' || (next.kind === 'symbol' && next.value === '%')) {
      return true
    }

    return next.kind === 'word' && (this.matchUnit(start + 1, 'target') !== null || this.matchCurrency(start + 1, false) !== null || next.lower === 'percent')
  }

  /** `size` words from `start`, each separated by a space, as one lower-case phrase. */
  private wordsAt(start: number, size: number): string | null {
    const words: string[] = []

    for (let index = start; index < start + size; index++) {
      const token = this.tokens[index]

      if (token?.kind !== 'word' || (index > start && !token.gap)) {
        return null
      }

      words.push(token.lower ?? '')
    }

    return words.join(' ')
  }

  /** A currency at `start`: a sign, a code or a name. `unknown` also takes any three capitals ("XYZ"), for a gentle error later. */
  private matchCurrency(start: number, unknown: boolean): { code: string; end: number } | null {
    const token = this.tokens[start]

    if (!token) {
      return null
    }

    if (token.kind === 'currency') {
      return { code: settleCode(token.value, this.context), end: start + 1 }
    }

    if (token.kind !== 'word') {
      return null
    }

    if (unknown) {
      return /^[A-Z]{3}$/.test(token.text) ? { code: token.text, end: start + 1 } : null
    }

    for (const size of [3, 2]) {
      const words = this.wordsAt(start, size)
      const code = words ? CURRENCY_NAMES[words] : undefined

      if (code) {
        return { code: settleCode(code, this.context), end: start + size }
      }
    }

    const letters = CURRENCY_LETTER_SYMBOLS[token.text]

    if (letters) {
      return { code: settleCode(letters, this.context), end: start + 1 }
    }

    const name = CURRENCY_NAMES[token.lower ?? '']

    if (name) {
      return { code: settleCode(name, this.context), end: start + 1 }
    }

    if (CURRENCY_CODES.has(token.text) || LOWERCASE_CODES.has(token.text)) {
      return { code: token.text.toUpperCase(), end: start + 1 }
    }

    return null
  }
}

function takesUnit(node: Node): boolean {
  return node.type === 'number' || node.type === 'group' || (node.type === 'binary' && node.op === '*' && node.left.type === 'number' && node.right.type === 'number')
}

const INCH: UnitRef = { unit: 'inch', symbol: 'in' }

function isLength(ref: UnitRef): boolean {
  return UNIT_BY_NAME.get(ref.unit)?.measure === 'length'
}

/**
 * What goes before "in" and a length, with a plain number there read as inches: "12 in cm",
 * "-12 in cm" and the 10 of "5 ft 10 in cm". Sums, names and brackets keep their value. The
 * inches reach to `end`, the end of that "in", which is their unit as well as the conversion.
 */
function inInches(node: Node, end: number): Node {
  if (node.type === 'number') {
    return { type: 'quantity', value: node, unit: INCH, from: node.from, to: end }
  }

  if (node.type === 'negate') {
    const value = inInches(node.value, end)

    return value === node.value ? node : { ...node, value, to: end }
  }

  if (node.type === 'binary' && node.op === 'juxt' && node.right.type === 'number') {
    const before = node.left.type === 'binary' && node.left.op === 'juxt' ? node.left.right : node.left

    return before.type === 'quantity' && isLength(before.unit) ? { ...node, right: inInches(node.right, end), to: end } : node
  }

  return node
}

/** Where the units written after amounts sit, from the end of each amount to the end of its unit: an "in" there is inches, any other one converts. */
export function unitSpans(node: Node): Array<[number, number]> {
  switch (node.type) {
    case 'quantity':
      return [[node.value.to, node.to], ...unitSpans(node.value)]
    case 'name':
      return node.unit ? [[node.from, node.to]] : []
    case 'money':
    case 'percent':
    case 'negate':
    case 'factorial':
    case 'group':
    case 'convert':
      return unitSpans(node.value)
    case 'binary':
      return [...unitSpans(node.left), ...unitSpans(node.right)]
    case 'call':
      return node.args.flatMap(arg => unitSpans(arg))
    case 'number':
      return []
  }
}

function refOf(entry: UnitWord): UnitRef {
  return { unit: entry.unit, symbol: entry.symbol }
}

const SUPERSCRIPTS: Readonly<Record<number, string>> = { 2: '²', 3: '³', 4: '⁴' }

function poweredUnit(ref: UnitRef, power: number): UnitRef {
  const unit = `${ref.unit}^${power}`
  const known = UNIT_BY_NAME.get(unit)

  return known ? refOf(known) : { unit, symbol: `${ref.symbol}${SUPERSCRIPTS[power] ?? `^${power}`}` }
}

function dividedUnit(top: UnitRef, bottom: UnitRef): UnitRef {
  const unit = `${top.unit}/${bottom.unit}`
  const known = UNIT_BY_NAME.get(unit)

  return known ? refOf(known) : { unit, symbol: `${top.symbol}/${bottom.symbol}` }
}

/** Whether a word is one the expression grammar reads as an operator or keyword, not a name. */
export function isOperatorWord(word: string): boolean {
  return word in OPERATOR_WORDS || STOP_WORDS.has(word)
}
