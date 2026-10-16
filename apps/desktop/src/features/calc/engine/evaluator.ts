import type { BigNumber, MathJsInstance, Unit } from 'mathjs'
import type { CalcRates } from '../../../../shared/calc.ts'
import { formatNumber, formatValue, unitDisplay } from './format.ts'
import type { Sentence, Slice } from './line.ts'
import { PRECISION } from './math.ts'
import { significantDigits } from './numbers.ts'
import type { Node, ParseContext, Target, UnitRef } from './parser.ts'
import { MAX_EXACT_DIGITS, Rational } from './rational.ts'
import type { CalcValue } from './types.ts'
import { DURATION_UNITS, UNIT_BY_NAME } from './words.ts'

/*
 * Working out an expression exactly. Plain numbers are BigInt rationals while they can be (0.1 +
 * 0.2 is 3/10, 1/3 × 3 is 1) and 64-digit BigNumbers after a root, a logarithm or a sine; units are
 * math.js units; money is an amount and a currency, converted through the ECB's euro rates. Each
 * operation leaves a line of working, inner operations first.
 */

export type Real = Rational | BigNumber

export type Value =
  | { kind: 'number'; x: Real }
  | { kind: 'percent'; x: Real }
  | { kind: 'unit'; u: Unit; pound?: Real }
  | { kind: 'money'; x: Real; code: string }
  | { kind: 'other'; value: CalcValue }

/** A line that reads as math but has no answer, with the gentle reason. */
export class CalcError extends Error {}

/** A name with no value: the words around a value may be a label instead. */
export class UnknownName extends CalcError {
  constructor(
    message: string,
    /** The name as written. */
    readonly name: string
  ) {
    super(message)
  }
}

const NO_RATES = "No currency rates yet: Herald fetches the European Central Bank's once a day when it can"
const DIVIDE_BY_ZERO = 'Dividing by zero has no answer'
const TOO_BIG = 'That number is too big to work with'
const MAX_STEPS = 24
const MAX_FACTORIAL = 3000

export interface Env {
  math: MathJsInstance
  context: ParseContext
  locale: string | undefined
  rates: CalcRates | null
  /** Names assigned above, keyed by nameKey. */
  scope: ReadonlyMap<string, Value>
  /** The value of the last line above with one: prev, ans. */
  previous: Value | null
}

export interface Work {
  steps: string[]
  usesRates: boolean
  /** Step numbers keep at least this many decimals: the most the line wrote. */
  places: number
  /** Units the line names, in order, for choosing how to show a mixed result. */
  hints: string[]
}

export function newWork(places = 0): Work {
  return { steps: [], usesRates: false, places, hints: [] }
}

type Dimensions = readonly number[]

/* math.js base dimensions: mass, length, time, current, temperature, luminous intensity, amount of substance, angle, bit. */
const MEASURES: ReadonlyArray<[string, Dimensions, string]> = [
  ['length', [0, 1, 0, 0, 0, 0, 0, 0, 0], 'a length'],
  ['mass', [1, 0, 0, 0, 0, 0, 0, 0, 0], 'a mass'],
  ['time', [0, 0, 1, 0, 0, 0, 0, 0, 0], 'a time'],
  ['temperature', [0, 0, 0, 0, 1, 0, 0, 0, 0], 'a temperature'],
  ['angle', [0, 0, 0, 0, 0, 0, 0, 1, 0], 'an angle'],
  ['data', [0, 0, 0, 0, 0, 0, 0, 0, 1], 'a data size'],
  ['area', [0, 2, 0, 0, 0, 0, 0, 0, 0], 'an area'],
  ['volume', [0, 3, 0, 0, 0, 0, 0, 0, 0], 'a volume'],
  ['speed', [0, 1, -1, 0, 0, 0, 0, 0, 0], 'a speed'],
  ['data rate', [0, 0, -1, 0, 0, 0, 0, 0, 1], 'a data rate'],
  ['energy', [1, 2, -2, 0, 0, 0, 0, 0, 0], 'an energy'],
  ['power', [1, 2, -3, 0, 0, 0, 0, 0, 0], 'a power'],
  ['pressure', [1, -1, -2, 0, 0, 0, 0, 0, 0], 'a pressure'],
  ['frequency', [0, 0, -1, 0, 0, 0, 0, 0, 0], 'a frequency'],
  ['force', [1, 1, -2, 0, 0, 0, 0, 0, 0], 'a force']
]

/** The unit a mixed result of each measure falls back to when the line names none that fits. */
const FALLBACK_UNITS: Readonly<Record<string, string>> = {
  length: 'm',
  mass: 'kg',
  area: 'm^2',
  volume: 'l',
  speed: 'm/s',
  data: 'B',
  'data rate': 'B/s',
  energy: 'kWh',
  power: 'W',
  pressure: 'Pa',
  frequency: 'Hz',
  force: 'N',
  temperature: 'K',
  angle: 'rad'
}

/** The length inside a speed, for showing "60 mph × 2 h" in miles. */
const SPEED_LENGTHS: Readonly<Record<string, string>> = { mph: 'mi', knot: 'nmi' }

const DURATION_NAMES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(DURATION_UNITS).map(([name, unit]) => [unit, name]))

const OFFSET_UNITS = new Set(['degC', 'degF', 'K'])

function measureOf(dimensions: Dimensions): string | null {
  return MEASURES.find(([, known]) => known.every((value, index) => value === (dimensions[index] ?? 0)))?.[0] ?? null
}

