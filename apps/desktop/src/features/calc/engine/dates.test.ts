import { describe, expect, it } from 'vitest'
import { evaluateDateLine, parseDate, type TimeAnswer, type TimeContext } from './dates.ts'
import { evaluateZoneLine } from './zones.ts'

/** Fri 16 Oct 2026, 1:16 PM in Sydney. */
const SYDNEY: TimeContext = { now: Date.UTC(2026, 9, 16, 2, 16), zone: 'Australia/Sydney', locale: 'en-US' }

function answer(text: string, context: TimeContext = SYDNEY): TimeAnswer {
  const outcome = evaluateDateLine(text, context)
  if (!outcome || 'error' in outcome) throw new Error(`"${text}" gave ${JSON.stringify(outcome)}`)

  return outcome
}

function exact(text: string, context: TimeContext = SYDNEY): string {
  return answer(text, context).value.exact
}

/** Newer ICU puts narrow no-break spaces in dates and times. */
function spaced(text: string): string {
  return text.replace(/\s+/g, ' ')
}

describe('written dates', () => {
  it.each([
    ['Dec 25', '2026-12-25'],
    ['December 25', '2026-12-25'],
    ['25 Dec', '2026-12-25'],
    ['25 December 2026', '2026-12-25'],
    ['Dec 25th', '2026-12-25'],
    ['the 25th of December', '2026-12-25'],
    ['December 25, 2026', '2026-12-25'],
    ['Fri, Dec 25', '2026-12-25'],
    ['2026-12-25', '2026-12-25'],
    ['2026/12/25', '2026-12-25'],
    ['12/25/2026', '2026-12-25'],
    ['25/12/2026', '2026-12-25'],
    ['03/04/2026', '2026-03-04'],
    ['Dec 25 2027', '2027-12-25']
  ])('%s is %s', (text, date) => {
    expect(exact(text)).toBe(date)
  })

  it('reads slashes in the locale’s order and dots day first', () => {
    expect(exact('03/04/2026', { ...SYDNEY, locale: 'en-GB' })).toBe('2026-04-03')
    expect(exact('25/12/2026', { ...SYDNEY, locale: 'en-GB' })).toBe('2026-12-25')
    expect(exact('25.12.2026', { ...SYDNEY, locale: 'de-DE' })).toBe('2026-12-25')
  })

  it('gives the date as a value at local midnight, shown with its weekday', () => {
    const result = answer('Dec 25')

    expect(result.value).toEqual({ kind: 'date', exact: '2026-12-25', number: Date.UTC(2026, 11, 24, 13) })
    expect(spaced(result.display)).toBe('Fri, Dec 25')
    expect(spaced(answer('Dec 25 2027').display)).toBe('Sat, Dec 25, 2027')
    expect(spaced(answer('Dec 25', { ...SYDNEY, locale: 'en-GB' }).display)).toBe('Fri 25 Dec')
    expect(spaced(answer('Dec 25', { ...SYDNEY, locale: 'de-DE' }).display)).toBe('Fr., 25. Dez.')
  })
})

describe('days in words', () => {
  it.each([
    ['today', '2026-10-16'],
    ['tomorrow', '2026-10-17'],
    ['yesterday', '2026-10-15'],
    ['the day after tomorrow', '2026-10-18'],
    ['Friday', '2026-10-23'],
    ['next Friday', '2026-10-23'],
    ['this Friday', '2026-10-16'],
    ['last Monday', '2026-10-12'],
    ['Monday', '2026-10-19'],
    ['Friday next week', '2026-10-23'],
    ['Friday last week', '2026-10-09'],
    ['next month', '2026-11-01'],
    ['next year', '2027-01-01'],
    ['end of the month', '2026-10-31'],
    ['start of next month', '2026-11-01'],
    ['end of next month', '2026-11-30'],
    ['end of the year', '2026-12-31'],
    ['end of February', '2026-02-28'],
    ['first Monday of November', '2026-11-02'],
    ['last Friday of the month', '2026-10-30'],
    ['the 1st', '2026-10-01'],
    ['Christmas', '2026-12-25'],
    ['last Christmas', '2025-12-25'],
    ['Easter', '2026-04-05'],
    ['Thanksgiving', '2026-11-26']
  ])('%s is %s', (text, date) => {
    expect(exact(text)).toBe(date)
  })

  it('starts weeks on the locale’s first day', () => {
    expect(exact('next week')).toBe('2026-10-18')
    expect(exact('next week', { ...SYDNEY, locale: 'en-GB' })).toBe('2026-10-19')
    expect(exact('Monday next week', { ...SYDNEY, locale: 'en-GB' })).toBe('2026-10-19')
  })

  it('counts from today in the person’s zone', () => {
    const newYork = { ...SYDNEY, zone: 'America/New_York' }

    expect(exact('today', newYork)).toBe('2026-10-15')
    expect(exact('days until Dec 25', newYork)).toBe('71')
  })
})

