import type { TimeContext } from './dates.ts'
import type { CalcValue } from './types.ts'
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  addDays,
  addMonths,
  canonicalZone,
  compareDates,
  dateIn,
  dayNumber,
  daysInMonth,
  fromDayNumber,
  isValidDate,
  isoWeekday,
  parseIsoDate,
  startOfDay,
  wallTime,
  zonedEpoch,
  type CivilDate,
  type Fold
} from './dates-calendar.ts'
import { decimalMark, formatAmount, formatClock, formatDate, formatDateTime, formatMonth, formatNumber, formatWallClock, joinAmounts, usableLocale, weekStart, writesDayFirst } from './dates-format.ts'
import { CLOCK_SEARCH, MONTH_NAMES, MONTH_WORDS, WEEKDAY_WORDS, readClock, readDuration, type Clock, type DurationPart, type TimeUnit } from './dates-words.ts'
import { lookupZone, zoneLabel, type ZoneMatch } from './zones-names.ts'

/*
 * Reading the dates and times a sentence names ("Dec 25", "next Friday", "9am Sydney",
 * "3 weeks from today", "deadline + 2 days") against the person's today and zone. Words that are
 * clearly a date but cannot be one ("Feb 30") leave a gentle message on the reader.
 */

/** A calendar date the words name. */
export interface DateMoment {
  type: 'date'
  date: CivilDate
  /** The working so far, one step a line. */
  steps: string[]
}

/** An instant the words name. */
export interface InstantMoment {
  type: 'instant'
  epoch: number
  /** The zone it was written in: the person's unless the words named another. */
  zone: string
  /** That zone's name as written ("Sydney", "PST"). */
  label?: string
  /** Its date where it was written; a result shown on another day says which. */
  from: CivilDate
  /** Written with a date ("tomorrow 9am") or held in a value, not a bare time of day. */
  dated: boolean
  /** A bare time of day ("9am"): "until", "since" and ranges may move it a day. */
  clock?: Clock
  /** Named by a time of day, a zone or a time value rather than worked out from now. */
  clocked: boolean
  /** Shown in its own zone rather than the person's: a time value keeps the zone it was shown in. */
  keep?: boolean
  steps: string[]
}

export type Moment = DateMoment | InstantMoment

/** The person's context, resolved once a line. */
export interface Reader {
  now: number
  zone: string
  locale: string | undefined
  decimal: string
  today: CivilDate
  weekStart: number
  dayFirst: boolean
  variables: ReadonlyMap<string, CalcValue>
  /** While reading the far end of "until", "since" or a range: a yearly day resolves to the next (or last) one from `from`. */
  seek: { forward: boolean; from: CivilDate } | null
  /** Why words that are clearly a date cannot be read ("February never has 30 days."). */
  issue: string | null
}

/** A duration as calendar arithmetic applies it: whole months, then whole days and weekdays, then exact time. */
interface Shift {
  months: number
  days: number
  business: number
  ms: number
}

