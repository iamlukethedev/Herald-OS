import { describe, expect, it } from 'vitest'
import { CLASSIC_GRID, CLASSIC_MEMORY, CONSTANTS_SLOT, DECIMAL_KEYS, decimalKeyFor, PROGRAMMER_GRID, PROGRAMMER_KEYS, programmerKeyFor, SCIENTIFIC_GRID } from './keys.ts'

describe('keyboard', () => {
  it('maps keys to the decimal keypad', () => {
    expect(decimalKeyFor('7', '.')).toBe('7')
    expect(decimalKeyFor('.', ',')).toBe('decimal')
    expect(decimalKeyFor(',', ',')).toBe('decimal')
    expect(decimalKeyFor(',', '.')).toBeNull()
    expect(decimalKeyFor('Enter', '.')).toBe('equals')
    expect(decimalKeyFor('=', '.')).toBe('equals')
    expect(decimalKeyFor('x', '.')).toBe('multiply')
    expect(decimalKeyFor('*', '.')).toBe('multiply')
    expect(decimalKeyFor('/', '.')).toBe('divide')
    expect(decimalKeyFor('÷', '.')).toBe('divide')
    expect(decimalKeyFor('^', '.')).toBe('power')
    expect(decimalKeyFor('%', '.')).toBe('percent')
    expect(decimalKeyFor('!', '.')).toBe('factorial')
    expect(decimalKeyFor('(', '.')).toBe('open')
    expect(decimalKeyFor(')', '.')).toBe('close')
    expect(decimalKeyFor('Backspace', '.')).toBe('backspace')
    expect(decimalKeyFor('Escape', '.')).toBe('clear')
    expect(decimalKeyFor('Delete', '.')).toBe('clear')
    expect(decimalKeyFor('a', '.')).toBeNull()
    expect(decimalKeyFor('constructor', '.')).toBeNull()
  })

  it('maps keys to the programmer keypad, digits only in their base', () => {
    expect(programmerKeyFor('a', 'hex')).toBe('A')
    expect(programmerKeyFor('F', 'hex')).toBe('F')
    expect(programmerKeyFor('a', 'dec')).toBeNull()
    expect(programmerKeyFor('9', 'oct')).toBeNull()
    expect(programmerKeyFor('1', 'bin')).toBe('1')
    expect(programmerKeyFor('&', 'dec')).toBe('and')
    expect(programmerKeyFor('|', 'dec')).toBe('or')
    expect(programmerKeyFor('^', 'dec')).toBe('xor')
    expect(programmerKeyFor('~', 'dec')).toBe('not')
    expect(programmerKeyFor('<', 'dec')).toBe('shl')
    expect(programmerKeyFor('>', 'dec')).toBe('sar')
    expect(programmerKeyFor('%', 'dec')).toBe('mod')
    expect(programmerKeyFor('x', 'hex')).toBe('multiply')
    expect(programmerKeyFor('Enter', 'hex')).toBe('equals')
  })
})

describe('layouts', () => {
  it('names every key it places', () => {
    for (const key of [...CLASSIC_MEMORY, ...CLASSIC_GRID.flat(), ...SCIENTIFIC_GRID.flat()]) {
      expect(key === CONSTANTS_SLOT || DECIMAL_KEYS.has(key)).toBe(true)
    }

    for (const key of PROGRAMMER_GRID.flat()) {
      expect(PROGRAMMER_KEYS.get(key)?.aria).toBeTruthy()
    }
  })

  it('fills each grid row', () => {
    expect(CLASSIC_GRID.every(row => row.length === 4)).toBe(true)
    expect(SCIENTIFIC_GRID.every(row => row.length === 6)).toBe(true)
    expect(PROGRAMMER_GRID.every(row => row.reduce((width, key) => width + (PROGRAMMER_KEYS.get(key)?.span ?? 1), 0) === 6)).toBe(true)
  })
})