describe('moving a date by a duration', () => {
  it.each([
    ['3 weeks from today', '2026-11-06'],
    ['three weeks from today', '2026-11-06'],
    ['3 weeks from now', '2026-11-06'],
    ['in 3 weeks', '2026-11-06'],
    ['a fortnight from today', '2026-10-30'],
    ['a week from Friday', '2026-10-30'],
    ['1 year 2 months from today', '2027-12-16'],
    ['2 days after Christmas', '2026-12-27'],
    ['2 days before Christmas', '2026-12-23'],
    ['90 days ago', '2026-07-18'],
    ['today + 30 days', '2026-11-15'],
    ['tomorrow + 1 week', '2026-10-24'],
    ['Dec 25 - 2 weeks', '2026-12-11'],
    ['Dec 25 plus a fortnight', '2027-01-08'],
    ['today + 1 week - 2 days', '2026-10-21'],
    ['today + 10 business days', '2026-10-30']
  ])('%s is %s', (text, date) => {
    expect(answer(text).value).toMatchObject({ kind: 'date', exact: date })
  })

  it('adds months by the calendar', () => {
    expect(exact('Jan 31 + 1 month')).toBe('2026-02-28')
    expect(exact('2028-01-31 + 1 month')).toBe('2028-02-29')
    expect(exact('Mar 31 - 1 month')).toBe('2026-02-28')
    expect(answer('Jan 31 + 1 month').steps.map(spaced)).toEqual(['Sat, Jan 31, 2026 + 1 month', 'February 2026 has 28 days', '= Sat, Feb 28, 2026'])
  })

  it('shows the working', () => {
    const result = answer('3 weeks from today')

    expect(spaced(result.display)).toBe('Fri, Nov 6')
    expect(result.steps.map(spaced)).toEqual(['Fri, Oct 16, 2026 + 3 weeks', '= Fri, Nov 6, 2026'])
    expect(spaced(answer('3 weeks from today', { ...SYDNEY, locale: 'de-DE' }).display)).toBe('Fr., 6. Nov.')
  })

  it('gives a time when the duration has hours or minutes', () => {
    expect(answer('90 minutes from now').value).toEqual({ kind: 'time', exact: '2026-10-16T14:46:00+11:00', number: Date.UTC(2026, 9, 16, 3, 46), zone: 'Australia/Sydney' })
    expect(exact('in 2 hours')).toBe('2026-10-16T15:16:00+11:00')
    expect(exact('2 hours ago')).toBe('2026-10-16T11:16:00+11:00')
    expect(exact('an hour and a half from now')).toBe('2026-10-16T14:46:00+11:00')
    expect(exact('1,5 hours from now', { ...SYDNEY, locale: 'de-DE' })).toBe('2026-10-16T14:46:00+11:00')
  })
})

describe('the time between dates', () => {
  it('counts days until a date, with the working', () => {
    const result = answer('days until Dec 25')

    expect(result.value).toEqual({ kind: 'duration', exact: '70', number: 70, unit: 'day' })
    expect(result.display).toBe('70 days')
    expect(result.steps.map(spaced)).toEqual(['Fri, Oct 16, 2026 → Fri, Dec 25, 2026', '= 70 days'])
    expect(answer('days until Dec 25', { ...SYDNEY, locale: 'de-DE' }).display).toBe('70 Tage')
  })

  it.each([
    ['how many days until Christmas', '70', 'day'],
    ['days till Mar 3', '138', 'day'],
    ['days until Feb 29', '501', 'day'],
    ['days since Jan 1', '288', 'day'],
    ['days since Dec 25', '295', 'day'],
    ['days until today', '0', 'day'],
    ['days until yesterday', '-1', 'day'],
    ['weeks until Dec 25', '10', 'week'],
    ['Mar 3 to Jun 9 in days', '98', 'day'],
    ['from Mar 3 to Jun 9', '98', 'day'],
    ['days from Mar 3 to Jun 9', '98', 'day'],
    ['Mar 3 to Jun 9 in weeks', '14', 'week'],
    ['between Mar 3 and Jun 9', '98', 'day'],
    ['between Jun 9 and Mar 3', '98', 'day'],
    ['days between Dec 20 and Jan 5', '16', 'day'],
    ['Dec 20 to Jan 5', '16', 'day'],
    ['Jun 9 - Mar 3', '98', 'day'],
    ['Mar 3 - Jun 9', '-98', 'day'],
    ['business days until Dec 25', '50', 'day'],
    ['hours between Oct 3 and Oct 5', '47', 'hour']
  ])('%s is %s %s', (text, amount, unit) => {
    expect(answer(text).value).toMatchObject({ kind: 'duration', exact: amount, unit })
  })

  it('splits weeks, months and years that do not come out whole', () => {
    expect(answer('weeks until Dec 26').value).toEqual({ kind: 'duration', exact: '10.142857142857142857', number: 71 / 7, unit: 'week', fraction: '71/7' })
    expect(answer('weeks until Dec 26').display).toBe('10 weeks 1 day')
    expect(answer('months until Dec 25').value).toMatchObject({ unit: 'month', fraction: '71/31' })
    expect(answer('months until Dec 25').display).toBe('2 months 9 days')
    expect(answer('years since 1990-05-01').display).toBe('36 years 5 months 15 days')
  })

  it('counts time until a date from now', () => {
    const result = answer('time until Dec 25')

    expect(result.value).toMatchObject({ kind: 'duration', unit: 'hour', fraction: '25001/15' })
    expect(spaced(result.display)).toBe('69 days 10 hr 44 min')
  })

  it('reads dates held in variables', () => {
    const context = { ...SYDNEY, variables: { deadline: { kind: 'date', exact: '2026-12-25', number: 0 }, trip: { kind: 'duration', exact: '10', number: 10, unit: 'day' } } } as const

    expect(exact('days until deadline', context)).toBe('70')
    expect(exact('deadline - today', context)).toBe('70')
    expect(exact('deadline + 2 weeks', context)).toBe('2027-01-08')
    expect(exact('today + trip', context)).toBe('2026-10-26')
  })

  it('leaves a line that is only a variable’s name to the engine', () => {
    const context = { ...SYDNEY, variables: { today: { kind: 'number', exact: '5', number: 5 }, deadline: { kind: 'date', exact: '2026-12-25', number: 0 } } } as const

    expect(evaluateDateLine('today', context)).toBeNull()
    expect(evaluateDateLine('deadline', context)).toBeNull()
    expect(evaluateZoneLine('today', context)).toBeNull()
  })
})