const UNIT_MS: Record<'hour' | 'minute' | 'second', number> = { hour: HOUR_MS, minute: MINUTE_MS, second: 1000 }
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTH_PATTERN = [...MONTH_WORDS.keys()].sort((a, b) => b.length - a.length).join('|')
const WEEKDAY_PATTERN = [...WEEKDAY_WORDS.keys()].sort((a, b) => b.length - a.length).join('|')
const MONTH_FIRST = new RegExp(`^(?:(?:${WEEKDAY_PATTERN}),? )?(${MONTH_PATTERN})\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?$`)
const DAY_FIRST = new RegExp(`^(?:(?:${WEEKDAY_PATTERN}),? )?(?:the )?(\\d{1,2})(?:st|nd|rd|th)? (?:of )?(${MONTH_PATTERN})\\.?(?:,? (\\d{4}))?$`)
const MONTH_EDGE = new RegExp(`^(?:the )?(start|beginning|first day|end|last day) of (${MONTH_PATTERN})\\.?(?: (\\d{4}))?$`)
const MONTH_YEAR = new RegExp(`^(${MONTH_PATTERN})\\.?(?: (\\d{4}))?$`)
const NTH_WEEKDAY = new RegExp(`^(?:the )?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last) (${WEEKDAY_PATTERN}) (?:of|in) (.+)$`)
const WEEKDAY_PHRASE = /^(?:(next|last|this coming|this|coming|past|previous) )?([a-z]+)(?: (next week|last week|this week|after next))?$/
const PERIOD = /^(?:the )?(?:(start|beginning|first day|end|last day) of (?:the )?)?(?:(this|next|last|previous|coming) )?(week|month|year)$/
const ORDINALS = new Map([
  ['first', 1],
  ['1st', 1],
  ['second', 2],
  ['2nd', 2],
  ['third', 3],
  ['3rd', 3],
  ['fourth', 4],
  ['4th', 4],
  ['fifth', 5],
  ['5th', 5],
  ['last', -1]
])
const NAMED_DAYS = new Map([
  ['today', 0],
  ['tonight', 0],
  ['tomorrow', 1],
  ['tmrw', 1],
  ['yesterday', -1],
  ['day after tomorrow', 2],
  ['the day after tomorrow', 2],
  ['day before yesterday', -2],
  ['the day before yesterday', -2]
])
const LOCAL_WORDS = new Set(['local', 'local time', 'my time', 'here', 'my zone', 'my timezone', 'my time zone'])

function easterSunday(year: number): CivilDate {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const h = (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) + 15) % 30
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)

  return { year, month, day: ((h + l - 7 * m + 114) % 31) + 1 }
}

/** The nth (or, for -1, the last) weekday of a month, or null when the month has no such day. */
function nthWeekdayOf(year: number, month: number, weekday: number, nth: number): CivilDate | null {
  const length = daysInMonth(year, month)
  if (nth < 0) return { year, month, day: length - ((isoWeekday({ year, month, day: length }) - weekday + 7) % 7) }
  const day = 1 + ((weekday - isoWeekday({ year, month, day: 1 }) + 7) % 7) + (nth - 1) * 7

  return day <= length ? { year, month, day } : null
}

const fixedDay = (month: number, day: number) => (year: number) => ({ year, month, day })
const HOLIDAYS = new Map<string, (year: number) => CivilDate | null>()
for (const [names, make] of [
  ['christmas, christmas day, xmas, xmas day', fixedDay(12, 25)],
  ['christmas eve, xmas eve', fixedDay(12, 24)],
  ['boxing day', fixedDay(12, 26)],
  ["new year's eve, new years eve, nye", fixedDay(12, 31)],
  ["new year's day, new years day, new year's, new years, new year", fixedDay(1, 1)],
  ["valentine's day, valentines day, valentine's, valentines", fixedDay(2, 14)],
  ["st patrick's day, st. patrick's day, st patricks day, saint patrick's day", fixedDay(3, 17)],
  ['halloween', fixedDay(10, 31)],
  ['easter, easter sunday', easterSunday],
  ['good friday', (year: number) => addDays(easterSunday(year), -2)],
  ['easter monday', (year: number) => addDays(easterSunday(year), 1)],
  ['thanksgiving', (year: number) => nthWeekdayOf(year, 11, 4, 4)]
] as const) {
  for (const name of names.split(', ')) HOLIDAYS.set(name, make)
}

export function createReader(context: TimeContext): Reader {
  const zone = typeof context.zone === 'string' && canonicalZone(context.zone) ? context.zone : 'UTC'
  const locale = usableLocale(context.locale)
  const now = Number.isFinite(context.now) ? context.now : 0
  const variables = new Map<string, CalcValue>()
  for (const [name, value] of Object.entries(context.variables ?? {})) variables.set(name.toLowerCase(), value)

  return { now, zone, locale, decimal: decimalMark(locale), today: dateIn(now, zone), weekStart: weekStart(locale), dayFirst: writesDayFirst(locale), variables, seek: null, issue: null }
}

function note(r: Reader, message: string): null {
  r.issue ??= message

  return null
}

export function nowMoment(r: Reader): InstantMoment {
  return { type: 'instant', epoch: r.now, zone: r.zone, from: r.today, dated: false, clocked: false, steps: [] }
}

