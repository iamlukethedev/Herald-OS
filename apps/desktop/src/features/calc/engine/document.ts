import { evaluateDateLine, type TimeContext, type TimeOutcome } from './dates.ts'
import { CalcError, Evaluator, newWork, UnknownName, type Env, type Value } from './evaluator.ts'
import { formatValue } from './format.ts'
import { lex, type Token } from './lexer.ts'
import { analyzeLine, labelName, matchSentence, nameKey, type LineShape, type Slice } from './line.ts'
import type { MathEngine } from './math.ts'
import { ParseError, parseContext, parseTokens, unitSpans, type Node, type ParseContext } from './parser.ts'
import { printExpression } from './printer.ts'
import { Rational } from './rational.ts'
import type { CalcContext, CalcValue, DocumentResult, LineResult, PlotFunction, TokenSpan } from './types.ts'
import { CONSTANT_NAMES, CURRENCY_NAMES, FUNCTION_NAMES, NUMBER_WORDS, OPERATOR_WORDS } from './words.ts'
import { evaluateZoneLine } from './zones.ts'

/*
 * A note, line by line: names assigned above count below, "prev" is the last answer, "sum" adds up
 * the block above, and the footer keeps a running total. Each line goes: blank, heading, comment,
 * label, assignment; then times and dates; then the sentence forms; then the expression. A line of
 * plain words is a comment, not an error.
 */

interface Answer {
  value: Value
  calc: CalcValue
  display: string
  steps: string[]
  usesRates: boolean
  /** The line was about dates or times. */
  time?: boolean
  /** Plain words around the value that name it ("$24 lunch with Sam"), and where they sit. */
  label?: { text: string; spans: Array<[number, number]> }
  /** Where the units written after amounts sit in the line, so an "in" there shows as inches. */
  units?: Array<[number, number]>
}

interface Failure {
  error: string
  /** The line did not read or named something unknown, so plain words around a value may be a label. */
  soft: boolean
  /** The name that had no value. */
  unknown?: string
}

type Outcome = Answer | Failure

interface Parsed {
  node: Node | null
  error?: ParseError
  /** The most decimals any number in it was written with, for the working. */
  places: number
}

const PARSE_LIMIT = 4000
/** At most this many words after numbers are read as what they count, in one line. */
const MAX_COUNT_WORDS = 4
const parseCache = new Map<string, Parsed>()

function parseText(text: string, context: ParseContext, locale: string | undefined): Parsed {
  const key = `${locale ?? ''}\u0000${text}`
  const cached = parseCache.get(key)

  if (cached) {
    return cached
  }

  const tokens = lex(text, context.symbols)
  const places = Math.min(2, Math.max(0, ...tokens.map(token => (token.kind === 'number' ? (token.decimals ?? 0) : 0))))
  let parsed: Parsed

  try {
    parsed = { node: parseTokens(tokens, context), places }
  } catch (error) {
    parsed = { node: null, error: error instanceof ParseError ? error : new ParseError("This line doesn't read as math", 0), places }
  }

  if (parseCache.size >= PARSE_LIMIT) {
    parseCache.delete(parseCache.keys().next().value as string)
  }

  parseCache.set(key, parsed)

  return parsed
}

/** Every line of `text` worked out with math.js loaded. Never throws. */
export function evaluateLines(text: string, context: CalcContext, engine: MathEngine): DocumentResult {
  return new NoteEvaluator(context, engine).run(text)
}

class NoteEvaluator {
  private readonly context: CalcContext
  private readonly engine: MathEngine
  private readonly parse: ParseContext
  private readonly scope = new Map<string, Value>()
  private readonly variables: Record<string, CalcValue> = {}
  private readonly phrases: string[] = []
  private phrasePattern: RegExp | null = null
  private previous: Value | null = null
  private previousCalc: CalcValue | null = null
  private block: Value[] = []
  private running: Value | null = null
  private runningBroken = false
  private usesRates = false
  private readonly functions: PlotFunction[] = []

  constructor(context: CalcContext, engine: MathEngine) {
    this.context = context
    this.engine = engine
    this.parse = parseContext(context.locale)
  }

