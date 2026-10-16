import { describe, expect, it } from 'vitest'
import type { TimeAnswer, TimeContext } from './dates.ts'
import { evaluateZoneLine, findZone, zoneNames } from './zones.ts'

/** Fri 16 Oct 2026, 1:16 PM in Sydney. */
const SYDNEY: TimeContext = { now: Date.UTC(2026, 9, 16, 2, 16), zone: 'Australia/Sydney', locale: 'en-US' }

function answer(text: string, context: TimeContext = SYDNEY): TimeAnswer {
  const outcome = evaluateZoneLine(text, context)
  if (!outcome || 'error' in outcome) throw new Error(`"${text}" gave ${JSON.stringify(outcome)}`)

  return outcome
}

/** Newer ICU puts narrow no-break spaces before AM and PM. */
function spaced(text: string): string {
  return text.replace(/\s+/g, ' ')
}

describe('a time of day in another zone', () => {
  it('converts 9am Sydney to New York, the day before there', () => {
    const result = answer('9am Sydney in New York')

    expect(result.value).toEqual({ kind: 'time', exact: '2026-10-15T18:00:00-04:00', number: Date.UTC(2026, 9, 15, 22), zone: 'America/New_York' })
    expect(spaced(result.display)).toBe('6:00 PM Thu (New York)')
    expect(result.steps.map(spaced)).toEqual(['9:00 AM in Sydney (UTC+11) = 22:00 UTC', '22:00 UTC = 6:00 PM Thu in New York (UTC−4)'])
  })

  it.each([
    ['9:30 am Sydney time in NYC', '2026-10-15T18:30:00-04:00', 'America/New_York'],
    ['3pm London to Tokyo', '2026-10-16T23:00:00+09:00', 'Asia/Tokyo'],
    ['noon UTC in Sydney', '2026-10-16T23:00:00+11:00', 'Australia/Sydney'],
    ['midnight PST in CET', '2026-10-15T09:00:00+02:00', 'Europe/Paris'],
    ['3pm London to PST', '2026-10-16T07:00:00-07:00', 'America/Los_Angeles'],
    ['9am in New York', '2026-10-15T18:00:00-04:00', 'America/New_York'],
    ['5pm New York in my time', '2026-10-16T08:00:00+11:00', 'Australia/Sydney'],
    ['3pm GMT-5 in London', '2026-10-15T21:00:00+01:00', 'Europe/London'],
    ['9am UTC+5:30 in UTC', '2026-10-16T03:30:00+00:00', 'UTC'],
    ['tomorrow 9am in London', '2026-10-16T23:00:00+01:00', 'Europe/London'],
    ['in 2 hours in Tokyo', '2026-10-16T13:16:00+09:00', 'Asia/Tokyo'],
    ['what time is 9am Sydney in Mumbai', '2026-10-16T03:30:00+05:30', 'Asia/Kolkata']
  ])('%s is %s', (text, iso, zone) => {
    expect(answer(text).value).toMatchObject({ kind: 'time', exact: iso, zone })
  })

  it('shows a zone’s time in the person’s zone when no other is asked for', () => {
    const result = answer('9am New York')

    expect(result.value).toMatchObject({ exact: '2026-10-16T00:00:00+11:00', zone: 'Australia/Sydney' })
    expect(spaced(result.display)).toBe('12:00 AM Fri (Sydney)')
  })

  it('names the date when it is not today', () => {
    const result = answer('Dec 25 9am Sydney in New York')

    expect(result.value.exact).toBe('2026-12-24T17:00:00-05:00')
    expect(spaced(result.display)).toBe('5:00 PM Thu, Dec 24 (New York)')
  })

  it('writes the time in the locale', () => {
    expect(spaced(answer('9am Sydney in New York', { ...SYDNEY, locale: 'en-GB' }).display)).toBe('18:00 Thu (New York)')
  })
})

describe('now', () => {
  it.each([
    ['now in Tokyo', '2026-10-16T11:16:00+09:00'],
    ['what time is it in Tokyo', '2026-10-16T11:16:00+09:00'],
    ['Tokyo time', '2026-10-16T11:16:00+09:00'],
    ['time in London', '2026-10-16T03:16:00+01:00'],
    ['now in UTC+3', '2026-10-16T05:16:00+03:00'],
    ['Tokyo now', '2026-10-16T11:16:00+09:00'],
    ['now', '2026-10-16T13:16:00+11:00'],
    ['what time is it', '2026-10-16T13:16:00+11:00'],
    ['what time is it now', '2026-10-16T13:16:00+11:00']
  ])('%s is %s', (text, iso) => {
    expect(answer(text).value.exact).toBe(iso)
  })

  it('gives the time difference between two places today', () => {
    const result = answer("what's the time difference between Sydney and London")

    expect(result.value).toEqual({ kind: 'duration', exact: '10', number: 10, unit: 'hour' })
    expect(result.display).toBe('10 hours')
    expect(result.steps).toEqual(['Sydney is UTC+11 and London is UTC+1 now', '= 10 hours, Sydney ahead'])
    expect(answer('time difference from Sydney to Mumbai').value.exact).toBe('5.5')
  })

  it('shows the time there, and the day when it is another one', () => {
    expect(spaced(answer('now in Tokyo').display)).toBe('11:16 AM (Tokyo)')
    expect(spaced(answer('now in London', { ...SYDNEY, zone: 'America/New_York' }).display)).toBe('3:16 AM Fri (London)')
    expect(spaced(answer('now').display)).toBe('1:16 PM')
  })
})