export function todayMoment(r: Reader): DateMoment {
  return { type: 'date', date: r.today, steps: [] }
}

/** A moment's date in the person's zone. */
export function momentDate(r: Reader, moment: Moment): CivilDate {
  return moment.type === 'date' ? moment.date : dateIn(moment.epoch, r.zone)
}

/** A moment's instant; a date starts at midnight in the person's zone. */
export function momentEpoch(r: Reader, moment: Moment): number {
  return moment.type === 'date' ? startOfDay(moment.date, r.zone) : moment.epoch
}

/** The zone a place names, the person's own for "local", "here" or "my time". */
export function zoneOf(r: Reader, text: string): ZoneMatch | null {
  return LOCAL_WORDS.has(text) ? { zone: r.zone, label: zoneLabel(r.zone) } : lookupZone(text)
}

export function describeMoment(r: Reader, moment: Moment): string {
  if (moment.type === 'date') return formatDate(moment.date, r.locale, true)
  const text = formatDateTime(moment.epoch, moment.zone, r.locale)

  return moment.zone === r.zone ? text : `${text} (${moment.label ?? zoneLabel(moment.zone)})`
}

function describeDuration(r: Reader, parts: readonly DurationPart[]): string {
  return joinAmounts(
    parts.map(({ amount, unit, business }) => (business ? `${formatNumber(amount, r.locale)} business ${amount === 1 ? 'day' : 'days'}` : formatAmount(amount, unit, r.locale))),
    r.locale
  )
}

/** The moment `text` names as a whole, or null. */
export function readMoment(r: Reader, text: string): Moment | null {
  if (!text) return null

  return readAtom(r, text) ?? readRelative(r, text) ?? readSum(r, text)
}

function readAtom(r: Reader, text: string): Moment | null {
  if (text === 'now' || text === 'right now') return nowMoment(r)
  const variable = readVariable(r, text)
  if (variable) return variable
  const day = readDay(r, text, r.today)

  return day ? { type: 'date', date: day, steps: [] } : readClocked(r, text)
}

function readVariable(r: Reader, text: string): Moment | null {
  const value = r.variables.get(text)
  if (value?.kind === 'date') {
    const date = parseIsoDate(value.exact)

    return date ? { type: 'date', date, steps: [] } : null
  }
  if (value?.kind !== 'time' || !Number.isFinite(value.number)) return null
  const zone = value.zone && canonicalZone(value.zone) ? value.zone : r.zone

  return { type: 'instant', epoch: value.number, zone, label: zone === r.zone ? undefined : zoneLabel(zone), from: dateIn(value.number, zone), dated: true, clocked: true, keep: true, steps: [] }
}

/** A date without a time of day, with `today` as the day relative words count from. */
function readDay(r: Reader, text: string, today: CivilDate): CivilDate | null {
  const named = NAMED_DAYS.get(text)
  if (named !== undefined) return addDays(today, named)

  return holiday(r, text, today) ?? weekday(r, text, today) ?? period(r, text, today) ?? written(r, text, today) ?? monthEdge(r, text, today) ?? nthWeekday(r, text, today)
}

/** A day that comes once a year: this year's, or the next or last one when the words or the sentence look ahead or back. */
function yearly(r: Reader, make: (year: number) => CivilDate | null, today: CivilDate, modifier?: string): CivilDate | null {
  const seek = modifier === 'next' ? { forward: true, from: addDays(today, 1) } : modifier === 'last' ? { forward: false, from: addDays(today, -1) } : modifier === 'this' ? null : r.seek
  if (!seek) {
    const date = make(today.year)

    return date && isValidDate(date) ? date : null
  }
  for (let step = 0; step <= 8; step++) {
    const date = make(seek.from.year + (seek.forward ? step : -step))
    if (date && isValidDate(date) && (seek.forward ? compareDates(date, seek.from) >= 0 : compareDates(date, seek.from) <= 0)) return date
  }

  return null
}

function holiday(r: Reader, text: string, today: CivilDate): CivilDate | null {
  const match = /^(?:(next|last|this) )?(.+)$/.exec(text)
  const make = match ? HOLIDAYS.get(match[2]) : undefined

  return match && make ? yearly(r, make, today, match[1]) : null
}

