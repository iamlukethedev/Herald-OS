import { addDecimals, negateDecimal, normalizeEntry } from './decimal.ts'
import {
  type Angle,
  type BinaryOp,
  CONSTANTS,
  type ConstantId,
  closeOpen,
  expressionOf,
  type Item,
  isOperand,
  lastOpen,
  type Operand,
  type Operator,
  operandExpression,
  reducibleOperand,
  sequenceText,
  type Token,
  takesAngle,
  type UnaryFn
} from './expression.ts'

/*
 * The classic and scientific keypads as a pure state machine, modelled on a modern phone
 * calculator: the display shows the number being typed or the operand just worked out, operators
 * keep their precedence (2 + 3 × 4 = 14), functions apply to what is on screen, percent works the
 * iOS way, and a repeated '=' repeats the last operation. It only builds the expression; the
 * engine evaluates it, and `resolve` hands each '=' its exact value back.
 */

export type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
export type FunctionKey = 'square' | 'cube' | 'reciprocal' | 'sqrt' | 'cbrt' | 'exp' | 'pow10' | 'ln' | 'log10' | 'factorial' | 'sin' | 'cos' | 'tan' | 'sinh' | 'cosh' | 'tanh'
export type MemoryKey = 'memory-clear' | 'memory-recall' | 'memory-add' | 'memory-subtract'
export type DecimalKey =
  | Digit
  | BinaryOp
  | FunctionKey
  | ConstantId
  | MemoryKey
  | 'decimal'
  | 'exponent'
  | 'sign'
  | 'percent'
  | 'equals'
  | 'clear'
  | 'backspace'
  | 'open'
  | 'close'
  | 'second'
  | 'rand'

/** The operand in the display slot: being typed, or worked out (a function, a constant, a group, a result). */
export type Current = { type: 'entry'; text: string } | { type: 'value'; operand: Operand }

export interface KeypadState {
  /** Everything before the current operand: operands, operators and parentheses still open. */
  items: Item[]
  /** Null right after an operator or a parenthesis. */
  current: Current | null
  /** A result is on screen and nothing has been typed since: a digit starts over. */
  fresh: boolean
  /** The last '=': the view evaluates and records each id once. */
  last: { id: number; items: Token[] } | null
  /** What another '=' does to the result. */
  repeat: { op: BinaryOp; operand: Operand } | null
  /** Exact decimal. */
  memory: string | null
  /** 2nd: the inverse functions. */
  second: boolean
}

export interface PressContext {
  angle: Angle
  /** Rand's value, from the view: a decimal in [0, 1). */
  random?: string
  /** The exact value on screen as the engine gave it, for M+ and M− when the state cannot know it. */
  shown?: string | null
}

export const INITIAL_KEYPAD: KeypadState = { items: [], current: null, fresh: false, last: null, repeat: null, memory: null, second: false }

export const MAX_ENTRY_DIGITS = 16
const MAX_EXPONENT_DIGITS = 3

const ZERO: Operand = { type: 'number', value: '0' }
const OPEN: Item = { type: 'open' }
const BINARY: ReadonlySet<string> = new Set<BinaryOp>(['add', 'subtract', 'multiply', 'divide', 'power', 'root'])
const FUNCTIONS: ReadonlySet<string> = new Set<FunctionKey>(['square', 'cube', 'reciprocal', 'sqrt', 'cbrt', 'exp', 'pow10', 'ln', 'log10', 'factorial', 'sin', 'cos', 'tan', 'sinh', 'cosh', 'tanh'])
/** What a function key does while 2nd is on. */
export const SECOND: Partial<Record<FunctionKey, UnaryFn>> = { sin: 'asin', cos: 'acos', tan: 'atan', sinh: 'asinh', cosh: 'acosh', tanh: 'atanh', pow10: 'pow2', log10: 'log2' }

const isDigit = (key: DecimalKey): key is Digit => key.length === 1 && key >= '0' && key <= '9'
const isBinary = (key: DecimalKey): key is BinaryOp => BINARY.has(key)
const isFunction = (key: DecimalKey): key is FunctionKey => FUNCTIONS.has(key)
const isConstant = (key: DecimalKey): key is ConstantId => Object.hasOwn(CONSTANTS, key)

const operandOf = (current: Current): Operand => (current.type === 'entry' ? { type: 'number', value: normalizeEntry(current.text) } : current.operand)

/** A result stops being one once anything is typed. */
const editing = (state: KeypadState): KeypadState => (state.fresh ? { ...state, items: [], fresh: false } : state)

/** The operand on screen: the current one, or the value the pending operator left showing. */
export function shownOperand(state: KeypadState): Operand {
  return state.current ? operandOf(state.current) : (reducibleOperand(state.items) ?? ZERO)
}