  run(text: string): DocumentResult {
    const lines = text.split(/\r\n|\r|\n/)
    const results = lines.map((source, index) => this.safeLine(source, index))
    let total: CalcValue | null = null

    if (this.running && !this.runningBroken) {
      try {
        total = this.evaluator().calcValue(this.running)
      } catch {
        total = null
      }
    }

    return {
      lines: results,
      total,
      totalDisplay: total ? formatValue(total, { locale: this.context.locale }) : null,
      usesRates: this.usesRates,
      functions: this.functions,
      locale: this.context.locale
    }
  }

  private evaluator(places = 0): Evaluator {
    return new Evaluator(this.env(), newWork(places))
  }

  private env(): Env {
    return { math: this.engine.math, context: this.parse, locale: this.context.locale, rates: this.context.rates, scope: this.scope, previous: this.previous }
  }

  private safeLine(source: string, index: number): LineResult {
    try {
      return this.line(source, index)
    } catch (error) {
      return { index, kind: 'error', source, error: error instanceof CalcError ? error.message : "This line couldn't be worked out" }
    }
  }

  private line(source: string, index: number): LineResult {
    const prepared = this.withNames(source)
    const { shape, tokens } = analyzeLine(prepared, this.context.locale)

    switch (shape.kind) {
      case 'blank':
        this.block = []

        return { index, kind: 'blank', source }
      case 'heading':
        this.block = []

        return { index, kind: 'heading', source, label: shape.label, tokens }
      case 'comment':
        return { index, kind: 'comment', source, label: shape.label, tokens }
      case 'total':
        return this.totalLine(shape, source, index, tokens)
      case 'function':
        return this.functionLine(shape.name, shape.variable, shape.body, shape.label, source, index, tokens)
      case 'plot':
        return this.plotLine(shape, source, index, tokens)
      case 'expression':
        return this.expressionLine(shape, source, prepared, index, tokens)
    }
  }

  /** Multi-word names assigned above, joined with underscores so they read as one name; the length stays the same. */
  private withNames(source: string): string {
    return this.phrasePattern ? source.replace(this.phrasePattern, match => match.replace(/\s/g, '_')) : source
  }