describe('the day a date falls on', () => {
  it.each([
    ['what day is Dec 25', 'Friday'],
    ['what day of the week is Christmas', 'Friday'],
    ['what day was it 100 days ago', 'Wednesday'],
    ['what day is it', 'Friday']
  ])('%s is %s', (text, weekday) => {
    expect(answer(text).value).toEqual({ kind: 'text', exact: weekday, number: Number.NaN })
  })

  it('names it in the locale', () => {
    expect(answer('what day is Dec 25', { ...SYDNEY, locale: 'de-DE' }).display).toBe('Freitag')
  })

  it('answers what the date is', () => {
    expect(exact("what's the date")).toBe('2026-10-16')
    expect(exact('what date is next Friday')).toBe('2026-10-23')
  })
})

describe('dates that cannot be', () => {
  it.each([
    ['Feb 30', 'February never has 30 days.'],
    ['Apr 31', 'April has 30 days.'],
    ['Feb 29', "2026 isn't a leap year, so it has no February 29."],
    ['2027-02-29', "2027 isn't a leap year, so February has 28 days."],
    ['2026-13-01', "There's no month 13."],
    ['32/01/2026', 'No month has a day 32.'],
    ['1.5 months from today', "Months have different lengths, so 1.5 months isn't exact; try weeks or days."]
  ])('%s says so gently', (text, error) => {
    expect(evaluateDateLine(text, SYDNEY)).toEqual({ error })
  })
})

describe('lines that are not about dates', () => {
  it.each(['5 km in miles', '20% of 84.50', '90 min in hours', '3 hours 20 minutes in minutes', '3 weeks', '2 + 2', '12/25', 'sqrt(2)', '100 USD in BRL', 'sun', 'march', '', 'hello world', 'today in days'])('%s is left to the engine', (text) => {
    expect(evaluateDateLine(text, SYDNEY)).toBeNull()
    expect(evaluateZoneLine(text, SYDNEY)).toBeNull()
  })

  it('leaves times of day and zones to the zone reader', () => {
    expect(evaluateDateLine('9am Sydney in New York', SYDNEY)).toBeNull()
    expect(evaluateDateLine('9am to 5pm', SYDNEY)).toBeNull()
    expect(evaluateZoneLine('days until Dec 25', SYDNEY)).toBeNull()
  })

  it('never throws, whatever the context', () => {
    expect(evaluateDateLine('days until Dec 25', { now: Number.NaN, zone: 'Not/AZone', locale: 'not a locale' })).toMatchObject({ value: { kind: 'duration' } })
    expect(evaluateDateLine('constructor', SYDNEY)).toBeNull()
  })
})

describe('parseDate', () => {
  it('gives the date words name, or null', () => {
    expect(parseDate('next Friday', SYDNEY)).toBe('2026-10-23')
    expect(parseDate('25/12/2026', { ...SYDNEY, locale: 'en-GB' })).toBe('2026-12-25')
    expect(parseDate('2026-12-25', SYDNEY)).toBe('2026-12-25')
    expect(parseDate('3 weeks from today', SYDNEY)).toBe('2026-11-06')
    expect(parseDate('nonsense', SYDNEY)).toBeNull()
    expect(parseDate('Feb 30', SYDNEY)).toBeNull()
  })
})