/** The exact value of an operand when the state knows it without the engine. */
export function knownValue(operand: Operand): string | null {
  switch (operand.type) {
    case 'number':
      return operand.value
    case 'constant':
      return CONSTANTS[operand.id].value
    case 'result':
      return operand.value ?? null
    default:
      return null
  }
}

function appendDigit(text: string, digit: Digit): string {
  const exponentAt = text.indexOf('e')

  if (exponentAt >= 0) {
    const exponent = text.slice(exponentAt + 1).replace('-', '')

    if (exponent.length >= MAX_EXPONENT_DIGITS) {
      return text
    }

    return exponent === '0' ? `${text.slice(0, -1)}${digit}` : `${text}${digit}`
  }

  if (text.replace(/\D/g, '').length >= MAX_ENTRY_DIGITS) {
    return text
  }

  if (text === '0' || text === '-0') {
    return `${text.slice(0, -1)}${digit}`
  }

  return `${text}${digit}`
}

function typeDigit(state: KeypadState, digit: Digit): KeypadState {
  const next = editing(state)
  const current = next.current

  if (!current || current.type === 'value') {
    return { ...next, current: { type: 'entry', text: digit } }
  }

  const text = appendDigit(current.text, digit)

  return text === current.text ? next : { ...next, current: { type: 'entry', text } }
}

function typeDecimal(state: KeypadState): KeypadState {
  const next = editing(state)
  const current = next.current

  if (!current || current.type === 'value') {
    return { ...next, current: { type: 'entry', text: '0.' } }
  }

  if (current.text.includes('.') || current.text.includes('e')) {
    return next
  }

  return { ...next, current: { type: 'entry', text: `${current.text}.` } }
}

/** EE: what follows is a power of ten; with nothing being typed it starts at 1. */
function typeExponent(state: KeypadState): KeypadState {
  const next = editing(state)
  const current = next.current

  if (!current || current.type === 'value') {
    return { ...next, current: { type: 'entry', text: '1e' } }
  }

  if (current.text.includes('e')) {
    return next
  }

  return { ...next, current: { type: 'entry', text: `${current.text.replace(/\.$/, '')}e` } }
}

function negate(operand: Operand): Operand {
  if (operand.type === 'number') {
    return { type: 'number', value: negateDecimal(operand.value) }
  }

  if (operand.type === 'result' && operand.value !== undefined) {
    return { type: 'number', value: negateDecimal(operand.value) }
  }

  if (operand.type === 'apply' && operand.fn === 'negate') {
    return operand.arg
  }

  return { type: 'apply', fn: 'negate', arg: operand }
}

/** ±: the sign of the number being typed (of its exponent after EE), or of the operand on screen. */
function toggleSign(state: KeypadState): KeypadState {
  const current = state.current

  if (!current) {
    return { ...state, current: { type: 'entry', text: '-0' } }
  }

  if (current.type === 'value') {
    return { ...state, fresh: false, current: { type: 'value', operand: negate(current.operand) } }
  }

  const exponentAt = current.text.indexOf('e')

  if (exponentAt >= 0) {
    const exponent = current.text.slice(exponentAt + 1)
    const flipped = exponent.startsWith('-') ? exponent.slice(1) : `-${exponent}`

    return { ...state, current: { type: 'entry', text: `${current.text.slice(0, exponentAt + 1)}${flipped}` } }
  }

  return { ...state, current: { type: 'entry', text: current.text.startsWith('-') ? current.text.slice(1) : `-${current.text}` } }
}

/** iOS percent: 50 + 10% is 50 + 5, 50 × 10% is 50 × 0.1, 10% alone is 0.1. */
function percent(state: KeypadState): KeypadState {
  const arg = shownOperand(state)
  const pending = state.items.at(-1)
  const additive = pending?.type === 'operator' && (pending.op === 'add' || pending.op === 'subtract')
  const of = additive ? reducibleOperand(state.items) : null
  const operand: Operand = of ? { type: 'percent', arg, of } : { type: 'percent', arg }

  return { ...state, fresh: false, current: { type: 'value', operand } }
}

function applyFunction(state: KeypadState, fn: UnaryFn, angle: Angle): KeypadState {
  const arg = shownOperand(state)
  const operand: Operand = takesAngle(fn) ? { type: 'apply', fn, arg, angle } : { type: 'apply', fn, arg }

  return { ...state, fresh: false, current: { type: 'value', operand } }
}

/** π, e, a constant, Rand and MR take the display slot, whatever was there. */
function replaceCurrent(state: KeypadState, operand: Operand): KeypadState {
  return { ...editing(state), current: { type: 'value', operand } }
}

