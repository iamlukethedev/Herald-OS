import { describe, expect, it } from 'vitest'
import {
  flipBit,
  INITIAL_PROGRAMMER,
  type ProgrammerKey,
  type ProgrammerState,
  pressWord,
  previewWord,
  programmerClearLabel,
  programmerHistoryInput,
  programmerPendingText,
  setBase,
  setSigned,
  setWordSize,
  shownWord,
  wordLiteral,
  wordText
} from './programmer-machine.ts'
import type { Base, WordSize } from './programmer.ts'

function start(base: Base = 'dec', bits: WordSize = 64, signed = true): ProgrammerState {
  return setBase(setSigned(setWordSize(INITIAL_PROGRAMMER, bits), signed), base)
}

function run(keys: ProgrammerKey[], state: ProgrammerState = start()): ProgrammerState {
  return keys.reduce(pressWord, state)
}

describe('programmer keypad', () => {
  it('types digits in the active base while they fit the word', () => {
    expect(shownWord(run(['F', 'F'], start('hex')))).toBe(255n)
    expect(shownWord(run(['1', '2', '8'], start('dec', 8)))).toBe(12n)
    expect(shownWord(run(['1', '2', '7'], start('dec', 8)))).toBe(127n)
    expect(shownWord(run(['2', '5', '5'], start('dec', 8, false)))).toBe(255n)
    expect(shownWord(run(['1', '2'], start('bin')))).toBe(1n)
  })

  it('keeps precedence: × before +, AND before XOR before OR', () => {
    expect(shownWord(run(['2', 'add', '3', 'multiply', '4', 'equals']))).toBe(14n)
    expect(shownWord(run(['1', 'or', '2', 'and', '3', 'equals']))).toBe(3n)
    expect(shownWord(run(['1', 'add', '1', 'shl', '2', 'equals']))).toBe(8n)
    expect(shownWord(run(['open', '2', 'add', '3', 'close', 'multiply', '4', 'equals']))).toBe(20n)
  })

  it('wraps results to the word size', () => {
    expect(shownWord(run(['2', '0', '0', 'add', '1', '0', '0', 'equals'], start('dec', 8, false)))).toBe(44n)
    expect(wordText(shownWord(run(['0', 'subtract', '1', 'equals'], start('hex', 16))) ?? 0n, start('hex', 16))).toBe('FFFF')
  })

  it('repeats the last operation on another =', () => {
    expect(shownWord(run(['2', 'add', '3', 'equals', 'equals']))).toBe(8n)
  })

  it('shows what the pending operator works on, and a live preview', () => {
    const pending = run(['2', 'multiply', '3', 'add'])

    expect(shownWord(pending)).toBe(6n)
    expect(previewWord(run(['2', 'add', '3', 'multiply', '4']))).toBe(14n)
    expect(previewWord(run(['5']))).toBeNull()
  })

  it('applies NOT, ± and the rotates to the value on screen, within the word', () => {
    const not = run(['0', 'not'], start('hex', 8))

    expect(shownWord(not)).toBe(0xffn)
    expect(wordText(0xffn, start('dec', 8))).toBe('\u22121')
    expect(shownWord(run(['1', 'negate'], start('hex', 8)))).toBe(0xffn)
    expect(shownWord(run(['8', '1', 'rol'], start('hex', 8)))).toBe(0x03n)
  })

  it('reports division by zero, and the next key starts over', () => {
    const failed = run(['5', 'divide', '0', 'equals'])

    expect(failed.error).toBe("Can't divide by zero")
    expect(shownWord(pressWord(failed, '7'))).toBe(7n)
    expect(pressWord(failed, 'clear').error).toBeNull()
  })

  it('clears the entry with C and everything with AC', () => {
    const typed = run(['2', 'add', '3'])

    expect(programmerClearLabel(typed)).toBe('C')
    const cleared = pressWord(typed, 'clear')

    expect(shownWord(cleared)).toBe(0n)
    expect(programmerClearLabel(cleared)).toBe('AC')
    expect(pressWord(cleared, 'clear').items).toEqual([])
  })

  it('takes digits back, then operators', () => {
    expect(shownWord(run(['F', 'F', 'backspace'], start('hex')))).toBe(15n)
    const back = run(['2', 'add', 'backspace'])

    expect(back.items).toEqual([])
    expect(shownWord(back)).toBe(2n)
  })

  it('moves every value to a new word size, widening signed values with their sign', () => {
    const minusOne = run(['1', 'negate'], start('dec', 8))

    expect(shownWord(setWordSize(minusOne, 16))).toBe(0xffffn)
    expect(shownWord(setWordSize(setSigned(minusOne, false), 16))).toBe(0xffn)
    expect(shownWord(setWordSize(run(['4', '6', '6', '0'], start('hex', 16)), 8))).toBe(0x60n)
  })

  it('flips bits of the value on screen and keeps typing from there', () => {
    const flipped = flipBit(run(['5']), 1)

    expect(shownWord(flipped)).toBe(7n)
    expect(shownWord(flipBit(flipped, 70))).toBe(7n)
    expect(shownWord(pressWord(flipped, '1'))).toBe(71n)
  })

  it('writes the expression in the active base and the history with prefixes', () => {
    const hex = run(['F', 'F', 'and', 'F'], start('hex'))

    expect(programmerPendingText(hex)).toBe('FF AND F')
    const done = pressWord(hex, 'equals')

    expect(programmerPendingText(done)).toBe('FF AND F =')
    expect(done.last && programmerHistoryInput(done, done.last.items)).toBe('0xFF AND 0xF')
    expect(done.last && wordLiteral(done.last.value, done)).toBe('0xF')
    expect(wordLiteral(255n, start('dec', 8))).toBe('\u22121')
  })
})
