import type { Digit } from './machine.ts'
import { type Base, digitValue, entryFits, formatWord, groupDigits, operate, operateUnary, type ProgrammerOp, type ProgrammerUnary, RADIX, resizeWord, toggleBit, type Word, type WordSize } from './programmer.ts'

/*
 * The programmer keypad as a pure state machine over BigInt words. It works like the decimal one
 * (precedence, a display slot, '=' repeating its last operation) but evaluates on the spot: every
 * value is already exact. Precedence follows C: × ÷ mod, then + −, shifts, AND, XOR, OR.
 */

export type HexDigit = Digit | 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
export type ProgrammerKey = HexDigit | ProgrammerOp | ProgrammerUnary | 'open' | 'close' | 'equals' | 'clear' | 'backspace'

export type WordOperand = { type: 'value'; value: bigint } | { type: 'group'; items: WordToken[]; value: bigint }
export type WordToken = WordOperand | { type: 'operator'; op: ProgrammerOp }
export type WordItem = WordToken | { type: 'open' }

export interface ProgrammerState {
  word: Word
  /** The base digits are typed in. */
  base: Base
  items: WordItem[]
  /** `typing`: digits append to it. */
  current: { operand: WordOperand; typing: boolean } | null
  fresh: boolean
  /** The last '=': the view records each id once. */
  last: { id: number; items: WordToken[]; value: bigint } | null
  repeat: { op: ProgrammerOp; operand: WordOperand } | null
  error: string | null
}

export const INITIAL_PROGRAMMER: ProgrammerState = { word: { bits: 64, signed: true }, base: 'dec', items: [], current: null, fresh: false, last: null, repeat: null, error: null }

export const PROGRAMMER_LEVEL: Record<ProgrammerOp, number> = { multiply: 6, divide: 6, mod: 6, add: 5, subtract: 5, shl: 4, sar: 4, shr: 4, and: 3, nand: 3, xor: 2, or: 1, nor: 1 }
const OPS: ReadonlySet<string> = new Set(Object.keys(PROGRAMMER_LEVEL))
const UNARY: ReadonlySet<string> = new Set<ProgrammerUnary>(['not', 'negate', 'rol', 'ror'])

export const PROGRAMMER_OPERATOR_TEXT: Record<ProgrammerOp, string> = {
  add: '+',
  subtract: '\u2212',
  multiply: '×',
  divide: '÷',
  mod: 'mod',
  and: 'AND',
  or: 'OR',
  xor: 'XOR',
  nand: 'NAND',
  nor: 'NOR',
  shl: '<<',
  sar: '>>',
  shr: '>>>'
}

const isOperand = (item: WordItem): item is WordOperand => item.type === 'value' || item.type === 'group'
const plain = (value: bigint): WordOperand => ({ type: 'value', value })
const ZERO = plain(0n)

/** Tokens by precedence, left to right; throws on division by zero. */
export function evaluateTokens(tokens: readonly WordToken[], word: Word): bigint {
  let position = 0

  const climb = (min: number): bigint => {
    const first = tokens[position]

    if (!first || first.type === 'operator') {
      return 0n
    }

    position++
    let left = first.value

    while (position < tokens.length) {
      const token = tokens[position]

      if (token.type !== 'operator' || PROGRAMMER_LEVEL[token.op] < min || position + 1 >= tokens.length) {
        break
      }

      position++
      left = operate(token.op, left, climb(PROGRAMMER_LEVEL[token.op] + 1), word)
    }

    return left
  }

  return climb(1)
}

function trimTail(items: readonly WordItem[]): WordItem[] {
  let end = items.length

  while (end > 0 && !isOperand(items[end - 1])) {
    end--
  }

  return items.slice(0, end)
}

const lastOpen = (items: readonly WordItem[]) => items.findLastIndex(item => item.type === 'open')

/** Open parentheses closed at the end, each group worked out; throws on division by zero. */
function closeOpen(items: readonly WordItem[], word: Word): WordToken[] {
  const result = [...items]

  for (let at = lastOpen(result); at >= 0; at = lastOpen(result)) {
    const inner = trimTail(result.slice(at + 1)) as WordToken[]
    const group: WordOperand[] = inner.length ? [{ type: 'group', items: inner, value: evaluateTokens(inner, word) }] : []
    result.splice(at, result.length - at, ...group)
  }

  return result as WordToken[]
}

/** With `items` ending in an operator: the part it cannot split, which the display shows. */
function reducibleOperand(items: readonly WordItem[], word: Word): WordOperand | null {
  const pending = items.at(-1)

  if (!pending || pending.type !== 'operator') {
    return null
  }

  const segment = items.slice(lastOpen(items) + 1, -1) as WordToken[]
  let start = segment.length - 1

  while (start >= 2) {
    const operator = segment[start - 1]

    if (operator.type !== 'operator' || PROGRAMMER_LEVEL[operator.op] < PROGRAMMER_LEVEL[pending.op]) {
      break
    }

    start -= 2
  }

  const part = segment.slice(Math.max(0, start))

  if (part.length === 0) {
    return null
  }

  return part.length === 1 ? (part[0] as WordOperand) : { type: 'group', items: part, value: evaluateTokens(part, word) }
}