describe('times of day', () => {
  it.each([
    ['9am', '2026-10-16T09:00:00+11:00'],
    ['21:15', '2026-10-16T21:15:00+11:00'],
    ['noon', '2026-10-16T12:00:00+11:00'],
    ['midnight', '2026-10-16T00:00:00+11:00'],
    ['3pm + 4 hours', '2026-10-16T19:00:00+11:00'],
    ['10pm + 4 hours', '2026-10-17T02:00:00+11:00'],
    ['2 hours before 9am', '2026-10-16T07:00:00+11:00']
  ])('%s is %s', (text, iso) => {
    expect(answer(text).value).toMatchObject({ kind: 'time', exact: iso, zone: 'Australia/Sydney' })
  })

  it('says the day a sum lands on when it is another one', () => {
    expect(spaced(answer('10pm + 4 hours').display)).toBe('2:00 AM Sat')
    expect(spaced(answer('3pm + 4 hours').display)).toBe('7:00 PM')
  })

  it('gives the time between two times of day', () => {
    const result = answer('9am to 5:30pm')

    expect(result.value).toEqual({ kind: 'duration', exact: '8.5', number: 8.5, unit: 'hour' })
    expect(spaced(result.display)).toBe('8 hr 30 min')
    expect(result.steps.map(spaced)).toEqual(['9:00 AM → 5:30 PM', '= 8 hr 30 min'])
  })

  it.each([
    ['9am to 5:30pm in minutes', '510', 'minute'],
    ['9am-5pm', '8', 'hour'],
    ['10pm to 6am', '8', 'hour'],
    ['between 10pm and 6am', '8', 'hour'],
    ['5pm - 9am', '8', 'hour'],
    ['9am - 5pm', '8', 'hour'],
    ['minutes until midnight', '644', 'minute'],
    ['hours until 5pm', '3.7333333333333333333', 'hour']
  ])('%s is %s %s', (text, amount, unit) => {
    expect(answer(text).value).toMatchObject({ kind: 'duration', exact: amount, unit })
  })

  it('counts until the next one and since the last one', () => {
    expect(spaced(answer('time until 9am').display)).toBe('19 hr 44 min')
    expect(spaced(answer('time since 9am').display)).toBe('4 hr 16 min')
    expect(answer('hours until 5pm').value.fraction).toBe('56/15')
  })

  it('keeps a time value in its own zone', () => {
    const variables = { meeting: { kind: 'time', exact: '2026-10-16T18:00:00-04:00', number: Date.UTC(2026, 9, 16, 22), zone: 'America/New_York' } } as const

    expect(answer('meeting in Tokyo', { ...SYDNEY, variables }).value.exact).toBe('2026-10-17T07:00:00+09:00')
    expect(answer('meeting + 1 hour', { ...SYDNEY, variables }).value).toMatchObject({ exact: '2026-10-16T19:00:00-04:00', zone: 'America/New_York' })
  })
})

describe('daylight saving', () => {
  it('knows New York is still on daylight time when London is not', () => {
    const lateOctober = { now: Date.UTC(2026, 9, 28, 12), zone: 'Europe/London', locale: 'en-GB' }

    expect(answer('9am London in New York', lateOctober).value.exact).toBe('2026-10-28T05:00:00-04:00')
    expect(answer('9am New York in London', lateOctober).value.exact).toBe('2026-10-28T13:00:00+00:00')
  })

  it('moves a time the clocks skip on, and says so', () => {
    const result = answer('2:30am New York on Mar 8 2026 in UTC')

    expect(result.value.exact).toBe('2026-03-08T07:30:00+00:00')
    expect(spaced(result.steps[0])).toBe("2:30 AM doesn't happen in New York on Sun, Mar 8, 2026: the clocks go forward, so 3:30 AM")
    expect(answer('Oct 4 2:30am in UTC').value.exact).toBe('2026-10-03T16:30:00+00:00')
  })

  it('takes the first of a time that happens twice', () => {
    expect(answer('Apr 5 2026 2:30am in UTC').value.exact).toBe('2026-04-04T15:30:00+00:00')
  })
})

