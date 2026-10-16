import type { DecimalKey, Digit } from './machine.ts'
import type { HexDigit, ProgrammerKey } from './programmer-machine.ts'
import { type Base, digitValue } from './programmer.ts'

/* The keys of each keypad: labels, names for screen readers, tones, layouts and the keyboard map. */

export type KeyTone = 'digit' | 'operator' | 'equals' | 'function' | 'control' | 'memory'
export type KeySound = 'digit' | 'operator' | 'equals'

export interface KeyDef<K extends string> {
  key: K
  label: string
  aria: string
  tone: KeyTone
  /** Label and name while 2nd is on. */
  second?: { label: string; aria: string }
  /** Grid columns it spans. */
  span?: 2 | 3
}

const DIGITS: Digit[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

export function soundOf(tone: KeyTone): KeySound {
  return tone === 'equals' ? 'equals' : tone === 'operator' ? 'operator' : 'digit'
}

const decimalDefs: KeyDef<DecimalKey>[] = [
  ...DIGITS.map((digit): KeyDef<DecimalKey> => ({ key: digit, label: digit, aria: digit, tone: 'digit' })),
  { key: 'decimal', label: '.', aria: 'Decimal point', tone: 'digit' },
  { key: 'add', label: '+', aria: 'Plus', tone: 'operator' },
  { key: 'subtract', label: '−', aria: 'Minus', tone: 'operator' },
  { key: 'multiply', label: '×', aria: 'Times', tone: 'operator' },
  { key: 'divide', label: '÷', aria: 'Divided by', tone: 'operator' },
  { key: 'equals', label: '=', aria: 'Equals', tone: 'equals' },
  { key: 'clear', label: 'AC', aria: 'All clear', tone: 'control' },
  { key: 'sign', label: '±', aria: 'Change sign', tone: 'control' },
  { key: 'percent', label: '%', aria: 'Percent', tone: 'control' },
  { key: 'backspace', label: '⌫', aria: 'Delete the last digit', tone: 'digit' },
  { key: 'memory-clear', label: 'MC', aria: 'Memory clear', tone: 'memory' },
  { key: 'memory-recall', label: 'MR', aria: 'Memory recall', tone: 'memory' },
  { key: 'memory-add', label: 'M+', aria: 'Add to memory', tone: 'memory' },
  { key: 'memory-subtract', label: 'M−', aria: 'Subtract from memory', tone: 'memory' },
  { key: 'open', label: '(', aria: 'Open parenthesis', tone: 'function' },
  { key: 'close', label: ')', aria: 'Close parenthesis', tone: 'function' },
  { key: 'second', label: '2nd', aria: 'Second functions', tone: 'function' },
  { key: 'square', label: 'x²', aria: 'Square', tone: 'function' },
  { key: 'cube', label: 'x³', aria: 'Cube', tone: 'function' },
  { key: 'power', label: 'xʸ', aria: 'x to the power of y', tone: 'function' },
  { key: 'exp', label: 'eˣ', aria: 'e to the power of x', tone: 'function' },
  { key: 'pow10', label: '10ˣ', aria: '10 to the power of x', tone: 'function', second: { label: '2ˣ', aria: '2 to the power of x' } },
  { key: 'reciprocal', label: '1/x', aria: 'Reciprocal', tone: 'function' },
  { key: 'sqrt', label: '√x', aria: 'Square root', tone: 'function' },
  { key: 'cbrt', label: '∛x', aria: 'Cube root', tone: 'function' },
  { key: 'root', label: 'ʸ√x', aria: 'y-th root of x', tone: 'function' },
  { key: 'ln', label: 'ln', aria: 'Natural logarithm', tone: 'function' },
  { key: 'log10', label: 'log₁₀', aria: 'Base 10 logarithm', tone: 'function', second: { label: 'log₂', aria: 'Base 2 logarithm' } },
  { key: 'factorial', label: 'x!', aria: 'Factorial', tone: 'function' },
  { key: 'sin', label: 'sin', aria: 'Sine', tone: 'function', second: { label: 'sin⁻¹', aria: 'Inverse sine' } },
  { key: 'cos', label: 'cos', aria: 'Cosine', tone: 'function', second: { label: 'cos⁻¹', aria: 'Inverse cosine' } },
  { key: 'tan', label: 'tan', aria: 'Tangent', tone: 'function', second: { label: 'tan⁻¹', aria: 'Inverse tangent' } },
  { key: 'sinh', label: 'sinh', aria: 'Hyperbolic sine', tone: 'function', second: { label: 'sinh⁻¹', aria: 'Inverse hyperbolic sine' } },
  { key: 'cosh', label: 'cosh', aria: 'Hyperbolic cosine', tone: 'function', second: { label: 'cosh⁻¹', aria: 'Inverse hyperbolic cosine' } },
  { key: 'tanh', label: 'tanh', aria: 'Hyperbolic tangent', tone: 'function', second: { label: 'tanh⁻¹', aria: 'Inverse hyperbolic tangent' } },
  { key: 'pi', label: 'π', aria: 'Pi', tone: 'function' },
  { key: 'e', label: 'e', aria: "Euler's number", tone: 'function' },
  { key: 'rand', label: 'Rand', aria: 'Random number', tone: 'function' },
  { key: 'exponent', label: 'EE', aria: 'Times ten to the power of', tone: 'function' }
]

export const DECIMAL_KEYS = new Map(decimalDefs.map(def => [def.key, def]))

/** The constants menu's key in the scientific grid. */
export const CONSTANTS_SLOT = 'constants'

export const CLASSIC_MEMORY: DecimalKey[] = ['memory-clear', 'memory-recall', 'memory-add', 'memory-subtract']

export const CLASSIC_GRID: DecimalKey[][] = [
  ['clear', 'sign', 'percent', 'divide'],
  ['7', '8', '9', 'multiply'],
  ['4', '5', '6', 'subtract'],
  ['1', '2', '3', 'add'],
  ['backspace', '0', 'decimal', 'equals']
]

export const SCIENTIFIC_GRID: (DecimalKey | typeof CONSTANTS_SLOT)[][] = [
  ['open', 'close', 'memory-clear', 'memory-add', 'memory-subtract', 'memory-recall'],
  ['second', 'square', 'cube', 'power', 'exp', 'pow10'],
  ['reciprocal', 'sqrt', 'cbrt', 'root', 'ln', 'log10'],
  ['factorial', 'sin', 'cos', 'tan', 'e', 'exponent'],
  [CONSTANTS_SLOT, 'sinh', 'cosh', 'tanh', 'pi', 'rand']
]

const HEX: HexDigit[] = [...DIGITS, 'A', 'B', 'C', 'D', 'E', 'F']

const programmerDefs: KeyDef<ProgrammerKey>[] = [
  ...HEX.map((digit): KeyDef<ProgrammerKey> => ({ key: digit, label: digit, aria: digit, tone: 'digit', ...(digit === '0' ? { span: 3 as const } : {}) })),
  { key: 'and', label: 'AND', aria: 'Bitwise AND', tone: 'function' },
  { key: 'or', label: 'OR', aria: 'Bitwise OR', tone: 'function' },
  { key: 'xor', label: 'XOR', aria: 'Bitwise XOR', tone: 'function' },
  { key: 'not', label: 'NOT', aria: 'Bitwise NOT', tone: 'function' },
  { key: 'nand', label: 'NAND', aria: 'Bitwise NAND', tone: 'function' },
  { key: 'nor', label: 'NOR', aria: 'Bitwise NOR', tone: 'function' },
  { key: 'shl', label: '<<', aria: 'Shift left', tone: 'function' },
  { key: 'sar', label: '>>', aria: 'Arithmetic shift right', tone: 'function' },
  { key: 'shr', label: '>>>', aria: 'Logical shift right', tone: 'function' },
  { key: 'rol', label: 'RoL', aria: 'Rotate left by one bit', tone: 'function' },
  { key: 'ror', label: 'RoR', aria: 'Rotate right by one bit', tone: 'function' },
  { key: 'mod', label: 'mod', aria: 'Modulo', tone: 'operator' },
  { key: 'open', label: '(', aria: 'Open parenthesis', tone: 'function' },
  { key: 'close', label: ')', aria: 'Close parenthesis', tone: 'function' },
  { key: 'negate', label: '±', aria: "Negate (two's complement)", tone: 'control' },
  { key: 'add', label: '+', aria: 'Plus', tone: 'operator' },
  { key: 'subtract', label: '−', aria: 'Minus', tone: 'operator' },
  { key: 'multiply', label: '×', aria: 'Times', tone: 'operator' },
  { key: 'divide', label: '÷', aria: 'Divided by', tone: 'operator' },
  { key: 'equals', label: '=', aria: 'Equals', tone: 'equals' },
  { key: 'clear', label: 'AC', aria: 'All clear', tone: 'control', span: 2 },
  { key: 'backspace', label: '⌫', aria: 'Delete the last digit', tone: 'digit', span: 2 }
]

export const PROGRAMMER_KEYS = new Map(programmerDefs.map(def => [def.key, def]))

export const PROGRAMMER_GRID: ProgrammerKey[][] = [
  ['and', 'or', 'xor', 'not', 'nand', 'nor'],
  ['shl', 'sar', 'shr', 'rol', 'ror', 'mod'],
  ['clear', 'open', 'close', 'negate', 'divide'],
  ['A', 'B', '7', '8', '9', 'multiply'],
  ['C', 'D', '4', '5', '6', 'subtract'],
  ['E', 'F', '1', '2', '3', 'add'],
  ['backspace', '0', 'equals']
]

const DECIMAL_SHORTCUTS = new Map<string, DecimalKey>([
  ['+', 'add'],
  ['-', 'subtract'],
  ['−', 'subtract'],
  ['*', 'multiply'],
  ['x', 'multiply'],
  ['X', 'multiply'],
  ['×', 'multiply'],
  ['/', 'divide'],
  ['÷', 'divide'],
  ['^', 'power'],
  ['%', 'percent'],
  ['(', 'open'],
  [')', 'close'],
  ['!', 'factorial'],
  ['Enter', 'equals'],
  ['=', 'equals'],
  ['Backspace', 'backspace'],
  ['Escape', 'clear'],
  ['Delete', 'clear'],
  ['Clear', 'clear']
])

/** The decimal keypad's key for a KeyboardEvent.key; `decimalMark` is the locale's, which counts as the point too. */
export function decimalKeyFor(key: string, decimalMark: string): DecimalKey | null {
  if (/^[0-9]$/.test(key)) {
    return key as Digit
  }

  if (key === '.' || key === decimalMark) {
    return 'decimal'
  }

  return DECIMAL_SHORTCUTS.get(key) ?? null
}

const PROGRAMMER_SHORTCUTS = new Map<string, ProgrammerKey>([
  ['+', 'add'],
  ['-', 'subtract'],
  ['−', 'subtract'],
  ['*', 'multiply'],
  ['x', 'multiply'],
  ['X', 'multiply'],
  ['×', 'multiply'],
  ['/', 'divide'],
  ['÷', 'divide'],
  ['%', 'mod'],
  ['&', 'and'],
  ['|', 'or'],
  ['^', 'xor'],
  ['~', 'not'],
  ['<', 'shl'],
  ['>', 'sar'],
  ['(', 'open'],
  [')', 'close'],
  ['Enter', 'equals'],
  ['=', 'equals'],
  ['Backspace', 'backspace'],
  ['Escape', 'clear'],
  ['Delete', 'clear'],
  ['Clear', 'clear']
])

/** The programmer keypad's key for a KeyboardEvent.key: digits only when the base has them, A–F in hex. */
export function programmerKeyFor(key: string, base: Base): ProgrammerKey | null {
  if (/^[0-9a-f]$/i.test(key)) {
    return digitValue(key, base) === null ? null : (key.toUpperCase() as HexDigit)
  }

  return PROGRAMMER_SHORTCUTS.get(key) ?? null
}