function pressOperator(state: KeypadState, op: BinaryOp): KeypadState {
  const operator: Operator = { type: 'operator', op }

  if (state.current) {
    return { ...state, items: [...state.items, operandOf(state.current), operator], current: null, fresh: false }
  }

  const pending = state.items.at(-1)

  if (!pending) {
    return { ...state, items: [ZERO, operator] }
  }

  // A second operator replaces the first; right after '(' there is nothing to work on yet.
  return pending.type === 'operator' ? { ...state, items: [...state.items.slice(0, -1), operator] } : state
}

function open(state: KeypadState): KeypadState {
  if (state.fresh) {
    return { ...state, items: [OPEN], current: null, fresh: false }
  }

  if (!state.current) {
    return { ...state, items: [...state.items, OPEN] }
  }

  return { ...state, items: [...state.items, operandOf(state.current), { type: 'operator', op: 'multiply' }, OPEN], current: null }
}

function close(state: KeypadState): KeypadState {
  const at = lastOpen(state.items)

  if (at < 0 || !state.current || state.fresh) {
    return state
  }

  const inner = [...state.items.slice(at + 1), operandOf(state.current)] as Token[]

  return { ...state, items: state.items.slice(0, at), current: { type: 'value', operand: { type: 'group', items: inner } } }
}

/** What '=' works out: the expression completed, or the result with the last operation again. */
function equalsTokens(state: KeypadState): Token[] {
  if (state.current && state.items.length > 0) {
    return closeOpen([...state.items, operandOf(state.current)])
  }

  let items = state.current ? [] : state.items

  while (items.at(-1)?.type === 'open') {
    items = items.slice(0, -1)
  }

  if (items.length === 0) {
    const operand = state.current ? operandOf(state.current) : ZERO

    return state.repeat ? [operand, { type: 'operator', op: state.repeat.op }, state.repeat.operand] : [operand]
  }

  // "2 × 3 + =" works with what the display shows after the operator: 2 × 3 + 6.
  return closeOpen([...items, reducibleOperand(items) ?? ZERO])
}

function equals(state: KeypadState): KeypadState {
  const tokens = equalsTokens(state)
  const [only] = tokens

  if (tokens.length === 1 && isOperand(only) && only.type === 'number') {
    return { ...state, items: [], current: { type: 'value', operand: only }, fresh: true }
  }

  const id = (state.last?.id ?? 0) + 1
  const operator = tokens.at(-2)
  const operand = tokens.at(-1)
  const repeat = tokens.length >= 3 && operator?.type === 'operator' && operand && isOperand(operand) ? { op: operator.op, operand } : state.repeat

  return { ...state, items: [], current: { type: 'value', operand: { type: 'result', id, items: tokens } }, fresh: true, last: { id, items: tokens }, repeat }
}

/** C clears the entry, AC everything but the memory. */
export function clearLabel(state: KeypadState): 'C' | 'AC' {
  const current = state.current

  return current && !state.fresh && !(current.type === 'entry' && current.text === '0') ? 'C' : 'AC'
}

function clear(state: KeypadState): KeypadState {
  if (clearLabel(state) === 'C') {
    return { ...state, current: { type: 'entry', text: '0' } }
  }

  return { ...INITIAL_KEYPAD, memory: state.memory, second: state.second, last: state.last }
}

function backspace(state: KeypadState): KeypadState {
  const current = state.current

  if (state.fresh) {
    return state
  }

  if (current?.type === 'entry') {
    const text = current.text.slice(0, -1)

    // Past the last digit the entry goes, and the next press takes back the operator before it.
    if (text === '' || text === '-' || current.text === '0') {
      if (state.items.length > 0) {
        return { ...state, current: null }
      }

      return current.text === '0' ? state : { ...state, current: { type: 'entry', text: '0' } }
    }

    return { ...state, current: { type: 'entry', text } }
  }

  if (current) {
    return { ...state, current: null }
  }

  const pending = state.items.at(-1)

  if (!pending) {
    return state
  }

  const items = state.items.slice(0, -1)
  const before = items.at(-1)

  if (pending.type === 'open' || !before || !isOperand(before)) {
    return { ...state, items }
  }

  // Taking back an operator brings back the operand before it, typed numbers as entries.
  return { ...state, items: items.slice(0, -1), current: before.type === 'number' ? { type: 'entry', text: before.value } : { type: 'value', operand: before } }
}

function remember(state: KeypadState, sign: 1 | -1, shown?: string | null): KeypadState {
  const value = knownValue(shownOperand(state)) ?? shown ?? null
  const memory = value === null ? null : addDecimals(state.memory ?? '0', sign === 1 ? value : negateDecimal(value))

  if (memory === null) {
    return state
  }

  // The number on screen is done: the next digit starts a new one.
  const current: Current | null = state.current?.type === 'entry' ? { type: 'value', operand: operandOf(state.current) } : state.current

  return { ...state, memory, current }
}

