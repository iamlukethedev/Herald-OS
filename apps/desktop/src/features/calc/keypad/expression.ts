import { formatNumber, MINUS } from './format.ts'

/*
 * The decimal keypads' expression: operands as small trees with the operators between them, read
 * with the usual precedence and printed two ways, as math.js text for the engine ("sin((30) deg)")
 * and as what a person reads above the result ("12 × 7 + 3").
 */

export type Angle = 'deg' | 'rad'
export type BinaryOp = 'add' | 'subtract' | 'multiply' | 'divide' | 'power' | 'root'
export type UnaryFn =
  | 'square'
  | 'cube'
  | 'reciprocal'
  | 'sqrt'
  | 'cbrt'
  | 'exp'
  | 'pow10'
  | 'pow2'
  | 'ln'
  | 'log10'
  | 'log2'
  | 'factorial'
  | 'sin'
  | 'cos'
  | 'tan'
  | 'asin'
  | 'acos'
  | 'atan'
  | 'sinh'
  | 'cosh'
  | 'tanh'
  | 'asinh'
  | 'acosh'
  | 'atanh'
  | 'negate'
export type ConstantId = 'pi' | 'e' | 'c' | 'g' | 'h' | 'na' | 'k' | 'qe' | 'phi'

export type Operand =
  | { type: 'number'; value: string }
  | { type: 'constant'; id: ConstantId }
  | { type: 'apply'; fn: UnaryFn; arg: Operand; angle?: Angle }
  /** iOS percent: of the left side for + and −, a hundredth otherwise. */
  | { type: 'percent'; arg: Operand; of?: Operand }
  | { type: 'group'; items: Token[] }
  /** What '=' worked out: its expression until the engine answers, then its exact value. */
  | { type: 'result'; id: number; items: Token[]; value?: string }

export interface Operator {
  type: 'operator'
  op: BinaryOp
}

export interface Open {
  type: 'open'
}

export type Token = Operand | Operator
export type Item = Token | Open

export interface ConstantDef {
  symbol: string
  name: string
  /** How math.js reads it. */
  expression: string
  /** The value, exact or to 20 decimals. */
  value: string
  unit?: string
}

export const CONSTANTS: Record<ConstantId, ConstantDef> = {
  pi: { symbol: 'π', name: 'Pi', expression: 'pi', value: '3.14159265358979323846' },
  e: { symbol: 'e', name: "Euler's number", expression: 'e', value: '2.71828182845904523536' },
  c: { symbol: 'c', name: 'Speed of light', expression: '299792458', value: '299792458', unit: 'm/s' },
  g: { symbol: 'g', name: 'Standard gravity', expression: '9.80665', value: '9.80665', unit: 'm/s²' },
  h: { symbol: 'h', name: 'Planck constant', expression: '6.62607015e-34', value: '6.62607015e-34', unit: 'J·s' },
  na: { symbol: 'Nₐ', name: 'Avogadro constant', expression: '6.02214076e23', value: '6.02214076e23', unit: '1/mol' },
  k: { symbol: 'k', name: 'Boltzmann constant', expression: '1.380649e-23', value: '1.380649e-23', unit: 'J/K' },
  qe: { symbol: 'qₑ', name: 'Elementary charge', expression: '1.602176634e-19', value: '1.602176634e-19', unit: 'C' },
  phi: { symbol: 'φ', name: 'Golden ratio', expression: '((1 + sqrt(5)) / 2)', value: '1.61803398874989484820' }
}

/** Printed text and how tightly it holds together, to know when it needs parentheses. */
interface Printed {
  text: string
  level: number
}

const SUM = 1
const NEGATION = 1.5
const PRODUCT = 2
const POWER = 3
const POSTFIX = 4
const ATOM = 10

const LEVEL: Record<BinaryOp, number> = { add: SUM, subtract: SUM, multiply: PRODUCT, divide: PRODUCT, power: POWER, root: POWER }
const RIGHT_ASSOCIATIVE: ReadonlySet<BinaryOp> = new Set(['power', 'root'])
const ZERO: Printed = { text: '0', level: ATOM }

export const OPERATOR_TEXT: Record<BinaryOp, string> = { add: '+', subtract: MINUS, multiply: '×', divide: '÷', power: '^', root: 'ʸ√' }
const MATH_OPERATOR: Record<Exclude<BinaryOp, 'root'>, string> = { add: '+', subtract: '-', multiply: '*', divide: '/', power: '^' }
const MATH_CALL: Partial<Record<UnaryFn, string>> = {
  sqrt: 'sqrt',
  cbrt: 'cbrt',
  exp: 'exp',
  ln: 'ln',
  log10: 'log10',
  log2: 'log2',
  sinh: 'sinh',
  cosh: 'cosh',
  tanh: 'tanh',
  asinh: 'asinh',
  acosh: 'acosh',
  atanh: 'atanh'
}
const NAMED: Partial<Record<UnaryFn, string>> = {
  ln: 'ln',
  log10: 'log₁₀',
  log2: 'log₂',
  sin: 'sin',
  cos: 'cos',
  tan: 'tan',
  asin: 'sin⁻¹',
  acos: 'cos⁻¹',
  atan: 'tan⁻¹',
  sinh: 'sinh',
  cosh: 'cosh',
  tanh: 'tanh',
  asinh: 'sinh⁻¹',
  acosh: 'cosh⁻¹',
  atanh: 'tanh⁻¹'
}
const ANGLED: ReadonlySet<UnaryFn> = new Set(['sin', 'cos', 'tan', 'asin', 'acos', 'atan'])