function weekday(r: Reader, text: string, today: CivilDate): CivilDate | null {
  const match = WEEKDAY_PHRASE.exec(text)
  const day = match ? WEEKDAY_WORDS.get(match[2]) : undefined
  if (!match || day === undefined || (match[1] && match[3])) return null
  const ahead = (day - isoWeekday(today) + 7) % 7
  const thisWeek = addDays(today, -((isoWeekday(today) - r.weekStart + 7) % 7))
  const inWeek = (weeks: number) => addDays(thisWeek, weeks * 7 + ((day - r.weekStart + 7) % 7))
  switch (match[1] ?? match[3]) {
    case undefined:
    case 'coming':
    case 'this coming':
      return addDays(today, ahead || 7)
    case 'this':
      return addDays(today, ahead)
    case 'next':
    case 'next week':
      return inWeek(1)
    case 'after next':
      return inWeek(2)
    case 'this week':
      return inWeek(0)
    case 'last week':
      return inWeek(-1)
    default:
      return addDays(today, -((isoWeekday(today) - day + 7) % 7 || 7))
  }
}

function period(r: Reader, text: string, today: CivilDate): CivilDate | null {
  const match = PERIOD.exec(text)
  if (!match || (!match[1] && !match[2])) return null
  const step = match[2] === 'next' || match[2] === 'coming' ? 1 : match[2] === 'last' || match[2] === 'previous' ? -1 : 0
  let start: CivilDate
  let next: CivilDate
  if (match[3] === 'week') {
    start = addDays(today, step * 7 - ((isoWeekday(today) - r.weekStart + 7) % 7))
    next = addDays(start, 7)
  } else if (match[3] === 'month') {
    start = addMonths({ ...today, day: 1 }, step).date
    next = addMonths(start, 1).date
  } else {
    start = { year: today.year + step, month: 1, day: 1 }
    next = { year: today.year + step + 1, month: 1, day: 1 }
  }

  return match[1] === 'end' || match[1] === 'last day' ? addDays(next, -1) : start
}

function missingDay(month: number, day: number, year?: number): string {
  if (month < 1 || month > 12) return `There's no month ${month}.`
  if (day < 1 || day > 31) return `No month has a day ${day}.`
  if (month === 2 && day === 29 && year !== undefined) return `${year} isn't a leap year, so February has 28 days.`
  if (month === 2) return `February never has ${day} days.`

  return `${MONTH_NAMES[month - 1]} has ${daysInMonth(2000, month)} days.`
}

function exactDate(r: Reader, year: number, month: number, day: number): CivilDate | null {
  const date = { year, month, day }
  if (isValidDate(date)) return date

  return note(r, year < 1 || year > 9999 ? 'Dates go from year 1 to 9999.' : missingDay(month, day, year))
}

function monthDay(r: Reader, month: number, day: number, year: string | undefined, today: CivilDate): CivilDate | null {
  if (year) return exactDate(r, Number(year), month, day)
  if (day < 1 || day > daysInMonth(2000, month)) return note(r, missingDay(month, day))

  return yearly(r, (y) => ({ year: y, month, day }), today) ?? note(r, `${today.year} isn't a leap year, so it has no February 29.`)
}

function written(r: Reader, text: string, today: CivilDate): CivilDate | null {
  let match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text)
  if (match) return exactDate(r, Number(match[1]), Number(match[2]), Number(match[3]))
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)
  if (match) {
    const [first, second, year] = [Number(match[1]), Number(match[2]), Number(match[3])]
    const [month, day] = r.dayFirst ? [second, first] : [first, second]
    const date = { year, month, day }
    const swapped = { year, month: day, day: month }
    if (isValidDate(date)) return date
    if (isValidDate(swapped)) return swapped

    return month > 12 && day <= 12 ? exactDate(r, year, day, month) : exactDate(r, year, month, day)
  }
  match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text)
  if (match) return exactDate(r, Number(match[3]), Number(match[2]), Number(match[1]))
  match = MONTH_FIRST.exec(text)
  if (match) return monthDay(r, MONTH_WORDS.get(match[1]) ?? 0, Number(match[2]), match[3], today)
  match = DAY_FIRST.exec(text)
  if (match) return monthDay(r, MONTH_WORDS.get(match[2]) ?? 0, Number(match[1]), match[3], today)
  match = /^the (\d{1,2})(?:st|nd|rd|th)$/.exec(text)

  return match ? dayOfMonth(r, Number(match[1]), today) : null
}

