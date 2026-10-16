import { describe, expect, it } from 'vitest'
import type { LineResult } from '../engine/types.ts'
import { committedLine, historyEntry, idleCaret, isEcho, leaveCaret, moveCaret } from './commit.ts'

const value = (index: number, source: string, display: string, extra: Partial<LineResult> = {}): LineResult => ({ index, kind: 'value', source, display, ...extra })

describe('the caret and finished lines', () => {
  it('finishes a line typed on once the caret leaves it, with its text after the last keystroke', () => {
    let step = moveCaret(null, 2, '5 km in mi', true)
    step = moveCaret(step.state, 2, '5 km in miles', true)

    expect(step.commit).toBeNull()

    step = moveCaret(step.state, 3, '', true)

    expect(step.commit).toEqual({ index: 2, source: '5 km in miles' })
    expect(step.state).toEqual({ index: 3, text: '', dirty: true })
  })

  it('finishes nothing when the caret only passes through', () => {
    let step = moveCaret(null, 0, '20% of 84.50', false)
    step = moveCaret(step.state, 1, '84.50 + 15%', false)
    step = moveCaret(step.state, 2, '15% off 60', false)

    expect(step.commit).toBeNull()
  })

  it('keeps the text typed last when the caret moves within the line', () => {
    const typed = moveCaret(null, 0, '1 + 2', true)
    const moved = moveCaret(typed.state, 0, 'ignored', false)

    expect(moved.state).toEqual({ index: 0, text: '1 + 2', dirty: true })
  })

  it('finishes a line that sits still after typing, once', () => {
    const typed = moveCaret(null, 4, '2,400 + 180 split 3 ways', true)
    const idle = idleCaret(typed.state)

    expect(idle.commit).toEqual({ index: 4, source: '2,400 + 180 split 3 ways' })
    expect(idleCaret(idle.state).commit).toBeNull()
    expect(moveCaret(idle.state, 5, '', false).commit).toBeNull()
  })

  it('finishes the line the caret was on when it leaves the note', () => {
    expect(leaveCaret(moveCaret(null, 1, 'rent = 850', true).state)).toEqual({ state: null, commit: { index: 1, source: 'rent = 850' } })
    expect(leaveCaret(moveCaret(null, 1, 'rent = 850', false).state).commit).toBeNull()
    expect(leaveCaret(null).commit).toBeNull()
  })
})

describe('committedLine', () => {
  const lines = [value(0, 'a = 1', '1', { name: 'a' }), value(1, 'a + 1', '2'), value(2, 'sum', '3'), value(3, 'a + 1', '2')]

  it('finds the line at its place, or the nearest with its text when lines moved', () => {
    expect(committedLine({ index: 1, source: 'a + 1' }, lines)).toBe(lines[1])
    expect(committedLine({ index: 2, source: 'a + 1' }, lines)).toBe(lines[1])
    expect(committedLine({ index: 4, source: 'a + 1' }, lines)).toBe(lines[3])
    expect(committedLine({ index: 1, source: 'gone' }, lines)).toBeNull()
  })
})

describe('isEcho', () => {
  it('knows a line that only names a number', () => {
    expect(isEcho(value(0, 'budget = 1,200', '1,200', { name: 'budget', label: 'budget' }))).toBe(true)
    expect(isEcho(value(0, 'Rent: 850', '850', { label: 'Rent' }))).toBe(true)
    expect(isEcho(value(0, '1200', '1,200'))).toBe(true)
  })

  it('keeps lines that work something out', () => {
    expect(isEcho(value(0, 'left = budget - rent', '350', { name: 'left', label: 'left' }))).toBe(false)
    expect(isEcho(value(0, 'Hotel: 3 * 189', '567', { label: 'Hotel' }))).toBe(false)
    expect(isEcho(value(0, '10:30 Sydney in London', '00:30'))).toBe(false)
  })
})

describe('historyEntry', () => {
  const lines = [value(0, '  20% of 84.50 ', '16.90'), value(1, 'Lunch: 18 + 4', '22', { label: 'Lunch' }), { index: 2, kind: 'error', source: '5 km in', error: 'Convert to what?' } satisfies LineResult, value(3, 'budget = 1,200', '1,200', { name: 'budget', label: 'budget' })]

  it('records a finished value with the note and the label as context', () => {
    expect(historyEntry({ index: 0, source: '  20% of 84.50 ' }, lines, 'Groceries', null)).toEqual({ entry: { input: '20% of 84.50', result: '16.90', source: 'notes', context: 'Groceries' }, key: '20% of 84.50\n16.90' })
    expect(historyEntry({ index: 1, source: 'Lunch: 18 + 4' }, lines, 'Trip', null)?.entry.context).toBe('Trip · Lunch')
  })

  it('never records a half-typed line, an echo, or the entry recorded just before', () => {
    expect(historyEntry({ index: 2, source: '5 km in' }, lines, 'Trip', null)).toBeNull()
    expect(historyEntry({ index: 3, source: 'budget = 1,200' }, lines, 'Trip', null)).toBeNull()
    expect(historyEntry({ index: 0, source: '  20% of 84.50 ' }, lines, 'Groceries', '20% of 84.50\n16.90')).toBeNull()
  })

  it('records nothing when the line is no longer there', () => {
    expect(historyEntry({ index: 0, source: '20% of 84' }, lines, 'Groceries', null)).toBeNull()
  })
})