/** Trigonometry reads the angle setting; the hyperbolic functions do not. */
export function takesAngle(fn: UnaryFn): boolean {
  return ANGLED.has(fn)
}

export function isOperand(item: Item): item is Operand {
  return item.type !== 'operator' && item.type !== 'open'
}

function wrap(printed: Printed, level: number): string {
  return printed.level >= level ? printed.text : `(${printed.text})`
}

function mathApply(fn: UnaryFn, arg: Printed, angle?: Angle): Printed {
  const call = MATH_CALL[fn]

  if (call) {
    return { text: `${call}(${arg.text})`, level: ATOM }
  }

  switch (fn) {
    case 'sin':
    case 'cos':
    case 'tan':
      return { text: angle === 'deg' ? `${fn}((${arg.text}) deg)` : `${fn}(${arg.text})`, level: ATOM }
    case 'asin':
    case 'acos':
    case 'atan':
      return angle === 'deg' ? { text: `${fn}(${arg.text}) * 180 / pi`, level: PRODUCT } : { text: `${fn}(${arg.text})`, level: ATOM }
    case 'square':
      return { text: `${wrap(arg, POSTFIX)} ^ 2`, level: POWER }
    case 'cube':
      return { text: `${wrap(arg, POSTFIX)} ^ 3`, level: POWER }
    case 'reciprocal':
      return { text: `1 / ${wrap(arg, POWER)}`, level: PRODUCT }
    case 'pow10':
      return { text: `10 ^ ${wrap(arg, POWER)}`, level: POWER }
    case 'pow2':
      return { text: `2 ^ ${wrap(arg, POWER)}`, level: POWER }
    case 'factorial':
      return { text: `${wrap(arg, ATOM)}!`, level: POSTFIX }
    default:
      return { text: `-${wrap(arg, POWER)}`, level: NEGATION }
  }
}

function mathOperand(operand: Operand): Printed {
  switch (operand.type) {
    case 'number':
      return { text: operand.value.startsWith('-') ? `(${operand.value})` : operand.value, level: ATOM }
    case 'constant':
      return { text: CONSTANTS[operand.id].expression, level: ATOM }
    case 'apply':
      return mathApply(operand.fn, mathOperand(operand.arg), operand.angle)
    case 'percent': {
      const arg = wrap(mathOperand(operand.arg), POWER)

      return { text: operand.of ? `${wrap(mathOperand(operand.of), PRODUCT)} * ${arg} / 100` : `${arg} / 100`, level: PRODUCT }
    }
    case 'group':
      return mathTokens(operand.items) ?? ZERO
    case 'result':
      return operand.value === undefined ? (mathTokens(operand.items) ?? ZERO) : mathOperand({ type: 'number', value: operand.value })
  }
}

type Tree = { type: 'leaf'; operand: Operand } | { type: 'node'; op: BinaryOp; left: Tree; right: Tree }

/** Operands and operators by precedence: × and ÷ before + and −, powers and roots first and from the right. */
function parseTokens(tokens: readonly Token[]): Tree | null {
  let position = 0

  const climb = (min: number): Tree | null => {
    const first = tokens[position]

    if (!first || first.type === 'operator') {
      return null
    }

    position++
    let left: Tree = { type: 'leaf', operand: first }

    while (position < tokens.length) {
      const token = tokens[position]

      if (token.type !== 'operator' || LEVEL[token.op] < min) {
        break
      }

      position++
      const right = climb(RIGHT_ASSOCIATIVE.has(token.op) ? LEVEL[token.op] : LEVEL[token.op] + 1)

      if (!right) {
        break
      }

      left = { type: 'node', op: token.op, left, right }
    }

    return left
  }

  return climb(SUM)
}

function mathTree(tree: Tree): Printed {
  if (tree.type === 'leaf') {
    return mathOperand(tree.operand)
  }

  const left = mathTree(tree.left)
  const right = mathTree(tree.right)

  if (tree.op === 'root') {
    return { text: `nthRoot(${left.text}, ${right.text})`, level: ATOM }
  }

  const level = LEVEL[tree.op]
  const fromRight = RIGHT_ASSOCIATIVE.has(tree.op)

  return { text: `${wrap(left, fromRight ? level + 1 : level)} ${MATH_OPERATOR[tree.op]} ${wrap(right, fromRight ? level : level + 1)}`, level }
}

function mathTokens(tokens: readonly Token[]): Printed | null {
  const tree = parseTokens(tokens)

  return tree ? mathTree(tree) : null
}

/** A sequence as math.js reads it: open parentheses close at the end and a trailing operator is left out. */
export function expressionOf(items: readonly Item[]): string | null {
  return mathTokens(closeOpen(trimTail(items)))?.text ?? null
}