/** "The 25th": this month's, or the next or last one when the sentence looks ahead or back. */
function dayOfMonth(r: Reader, day: number, today: CivilDate): CivilDate | null {
  if (day < 1 || day > 31) return note(r, missingDay(1, day))
  const make = (index: number) => {
    const year = Math.floor(index / 12)
    const month = index - year * 12 + 1

    return day <= daysInMonth(year, month) ? { year, month, day } : null
  }
  if (!r.seek) return make(today.year * 12 + today.month - 1) ?? note(r, missingDay(today.month, day, today.year))
  const { forward, from } = r.seek
  for (let step = 0; step <= 12; step++) {
    const date = make(from.year * 12 + from.month - 1 + (forward ? step : -step))
    if (date && (forward ? compareDates(date, from) >= 0 : compareDates(date, from) <= 0)) return date
  }

  return null
}

function monthEdge(r: Reader, text: string, today: CivilDate): CivilDate | null {
  const match = MONTH_EDGE.exec(text)
  if (!match) return null
  const month = MONTH_WORDS.get(match[2]) ?? 0
  const end = match[1] === 'end' || match[1] === 'last day'
  const make = (year: number) => ({ year, month, day: end ? daysInMonth(year, month) : 1 })

  return match[3] ? exactDate(r, Number(match[3]), month, make(Number(match[3])).day) : yearly(r, make, today)
}

function nthWeekday(r: Reader, text: string, today: CivilDate): CivilDate | null {
  const match = NTH_WEEKDAY.exec(text)
  if (!match) return null
  const nth = ORDINALS.get(match[1]) ?? 1
  const day = WEEKDAY_WORDS.get(match[2]) ?? 1
  const relative = /^(?:(?:the|this) )?month$|^(next|last) month$/.exec(match[3])
  let date: CivilDate | null
  if (relative) {
    const month = addMonths({ ...today, day: 1 }, relative[1] === 'next' ? 1 : relative[1] === 'last' ? -1 : 0).date
    date = nthWeekdayOf(month.year, month.month, day, nth)
  } else {
    const named = MONTH_YEAR.exec(match[3])
    if (!named) return null
    const month = MONTH_WORDS.get(named[1]) ?? 1
    const make = (year: number) => nthWeekdayOf(year, month, day, nth)
    date = named[2] ? make(Number(named[2])) : yearly(r, make, today)
  }

  return date ?? note(r, `That month has no ${match[1]} ${WEEKDAY_NAMES[day - 1]}.`)
}

function foldSteps(r: Reader, fold: Fold, clock: Clock, day: CivilDate, zone: string, epoch: number, label: string | undefined): string[] {
  if (fold === 'exact') return []
  const place = label ?? zoneLabel(zone)
  const written = formatWallClock(clock.hour, clock.minute, r.locale)
  const on = formatDate(day, r.locale, true)

  return [fold === 'gap' ? `${written} doesn't happen in ${place} on ${on}: the clocks go forward, so ${formatClock(epoch, zone, r.locale)}` : `${written} happens twice in ${place} on ${on}: the first one`]
}

function atClock(r: Reader, clock: Clock, zone: ZoneMatch | null, date: CivilDate | null): InstantMoment {
  const id = zone?.zone ?? r.zone
  const day = date ?? (zone ? dateIn(r.now, id) : r.today)
  const { epoch, fold } = zonedEpoch({ ...day, ...clock }, id)

  return { type: 'instant', epoch, zone: id, label: zone?.label, from: day, dated: date !== null, clock: date ? undefined : clock, clocked: true, steps: foldSteps(r, fold, clock, day, id, epoch, zone?.label) }
}

