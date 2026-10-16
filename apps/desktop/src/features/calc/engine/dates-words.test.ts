import { describe, expect, it } from 'vitest'
import { cleanLine, readClock, readCountUnit, readDuration, readNumber } from './dates-words.ts'

describe('numbers in figures', () => {
  it('reads the locale’s decimal mark and grouping', () => {
    expect(readNumber('1.5', '.')).toBe(1.5)
    expect(readNumber('1,000', '.')).toBe(1000)
    expect(readNumber('1,5', ',')).toBe(1.5)
    expect(readNumber('1.000', ',')).toBe(1000)
    expect(readNumber('1,234.5', '.')).toBe(1234.5)
    expect(readNumber('1.234,5', ',')).toBe(1234.5)
    expect(readNumber('12a', '.')).toBeNull()
  })
})

describe('durations in words', () => {
  it.each([
    ['3 weeks', [{ amount: 3, unit: 'week' }]],
    ['1 year 2 months', [{ amount: 1, unit: 'year' }, { amount: 2, unit: 'month' }]],
    ['1 year, 2 months and 3 days', [{ amount: 1, unit: 'year' }, { amount: 2, unit: 'month' }, { amount: 3, unit: 'day' }]],
    ['90 minutes', [{ amount: 90, unit: 'minute' }]],
    ['1.5 hours', [{ amount: 1.5, unit: 'hour' }]],
    ['2h 30min', [{ amount: 2, unit: 'hour' }, { amount: 30, unit: 'minute' }]],
    ['a week', [{ amount: 1, unit: 'week' }]],
    ['a fortnight', [{ amount: 2, unit: 'week' }]],
    ['three weeks', [{ amount: 3, unit: 'week' }]],
    ['twenty-one days', [{ amount: 21, unit: 'day' }]],
    ['an hour and a half', [{ amount: 1.5, unit: 'hour' }]],
    ['half an hour', [{ amount: 0.5, unit: 'hour' }]],
    ['two and a half weeks', [{ amount: 2.5, unit: 'week' }]],
    ['a couple of days', [{ amount: 2, unit: 'day' }]],
    ['10 business days', [{ amount: 10, unit: 'day', business: true }]]
  ])('reads %s', (text, parts) => {
    expect(readDuration(text, '.')).toEqual(parts)
  })

  it('reads nothing else as one', () => {
    for (const text of ['weeks', 'a days', '3', '3 apples', 'today', 'dec 25', '2 hours 30']) expect(readDuration(text, '.')).toBeNull()
  })

  it('knows the units a count is asked in', () => {
    expect(readCountUnit('days')).toBe('day')
    expect(readCountUnit('hrs')).toBe('hour')
    expect(readCountUnit('business days')).toBe('business')
    expect(readCountUnit('nights')).toBe('day')
    expect(readCountUnit('fortnights')).toBeNull()
    expect(readCountUnit('miles')).toBeNull()
  })
})

describe('times of day', () => {
  it.each([
    ['9am', { hour: 9, minute: 0, second: 0 }],
    ['9:30 pm', { hour: 21, minute: 30, second: 0 }],
    ['12am', { hour: 0, minute: 0, second: 0 }],
    ['12pm', { hour: 12, minute: 0, second: 0 }],
    ['21:15', { hour: 21, minute: 15, second: 0 }],
    ['noon', { hour: 12, minute: 0, second: 0 }],
    ['midnight', { hour: 0, minute: 0, second: 0 }],
    ["9 o'clock", { hour: 9, minute: 0, second: 0 }]
  ])('reads %s', (text, clock) => {
    expect(readClock(text)).toEqual(clock)
  })

  it('reads no impossible time', () => {
    for (const text of ['13pm', '0am', '24:00', '9:75', '9']) expect(readClock(text)).toBeNull()
  })

  it('cleans a line for reading', () => {
    expect(cleanLine('  What day is Dec 25?  ')).toBe('what day is dec 25')
    expect(cleanLine('9 a.m. Sydney')).toBe('9 am sydney')
    expect(cleanLine('9.30pm')).toBe('9:30pm')
    expect(cleanLine('9am-5pm')).toBe('9am – 5pm')
    expect(cleanLine('2026-12-25T09:00Z')).toBe('2026-12-25 09:00 utc')
    expect(cleanLine('9:00\u202fAM')).toBe('9:00 am')
  })
})
