import { describe, expect, it } from 'vitest'
import { expressionOf } from './expression.ts'
import { clearLabel, type DecimalKey, INITIAL_KEYPAD, type KeypadState, type PressContext, pendingOperator, pendingText, press, previewExpression, resolve, shown } from './machine.ts'

const DEG: PressContext = { angle: 'deg' }
const RAD: PressContext = { angle: 'rad' }

function run(keys: DecimalKey[], context: PressContext = DEG, state: KeypadState = INITIAL_KEYPAD): KeypadState {
  return keys.reduce((next, key) => press(next, key, context), state)
}

/** What the last '=' asks the engine. */
function asked(state: KeypadState): string | null {
  return state.last ? expressionOf(state.last.items) : null
}

describe('typing', () => {
  it('builds the entry as typed', () => {
    expect(shown(run(['1', '2', 'decimal', '5']))).toEqual({ type: 'entry', text: '12.5' })
    expect(shown(run(['0', '0', '7']))).toEqual({ type: 'entry', text: '7' })
    expect(shown(run(['1', 'decimal', 'decimal', '5']))).toEqual({ type: 'entry', text: '1.5' })
    expect(shown(run(['decimal', '5']))).toEqual({ type: 'entry', text: '0.5' })
    expect(shown(INITIAL_KEYPAD)).toEqual({ type: 'value', value: '0' })
  })

  it('stops at sixteen digits', () => {
    const state = run(Array.from({ length: 20 }, () => '9' as const))

    expect(shown(state)).toEqual({ type: 'entry', text: '9'.repeat(16) })
  })

  it('types a power of ten after EE, and ± there flips the exponent', () => {
    expect(shown(run(['6', 'decimal', '0', '2', 'exponent', '2', '3']))).toEqual({ type: 'entry', text: '6.02e23' })
    expect(shown(run(['6', 'exponent', '2', '3', 'sign']))).toEqual({ type: 'entry', text: '6e-23' })
    expect(shown(run(['exponent', '3']))).toEqual({ type: 'entry', text: '1e3' })
  })
})

describe('precedence and =', () => {
  it('multiplies before it adds', () => {
    const state = run(['2', 'add', '3', 'multiply', '4', 'equals'])

    expect(asked(state)).toBe('2 + 3 * 4')
    expect(pendingText(state, 'en-US')).toBe('2 + 3 × 4 =')
  })

  it('shows what each operator leaves on screen', () => {
    expect(shown(run(['2', 'add', '3', 'multiply']))).toEqual({ type: 'value', value: '3' })
    expect(shown(run(['2', 'add', '3', 'multiply', '4', 'add']))).toEqual({ type: 'expression', expression: '2 + 3 * 4' })
    expect(shown(run(['2', 'power', '3', 'multiply']))).toEqual({ type: 'expression', expression: '2 ^ 3' })
  })

  it('previews the whole expression while typing', () => {
    expect(previewExpression(run(['2', 'add', '3', 'multiply', '4']))).toBe('2 + 3 * 4')
    expect(previewExpression(run(['5']))).toBeNull()
    expect(previewExpression(run(['2', 'add', '3', 'equals']))).toBeNull()
  })

  it('replaces an operator pressed twice and starts from 0', () => {
    expect(asked(run(['2', 'add', 'multiply', '3', 'equals']))).toBe('2 * 3')
    expect(asked(run(['add', '5', 'equals']))).toBe('0 + 5')
    expect(pendingOperator(run(['2', 'add']))).toBe('add')
    expect(pendingOperator(run(['2', 'add', '3']))).toBeNull()
  })

  it('repeats the last operation on another =', () => {
    const once = run(['2', 'add', '3', 'equals'])

    expect(asked(run(['equals'], DEG, once))).toBe('2 + 3 + 3')
    expect(asked(run(['equals'], DEG, resolve(once, 1, '5')))).toBe('5 + 3')
    expect(asked(run(['7', 'equals'], DEG, resolve(once, 1, '5')))).toBe('7 + 3')
    expect(asked(run(['equals'], DEG, resolve(run(['2', 'multiply', '3', 'add', '4', 'equals']), 1, '10')))).toBe('10 + 4')
  })

  it('works with what the display shows when = follows an operator', () => {
    expect(asked(run(['2', 'add', 'equals']))).toBe('2 + 2')
    expect(asked(run(['2', 'multiply', '3', 'add', 'equals']))).toBe('2 * 3 + 2 * 3')
  })

  it('starts over on a digit after =, and goes on with the result on an operator', () => {
    const after = run(['2', 'add', '3', 'equals', '4'])

    expect(after.items).toEqual([])
    expect(shown(after)).toEqual({ type: 'entry', text: '4' })
    expect(asked(run(['2', 'add', '3', 'equals', 'multiply', '2', 'equals']))).toBe('(2 + 3) * 2')
  })

  it('takes the exact value back from the engine', () => {
    const state = resolve(run(['2', 'add', '3', 'multiply', '4', 'equals']), 1, '14')

    expect(shown(state)).toEqual({ type: 'value', value: '14' })
    expect(pendingText(state, 'en-US')).toBe('2 + 3 × 4 =')
    expect(resolve(state, 9, '1')).toEqual(state)
  })
})