export function operandExpression(operand: Operand): string {
  return mathOperand(operand).text
}

/** Without the operators and open parentheses at its end. */
export function trimTail(items: readonly Item[]): Item[] {
  let end = items.length

  while (end > 0 && !isOperand(items[end - 1])) {
    end--
  }

  return items.slice(0, end)
}

export function lastOpen(items: readonly Item[]): number {
  return items.findLastIndex(item => item.type === 'open')
}

/** Every parenthesis still open, closed at the end: what follows each becomes a group. */
export function closeOpen(items: readonly Item[]): Token[] {
  const result = [...items]

  for (let at = lastOpen(result); at >= 0; at = lastOpen(result)) {
    const inner = trimTail(result.slice(at + 1)) as Token[]
    const group: Operand[] = inner.length ? [{ type: 'group', items: inner }] : []
    result.splice(at, result.length - at, ...group)
  }

  return result as Token[]
}

/**
 * With `items` ending in an operator: the operand that operator cannot split, which is what the
 * display shows once it is pressed ("2 + 3 × 4 +" shows 14, "2 + 3 ×" shows 3); null without one.
 */
export function reducibleOperand(items: readonly Item[]): Operand | null {
  const pending = items.at(-1)

  if (!pending || pending.type !== 'operator') {
    return null
  }

  const segment = items.slice(lastOpen(items) + 1, -1) as Token[]
  const binds = (op: BinaryOp) => (RIGHT_ASSOCIATIVE.has(pending.op) ? LEVEL[op] > LEVEL[pending.op] : LEVEL[op] >= LEVEL[pending.op])
  let start = segment.length - 1

  while (start >= 2) {
    const operator = segment[start - 1]

    if (operator.type !== 'operator' || !binds(operator.op)) {
      break
    }

    start -= 2
  }

  const part = segment.slice(Math.max(0, start))

  if (part.length === 0) {
    return null
  }

  return part.length === 1 ? (part[0] as Operand) : { type: 'group', items: part }
}

function prettyApply(operand: Extract<Operand, { type: 'apply' }>, locale?: string): Printed {
  const arg = pretty(operand.arg, locale)
  const atom = wrap(arg, ATOM)

  switch (operand.fn) {
    case 'square':
      return { text: `${atom}²`, level: POSTFIX }
    case 'cube':
      return { text: `${atom}³`, level: POSTFIX }
    case 'factorial':
      return { text: `${atom}!`, level: POSTFIX }
    case 'sqrt':
      return { text: `√${atom}`, level: POSTFIX }
    case 'cbrt':
      return { text: `∛${atom}`, level: POSTFIX }
    case 'reciprocal':
      return { text: `1/${atom}`, level: PRODUCT }
    case 'exp':
      return { text: `e^${atom}`, level: POWER }
    case 'pow10':
      return { text: `10^${atom}`, level: POWER }
    case 'pow2':
      return { text: `2^${atom}`, level: POWER }
    case 'negate':
      return { text: `${MINUS}${atom}`, level: NEGATION }
    default: {
      const degrees = operand.angle === 'deg' && (operand.fn === 'sin' || operand.fn === 'cos' || operand.fn === 'tan')
      const inside = degrees ? `${operand.arg.type === 'number' || arg.level >= POSTFIX ? arg.text : `(${arg.text})`}°` : arg.text

      return { text: `${NAMED[operand.fn] ?? operand.fn}(${inside})`, level: ATOM }
    }
  }
}

function pretty(operand: Operand, locale?: string): Printed {
  switch (operand.type) {
    case 'number':
      return { text: formatNumber(operand.value, { locale }), level: operand.value.startsWith('-') ? NEGATION : ATOM }
    case 'constant':
      return { text: CONSTANTS[operand.id].symbol, level: ATOM }
    case 'apply':
      return prettyApply(operand, locale)
    case 'percent':
      return { text: `${wrap(pretty(operand.arg, locale), ATOM)}%`, level: POSTFIX }
    case 'group':
      return { text: `(${sequenceText(operand.items, locale)})`, level: ATOM }
    case 'result':
      return operand.value === undefined ? { text: `(${sequenceText(operand.items, locale)})`, level: ATOM } : pretty({ type: 'number', value: operand.value }, locale)
  }
}

export function operandText(operand: Operand, locale?: string): string {
  return pretty(operand, locale).text
}

/** A sequence as it reads above the result, dangling operators and open parentheses included: "12 × (7 + 3". */
export function sequenceText(items: readonly Item[], locale?: string): string {
  let text = ''
  let previous: Item | null = null

  for (const item of items) {
    let piece = item.type === 'open' ? '(' : item.type === 'operator' ? OPERATOR_TEXT[item.op] : ''

    if (isOperand(item)) {
      const printed = pretty(item, locale)
      const after = previous?.type === 'operator' ? previous.op : null
      piece = after && printed.level <= Math.max(NEGATION, LEVEL[after]) ? `(${printed.text})` : printed.text
    }

    text += previous === null || previous.type === 'open' ? piece : ` ${piece}`
    previous = item
  }

  return text
}