/** The value on screen: the current operand or what the pending operator left showing; null when that divides by zero. */
export function shownWord(state: ProgrammerState): bigint | null {
  if (state.current) {
    return state.current.operand.value
  }

  try {
    return reducibleOperand(state.items, state.word)?.value ?? 0n
  } catch {
    return null
  }
}

/** The whole expression's value while there is more to it than the operand on screen; null when it fails. */
export function previewWord(state: ProgrammerState): bigint | null {
  if (state.fresh || !state.current || state.items.length === 0) {
    return null
  }

  try {
    return evaluateTokens(closeOpen([...state.items, state.current.operand], state.word), state.word)
  } catch {
    return null
  }
}

const editing = (state: ProgrammerState): ProgrammerState => (state.fresh ? { ...state, items: [], fresh: false } : state)

function typeDigit(state: ProgrammerState, digit: HexDigit): ProgrammerState {
  const digitNumber = digitValue(digit, state.base)

  if (digitNumber === null) {
    return state
  }

  const next = editing(state)
  const current = next.current

  if (!current || !current.typing) {
    return { ...next, current: { operand: plain(BigInt(digitNumber)), typing: true } }
  }

  const typed = current.operand.value * BigInt(RADIX[state.base]) + BigInt(digitNumber)

  return entryFits(typed, state.base, state.word) ? { ...next, current: { operand: plain(typed), typing: true } } : next
}

function pressOperator(state: ProgrammerState, op: ProgrammerOp): ProgrammerState {
  const operator: WordToken = { type: 'operator', op }

  if (state.current) {
    return { ...state, items: [...state.items, state.current.operand, operator], current: null, fresh: false }
  }

  const pending = state.items.at(-1)

  if (!pending) {
    return { ...state, items: [ZERO, operator] }
  }

  return pending.type === 'operator' ? { ...state, items: [...state.items.slice(0, -1), operator] } : state
}

function applyUnary(state: ProgrammerState, op: ProgrammerUnary): ProgrammerState {
  const shown = shownWord(state)

  if (shown === null) {
    throw new RangeError("Can't divide by zero")
  }

  return { ...state, fresh: false, current: { operand: plain(operateUnary(op, shown, state.word.bits)), typing: false } }
}

function open(state: ProgrammerState): ProgrammerState {
  if (state.fresh) {
    return { ...state, items: [{ type: 'open' }], current: null, fresh: false }
  }

  if (!state.current) {
    return { ...state, items: [...state.items, { type: 'open' }] }
  }

  return { ...state, items: [...state.items, state.current.operand, { type: 'operator', op: 'multiply' }, { type: 'open' }], current: null }
}

function close(state: ProgrammerState): ProgrammerState {
  const at = lastOpen(state.items)

  if (at < 0 || !state.current || state.fresh) {
    return state
  }

  const inner = [...state.items.slice(at + 1), state.current.operand] as WordToken[]
  const group: WordOperand = { type: 'group', items: inner, value: evaluateTokens(inner, state.word) }

  return { ...state, items: state.items.slice(0, at), current: { operand: group, typing: false } }
}

function equalsTokens(state: ProgrammerState): WordToken[] {
  if (state.current && state.items.length > 0) {
    return closeOpen([...state.items, state.current.operand], state.word)
  }

  let items = state.current ? [] : state.items

  while (items.at(-1)?.type === 'open') {
    items = items.slice(0, -1)
  }

  if (items.length === 0) {
    const operand = state.current?.operand ?? ZERO

    return state.repeat ? [operand, { type: 'operator', op: state.repeat.op }, state.repeat.operand] : [operand]
  }

  return closeOpen([...items, reducibleOperand(items, state.word) ?? ZERO], state.word)
}

function equals(state: ProgrammerState): ProgrammerState {
  const tokens = equalsTokens(state)

  // A lone number has nothing to work out; the next digit starts a new one.
  if (tokens.length === 1) {
    return { ...state, items: [], current: { operand: tokens[0] as WordOperand, typing: false } }
  }

  const result = evaluateTokens(tokens, state.word)
  const operator = tokens.at(-2)
  const operand = tokens.at(-1)
  const repeat = operator?.type === 'operator' && operand && operand.type !== 'operator' ? { op: operator.op, operand } : state.repeat
  const id = (state.last?.id ?? 0) + 1

  return { ...state, items: [], current: { operand: plain(result), typing: false }, fresh: true, last: { id, items: tokens, value: result }, repeat }
}

export function programmerClearLabel(state: ProgrammerState): 'C' | 'AC' {
  return state.current && !state.fresh && !state.error && state.current.operand.value !== 0n ? 'C' : 'AC'
}

function clear(state: ProgrammerState): ProgrammerState {
  if (programmerClearLabel(state) === 'C') {
    return { ...state, current: { operand: ZERO, typing: true } }
  }

  return { ...INITIAL_PROGRAMMER, word: state.word, base: state.base, last: state.last }
}

