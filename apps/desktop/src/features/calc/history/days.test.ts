import { describe, expect, it } from 'vitest'
import type { CalcHistoryEntry } from '../../../../shared/calc.ts'
import { dayKey, dayLabel, groupByDay, startOfDay, timeLabel } from './days.ts'

const on = (day: number, hour = 12, month = 9, year = 2026) => new Date(year, month, day, hour).getTime()
const NOW = on(14, 15)

const entry = (id: string, at: number): CalcHistoryEntry => ({ id, at, input: id, result: '1', source: 'notes' })

describe('the days of the history', () => {
  it('are local days', () => {
    expect(dayKey(on(4, 0))).toBe('2026-10-04')
    expect(dayKey(on(4, 23))).toBe('2026-10-04')
    expect(startOfDay(on(4, 23))).toBe(on(4, 0))
    expect(startOfDay(on(31, 9), 1)).toBe(on(1, 0, 10))
  })

  it('say Today and Yesterday, then the date in the locale, with the year only when it is another', () => {
    expect(dayLabel(on(14, 1), NOW, 'en-GB')).toBe('Today')
    expect(dayLabel(on(13, 23), NOW, 'en-GB')).toBe('Yesterday')
    expect(dayLabel(on(2, 9), NOW, 'en-GB')).toBe(new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(on(2, 9)))
    expect(dayLabel(on(5, 9, 11, 2025), NOW, 'en-GB')).toContain('2025')
    expect(dayLabel(on(2, 9), NOW, 'en-GB')).not.toContain('2026')
    expect(dayLabel(on(2, 9), NOW, 'de-DE')).toBe(new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short' }).format(on(2, 9)))
  })

  it('fall back to the system’s locale for one the platform does not know', () => {
    expect(() => dayLabel(on(2, 9), NOW, 'not a locale!')).not.toThrow()
    expect(() => timeLabel(on(2, 9), 'not a locale!')).not.toThrow()
  })

  it('give times in the locale', () => {
    expect(timeLabel(on(2, 15), 'en-GB')).toBe('15:00')
    expect(timeLabel(on(2, 15), 'en-US')).toMatch(/^3:00\sPM$/)
  })

  it('group entries under the day each was made, each day where its first entry is', () => {
    const groups = groupByDay([entry('a', on(14, 9)), entry('b', on(7, 9)), entry('c', on(14, 8)), entry('d', on(13, 9))], NOW, 'en-GB')

    expect(groups.map(group => [group.label, group.entries.map(found => found.id)])).toEqual([
      ['Today', ['a', 'c']],
      [dayLabel(on(7, 9), NOW, 'en-GB'), ['b']],
      ['Yesterday', ['d']]
    ])
    expect(groups.map(group => group.key)).toEqual(['2026-10-14', '2026-10-07', '2026-10-13'])
  })
})