function measurePhrase(measure: string | null): string {
  return MEASURES.find(([name]) => name === measure)?.[2] ?? 'that unit'
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function prefixName(component: Unit['units'][number]): string {
  const prefix = component.prefix as unknown

  return typeof prefix === 'string' ? prefix : ((prefix as { name?: string } | null)?.name ?? '')
}

/** The engine's name for a math.js unit: "km", "km/h", "m^2", "TB s/MB". */
function unitName(unit: Unit): string {
  const top: string[] = []
  const bottom: string[] = []

  for (const component of unit.units) {
    const power = Math.abs(component.power)
    const name = `${prefixName(component)}${component.unit.name}`
    const text = power === 1 ? name : `${name}^${power}`

    if (component.power > 0) {
      top.push(text)
    } else {
      bottom.push(text)
    }
  }

  return bottom.length ? `${top.join(' ') || '1'}/${bottom.join(' ')}` : top.join(' ')
}

/** The working of one line: evaluate nodes and sentences into values, writing steps as it goes. */
export class Evaluator {
  readonly env: Env
  readonly work: Work

  constructor(env: Env, work: Work) {
    this.env = env
    this.work = work
  }

  private get math(): MathJsInstance {
    return this.env.math
  }

  evaluate(node: Node): Value {
    switch (node.type) {
      case 'number': {
        const x = Rational.parse(node.value)

        if (!x) {
          throw new CalcError(TOO_BIG)
        }

        return { kind: 'number', x }
      }
      case 'group':
        return this.evaluate(node.value)
      case 'name':
        return this.name(node)
      case 'quantity':
        return this.quantity(this.evaluate(node.value), node.unit)
      case 'money': {
        const value = this.evaluate(node.value)

        if (value.kind !== 'number') {
          throw new CalcError('A currency goes with a plain amount, like $5 or 20 EUR')
        }

        return { kind: 'money', x: value.x, code: node.code }
      }
      case 'percent': {
        const value = this.evaluate(node.value)

        if (value.kind !== 'number') {
          throw new CalcError('Only a plain number can be a percentage')
        }

        return { kind: 'percent', x: value.x }
      }
      case 'negate':
        return this.negate(this.evaluate(node.value))
      case 'factorial':
        return this.factorial(this.evaluate(node.value))
      case 'binary':
        return this.binary(node.op, this.evaluate(node.left), this.evaluate(node.right))
      case 'call':
        return this.call(node.fn, node.args.map(arg => this.evaluate(arg)))
      case 'convert':
        return this.convert(this.evaluate(node.value), node.target)
    }
  }

  /** A sentence form, its parts worked out by `part`. */
  sentence(sentence: Sentence, part: (slice: Slice) => Value): Value {
    switch (sentence.form) {
      case 'percentOf': {
        const piece = part(sentence.part)
        const whole = part(sentence.whole)
        const ratio = this.ratio(piece, whole)
        const percent: Value = { kind: 'percent', x: this.mulReal(ratio, Rational.HUNDRED) }

        this.step(`${this.show(piece)} ÷ ${this.show(whole)} = ${this.showReal(ratio)}`)
        this.step(`${this.showReal(ratio)} × 100 = ${this.show(percent)}`)

        return percent
      }
      case 'percentOfWhat': {
        const piece = part(sentence.part)
        const rate = this.percentNumber(part(sentence.percent))
        const factor = this.divReal(rate, Rational.HUNDRED)
        const result = this.scale(piece, this.divReal(Rational.ONE, factor))

        this.step(`${this.show(piece)} ÷ ${this.showReal(factor)} = ${this.show(result)}`)

        return result
      }
      case 'percentChange': {
        const start = part(sentence.start)
        const end = part(sentence.end)
        const difference = this.combine(end, start, -1)
        const ratio = this.ratio(difference, start)
        const percent: Value = { kind: 'percent', x: this.mulReal(ratio, Rational.HUNDRED) }

        this.step(`${this.show(end)} − ${this.show(start)} = ${this.show(difference)}`)
        this.step(`${this.show(difference)} ÷ ${this.show(start)} = ${this.showReal(ratio)}`)
        this.step(`${this.showReal(ratio)} × 100 = ${this.show(percent)}`)

        return percent
      }
      case 'adjust':
        return this.adjust(part(sentence.base), this.percentNumber(part(sentence.percent)), sentence.sign)
      case 'split': {
        const amount = part(sentence.amount)
        const ways = part(sentence.ways)

        if (ways.kind !== 'number' || this.sign(ways.x) <= 0) {
          throw new CalcError('Split it a number of ways, like “split 3 ways”')
        }

        return this.divide(amount, ways)
      }
    }
  }

  /** The value as the engine hands it on. */
  calcValue(value: Value): CalcValue {
    switch (value.kind) {
      case 'number':
        return { kind: 'number', ...this.realParts(value.x) }
      case 'percent': {
        const { exact, number } = this.realParts(value.x)

        return { kind: 'percent', exact, number }
      }
      case 'money': {
        const { exact, number } = this.realParts(value.x)

        return { kind: 'currency', exact, number, unit: value.code }
      }
      case 'unit':
        return this.unitValue(value.u)
      case 'other':
        return value.value
    }
  }

  /** A final value tidied for showing: a unit that cancels becomes a number; a mixed unit like "TB s/MB" becomes hours. */
  tidy(value: Value): Value {
    if (value.kind !== 'unit') {
      return value
    }

    const unit = value.u

    if (unit.dimensions.every(dimension => dimension === 0)) {
      return { kind: 'number', x: this.fromBig(this.toBig(unit.value)) }
    }

    if (unit.units.length < 2 || UNIT_BY_NAME.has(unitName(unit))) {
      return value
    }

    const target = this.preferredUnit(unit)

    if (!target) {
      return value
    }

    try {
      return { kind: 'unit', u: unit.to(target) }
    } catch {
      return value
    }
  }

  /** Values added up the way a total adds them: plain numbers join money, other currencies convert to the first one's. */
  sum(values: readonly Value[]): Value {
    return values.slice(1).reduce((total, value) => this.combine(total, this.usable(value), 1), this.usable(values[0]))
  }

  average(sum: Value, count: number): Value {
    return this.scale(sum, new Rational(1n, BigInt(count)))
  }

  /** A stored value made ready for arithmetic: durations from the dates engine become time units. */
  usable(value: Value): Value {
    if (value.kind !== 'other' || value.value.kind !== 'duration') {
      return value
    }

    const magnitude = Rational.parse(value.value.exact)
    const unit = DURATION_UNITS[value.value.unit ?? ''] ?? DURATION_UNITS[(value.value.unit ?? '').replace(/s$/, '')] ?? value.value.unit

    if (!magnitude || !unit) {
      return value
    }

    try {
      return { kind: 'unit', u: this.math.unit(this.toBig(magnitude), unit) }
    } catch {
      return value
    }
  }

  private name(node: Extract<Node, { type: 'name' }>): Value {
    const key = node.key

    if (key === 'prev' || key === 'ans') {
      if (!this.env.previous) {
        throw new CalcError(`There is no answer above for “${node.name}”`)
      }

      return this.usable(this.env.previous)
    }

    const constant = key === 'pi' || key === 'e' || key === 'phi' || key === 'tau' ? (this.math[key] as unknown) : undefined

    if (constant !== undefined) {
      return { kind: 'number', x: this.toBig(constant) }
    }

    const scoped = this.env.scope.get(key)

    if (scoped) {
      return this.usable(scoped)
    }

    if (node.unit) {
      return this.quantity({ kind: 'number', x: Rational.ONE }, node.unit)
    }

    if (node.code) {
      return { kind: 'money', x: Rational.ONE, code: node.code }
    }

    throw new UnknownName(`“${node.name}” has no value yet: give it one on a line above, like “${node.name} = 5”`, node.name)
  }

  private quantity(value: Value, ref: UnitRef): Value {
    if (value.kind !== 'number') {
      throw new CalcError(`A unit goes with a plain number, like 5 ${ref.symbol}`)
    }

    this.work.hints.push(ref.unit)

    return { kind: 'unit', u: this.makeUnit(value.x, ref), pound: ref.pound ? value.x : undefined }
  }

  private makeUnit(x: Real, ref: UnitRef): Unit {
    try {
      return this.math.unit(this.toBig(x), ref.unit)
    } catch {
      throw new CalcError(`Herald doesn't know the unit “${ref.symbol}”`)
    }
  }

  private negate(value: Value): Value {
    switch (value.kind) {
      case 'number':
      case 'percent':
        return { kind: value.kind, x: this.negReal(value.x) }
      case 'money':
        return { ...value, x: this.negReal(value.x) }
      case 'unit':
        return { kind: 'unit', u: this.math.unaryMinus(value.u) as Unit, pound: value.pound === undefined ? undefined : this.negReal(value.pound) }
      default:
        throw this.otherError(value)
    }
  }

  private factorial(value: Value): Value {
    if (value.kind !== 'number') {
      throw new CalcError('A factorial needs a plain number')
    }

    const result: Value = { kind: 'number', x: this.factorialReal(value.x) }

    this.step(`${this.show(value)}! = ${this.show(result)}`)

    return result
  }

  private factorialReal(x: Real): Real {
    if (x instanceof Rational && x.isInteger()) {
      if (x.sign() < 0) {
        throw new CalcError('A factorial needs a whole number from 0 up')
      }

      if (x.n > BigInt(MAX_FACTORIAL)) {
        throw new CalcError(TOO_BIG)
      }

      let product = 1n

      for (let factor = 2n; factor <= x.n; factor++) {
        product *= factor
      }

      return new Rational(product)
    }

    const gamma = this.math.gamma(this.toNumber(x) + 1) as unknown as number

    if (!Number.isFinite(gamma)) {
      throw new CalcError('A factorial needs a whole number from 0 up')
    }

    // Known only to float precision: kept as a decimal so it shows like a value that never ends.
    return this.math.bignumber(gamma) as BigNumber
  }

  private binary(op: Extract<Node, { type: 'binary' }>['op'], left: Value, right: Value): Value {
    switch (op) {
      case '+':
        return this.add(left, right, 1)
      case '-':
        return this.add(left, right, -1)
      case '*':
        return this.multiply(left, right)
      case '/':
        return this.divide(left, right)
      case '^':
        return this.power(left, right)
      case 'mod':
        return this.modulo(left, right)
      case 'of':
        return this.of(left, right)
      case 'off':
      case 'on':
        if (left.kind !== 'percent') {
          throw new CalcError(`“${op}” goes after a percentage, like “15% ${op} 60”`)
        }

        return this.adjust(right, left.x, op === 'on' ? 1 : -1)
      case 'juxt':
        if (left.kind === 'unit' && right.kind === 'unit') {
          return this.add(left, right, 1)
        }

        return this.multiply(left, right)
    }
  }

  private add(left: Value, right: Value, sign: 1 | -1): Value {
    if (right.kind === 'percent' && left.kind !== 'percent') {
      return this.adjust(left, right.x, sign)
    }

    const a = this.sterling(left, right)
    const b = this.sterling(right, left)
    const result = this.combine(a, b, sign)

    this.step(`${this.show(a)} ${sign > 0 ? '+' : '−'} ${this.show(b)} = ${this.show(result)}`)

    return result
  }

  /** "pounds" next to money are sterling. */
  private sterling(value: Value, other: Value): Value {
    return value.kind === 'unit' && value.pound !== undefined && other.kind === 'money' ? { kind: 'money', x: value.pound, code: 'GBP' } : value
  }

  /** left ± right without a step of its own (money conversions still show theirs). */
  private combine(left: Value, right: Value, sign: 1 | -1): Value {
    let a = left
    let b = right

    if (a.kind === 'other' || b.kind === 'other') {
      throw this.otherError(a.kind === 'other' ? a : b)
    }

    if (a.kind === 'percent' && b.kind === 'percent') {
      return { kind: 'percent', x: sign > 0 ? this.addReal(a.x, b.x) : this.subReal(a.x, b.x) }
    }

    if (a.kind === 'percent' || b.kind === 'percent') {
      throw new CalcError('Put the percentage after the amount, like “60 + 15%”')
    }

    if (a.kind === 'unit' && a.pound !== undefined && b.kind === 'money') {
      a = { kind: 'money', x: a.pound, code: 'GBP' }
    }

    if (b.kind === 'unit' && b.pound !== undefined && a.kind === 'money') {
      b = { kind: 'money', x: b.pound, code: 'GBP' }
    }

    if (a.kind === 'number' && b.kind === 'number') {
      return { kind: 'number', x: sign > 0 ? this.addReal(a.x, b.x) : this.subReal(a.x, b.x) }
    }

    if (a.kind === 'money' && (b.kind === 'money' || b.kind === 'number')) {
      const other = b.kind === 'money' ? this.convertMoney(b, a.code).x : b.x

      return { kind: 'money', x: sign > 0 ? this.addReal(a.x, other) : this.subReal(a.x, other), code: a.code }
    }

    if (a.kind === 'number' && b.kind === 'money') {
      return { kind: 'money', x: sign > 0 ? this.addReal(a.x, b.x) : this.subReal(a.x, b.x), code: b.code }
    }

    if (a.kind === 'unit' && b.kind === 'unit') {
      try {
        const u = (sign > 0 ? this.math.add(a.u, b.u) : this.math.subtract(a.u, b.u)) as Unit
        const pound = a.pound !== undefined && b.pound !== undefined ? (sign > 0 ? this.addReal(a.pound, b.pound) : this.subReal(a.pound, b.pound)) : undefined

        return { kind: 'unit', u, pound }
      } catch {
        throw this.mismatch(a, b)
      }
    }

    throw this.mismatch(a, b)
  }

  private mismatch(a: Value, b: Value): CalcError {
    return new CalcError(`${capitalize(this.describe(a))} and ${this.describe(b)} don't add up`)
  }

  private describe(value: Value): string {
    switch (value.kind) {
      case 'number':
        return 'a plain number'
      case 'percent':
        return 'a percentage'
      case 'money':
        return 'an amount of money'
      case 'unit':
        return measurePhrase(measureOf(value.u.dimensions))
      case 'other':
        return value.value.kind === 'date' ? 'a date' : value.value.kind === 'time' ? 'a time of day' : 'that'
    }
  }

  private otherError(value: Value): CalcError {
    if (value.kind === 'other' && (value.value.kind === 'date' || value.value.kind === 'time')) {
      return new CalcError('Dates and times are worked out in date sentences, like “deadline + 3 days”')
    }

    return new CalcError("That doesn't work in arithmetic")
  }

  private multiply(left: Value, right: Value): Value {
    const result = this.product(left, right)

    this.step(`${this.show(left)} × ${this.show(right)} = ${this.show(result)}`)

    return result
  }

  private product(a: Value, b: Value): Value {
    if (a.kind === 'other' || b.kind === 'other') {
      throw this.otherError(a.kind === 'other' ? a : b)
    }

    if (a.kind === 'number' && b.kind === 'number') {
      return { kind: 'number', x: this.mulReal(a.x, b.x) }
    }

    if (b.kind === 'percent') {
      return this.scale(a, this.divReal(b.x, Rational.HUNDRED))
    }

    if (a.kind === 'percent') {
      return this.scale(b, this.divReal(a.x, Rational.HUNDRED))
    }

    if (a.kind === 'money' && b.kind === 'money') {
      throw new CalcError("Two amounts of money don't multiply")
    }

    if (b.kind === 'number') {
      return this.scale(a, b.x)
    }

    if (a.kind === 'number') {
      return this.scale(b, a.x)
    }

    if (a.kind === 'unit' && b.kind === 'unit') {
      const result = this.math.multiply(a.u, b.u) as unknown

      return this.isUnit(result) ? this.tidy({ kind: 'unit', u: result }) : { kind: 'number', x: this.fromBig(this.toBig(result)) }
    }

    throw new CalcError("Money and units don't multiply yet: work out the amount, then the price")
  }

  private divide(left: Value, right: Value): Value {
    const result = this.quotient(left, right)

    this.step(`${this.show(left)} ÷ ${this.show(right)} = ${this.show(result)}`)

    return result
  }

  private quotient(a: Value, b: Value): Value {
    if (a.kind === 'other' || b.kind === 'other') {
      throw this.otherError(a.kind === 'other' ? a : b)
    }

    if (this.isZeroValue(b)) {
      throw new CalcError(DIVIDE_BY_ZERO)
    }

    if (b.kind === 'percent') {
      const factor = this.divReal(b.x, Rational.HUNDRED)

      return a.kind === 'percent' ? { kind: 'number', x: this.divReal(a.x, b.x) } : this.scale(a, this.divReal(Rational.ONE, factor))
    }

    if (b.kind === 'number') {
      return this.scale(a, this.divReal(Rational.ONE, b.x))
    }

    if (a.kind === 'money' && b.kind === 'money') {
      return { kind: 'number', x: this.divReal(a.x, this.convertMoney(b, a.code).x) }
    }

    if (b.kind === 'money') {
      throw new CalcError("Dividing by an amount of money doesn't give an answer here")
    }

    if (a.kind === 'money' || a.kind === 'percent') {
      throw new CalcError("Money and units don't divide yet: work out the amount, then the price")
    }

    const top = a.kind === 'number' ? this.toBig(a.x) : a.u
    const result = this.math.divide(top, (b as Extract<Value, { kind: 'unit' }>).u) as unknown

    return this.isUnit(result) ? this.tidy({ kind: 'unit', u: result }) : { kind: 'number', x: this.fromBig(this.toBig(result)) }
  }

  private power(left: Value, right: Value): Value {
    if (right.kind !== 'number') {
      throw new CalcError('A power needs a plain number')
    }

    let result: Value

    if (left.kind === 'number') {
      result = { kind: 'number', x: this.powReal(left.x, right.x) }
    } else if (left.kind === 'unit') {
      try {
        result = { kind: 'unit', u: this.math.pow(left.u, this.toBig(right.x)) as Unit }
      } catch {
        throw new CalcError('That unit has no such power')
      }
    } else {
      throw new CalcError(`${capitalize(this.describe(left))} can't be raised to a power`)
    }

    this.step(`${this.show(left)}^${this.show(right)} = ${this.show(result)}`)

    return result
  }

  private modulo(left: Value, right: Value): Value {
    if (right.kind !== 'number' || (left.kind !== 'number' && left.kind !== 'money')) {
      throw new CalcError('mod works on plain numbers')
    }

    if (this.isZeroReal(right.x)) {
      throw new CalcError(DIVIDE_BY_ZERO)
    }

    const x = this.modReal(left.x, right.x)
    const result: Value = left.kind === 'money' ? { ...left, x } : { kind: 'number', x }

    this.step(`${this.show(left)} mod ${this.show(right)} = ${this.show(result)}`)

    return result
  }

  private of(left: Value, right: Value): Value {
    if (left.kind !== 'percent') {
      return this.multiply(left, right)
    }

    const factor = this.divReal(left.x, Rational.HUNDRED)
    const result = this.scale(right, factor)

    this.step(`${this.show(left)} of ${this.show(right)} = ${this.show(right)} × ${this.showReal(factor)}`)
    this.step(`= ${this.show(result)}`)

    return result
  }

  /** base plus or minus a percentage of itself: "84.50 + 15%", "15% off 60". */
  private adjust(base: Value, percent: Real, sign: 1 | -1): Value {
    const part = this.scale(base, this.divReal(percent, Rational.HUNDRED))
    const result = this.combine(base, part, sign)

    this.step(`${this.show({ kind: 'percent', x: percent })} of ${this.show(base)} = ${this.show(part)}`)
    this.step(`${this.show(base)} ${sign > 0 ? '+' : '−'} ${this.show(part)} = ${this.show(result)}`)

    return result
  }

  private percentNumber(value: Value): Real {
    if (value.kind === 'percent' || value.kind === 'number') {
      return value.x
    }

    throw new CalcError('A percentage needs a plain number')
  }

  /** a ÷ b as a plain number, converting money and units to match. */
  private ratio(a: Value, b: Value): Real {
    const result = this.quotient(a, b)

    if (result.kind === 'number') {
      return result.x
    }

    throw new CalcError(`${capitalize(this.describe(a))} and ${this.describe(b)} can't be compared`)
  }

  private scale(value: Value, factor: Real): Value {
    switch (value.kind) {
      case 'number':
      case 'percent':
        return { kind: value.kind, x: this.mulReal(value.x, factor) }
      case 'money':
        return { ...value, x: this.mulReal(value.x, factor) }
      case 'unit':
        return { kind: 'unit', u: this.math.multiply(value.u, this.toBig(factor)) as Unit, pound: value.pound === undefined ? undefined : this.mulReal(value.pound, factor) }
      default:
        throw this.otherError(value)
    }
  }

  private convert(value: Value, target: Target): Value {
    switch (target.type) {
      case 'percent': {
        if (value.kind === 'percent') {
          return value
        }

        if (value.kind !== 'number') {
          throw new CalcError('Only a plain number converts to a percentage')
        }

        const result: Value = { kind: 'percent', x: this.mulReal(value.x, Rational.HUNDRED) }

        this.step(`${this.show(value)} × 100 = ${this.show(result)}`)

        return result
      }
      case 'currency':
        if (value.kind === 'money') {
          return this.convertMoney(value, target.code)
        }

        if (value.kind === 'unit' && value.pound !== undefined) {
          return this.convertMoney({ kind: 'money', x: value.pound, code: 'GBP' }, target.code)
        }

        if (value.kind === 'number') {
          return { kind: 'money', x: value.x, code: target.code }
        }

        throw new CalcError(`${capitalize(this.describe(value))} doesn't convert to money`)
      case 'unit':
        return this.convertToUnit(value, target.unit)
    }
  }

  private convertToUnit(value: Value, ref: UnitRef): Value {
    this.work.hints.push(ref.unit)

    if (value.kind === 'money' && ref.pound) {
      return this.convertMoney(value, 'GBP')
    }

    if (value.kind === 'number') {
      const target = this.makeUnit(Rational.ONE, ref)

      if (measureOf(target.dimensions) === 'angle') {
        return { kind: 'unit', u: this.convertUnit(this.math.unit(this.toBig(value.x), 'rad'), ref) }
      }

      return { kind: 'unit', u: this.makeUnit(value.x, ref) }
    }

    if (value.kind !== 'unit') {
      throw new CalcError(`${capitalize(this.describe(value))} doesn't convert to ${ref.symbol}`)
    }

    return { kind: 'unit', u: this.convertUnit(value.u, ref) }
  }

  private convertUnit(unit: Unit, ref: UnitRef): Unit {
    let result: Unit

    try {
      result = unit.to(ref.unit)
    } catch {
      const target = this.makeUnit(Rational.ONE, ref)

      throw new CalcError(`${capitalize(measurePhrase(measureOf(unit.dimensions)))} doesn't convert to ${measurePhrase(measureOf(target.dimensions))}`)
    }

    this.conversionSteps(unit, result, ref)

    return result
  }

  private conversionSteps(from: Unit, to: Unit, ref: UnitRef): void {
    const fromName = unitName(from)

    if (fromName === unitName(to)) {
      return
    }

    const source = this.unitMagnitude(from)
    const shown = this.show({ kind: 'unit', u: to })
    const fromSymbol = unitDisplay(fromName).symbol

    if (OFFSET_UNITS.has(fromName) || OFFSET_UNITS.has(ref.unit)) {
      const value = formatNumber(source, this.env.context.symbols, { digits: 6 })
      const formulas: Readonly<Record<string, string>> = {
        'degF>degC': `(${value} − 32) × 5/9`,
        'degC>degF': `${value} × 9/5 + 32`,
        'degC>K': `${value} + 273.15`,
        'K>degC': `${value} − 273.15`,
        'degF>K': `(${value} − 32) × 5/9 + 273.15`,
        'K>degF': `(${value} − 273.15) × 9/5 + 32`
      }
      const formula = formulas[`${fromName}>${ref.unit}`]

      this.step(formula ? `${formula} = ${shown}` : `${this.show({ kind: 'unit', u: from })} = ${shown}`)

      return
    }

    let factor: string

    try {
      factor = formatNumber(this.realText(this.fromBig(this.toBig(this.math.unit(this.math.bignumber(1), fromName).to(ref.unit).toNumeric()))), this.env.context.symbols, {
        digits: 6,
        endless: true
      })
    } catch {
      this.step(`${this.show({ kind: 'unit', u: from })} = ${shown}`)

      return
    }

    const toSymbol = unitDisplay(unitName(to)).symbol

    this.step(`1 ${fromSymbol} = ${factor}${toSymbol === '°' ? '' : ' '}${toSymbol}`)

    if (source !== '1') {
      this.step(`${this.show({ kind: 'unit', u: from })} × ${factor} = ${shown}`)
    }
  }

  /** Money in another currency through the ECB's euro rates; same currency needs none. */
  private convertMoney(money: Extract<Value, { kind: 'money' }>, code: string): Extract<Value, { kind: 'money' }> {
    if (money.code === code) {
      return money
    }

    const rates = this.env.rates

    if (!rates) {
      throw new CalcError(NO_RATES)
    }

    const from = this.rate(rates, money.code)
    const to = this.rate(rates, code)
    const result: Extract<Value, { kind: 'money' }> = { kind: 'money', x: this.mulReal(this.divReal(money.x, from.value), to.value), code }
    const quoted = [from, to].filter(rate => rate.code !== 'EUR').map(rate => `1 EUR = ${rate.text} ${rate.code}`)

    this.work.usesRates = true
    this.step(`ECB rates on ${rates.date}: ${quoted.join(', ')}`)
    this.step(`${this.show(money)}${from.code === 'EUR' ? '' : ` ÷ ${from.text}`}${to.code === 'EUR' ? '' : ` × ${to.text}`} = ${this.show(result)}`)

    return result
  }

  private rate(rates: CalcRates, code: string): { code: string; value: Rational; text: string } {
    if (code === 'EUR') {
      return { code, value: Rational.ONE, text: '1' }
    }

    const raw = rates.rates[code]
    const value = typeof raw === 'number' && raw > 0 ? Rational.fromNumber(raw) : null

    if (!value) {
      throw new CalcError(`The ECB publishes no rate for ${code}`)
    }

    return { code, value, text: formatNumber(String(raw), this.env.context.symbols, { digits: 10 }) }
  }

  private call(fn: string, args: Value[]): Value {
    const result = this.apply(fn, args)
    const shown = this.show(result)

    if (fn === 'sqrt' || fn === 'cbrt') {
      this.step(`${fn === 'sqrt' ? '√' : '∛'}${this.show(args[0])} = ${shown}`)
    } else if (fn === 'factorial') {
      this.step(`${this.show(args[0])}! = ${shown}`)
    } else {
      const label = fn === 'mean' ? 'average' : fn === 'nthRoot' ? 'root' : fn === 'combinations' ? 'choose' : fn

      this.step(`${label}(${args.map(arg => this.show(arg)).join(', ')}) = ${shown}`)
    }

    return result
  }

  private apply(fn: string, args: Value[]): Value {
    const many = new Set(['min', 'max', 'gcd', 'lcm', 'sum', 'mean', 'median', 'hypot'])
    const two = new Set(['nthRoot', 'atan2', 'combinations', 'permutations', 'mod'])
    const optional = new Set(['round', 'log'])

    if (!args.length || (!many.has(fn) && args.length > (two.has(fn) || optional.has(fn) ? 2 : 1)) || (two.has(fn) && args.length !== 2)) {
      throw new CalcError(`${fn} takes ${two.has(fn) ? 'two numbers' : many.has(fn) ? 'one or more numbers' : 'one number'}`)
    }

    const [first, second] = args

    switch (fn) {
      case 'sqrt':
      case 'cbrt':
        return this.root(first, fn === 'sqrt' ? 2n : 3n)
      case 'nthRoot': {
        const degree = this.real(second, fn)

        if (!(degree instanceof Rational) || !degree.isInteger() || degree.sign() <= 0) {
          throw new CalcError('A root needs a whole number degree, like root(27, 3)')
        }

        return this.root(first, degree.n)
      }
      case 'abs':
      case 'round':
      case 'floor':
      case 'ceil':
      case 'trunc':
      case 'sign':
        return this.rounding(fn, first, second)
      case 'min':
      case 'max':
        return this.extreme(fn, args)
      case 'sum':
      case 'mean':
        return this.total(args, fn === 'mean')
      case 'median':
        return this.median(args)
      case 'factorial':
        return { kind: 'number', x: this.factorialReal(this.real(first, fn)) }
      case 'mod':
        return this.modulo(first, second)
      case 'gcd':
      case 'lcm':
        return { kind: 'number', x: this.divisors(fn, args.map(arg => this.real(arg, fn))) }
      case 'combinations':
      case 'permutations':
        return { kind: 'number', x: this.choose(this.real(first, fn), this.real(second, fn), fn === 'permutations') }
      case 'hypot': {
        const squares = args.map(arg => this.mulReal(this.real(arg, fn), this.real(arg, fn)))

        return this.root({ kind: 'number', x: squares.reduce((sum, square) => this.addReal(sum, square)) }, 2n)
      }
      default:
        return { kind: 'number', x: this.transcendental(fn, first, second) }
    }
  }

  private real(value: Value, fn: string): Real {
    if (value.kind === 'number') {
      return value.x
    }

    throw new CalcError(`${fn} needs a plain number`)
  }

  private root(value: Value, degree: bigint): Value {
    if (value.kind === 'unit' && degree === 2n) {
      try {
        return { kind: 'unit', u: this.math.sqrt(value.u) as Unit }
      } catch {
        throw new CalcError('That unit has no square root')
      }
    }

    const x = this.real(value, degree === 2n ? 'sqrt' : 'root')
    const exact = x instanceof Rational ? x.root(degree) : null

    if (exact) {
      return { kind: 'number', x: exact }
    }

    if (this.sign(x) < 0) {
      if (degree % 2n === 0n) {
        throw new CalcError(degree === 2n ? "The square root of a negative number isn't a real number" : "An even root of a negative number isn't a real number")
      }

      return { kind: 'number', x: this.negReal(this.rootReal(this.negReal(x), degree)) }
    }

    return { kind: 'number', x: this.rootReal(x, degree) }
  }

  private rootReal(x: Real, degree: bigint): Real {
    const big = this.toBig(x)

    if (degree === 2n) {
      return this.fromBig(big.sqrt() as BigNumber)
    }

    if (degree === 3n) {
      return this.fromBig(big.cbrt() as BigNumber)
    }

    return this.fromBig(big.pow(this.toBig(new Rational(1n, degree))) as BigNumber)
  }

  private rounding(fn: string, value: Value, digitsValue?: Value): Value {
    let digits = 0

    if (digitsValue) {
      const places = this.real(digitsValue, fn)

      if (!(places instanceof Rational) || !places.isInteger() || places.sign() < 0 || places.n > 30n) {
        throw new CalcError('round takes a whole number of decimals, like round(2.345, 2)')
      }

      digits = Number(places.n)
    }

    const apply = (x: Real): Real => {
      const exact = x instanceof Rational ? x : Rational.parse(this.realText(x))

      if (!exact) {
        return x
      }

      switch (fn) {
        case 'abs':
          return exact.abs()
        case 'round':
          return exact.round(digits)
        case 'floor':
          return exact.floor()
        case 'ceil':
          return exact.ceil()
        case 'trunc':
          return exact.trunc()
        default:
          return new Rational(BigInt(exact.sign()))
      }
    }

    switch (value.kind) {
      case 'number':
      case 'percent':
        return { kind: value.kind, x: apply(value.x) }
      case 'money':
        return { ...value, x: apply(value.x) }
      case 'unit': {
        const name = unitName(value.u)
        const magnitude = Rational.parse(this.unitMagnitude(value.u)) ?? Rational.ZERO

        return fn === 'sign' ? { kind: 'number', x: apply(magnitude) } : { kind: 'unit', u: this.math.unit(this.toBig(apply(magnitude)), name) }
      }
      default:
        throw this.otherError(value)
    }
  }

  private extreme(fn: 'min' | 'max', args: Value[]): Value {
    return args.reduce((best, candidate) => {
      const difference = this.combine(candidate, best, -1)
      const sign = difference.kind === 'unit' ? this.sign(this.toBig(difference.u.value)) : difference.kind === 'other' ? 0 : this.sign(difference.x)

      return (fn === 'max' ? sign > 0 : sign < 0) ? candidate : best
    })
  }

  private total(args: Value[], average: boolean): Value {
    const sum = args.slice(1).reduce((total, value) => this.combine(total, value, 1), args[0])

    return average ? this.scale(sum, new Rational(1n, BigInt(args.length))) : sum
  }

  private median(args: Value[]): Value {
    const values = args.map(arg => this.real(arg, 'median')).sort((a, b) => this.cmpReal(a, b))
    const middle = Math.floor(values.length / 2)

    return { kind: 'number', x: values.length % 2 ? values[middle] : this.divReal(this.addReal(values[middle - 1], values[middle]), new Rational(2n)) }
  }

  private divisors(fn: 'gcd' | 'lcm', values: Real[]): Real {
    const integers = values.map(value => {
      if (!(value instanceof Rational) || !value.isInteger()) {
        throw new CalcError(`${fn} works on whole numbers`)
      }

      return value.n < 0n ? -value.n : value.n
    })
    const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b))
    const result = integers.reduce((acc, value) => (fn === 'gcd' ? gcd(acc, value) : acc === 0n || value === 0n ? 0n : (acc / gcd(acc, value)) * value))

    return new Rational(result)
  }

  private choose(nValue: Real, kValue: Real, ordered: boolean): Real {
    if (!(nValue instanceof Rational) || !(kValue instanceof Rational) || !nValue.isInteger() || !kValue.isInteger() || kValue.sign() < 0 || nValue.cmp(kValue) < 0) {
      throw new CalcError('That needs whole numbers with the second no bigger than the first')
    }

    if (nValue.n > 100_000n) {
      throw new CalcError(TOO_BIG)
    }

    const k = ordered ? kValue.n : kValue.n < nValue.n - kValue.n ? kValue.n : nValue.n - kValue.n
    let result = 1n

    for (let index = 0n; index < k; index++) {
      result *= nValue.n - index

      if (!ordered) {
        result /= index + 1n
      }
    }

    return new Rational(result)
  }

  private angle(value: Value, fn: string): BigNumber {
    if (value.kind === 'number') {
      return this.toBig(value.x)
    }

    if (value.kind === 'unit' && measureOf(value.u.dimensions) === 'angle') {
      return this.toBig(value.u.toNumeric('rad'))
    }

    throw new CalcError(`${fn} needs an angle or a plain number`)
  }

  private transcendental(fn: string, value: Value, second?: Value): Real {
    const trig = new Set(['sin', 'cos', 'tan', 'sec', 'csc', 'cot'])

    if (trig.has(fn)) {
      const x = this.angle(value, fn)
      const base = fn === 'sin' || fn === 'csc' ? x.sin() : fn === 'cos' || fn === 'sec' ? x.cos() : x.tan()
      const snapped = (base.abs().lt(`1e-${PRECISION - 6}`) ? this.math.bignumber(0) : base) as BigNumber

      if (fn === 'sec' || fn === 'csc' || fn === 'cot') {
        if (snapped.isZero()) {
          throw new CalcError(`${fn} has no value there`)
        }

        return this.fromBig(this.math.bignumber(1).div(snapped) as BigNumber)
      }

      return this.fromBig(snapped)
    }

    const x = this.toBig(this.real(value, fn))

    switch (fn) {
      case 'log':
      case 'ln':
      case 'log10':
      case 'log2': {
        if (x.lte(0)) {
          throw new CalcError('A logarithm needs a number above zero')
        }

        if (fn === 'ln') {
          return this.fromBig(x.ln() as BigNumber)
        }

        const base = fn === 'log2' ? this.math.bignumber(2) : second ? this.toBig(this.real(second, fn)) : this.math.bignumber(10)

        if (base.lte(0) || base.eq(1)) {
          throw new CalcError('A logarithm needs a base above zero other than 1')
        }

        return this.fromBig(x.log(base) as BigNumber)
      }
      case 'exp':
        return this.fromBig(x.exp() as BigNumber)
      case 'asin':
      case 'acos':
        if (x.abs().gt(1)) {
          throw new CalcError(`${fn} needs a number from −1 to 1`)
        }

        return this.fromBig((fn === 'asin' ? x.asin() : x.acos()) as BigNumber)
      case 'atan':
        return this.fromBig(x.atan() as BigNumber)
      case 'atan2':
        return this.fromBig((this.math.atan2 as unknown as (y: BigNumber, x: BigNumber) => BigNumber)(x, this.toBig(this.real(second as Value, fn))))
      case 'sinh':
        return this.fromBig(x.sinh() as BigNumber)
      case 'cosh':
        return this.fromBig(x.cosh() as BigNumber)
      case 'tanh':
        return this.fromBig(x.tanh() as BigNumber)
      case 'asinh':
        return this.fromBig(x.asinh() as BigNumber)
      case 'acosh':
        if (x.lt(1)) {
          throw new CalcError('acosh needs a number from 1 up')
        }

        return this.fromBig(x.acosh() as BigNumber)
      case 'atanh':
        if (x.abs().gte(1)) {
          throw new CalcError('atanh needs a number between −1 and 1')
        }

        return this.fromBig(x.atanh() as BigNumber)
      default:
        throw new CalcError(`Herald doesn't know the function ${fn}`)
    }
  }

  private preferredUnit(unit: Unit): string | null {
    const measure = measureOf(unit.dimensions)

    if (measure === 'time') {
      const seconds = Math.abs(this.toNumber(this.toBig(unit.toNumeric('s'))))

      return seconds < 1 ? 'ms' : seconds < 60 ? 's' : seconds < 3600 ? 'min' : seconds < 172_800 ? 'h' : 'day'
    }

    const candidates = [
      ...unit.units.filter(component => component.power === 1).map(component => `${prefixName(component)}${component.unit.name}`),
      ...this.work.hints.flatMap(hint => [hint, hint.split('/')[0], SPEED_LENGTHS[hint] ?? ''])
    ]

    for (const candidate of candidates) {
      if (!candidate) {
        continue
      }

      try {
        if (this.math.unit(this.math.bignumber(1), candidate).equalBase(unit)) {
          return candidate
        }
      } catch {
        // Not a unit on its own.
      }
    }

    return measure ? (FALLBACK_UNITS[measure] ?? null) : null
  }

  private unitValue(unit: Unit): CalcValue {
    const name = unitName(unit)
    const exact = this.unitMagnitude(unit)
    const duration = DURATION_NAMES[name]

    return duration ? { kind: 'duration', exact, number: Number(exact), unit: duration } : { kind: 'unit', exact, number: Number(exact), unit: name }
  }

  private unitMagnitude(unit: Unit): string {
    return this.realText(this.fromBig(this.toBig(unit.toNumeric())))
  }

  /** How the notepad shows a final value; one known only to float precision shows ten digits like any that never ends. */
  display(value: Value): string {
    if (value.kind === 'number' && !(value.x instanceof Rational)) {
      return formatNumber(this.realText(value.x), this.env.context.symbols, { endless: true })
    }

    return formatValue(this.calcValue(value), { locale: this.env.locale })
  }

  /** How a value appears in a step: fractions keep the decimals the line wrote ("84.50 × 0.20"). */
  show(value: Value): string {
    if (value.kind === 'number') {
      return this.showReal(value.x)
    }

    return formatValue(this.calcValue(value), { locale: this.env.locale })
  }

  private showReal(x: Real): string {
    const parts = this.realParts(x)
    const places = parts.exact.includes('.') ? this.work.places : 0

    return formatNumber(parts.exact, this.env.context.symbols, { endless: !this.ends(x), places })
  }

  private step(text: string): void {
    if (this.work.steps.length < MAX_STEPS) {
      this.work.steps.push(text)
    }
  }

  private realParts(x: Real): { exact: string; number: number; fraction?: string } {
    if (x instanceof Rational) {
      const exact = x.toDecimal(PRECISION).text
      const fraction = x.shortFraction() ?? undefined

      return fraction ? { exact, number: x.toNumber(), fraction } : { exact, number: x.toNumber() }
    }

    const exact = this.realText(x)

    return { exact, number: Number(exact) }
  }

  private realText(x: Real): string {
    return x instanceof Rational ? x.toDecimal(PRECISION).text : (x.toSignificantDigits(PRECISION) as BigNumber).toFixed()
  }

  private ends(x: Real): boolean {
    return x instanceof Rational ? x.terminates() : false
  }

  private isUnit(value: unknown): value is Unit {
    return typeof value === 'object' && value !== null && 'units' in value && Array.isArray((value as Unit).units)
  }

  private isZeroValue(value: Value): boolean {
    switch (value.kind) {
      case 'number':
      case 'percent':
      case 'money':
        return this.isZeroReal(value.x)
      case 'unit':
        return this.toBig(value.u.value).isZero()
      default:
        return false
    }
  }

  toBig(value: unknown): BigNumber {
    if (value instanceof Rational) {
      return this.math.bignumber(value.n.toString()).div(value.d.toString()) as BigNumber
    }

    if (typeof value === 'number') {
      return this.math.bignumber(value) as BigNumber
    }

    return value as BigNumber
  }

  /** A BigNumber result as an exact rational when it is short (sin 30° is exactly 1/2), else as it is. */
  fromBig(value: BigNumber): Real {
    if (!value.isFinite()) {
      throw new CalcError(value.isNaN() ? 'That has no answer' : TOO_BIG)
    }

    const short = (value.toSignificantDigits(PRECISION - 8) as BigNumber).toFixed()

    if (significantDigits(short) <= PRECISION - 24) {
      return Rational.parse(short) ?? value
    }

    return value
  }

  private toNumber(x: Real): number {
    return x instanceof Rational ? x.toNumber() : x.toNumber()
  }

  private sign(x: Real): number {
    return x instanceof Rational ? x.sign() : x.isZero() ? 0 : x.isNegative() ? -1 : 1
  }

  private isZeroReal(x: Real): boolean {
    return x instanceof Rational ? x.isZero() : x.isZero()
  }

  private addReal(a: Real, b: Real): Real {
    return a instanceof Rational && b instanceof Rational ? a.add(b) : this.fromBig(this.toBig(a).plus(this.toBig(b)) as BigNumber)
  }

  private subReal(a: Real, b: Real): Real {
    return a instanceof Rational && b instanceof Rational ? a.sub(b) : this.fromBig(this.toBig(a).minus(this.toBig(b)) as BigNumber)
  }

  private mulReal(a: Real, b: Real): Real {
    if (a instanceof Rational && b instanceof Rational) {
      return this.sized(a.mul(b))
    }

    return this.fromBig(this.toBig(a).times(this.toBig(b)) as BigNumber)
  }

  private divReal(a: Real, b: Real): Real {
    if (this.isZeroReal(b)) {
      throw new CalcError(DIVIDE_BY_ZERO)
    }

    if (a instanceof Rational && b instanceof Rational) {
      return this.sized(a.div(b))
    }

    return this.fromBig(this.toBig(a).div(this.toBig(b)) as BigNumber)
  }

  private negReal(x: Real): Real {
    return x instanceof Rational ? x.neg() : (x.neg() as BigNumber)
  }

  private cmpReal(a: Real, b: Real): number {
    return a instanceof Rational && b instanceof Rational ? a.cmp(b) : this.toBig(a).cmp(this.toBig(b))
  }

  private modReal(a: Real, b: Real): Real {
    if (a instanceof Rational && b instanceof Rational) {
      return a.mod(b)
    }

    const x = this.toBig(a)
    const y = this.toBig(b)

    return this.fromBig(x.minus(y.times(x.div(y).floor())) as BigNumber)
  }

  private powReal(base: Real, exponent: Real): Real {
    if (base instanceof Rational && exponent instanceof Rational) {
      try {
        if (exponent.isInteger()) {
          return base.pow(exponent.n)
        }

        const root = exponent.d <= 64n ? base.root(exponent.d) : null

        if (root) {
          return root.pow(exponent.n)
        }
      } catch (error) {
        if (error instanceof RangeError && error.message === 'division by zero') {
          throw new CalcError(DIVIDE_BY_ZERO)
        }
      }
    }

    const integer = exponent instanceof Rational ? exponent.isInteger() : exponent.isInteger()

    if (this.sign(base) < 0 && !integer) {
      throw new CalcError("A negative number to a fractional power isn't a real number")
    }

    if (this.isZeroReal(base) && this.sign(exponent) < 0) {
      throw new CalcError(DIVIDE_BY_ZERO)
    }

    return this.fromBig(this.toBig(base).pow(this.toBig(exponent)) as BigNumber)
  }

  /** An exact result that grew too long becomes a 64-digit decimal. */
  private sized(x: Rational): Real {
    return x.size() > MAX_EXACT_DIGITS ? this.fromBig(this.toBig(x)) : x
  }
}