function backspace(state: ProgrammerState): ProgrammerState {
  const current = state.current

  if (state.fresh) {
    return state
  }

  if (current?.typing) {
    return { ...state, current: { operand: plain(current.operand.value / BigInt(RADIX[state.base])), typing: true } }
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

  return { ...state, items: items.slice(0, -1), current: { operand: before, typing: before.type === 'value' } }
}

function step(state: ProgrammerState, key: ProgrammerKey): ProgrammerState {
  if (digitValue(key, 'hex') !== null) {
    return typeDigit(state, key as HexDigit)
  }

  if (OPS.has(key)) {
    return pressOperator(state, key as ProgrammerOp)
  }

  if (UNARY.has(key)) {
    return applyUnary(state, key as ProgrammerUnary)
  }

  switch (key) {
    case 'open':
      return open(state)
    case 'close':
      return close(state)
    case 'equals':
      return equals(state)
    case 'clear':
      return clear(state)
    case 'backspace':
      return backspace(state)
    default:
      return state
  }
}

export function pressWord(state: ProgrammerState, key: ProgrammerKey): ProgrammerState {
  // After an error every key starts over; clearing and deleting only clear it.
  const ready = state.error ? { ...state, items: [], current: null, fresh: false, error: null } : state

  if (state.error && (key === 'clear' || key === 'backspace')) {
    return ready
  }

  try {
    return step(ready, key)
  } catch (error) {
    return { ...ready, items: [], current: null, fresh: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function resizeOperand(operand: WordOperand, from: WordSize, to: WordSize, signed: boolean): WordOperand {
  const resized = resizeWord(operand.value, from, to, signed)

  return operand.type === 'group' ? { type: 'group', items: operand.items.map(token => (token.type === 'operator' ? token : resizeOperand(token, from, to, signed))), value: resized } : plain(resized)
}

/** Another word size: every value cut to it, or widened keeping its number. */
export function setWordSize(state: ProgrammerState, bits: WordSize): ProgrammerState {
  const from = state.word.bits
  const { signed } = state.word

  if (from === bits) {
    return state
  }

  const fit = (operand: WordOperand) => resizeOperand(operand, from, bits, signed)

  return {
    ...state,
    word: { bits, signed },
    items: state.items.map(item => (isOperand(item) ? fit(item) : item)),
    current: state.current ? { ...state.current, operand: fit(state.current.operand) } : null,
    repeat: state.repeat ? { ...state.repeat, operand: fit(state.repeat.operand) } : null
  }
}

export function setSigned(state: ProgrammerState, signed: boolean): ProgrammerState {
  return state.word.signed === signed ? state : { ...state, word: { ...state.word, signed } }
}

export function setBase(state: ProgrammerState, base: Base): ProgrammerState {
  return state.base === base ? state : { ...state, base }
}

/** A bit of the value on screen flipped; it becomes the operand being typed. */
export function flipBit(state: ProgrammerState, index: number): ProgrammerState {
  const shown = shownWord(state)

  if (index >= state.word.bits || shown === null) {
    return state
  }

  return { ...editing(state), error: null, current: { operand: plain(toggleBit(shown, index, state.word.bits)), typing: true } }
}

export function wordText(value: bigint, state: Pick<ProgrammerState, 'base' | 'word'>, locale?: string): string {
  return groupDigits(formatWord(value, state.base, state.word), state.base, locale)
}

const PREFIX: Record<Base, string> = { hex: '0x', dec: '', oct: '0o', bin: '0b' }

/** A value as the history keeps it: 0xFF, 0b1010, −12. */
export function wordLiteral(value: bigint, state: Pick<ProgrammerState, 'base' | 'word'>): string {
  const text = formatWord(value, state.base, state.word)

  return text.startsWith('-') ? `\u2212${text.slice(1)}` : `${PREFIX[state.base]}${text}`
}

function tokensText(items: readonly WordItem[], print: (value: bigint) => string): string {
  let text = ''
  let previous: WordItem | null = null

  for (const item of items) {
    const piece = item.type === 'open' ? '(' : item.type === 'operator' ? PROGRAMMER_OPERATOR_TEXT[item.op] : item.type === 'group' ? `(${tokensText(item.items, print)})` : print(item.value)
    text += previous === null || previous.type === 'open' ? piece : ` ${piece}`
    previous = item
  }

  return text
}

/** The line above the display, in the active base. */
export function programmerPendingText(state: ProgrammerState): string {
  const print = (value: bigint) => formatWord(value, state.base, state.word).replace('-', '\u2212')

  if (state.fresh && state.last && state.current) {
    return `${tokensText(state.last.items, print)} =`
  }

  if (!state.current) {
    return tokensText(state.items, print)
  }

  return state.items.length === 0 && state.current.operand.type === 'value' ? '' : tokensText([...state.items, state.current.operand], print)
}

/** What '=' worked out, as the history keeps it. */
export function programmerHistoryInput(state: ProgrammerState, tokens: readonly WordToken[]): string {
  return tokensText(tokens, value => wordLiteral(value, state))
}

export function pendingWordOperator(state: ProgrammerState): ProgrammerOp | null {
  const pending = state.items.at(-1)

  return !state.current && pending?.type === 'operator' ? pending.op : null
}