export function press(state: KeypadState, key: DecimalKey, context: PressContext): KeypadState {
  if (isDigit(key)) {
    return typeDigit(state, key)
  }

  if (isBinary(key)) {
    return pressOperator(state, key)
  }

  if (isFunction(key)) {
    return applyFunction(state, state.second ? (SECOND[key] ?? key) : key, context.angle)
  }

  if (isConstant(key)) {
    return replaceCurrent(state, { type: 'constant', id: key })
  }

  switch (key) {
    case 'decimal':
      return typeDecimal(state)
    case 'exponent':
      return typeExponent(state)
    case 'sign':
      return toggleSign(state)
    case 'percent':
      return percent(state)
    case 'equals':
      return equals(state)
    case 'clear':
      return clear(state)
    case 'backspace':
      return backspace(state)
    case 'open':
      return open(state)
    case 'close':
      return close(state)
    case 'second':
      return { ...state, second: !state.second }
    case 'rand':
      return replaceCurrent(state, { type: 'number', value: context.random ?? '0' })
    case 'memory-clear':
      return state.memory === null ? state : { ...state, memory: null }
    case 'memory-recall':
      return state.memory === null ? state : replaceCurrent(state, { type: 'number', value: state.memory })
    case 'memory-add':
      return remember(state, 1, context.shown)
    case 'memory-subtract':
      return remember(state, -1, context.shown)
  }
}

function fillOperand(operand: Operand, id: number, value: string): Operand {
  switch (operand.type) {
    case 'result':
      return operand.id === id && operand.value === undefined ? { ...operand, value } : { ...operand, items: fillTokens(operand.items, id, value) }
    case 'group':
      return { ...operand, items: fillTokens(operand.items, id, value) }
    case 'apply':
      return { ...operand, arg: fillOperand(operand.arg, id, value) }
    case 'percent':
      return operand.of ? { ...operand, arg: fillOperand(operand.arg, id, value), of: fillOperand(operand.of, id, value) } : { ...operand, arg: fillOperand(operand.arg, id, value) }
    default:
      return operand
  }
}

function fillTokens(tokens: readonly Token[], id: number, value: string): Token[] {
  return tokens.map(token => (isOperand(token) ? fillOperand(token, id, value) : token))
}

/** The engine's exact value for the '=' with this id, wherever its result is now. */
export function resolve(state: KeypadState, id: number, value: string): KeypadState {
  return {
    ...state,
    items: state.items.map(item => (isOperand(item) ? fillOperand(item, id, value) : item)),
    current: state.current?.type === 'value' ? { type: 'value', operand: fillOperand(state.current.operand, id, value) } : state.current,
    last: state.last ? { ...state.last, items: fillTokens(state.last.items, id, value) } : null,
    repeat: state.repeat ? { ...state.repeat, operand: fillOperand(state.repeat.operand, id, value) } : null
  }
}

/** The big display: the entry as typed, a value the state knows, or an expression for the engine. */
export type Shown = { type: 'entry'; text: string } | { type: 'value'; value: string } | { type: 'expression'; expression: string }

export function shown(state: KeypadState): Shown {
  if (state.current?.type === 'entry') {
    return { type: 'entry', text: state.current.text }
  }

  const operand = shownOperand(state)
  const value = knownValue(operand)

  return value === null ? { type: 'expression', expression: operandExpression(operand) } : { type: 'value', value }
}

/** The line above the display: the expression so far, or what the result on screen came from. */
export function pendingText(state: KeypadState, locale?: string): string {
  const current = state.current

  if (state.fresh && current?.type === 'value' && current.operand.type === 'result') {
    return `${sequenceText(current.operand.items, locale)} =`
  }

  if (!current) {
    return sequenceText(state.items, locale)
  }

  if (state.items.length === 0 && (current.type === 'entry' || current.operand.type === 'number' || current.operand.type === 'result')) {
    return ''
  }

  return sequenceText([...state.items, operandOf(current)], locale)
}

/** The whole expression while there is more to it than the operand on screen, for the live result. */
export function previewExpression(state: KeypadState): string | null {
  if (state.fresh || !state.current || state.items.length === 0) {
    return null
  }

  return expressionOf([...state.items, operandOf(state.current)])
}

/** The operator waiting for its right side, which its key shows. */
export function pendingOperator(state: KeypadState): BinaryOp | null {
  const pending = state.items.at(-1)

  return !state.current && pending?.type === 'operator' ? pending.op : null
}