/** What stands around a time of day: a zone ("Sydney", "PST time") and a date ("tomorrow", "on Dec 25"), each optional. */
function clockSetting(r: Reader, before: string, after: string): { zone: ZoneMatch | null; date: CivilDate | null } | null {
  const splits: [string, string][] = after ? [[after, ''], ['', after]] : [['', '']]
  for (let index = after.indexOf(' '); index > 0; index = after.indexOf(' ', index + 1)) {
    splits.push([after.slice(0, index), after.slice(index + 1)], [after.slice(index + 1), after.slice(0, index)])
  }
  for (const [zoneText, rawDate] of splits) {
    const dateText = rawDate.replace(/^on /, '')
    if (dateText && before) continue
    const zone = zoneText ? zoneOf(r, zoneText) : null
    if (zoneText && !zone) continue
    const text = dateText || before
    const date = text ? readDayOrValue(r, text, zone ? dateIn(r.now, zone.zone) : r.today) : null
    if (text && !date) continue

    return { zone, date }
  }

  return null
}

function readDayOrValue(r: Reader, text: string, today: CivilDate): CivilDate | null {
  const value = r.variables.get(text)
  if (value?.kind === 'date') return parseIsoDate(value.exact)

  return readDay(r, text, today)
}

function readClocked(r: Reader, text: string): InstantMoment | null {
  for (const match of text.matchAll(CLOCK_SEARCH)) {
    const clock = readClock(match[0])
    if (!clock) continue
    const before = text
      .slice(0, match.index)
      .trim()
      .replace(/(?:^| )at$|,$/, '')
      .trim()
    const setting = clockSetting(r, before, text.slice(match.index + match[0].length).trim())
    if (setting) return atClock(r, clock, setting.zone, setting.date)
  }

  return null
}

/** A bare time of day moved to the next (or last) one from `from`: "time until 9am" in the afternoon means tomorrow's. */
export function rollClock(r: Reader, moment: Moment, forward: boolean, from: number): Moment {
  if (moment.type !== 'instant' || !moment.clock) return moment
  const clock = moment.clock
  let rolled = moment
  for (let step = 0; step < 2 && (forward ? rolled.epoch < from : rolled.epoch > from); step++) {
    const day = addDays(rolled.from, forward ? 1 : -1)
    const { epoch, fold } = zonedEpoch({ ...day, ...clock }, moment.zone)
    rolled = { ...rolled, epoch, from: day, steps: foldSteps(r, fold, clock, day, moment.zone, epoch, moment.label) }
  }

  return rolled
}

function readDurationIn(r: Reader, text: string): DurationPart[] | null {
  const value = r.variables.get(text)
  if (value?.kind === 'duration' && value.unit && ['year', 'month', 'week', 'day', 'hour', 'minute', 'second'].includes(value.unit)) {
    const amount = Number(value.exact)

    return Number.isFinite(amount) ? [{ amount, unit: value.unit as TimeUnit }] : null
  }

  return readDuration(text, r.decimal)
}

function nearInteger(value: number): number | null {
  const rounded = Math.round(value)

  return Math.abs(value - rounded) < 1e-9 ? rounded : null
}

function toShift(r: Reader, parts: readonly DurationPart[], sign: number): Shift | null {
  const shift: Shift = { months: 0, days: 0, business: 0, ms: 0 }
  for (const { amount, unit, business } of parts) {
    const value = amount * sign
    if (business) {
      const days = nearInteger(value)
      if (days === null || Math.abs(days) > 100_000) return note(r, 'Business days count in whole days.')
      shift.business += days
    } else if (unit === 'year' || unit === 'month') {
      const months = nearInteger(unit === 'year' ? value * 12 : value)
      if (months === null) return note(r, `Months have different lengths, so ${describeDuration(r, [{ amount, unit }])} isn't exact; try weeks or days.`)
      shift.months += months
    } else if (unit === 'week' || unit === 'day') {
      const days = unit === 'week' ? value * 7 : value
      const whole = nearInteger(days) ?? Math.trunc(days)
      shift.days += whole
      shift.ms += Math.round((days - whole) * DAY_MS)
    } else {
      shift.ms += Math.round(value * UNIT_MS[unit])
    }
  }

  return shift
}

