import { describe, expect, it } from 'vitest'
import { addMonths, dateIn, dayNumber, fromDayNumber, isValidDate, isoDate, isoInstant, isoWeekday, offsetAt, parseIsoDate, startOfDay, zonedEpoch } from './dates-calendar.ts'

describe('calendar dates', () => {
  it('counts days from 1970-01-01 both ways', () => {
    expect(dayNumber({ year: 1970, month: 1, day: 1 })).toBe(0)
    expect(dayNumber({ year: 2000, month: 3, day: 1 })).toBe(11_017)
    for (let day = -700_000; day <= 2_900_000; day += 9_973) {
      const date = fromDayNumber(day)
      const utc = new Date(day * 86_400_000)

      expect(dayNumber(date)).toBe(day)
      if (date.year >= 100) expect([date.year, date.month, date.day]).toEqual([utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate()])
    }
  })

  it('knows weekdays and real dates', () => {
    expect(isoWeekday({ year: 2026, month: 10, day: 16 })).toBe(5)
    expect(isoWeekday({ year: 2026, month: 10, day: 18 })).toBe(7)
    expect(isValidDate({ year: 2028, month: 2, day: 29 })).toBe(true)
    expect(isValidDate({ year: 2026, month: 2, day: 29 })).toBe(false)
    expect(isValidDate({ year: 1900, month: 2, day: 29 })).toBe(false)
    expect(isValidDate({ year: 2026, month: 4, day: 31 })).toBe(false)
    expect(isValidDate({ year: 10_000, month: 1, day: 1 })).toBe(false)
  })

  it('adds calendar months, keeping to the last day of a shorter month', () => {
    expect(addMonths({ year: 2026, month: 1, day: 31 }, 1)).toEqual({ date: { year: 2026, month: 2, day: 28 }, clamped: true })
    expect(addMonths({ year: 2028, month: 1, day: 31 }, 1).date).toEqual({ year: 2028, month: 2, day: 29 })
    expect(addMonths({ year: 2026, month: 3, day: 31 }, -1).date).toEqual({ year: 2026, month: 2, day: 28 })
    expect(addMonths({ year: 2026, month: 12, day: 15 }, 1)).toEqual({ date: { year: 2027, month: 1, day: 15 }, clamped: false })
    expect(addMonths({ year: 2026, month: 1, day: 15 }, -13).date).toEqual({ year: 2024, month: 12, day: 15 })
  })

  it('writes and reads YYYY-MM-DD', () => {
    expect(isoDate({ year: 33, month: 7, day: 4 })).toBe('0033-07-04')
    expect(parseIsoDate('2026-12-25')).toEqual({ year: 2026, month: 12, day: 25 })
    expect(parseIsoDate('2026-02-30')).toBeNull()
    expect(parseIsoDate('Dec 25')).toBeNull()
  })
})

describe('wall-clock times in a zone', () => {
  it('maps a wall time to its instant', () => {
    expect(zonedEpoch({ year: 2026, month: 10, day: 16, hour: 13, minute: 16, second: 0 }, 'Australia/Sydney')).toEqual({ epoch: Date.UTC(2026, 9, 16, 2, 16), fold: 'exact' })
    expect(dateIn(Date.UTC(2026, 9, 16, 2, 16), 'America/New_York')).toEqual({ year: 2026, month: 10, day: 15 })
    expect(startOfDay({ year: 2026, month: 11, day: 6 }, 'Australia/Sydney')).toBe(Date.UTC(2026, 10, 5, 13))
  })

  it('moves a time the clocks skip on by the jump', () => {
    expect(zonedEpoch({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, 'America/New_York')).toEqual({ epoch: Date.UTC(2026, 2, 8, 7, 30), fold: 'gap' })
    expect(zonedEpoch({ year: 2026, month: 10, day: 4, hour: 2, minute: 30, second: 0 }, 'Australia/Sydney')).toEqual({ epoch: Date.UTC(2026, 9, 3, 16, 30), fold: 'gap' })
  })

  it('takes the first of a time the clocks repeat', () => {
    expect(zonedEpoch({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, 'America/New_York')).toEqual({ epoch: Date.UTC(2026, 10, 1, 5, 30), fold: 'overlap' })
  })

  it('knows each zone’s offset on the day, daylight saving included', () => {
    const lateOctober = Date.UTC(2026, 9, 28, 12)

    expect(offsetAt(lateOctober, 'Europe/London')).toBe(0)
    expect(offsetAt(lateOctober, 'America/New_York')).toBe(-4 * 3_600_000)
    expect(offsetAt(Date.UTC(2026, 9, 16), 'Asia/Kolkata')).toBe(5.5 * 3_600_000)
  })

  it('writes instants as ISO 8601 with the offset', () => {
    expect(isoInstant(Date.UTC(2026, 9, 15, 22), 'America/New_York')).toBe('2026-10-15T18:00:00-04:00')
    expect(isoInstant(Date.UTC(2026, 9, 15, 22), 'UTC')).toBe('2026-10-15T22:00:00+00:00')
    expect(isoInstant(Date.UTC(2026, 9, 15, 22), 'Asia/Kolkata')).toBe('2026-10-16T03:30:00+05:30')
  })
})