describe('percent, sign, clear and backspace', () => {
  it('works percent out the iOS way', () => {
    expect(asked(run(['5', '0', 'add', '1', '0', 'percent', 'equals']))).toBe('50 + 50 * 10 / 100')
    expect(asked(run(['5', '0', 'subtract', '1', '0', 'percent', 'equals']))).toBe('50 - 50 * 10 / 100')
    expect(asked(run(['5', '0', 'multiply', '1', '0', 'percent', 'equals']))).toBe('50 * (10 / 100)')
    expect(asked(run(['1', 'add', '2', 'multiply', '3', 'add', '1', '0', 'percent', 'equals']))).toBe('1 + 2 * 3 + (1 + 2 * 3) * 10 / 100')
    expect(shown(run(['1', '0', 'percent']))).toEqual({ type: 'expression', expression: '10 / 100' })
    expect(pendingText(run(['5', '0', 'add', '1', '0', 'percent']), 'en-US')).toBe('50 + 10%')
  })

  it('flips the sign of the entry or the operand on screen', () => {
    expect(shown(run(['5', 'sign']))).toEqual({ type: 'entry', text: '-5' })
    expect(shown(run(['5', 'sign', 'sign']))).toEqual({ type: 'entry', text: '5' })
    expect(shown(run(['sign', '3']))).toEqual({ type: 'entry', text: '-3' })
    expect(shown(run(['9', 'sqrt', 'sign']))).toEqual({ type: 'expression', expression: '-sqrt(9)' })
    expect(shown(run(['9', 'sqrt', 'sign', 'sign']))).toEqual({ type: 'expression', expression: 'sqrt(9)' })
    expect(shown(run(['sign'], DEG, resolve(run(['2', 'add', '3', 'equals']), 1, '5')))).toEqual({ type: 'value', value: '-5' })
    expect(asked(run(['2', 'multiply', '3', 'sign', 'equals']))).toBe('2 * (-3)')
  })

  it('clears the entry with C, then everything but the memory with AC', () => {
    const typed = run(['2', 'add', '3'])

    expect(clearLabel(typed)).toBe('C')
    const cleared = press(typed, 'clear', DEG)

    expect(clearLabel(cleared)).toBe('AC')
    expect(shown(cleared)).toEqual({ type: 'entry', text: '0' })
    expect(asked(run(['equals'], DEG, cleared))).toBe('2 + 0')

    const remembered = run(['7', 'memory-add', '2', 'add', '3', 'clear', 'clear'])

    expect(remembered.items).toEqual([])
    expect(remembered.current).toBeNull()
    expect(remembered.memory).toBe('7')
    expect(clearLabel(run(['2', 'add', '3', 'equals']))).toBe('AC')
  })

  it('takes back digits, then the operator before them', () => {
    expect(shown(run(['1', '2', '3', 'backspace']))).toEqual({ type: 'entry', text: '12' })
    expect(shown(run(['5', 'backspace']))).toEqual({ type: 'entry', text: '0' })

    const operator = run(['2', 'add', '3', 'backspace'])

    expect(operator.current).toBeNull()
    expect(pendingText(operator, 'en-US')).toBe('2 +')

    const back = press(operator, 'backspace', DEG)

    expect(back.items).toEqual([])
    expect(shown(back)).toEqual({ type: 'entry', text: '2' })
    expect(run(['2', 'add', '3', 'equals', 'backspace']).fresh).toBe(true)
  })
})

describe('memory', () => {
  it('adds and subtracts exactly, recalls and clears', () => {
    const tenths = run(['0', 'decimal', '1', 'memory-add', '0', 'decimal', '2', 'memory-add'])

    expect(tenths.memory).toBe('0.3')
    const less = run(['1', 'memory-subtract'], DEG, tenths)

    expect(less.memory).toBe('-0.7')
    expect(shown(run(['memory-recall'], DEG, less))).toEqual({ type: 'value', value: '-0.7' })
    expect(run(['memory-clear'], DEG, less).memory).toBeNull()
  })

  it('starts a new number after M+, and takes a worked-out value from the engine', () => {
    expect(shown(run(['5', 'memory-add', '3']))).toEqual({ type: 'entry', text: '3' })
    expect(run(['9', 'sqrt', 'memory-add']).memory).toBeNull()
    expect(run(['9', 'sqrt', 'memory-add'], { angle: 'deg', shown: '3' }).memory).toBe('3')
    expect(run(['memory-recall']).current).toBeNull()
  })
})