function addBusinessDays(date: CivilDate, count: number): CivilDate {
  let day = dayNumber(date)
  const step = count < 0 ? -1 : 1
  for (let left = Math.abs(count); left > 0; ) {
    day += step
    if (((((day + 3) % 7) + 7) % 7) < 5) left--
  }

  return fromDayNumber(day)
}

function shiftDate(date: CivilDate, shift: Shift): CivilDate {
  const moved = addDays(addMonths(date, shift.months).date, shift.days)

  return shift.business ? addBusinessDays(moved, shift.business) : moved
}

function shiftMoment(r: Reader, moment: Moment, shift: Shift): Moment {
  if (moment.type === 'date' && shift.ms === 0) return { type: 'date', date: shiftDate(moment.date, shift), steps: [] }
  const base: InstantMoment = moment.type === 'date' ? { type: 'instant', epoch: startOfDay(moment.date, r.zone), zone: r.zone, from: moment.date, dated: true, clocked: false, steps: [] } : moment
  let epoch = base.epoch
  if (shift.months || shift.days || shift.business) {
    const wall = wallTime(epoch, base.zone)
    epoch = zonedEpoch({ ...wall, ...shiftDate(wall, shift) }, base.zone).epoch + (epoch - Math.floor(epoch / 1000) * 1000)
  }

  return { ...base, epoch: epoch + shift.ms, clock: undefined, steps: [] }
}

/** `base` moved by a written duration, with the working; null (with a message) when the duration is not exact. */
function applyDuration(r: Reader, base: Moment, parts: readonly DurationPart[], sign: 1 | -1): Moment | null {
  const shift = toShift(r, parts, sign)
  if (!shift) return null
  const moved = shiftMoment(r, base, shift)
  const steps = [...base.steps, `${describeMoment(r, base)} ${sign > 0 ? '+' : '−'} ${describeDuration(r, parts)}`]
  const months = addMonths(base.type === 'date' ? base.date : wallTime(base.epoch, base.zone), shift.months)
  if (months.clamped) steps.push(`${formatMonth(months.date, r.locale)} has ${months.date.day} days`)
  steps.push(`= ${describeMoment(r, moved)}`)

  return { ...moved, steps }
}

function hasTimeOfDay(parts: readonly DurationPart[]): boolean {
  return parts.some(({ amount, unit }) => unit === 'hour' || unit === 'minute' || unit === 'second' || ((unit === 'day' || unit === 'week') && nearInteger(unit === 'week' ? amount * 7 : amount) === null))
}

/** "3 days ago", "in 2 hours", "a week later", "3 weeks from today", "2 days before Christmas". */
function readRelative(r: Reader, text: string): Moment | null {
  const alone = /^(.+) (ago|later|hence)$/.exec(text) ?? /^(in) (.+)$/.exec(text)
  if (alone) {
    const parts = readDurationIn(r, alone[1] === 'in' ? alone[2] : alone[1])
    if (parts) return applyDuration(r, hasTimeOfDay(parts) ? nowMoment(r) : todayMoment(r), parts, alone[2] === 'ago' ? -1 : 1)
  }
  for (const match of text.matchAll(/ (from|after|before) /g)) {
    const parts = readDurationIn(r, text.slice(0, match.index))
    if (!parts) continue
    const rest = text.slice(match.index + match[0].length)
    const base = rest === 'now' && !hasTimeOfDay(parts) ? todayMoment(r) : readMoment(r, rest)
    if (base) return applyDuration(r, base, parts, match[1] === 'before' ? -1 : 1)
  }

  return null
}

/** "today + 30 days", "deadline - 2 weeks", "Dec 25 plus a fortnight": a moment and durations, left to right. */
function readSum(r: Reader, text: string): Moment | null {
  for (const match of [...text.matchAll(/ (plus|minus) |\s*([+-])\s*/g)].reverse()) {
    const parts = readDurationIn(r, text.slice(match.index + match[0].length).trim())
    if (!parts) continue
    const base = readMoment(r, text.slice(0, match.index).trim())
    if (base) return applyDuration(r, base, parts, match[1] === 'minus' || match[2] === '-' ? -1 : 1)
  }

  return null
}