  private remember(name: string, value: Value, calc: CalcValue): void {
    const key = nameKey(name)
    const spaced = name.trim().toLowerCase().replace(/\s+/g, ' ')

    this.scope.set(key, value)
    this.variables[key] = calc
    this.variables[spaced] = calc

    if (spaced.includes(' ') && !this.phrases.includes(spaced)) {
      const escape = (phrase: string): string => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s')

      this.phrases.push(spaced)
      this.phrases.sort((a, b) => b.length - a.length)
      this.phrasePattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${this.phrases.map(escape).join('|')})(?![\\p{L}\\p{N}_])`, 'giu')
    }
  }

  private settle(value: Value, calc: CalcValue): void {
    this.previous = value
    this.previousCalc = calc
  }

  private addToRunning(value: Value): void {
    if (this.runningBroken) {
      return
    }

    if (!this.running) {
      this.running = value
      return
    }

    try {
      const evaluator = this.evaluator()

      this.running = evaluator.sum([this.running, value])
      this.usesRates ||= evaluator.work.usesRates
    } catch {
      this.runningBroken = true
    }
  }

  private totalLine(shape: Extract<LineShape, { kind: 'total' }>, source: string, index: number, tokens: TokenSpan[]): LineResult {
    const evaluator = this.evaluator()
    const values = this.block

    try {
      const sum: Value = values.length ? evaluator.sum(values) : { kind: 'number', x: Rational.ZERO }
      const result = shape.total === 'average' && values.length ? evaluator.average(sum, values.length) : sum
      const calc = evaluator.calcValue(result)
      const steps = [...evaluator.work.steps]

      if (values.length > 1) {
        const shown = values.map(item => evaluator.show(evaluator.usable(item)))

        steps.push(values.length <= 8 ? `${shown.join(' + ')} = ${evaluator.show(sum)}` : `${values.length} lines add up to ${evaluator.show(sum)}`)

        if (shape.total === 'average') {
          steps.push(`${evaluator.show(sum)} ÷ ${values.length} = ${evaluator.show(result)}`)
        }
      }

      this.settle(result, calc)
      this.usesRates ||= evaluator.work.usesRates

      return {
        index,
        kind: 'value',
        source,
        label: shape.label?.text ?? (shape.total === 'average' ? 'Average' : 'Total'),
        value: calc,
        display: formatValue(calc, { locale: this.context.locale }),
        steps,
        tokens,
        usesRates: evaluator.work.usesRates || undefined
      }
    } catch (error) {
      return { index, kind: 'error', source, error: error instanceof CalcError ? error.message : "These lines don't add up", tokens }
    }
  }

  private functionLine(name: string, variable: string, body: Slice, label: Slice | undefined, source: string, index: number, tokens: TokenSpan[]): LineResult {
    try {
      const plot = this.plotFunction(name, variable, body, index)

      this.functions.push(plot)

      return { index, kind: 'function', source, label: label?.text ?? name, plot, tokens }
    } catch (error) {
      return { index, kind: 'error', source, error: error instanceof Error ? error.message : "That doesn't read as a function", tokens }
    }
  }

  private plotFunction(name: string, variable: string, body: Slice, index: number): PlotFunction {
    const parsed = parseText(body.text, this.parse, this.context.locale)

    if (!parsed.node) {
      throw parsed.error ?? new ParseError("That doesn't read as a function", body.from)
    }

    const evaluator = this.evaluator()
    const expression = printExpression(parsed.node, key => {
      if (key === variable.toLowerCase()) {
        return variable
      }

      const value = this.scope.get(key)

      if (value?.kind === 'number' || value?.kind === 'percent') {
        const number = evaluator.calcValue(value).number / (value.kind === 'percent' ? 100 : 1)

        return Number.isFinite(number) ? String(number) : null
      }

      return null
    })

    return { name, expression, variable, index }
  }

  private plotLine(shape: Extract<LineShape, { kind: 'plot' }>, source: string, index: number, tokens: TokenSpan[]): LineResult {
    try {
      const plot = this.plotFunction(shape.name ?? '', 'x', shape.body, index)

      this.functions.push(plot)

      return { index, kind: 'plot', source, label: shape.label?.text, plot, tokens }
    } catch {
      return { index, kind: 'plot', source, label: shape.label?.text, plotSource: shape.body.text, tokens }
    }
  }

  private expressionLine(shape: Extract<LineShape, { kind: 'expression' }>, source: string, prepared: string, index: number, tokens: TokenSpan[]): LineResult {
    if (shape.reserved) {
      return { index, kind: 'error', source, error: `“${shape.reserved}” is built in, so it can't be a name`, tokens }
    }

    const name = shape.name ? source.slice(shape.name.from, shape.name.to) : undefined

    if (shape.name && shape.usesX && !this.scope.has('x')) {
      return this.functionLine(name ?? 'y', 'x', shape.body, shape.label, source, index, tokens)
    }

    if (!shape.body.text) {
      return { index, kind: 'error', source, label: shape.label?.text, error: name ? `Give “${name}” a value after the =` : 'There is nothing to work out', tokens }
    }

    const outcome = this.evaluateBody(shape.body, prepared, source)

    if ('error' in outcome) {
      if (!name && !looksLikeMath(shape.body.text, this.parse)) {
        return { index, kind: 'comment', source, label: source.trim(), tokens: tokens.filter(span => span.type === 'comment') }
      }

      return { index, kind: 'error', source, label: shape.label?.text ?? name, name, error: outcome.error, tokens }
    }

    const named = name ?? (shape.label ? labelName(shape.label.text) : null)

    if (named) {
      this.remember(named, outcome.value, outcome.calc)
    }

    this.settle(outcome.value, outcome.calc)
    this.block.push(outcome.value)
    this.addToRunning(outcome.value)
    this.usesRates ||= outcome.usesRates