describe('lines a zone cannot answer', () => {
  it('says gently when it does not know a place', () => {
    expect(evaluateZoneLine('9am in Gotham', SYDNEY)).toEqual({ error: "I don't know the time zone of “Gotham”." })
    expect(evaluateZoneLine('9am Gotham in London', SYDNEY)).toEqual({ error: "I don't know the time zone of “Gotham”." })
    expect(evaluateZoneLine('9am on Feb 30 in London', SYDNEY)).toEqual({ error: 'February never has 30 days.' })
  })

  it.each(['5 km in miles', '20% of 84.50', '90 min in hours', '100 USD in EUR', '1 pm in nm', '9am coffee', 'meeting at 9am', 'days until Dec 25', 'Mar 3 to Jun 9 in days', 'today in Tokyo', '9am Sydney in New York standup', 'standup 9am Sydney in New York'])('%s is not its line', (text) => {
    expect(evaluateZoneLine(text, SYDNEY)).toBeNull()
  })
})

describe('findZone', () => {
  it.each([
    ['Sydney', 'Australia/Sydney'],
    ['new york', 'America/New_York'],
    ['NYC', 'America/New_York'],
    ['Los Angeles', 'America/Los_Angeles'],
    ['LA', 'America/Los_Angeles'],
    ['San Francisco', 'America/Los_Angeles'],
    ['Seattle', 'America/Los_Angeles'],
    ['Washington DC', 'America/New_York'],
    ['são paulo', 'America/Sao_Paulo'],
    ['Sao Paulo', 'America/Sao_Paulo'],
    ['Brasília', 'America/Sao_Paulo'],
    ['Rio', 'America/Sao_Paulo'],
    ['Montreal', 'America/Toronto'],
    ['Mumbai', 'Asia/Kolkata'],
    ['Bengaluru', 'Asia/Kolkata'],
    ['Kolkata', 'Asia/Kolkata'],
    ['Calcutta', 'Asia/Kolkata'],
    ['Asia/Calcutta', 'Asia/Kolkata'],
    ['Kyiv', 'Europe/Kyiv'],
    ['Beijing', 'Asia/Shanghai'],
    ['Osaka', 'Asia/Tokyo'],
    ['Munich', 'Europe/Berlin'],
    ['Geneva', 'Europe/Zurich'],
    ['Abu Dhabi', 'Asia/Dubai'],
    ['Tel Aviv', 'Asia/Jerusalem'],
    ['Cape Town', 'Africa/Johannesburg'],
    ['Wellington', 'Pacific/Auckland'],
    ['Canberra', 'Australia/Sydney'],
    ['Edinburgh', 'Europe/London'],
    ['Europe/Paris', 'Europe/Paris'],
    ['europe/paris', 'Europe/Paris'],
    ['Japan', 'Asia/Tokyo'],
    ['UK', 'Europe/London'],
    ['the UK', 'Europe/London'],
    ['Germany', 'Europe/Berlin'],
    ['India', 'Asia/Kolkata'],
    ['China', 'Asia/Shanghai'],
    ['USA', 'America/New_York'],
    ['Australia', 'Australia/Sydney'],
    ['Brazil', 'America/Sao_Paulo'],
    ['UTC', 'UTC'],
    ['GMT', 'UTC'],
    ['Z', 'UTC'],
    ['EST', 'America/New_York'],
    ['EDT', 'America/New_York'],
    ['CT', 'America/Chicago'],
    ['MST', 'America/Denver'],
    ['PST', 'America/Los_Angeles'],
    ['AKST', 'America/Anchorage'],
    ['HST', 'Pacific/Honolulu'],
    ['AEST', 'Australia/Sydney'],
    ['AWST', 'Australia/Perth'],
    ['NZDT', 'Pacific/Auckland'],
    ['JST', 'Asia/Tokyo'],
    ['IST', 'Asia/Kolkata'],
    ['CET', 'Europe/Paris'],
    ['BST', 'Europe/London'],
    ['MSK', 'Europe/Moscow'],
    ['GST', 'Asia/Dubai'],
    ['SAST', 'Africa/Johannesburg'],
    ['Pacific Time', 'America/Los_Angeles'],
    ['Eastern Standard Time', 'America/New_York'],
    ['British Summer Time', 'Europe/London'],
    ['UTC+3', 'Etc/GMT-3'],
    ['GMT-5', 'Etc/GMT+5'],
    ['UTC+05:30', '+05:30'],
    ['utc+0', 'UTC']
  ])('%s is %s', (name, zone) => {
    expect(findZone(name)).toBe(zone)
  })

  it('knows no zone for nonsense', () => {
    for (const name of ['Gotham', 'xyz', '', 'UTC+15', 'constructor', '__proto__', 'Christmas', 'center', 'Mars/Olympus']) expect(findZone(name)).toBeNull()
  })
})

describe('zoneNames', () => {
  it('lists every place and abbreviation findZone knows, lower case', () => {
    const names = zoneNames()

    expect(names.length).toBeGreaterThan(700)
    for (const name of ['sydney', 'new york', 'nyc', 'pst', 'japan', 'são paulo', 'sao paulo', 'utc', 'kolkata', 'mumbai']) expect(names).toContain(name)
    expect(names).not.toContain('christmas')
    for (const name of names) {
      expect(name).toBe(name.toLowerCase())
      expect(findZone(name)).not.toBeNull()
    }
  })
})