describe('scientific', () => {
  it('builds degrees and radians for trigonometry', () => {
    expect(shown(run(['3', '0', 'sin']))).toEqual({ type: 'expression', expression: 'sin((30) deg)' })
    expect(shown(run(['3', '0', 'sin'], RAD))).toEqual({ type: 'expression', expression: 'sin(30)' })
    expect(shown(run(['second', '0', 'decimal', '5', 'sin']))).toEqual({ type: 'expression', expression: 'asin(0.5) * 180 / pi' })
    expect(shown(run(['second', '0', 'decimal', '5', 'sin'], RAD))).toEqual({ type: 'expression', expression: 'asin(0.5)' })
    expect(asked(run(['2', 'multiply', '6', '0', 'cos', 'equals']))).toBe('2 * cos((60) deg)')
    expect(asked(run(['1', 'add', 'second', '1', 'tan', 'equals']))).toBe('1 + atan(1) * 180 / pi')
    expect(shown(run(['1', 'sinh']))).toEqual({ type: 'expression', expression: 'sinh(1)' })
    expect(shown(run(['second', '1', 'sinh']))).toEqual({ type: 'expression', expression: 'asinh(1)' })
    expect(pendingText(run(['2', 'multiply', '3', '0', 'sin']), 'en-US')).toBe('2 × sin(30°)')
  })

  it('applies functions to the operand on screen', () => {
    const fn = (keys: DecimalKey[]) => shown(run(keys))

    expect(fn(['3', 'square'])).toEqual({ type: 'expression', expression: '3 ^ 2' })
    expect(fn(['2', 'cube'])).toEqual({ type: 'expression', expression: '2 ^ 3' })
    expect(fn(['2', 'sign', 'square'])).toEqual({ type: 'expression', expression: '(-2) ^ 2' })
    expect(fn(['4', 'reciprocal'])).toEqual({ type: 'expression', expression: '1 / 4' })
    expect(fn(['5', 'factorial'])).toEqual({ type: 'expression', expression: '5!' })
    expect(fn(['2', 'exp'])).toEqual({ type: 'expression', expression: 'exp(2)' })
    expect(fn(['3', 'pow10'])).toEqual({ type: 'expression', expression: '10 ^ 3' })
    expect(fn(['3', 'second', 'pow10'])).toEqual({ type: 'expression', expression: '2 ^ 3' })
    expect(fn(['1', '0', '0', 'log10'])).toEqual({ type: 'expression', expression: 'log10(100)' })
    expect(fn(['8', 'second', 'log10'])).toEqual({ type: 'expression', expression: 'log2(8)' })
    expect(fn(['1', 'ln'])).toEqual({ type: 'expression', expression: 'ln(1)' })
    expect(fn(['2', '7', 'cbrt'])).toEqual({ type: 'expression', expression: 'cbrt(27)' })
    expect(fn(['9', 'sqrt', 'square'])).toEqual({ type: 'expression', expression: 'sqrt(9) ^ 2' })
    expect(asked(run(['2', 'multiply', '3', 'add', 'sqrt', 'equals']))).toBe('2 * 3 + sqrt(2 * 3)')
  })

  it('reads powers from the right and roots as nthRoot', () => {
    expect(asked(run(['2', 'power', '3', 'power', '2', 'equals']))).toBe('2 ^ 3 ^ 2')
    expect(asked(run(['8', 'root', '3', 'equals']))).toBe('nthRoot(8, 3)')
    expect(asked(run(['1', 'add', '2', '7', 'root', '3', 'equals']))).toBe('1 + nthRoot(27, 3)')
  })

  it('groups with parentheses, closing what is left open, and multiplies before an opening one', () => {
    expect(asked(run(['2', 'multiply', 'open', '3', 'add', '4', 'close', 'equals']))).toBe('2 * (3 + 4)')
    expect(asked(run(['2', 'open', '3', 'add', '4', 'equals']))).toBe('2 * (3 + 4)')
    expect(pendingText(run(['2', 'multiply', 'open', '3', 'add']), 'en-US')).toBe('2 × (3 +')
    expect(run(['close', '5']).items).toEqual([])
  })

  it('takes constants, Rand and memory into the display slot', () => {
    expect(asked(run(['2', 'multiply', 'pi', 'equals']))).toBe('2 * pi')
    expect(pendingText(run(['2', 'multiply', 'pi', 'equals']), 'en-US')).toBe('2 × π =')
    expect(shown(run(['c']))).toEqual({ type: 'value', value: '299792458' })
    expect(asked(run(['h', 'multiply', '2', 'equals']))).toBe('6.62607015e-34 * 2')
    expect(asked(run(['phi', 'multiply', '2', 'equals']))).toBe('((1 + sqrt(5)) / 2) * 2')
    expect(shown(press(INITIAL_KEYPAD, 'rand', { angle: 'deg', random: '0.25' }))).toEqual({ type: 'value', value: '0.25' })
  })
})

describe('the line above the result', () => {
  it('writes numbers the locale’s way', () => {
    expect(pendingText(run(['1', '2', '3', '4', 'decimal', '5', 'add', '6']), 'de-DE')).toBe('1.234,5 + 6')
    expect(pendingText(run(['1', '2', 'multiply', '7', 'add', '3', 'equals']), 'en-US')).toBe('12 × 7 + 3 =')
  })

  it('stays empty while only a number is typed', () => {
    expect(pendingText(run(['4', '2']), 'en-US')).toBe('')
    expect(pendingText(run(['9', 'sqrt']), 'en-US')).toBe('√9')
  })
})