    return {
      index,
      kind: 'value',
      source,
      label: shape.label?.text ?? name ?? outcome.label?.text,
      name: named ?? undefined,
      value: outcome.calc,
      display: outcome.display,
      steps: outcome.steps,
      tokens: retag(tokens, outcome, prepared),
      usesRates: outcome.usesRates || undefined
    }
  }

  /** The body worked out, retrying without plain words before or after the value when it does not read. */
  private evaluateBody(body: Slice, prepared: string, source: string): Outcome {
    const first = this.attempt(body)

    if (!('error' in first) || !first.soft || prepared.slice(body.from, body.to) !== body.text) {
      return first
    }

    const tokens = lex(body.text, this.parse.symbols, body.from)
    const lead = leadingWords(tokens)

    for (let cut = 1; cut <= lead; cut++) {
      const rest = { text: prepared.slice(tokens[cut].from, body.to), from: tokens[cut].from, to: body.to }
      const outcome = this.withTrailing(rest, prepared, source)

      if (!('error' in outcome)) {
        const words = source.slice(body.from, tokens[cut - 1].to)
        const spans: Array<[number, number]> = [[body.from, tokens[cut - 1].to], ...(outcome.label?.spans ?? [])]

        return { ...outcome, label: { text: [words, outcome.label?.text].filter(Boolean).join(' '), spans } }
      }
    }

    return this.trailing(body, prepared, source, tokens) ?? this.counted(body, prepared, source, tokens, first) ?? first
  }

  /** "4 nights * $189": a word right after a number that names nothing says what the number counts. */
  private counted(body: Slice, prepared: string, source: string, tokens: Token[], first: Failure): Answer | null {
    const dropped: Token[] = []
    let text = prepared.slice(body.from, body.to)
    let failure = first

    while (failure.unknown && dropped.length < MAX_COUNT_WORDS) {
      const name = failure.unknown.toLowerCase()
      const word = tokens.find((token, at) => token.kind === 'word' && token.lower === name && tokens[at - 1]?.kind === 'number' && !dropped.includes(token))

      if (!word) {
        return null
      }

      dropped.push(word)
      text = `${text.slice(0, word.from - body.from)}${' '.repeat(word.to - word.from)}${text.slice(word.to - body.from)}`
      const outcome = this.attempt({ text, from: body.from, to: body.to })

      if (!('error' in outcome)) {
        const spans: Array<[number, number]> = dropped.map(token => [token.from, token.to])

        return { ...outcome, label: { text: dropped.map(token => source.slice(token.from, token.to)).join(' '), spans: [...spans, ...(outcome.label?.spans ?? [])] } }
      }

      if (!outcome.soft) {
        return null
      }

      failure = outcome
    }

    return null
  }

  private withTrailing(slice: Slice, prepared: string, source: string): Outcome {
    const outcome = this.attempt(slice)

    if (!('error' in outcome) || !outcome.soft) {
      return outcome
    }

    return this.trailing(slice, prepared, source, lex(slice.text, this.parse.symbols, slice.from)) ?? outcome
  }

  /** "$24 lunch with Sam": the longest start that has a value when only words follow it. */
  private trailing(slice: Slice, prepared: string, source: string, tokens: Token[]): Answer | null {
    for (let cut = tokens.length - 1; cut >= 1; cut--) {
      if (!tokens.slice(cut).every(token => token.kind === 'word')) {
        break
      }

      const end = tokens[cut - 1].to
      const outcome = this.attempt({ text: prepared.slice(slice.from, end), from: slice.from, to: end })
      const conversion = cut === tokens.length - 2 && /^(in|into|to|as)$/.test(tokens[cut].lower ?? '')

      // "5 km in parsecs" asks for a unit Herald lacks; the words after a unit are not a label.
      if (conversion && !('error' in outcome) && outcome.value.kind === 'unit') {
        return null
      }

      if (!('error' in outcome)) {
        const from = tokens[cut].from

        return { ...outcome, label: { text: source.slice(from, slice.to), spans: [[from, slice.to]] } }
      }
    }

    return null
  }

  /** One try at a body: times and dates, then the sentence forms, then the expression. */
  private attempt(body: Slice): Outcome {
    const time = this.time(body.text)

    if (time) {
      if ('error' in time) {
        return { error: time.error, soft: false }
      }

      const value = this.evaluator().usable({ kind: 'other', value: time.value })

      return { value, calc: time.value, display: time.display, steps: time.steps, usesRates: false, time: true }
    }

    const sentence = matchSentence(body)
    const evaluator = this.evaluator(parseText(body.text, this.parse, this.context.locale).places)
    const units: Array<[number, number]> = []
    const read = (slice: Slice): Node => {
      const node = this.node(slice)

      units.push(...unitSpans(node).map(([from, to]): [number, number] => [slice.from + from, slice.from + to]))

      return node
    }

    try {
      const raw = sentence ? evaluator.sentence(sentence, part => evaluator.evaluate(read(part))) : evaluator.evaluate(read(body))
      const value = evaluator.tidy(raw)
      const calc = evaluator.calcValue(value)

      return { value, calc, display: evaluator.display(value), steps: evaluator.work.steps, usesRates: evaluator.work.usesRates, units }
    } catch (error) {
      if (error instanceof UnknownName) {
        return { error: error.message, soft: true, unknown: error.name }
      }

      if (error instanceof ParseError) {
        return { error: error.message, soft: true }
      }

      return { error: error instanceof CalcError ? error.message : "This line couldn't be worked out", soft: false }
    }
  }

  private node(slice: Slice): Node {
    const parsed = parseText(slice.text, this.parse, this.context.locale)

    if (!parsed.node) {
      throw parsed.error ?? new ParseError("This line doesn't read as math", slice.from)
    }

    return parsed.node
  }

  private time(text: string): TimeOutcome {
    const variables: Record<string, CalcValue> = { ...this.variables }

    if (this.previousCalc) {
      variables.prev = this.previousCalc
      variables.ans = this.previousCalc
    }

    const context: TimeContext = { now: this.context.now, zone: this.context.zone, locale: this.context.locale, variables }

    for (const read of [evaluateZoneLine, evaluateDateLine]) {
      try {
        const outcome = read(text, context)

        if (outcome) {
          return outcome
        }
      } catch {
        // A reader that fails has nothing to say about the line.
      }
    }

    return null
  }
}

/** How many words at the start may be a label: plain words before the first number, sign or bracket. */
function leadingWords(tokens: Token[]): number {
  let count = 0

  for (const token of tokens) {
    const word = token.lower ?? ''

    if (token.kind !== 'word' || FUNCTION_NAMES[word] || CONSTANT_NAMES[word] || NUMBER_WORDS[word] || CURRENCY_NAMES[word] || word in OPERATOR_WORDS || word === 'square' || word === 'cube') {
      break
    }

    count++
  }

  return Math.min(count, tokens.length - 1)
}

/** Whether a line that failed was trying to be math (a number, a currency, an operator sign, a call), so it gets an error rather than reading as text. */
function looksLikeMath(text: string, context: ParseContext): boolean {
  const tokens = lex(text, context.symbols)

  return tokens.some((token, index) => {
    if (token.kind === 'number' || token.kind === 'currency') {
      return true
    }

    return token.kind === 'symbol' && (/^[+*/^=%√∛²³]$/.test(token.value) || (token.value === '(' && tokens[index - 1]?.kind === 'word'))
  })
}

/** The line's tokens with its label words marked as a label, a line about dates marked as dates, and an "in" read as inches marked as a unit. */
function retag(tokens: TokenSpan[], answer: Answer, line: string): TokenSpan[] {
  const spans = answer.label?.spans ?? []
  const inches = (span: TokenSpan): boolean => line.slice(span.from, span.to).toLowerCase() === 'in' && (answer.units ?? []).some(([from, to]) => span.from >= from && span.to <= to)
  const kept = tokens
    .filter(span => !spans.some(([from, to]) => span.from >= from && span.to <= to))
    .map(span => (answer.time && span.type !== 'comment' && span.type !== 'label' && span.type !== 'operator' ? { ...span, type: 'date' as const } : span))
    .map(span => (span.type === 'keyword' && inches(span) ? { ...span, type: 'unit' as const } : span))

  return [...kept, ...spans.map(([from, to]) => ({ from, to, type: 'label' as const }))].sort((a, b) => a.from - b.from)
}
