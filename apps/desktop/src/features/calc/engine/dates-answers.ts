import type { TimeAnswer } from './dates.ts'
import type { CalcValue } from './types.ts'
import { DAY_MS, HOUR_MS, MINUTE_MS, addMonths, compareDates, dateIn, dayNumber, isoDate, isoInstant, offsetAt, startOfDay, type CivilDate } from './dates-calendar.ts'
import { formatAmount, formatClock, formatDate, formatNumber, formatOffset, formatUtcClock, formatWeekday, joinAmounts } from './dates-format.ts'
import { describeMoment, momentDate, momentEpoch, type DateMoment, type InstantMoment, type Moment, type Reader } from './dates-moments.ts'
import type { CalendarUnit, ClockUnit, CountUnit, TimeUnit } from './dates-words.ts'
import { zoneLabel, type ZoneMatch } from './zones-names.ts'

/*
 * Answers as the notepad shows them: the exact value, the display in the person's locale, and the
 * working one step a line.
 */

/** An answer, and whether it rests on a time of day or a zone (the zone reader's lines). */
export interface Answer extends TimeAnswer {
  clocked: boolean
}

/** What a span of time is counted in; 'time' breaks it into days, hours and minutes. */
export type SpanUnit = CountUnit | 'time'

const UNIT_MS: Record<ClockUnit, number> = { hour: HOUR_MS, minute: MINUTE_MS, second: 1000 }

export function finish({ value, display, steps }: Answer): TimeAnswer {
  return { value, display, steps }
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y !== 0n) {
    const rest = x % y
    x = y
    y = rest
  }

  return x
}

/** A ratio of whole numbers as the engine writes it: every digit when it ends, else cut at 20 significant digits beside a short fraction. */
function exactRatio(numerator: number, denominator: number): { exact: string; fraction?: string; number: number } {
  let top = BigInt(Math.round(numerator))
  let bottom = BigInt(Math.round(denominator))
  if (bottom < 0n) {
    top = -top
    bottom = -bottom
  }
  const divisor = gcd(top, bottom) || 1n
  top /= divisor
  bottom /= divisor
  const sign = top < 0n ? '-' : ''
  const size = top < 0n ? -top : top
  const whole = size / bottom
  let rest = size % bottom
  let digits = ''
  let significant = whole > 0n ? whole.toString().length : 0
  while (rest !== 0n && significant < 20) {
    rest *= 10n
    const digit = rest / bottom
    rest %= bottom
    digits += digit.toString()
    if (significant > 0 || digit !== 0n) significant++
  }
  const exact = `${sign}${whole}${digits ? `.${digits}` : ''}`
  const number = Number(top) / Number(bottom)

  return rest !== 0n && bottom <= 3600n ? { exact, fraction: `${sign}${size}/${bottom}`, number } : { exact, number }
}

function durationValue(numerator: number, denominator: number, unit: TimeUnit): CalcValue {
  const { exact, fraction, number } = exactRatio(numerator, denominator)

  return fraction ? { kind: 'duration', exact, number, unit, fraction } : { kind: 'duration', exact, number, unit }
}

function isClocked(moment: Moment): boolean {
  return moment.type === 'instant' && moment.clocked
}

export function dateAnswer(r: Reader, moment: DateMoment): Answer {
  return {
    value: { kind: 'date', exact: isoDate(moment.date), number: startOfDay(moment.date, r.zone) },
    display: formatDate(moment.date, r.locale, moment.date.year !== r.today.year),
    steps: moment.steps,
    clocked: false
  }
}

/** The day a time falls on where it is shown, when it is not simply today where it was written: "Thu", or "Thu, Dec 24" further off. */
function dayPart(r: Reader, moment: InstantMoment, zone: string): string {
  const shown = dateIn(moment.epoch, zone)
  if (compareDates(shown, moment.from) === 0 && compareDates(moment.from, dateIn(r.now, moment.zone)) === 0) return ''
  const today = dateIn(r.now, zone)

  return ` ${Math.abs(compareDates(shown, today)) <= 6 ? formatWeekday(shown, r.locale, 'short') : formatDate(shown, r.locale, shown.year !== today.year)}`
}

function isUtc(zone: string): boolean {
  return zone === 'UTC' || zone === 'Etc/UTC' || zone === 'Etc/GMT'
}

/** "Sydney (UTC+11)"; an offset's own name ("UTC+3") needs no repeat. */
function placeWithOffset(epoch: number, zone: string, label: string): string {
  const offset = formatOffset(offsetAt(epoch, zone))

  return label === offset ? label : `${label} (${offset})`
}

function conversionSteps(r: Reader, moment: InstantMoment, zone: string, label: string | undefined): string[] {
  const utc = `${formatUtcClock(moment.epoch)} UTC`
  const steps: string[] = []
  if (!isUtc(moment.zone)) steps.push(`${formatClock(moment.epoch, moment.zone, r.locale)} in ${placeWithOffset(moment.epoch, moment.zone, moment.label ?? zoneLabel(moment.zone))} = ${utc}`)
  if (!isUtc(zone)) steps.push(`${utc} = ${formatClock(moment.epoch, zone, r.locale)}${dayPart(r, moment, zone)} in ${placeWithOffset(moment.epoch, zone, label ?? zoneLabel(zone))}`)

  return steps
}

/** A time shown in `target`'s zone; without one, in the person's (or a time value's own). */
export function instantAnswer(r: Reader, moment: InstantMoment, target?: ZoneMatch): Answer {
  const zone = target?.zone ?? (moment.keep ? moment.zone : r.zone)
  const label = target ? target.label : zone !== r.zone ? (moment.label ?? zoneLabel(zone)) : moment.zone === r.zone ? undefined : zoneLabel(r.zone)
  const shown = `${formatClock(moment.epoch, zone, r.locale)}${dayPart(r, moment, zone)}`

  return {
    value: { kind: 'time', exact: isoInstant(moment.epoch, zone), number: moment.epoch, zone },
    display: label ? `${shown} (${label})` : shown,
    steps: zone === moment.zone ? moment.steps : [...moment.steps, ...conversionSteps(r, moment, zone, label)],
    clocked: moment.clocked || target !== undefined
  }
}

/** The weekday a moment falls on: "Friday". */
export function weekdayAnswer(r: Reader, moment: Moment): Answer {
  const date = moment.type === 'date' ? moment.date : dateIn(moment.epoch, moment.zone)
  const name = formatWeekday(date, r.locale, 'long')

  return { value: { kind: 'text', exact: name, number: Number.NaN }, display: name, steps: moment.steps.length > 0 ? moment.steps : [formatDate(date, r.locale, true)], clocked: isClocked(moment) }
}

function signed(r: Reader, sign: number, parts: [number, TimeUnit][], fallback: TimeUnit): string {
  const shown = parts.filter(([amount]) => amount > 0).map(([amount, unit]) => formatAmount(amount, unit, r.locale))
  if (shown.length === 0) return formatAmount(0, fallback, r.locale)
  const text = joinAmounts(shown, r.locale)

  return sign < 0 ? `-${text}` : text
}

/** Whole calendar months from `from` to `to` (not before it), the days left over, and the length of the month they fall in. */
function monthSpan(from: CivilDate, to: CivilDate): { months: number; days: number; length: number } {
  let months = (to.year - from.year) * 12 + to.month - from.month
  while (months > 0 && compareDates(addMonths(from, months).date, to) > 0) months--
  const anchor = addMonths(from, months).date

  return { months, days: dayNumber(to) - dayNumber(anchor), length: dayNumber(addMonths(from, months + 1).date) - dayNumber(anchor) }
}

/** Mondays to Fridays from `from` up to, not including, `to`. */
function businessDays(from: CivilDate, to: CivilDate): number {
  const start = dayNumber(from)
  const total = dayNumber(to) - start
  let count = Math.floor(total / 7) * 5
  for (let day = start + total - (total % 7); day < start + total; day++) {
    if (((((day + 3) % 7) + 7) % 7) < 5) count++
  }

  return count
}

function calendarSpan(r: Reader, start: Moment, end: Moment, unit: CalendarUnit | 'business', absolute: boolean): TimeAnswer {
  let a = momentDate(r, start)
  let b = momentDate(r, end)
  if (absolute && compareDates(a, b) > 0) [a, b] = [b, a]
  const days = dayNumber(b) - dayNumber(a)
  const sign = days < 0 ? -1 : 1
  const [from, to] = days < 0 ? [b, a] : [a, b]
  let value: CalcValue
  let display: string
  if (unit === 'business') {
    const count = businessDays(from, to) * sign
    value = durationValue(count, 1, 'day')
    display = `${formatNumber(count, r.locale)} business ${Math.abs(count) === 1 ? 'day' : 'days'}`
  } else if (unit === 'week') {
    value = durationValue(days, 7, 'week')
    display = signed(r, sign, [[Math.floor(Math.abs(days) / 7), 'week'], [Math.abs(days) % 7, 'day']], 'week')
  } else if (unit === 'month') {
    const span = monthSpan(from, to)
    value = durationValue(sign * (span.months * span.length + span.days), span.length, 'month')
    display = signed(r, sign, [[span.months, 'month'], [span.days, 'day']], 'month')
  } else if (unit === 'year') {
    const span = monthSpan(from, to)
    const years = Math.floor(span.months / 12)
    const anchor = addMonths(from, years * 12).date
    const length = dayNumber(addMonths(from, years * 12 + 12).date) - dayNumber(anchor)
    value = durationValue(sign * (years * length + dayNumber(to) - dayNumber(anchor)), length, 'year')
    display = signed(r, sign, [[years, 'year'], [span.months % 12, 'month'], [span.days, 'day']], 'year')
  } else {
    value = durationValue(days, 1, 'day')
    display = formatAmount(days, 'day', r.locale)
  }

  return { value, display, steps: [...start.steps, ...end.steps, `${formatDate(a, r.locale, true)} → ${formatDate(b, r.locale, true)}`, `= ${display}`] }
}

/** "69 days 10 hr 44 min": minutes once it is an hour or more, seconds below that. */
function breakdown(r: Reader, ms: number): string {
  let rest = Math.abs(ms)
  if (rest >= HOUR_MS) rest = Math.round(rest / MINUTE_MS) * MINUTE_MS
  const parts: [number, string, 'long' | 'short'][] = [
    [Math.floor(rest / DAY_MS), 'day', 'long'],
    [Math.floor((rest % DAY_MS) / HOUR_MS), 'hour', 'short'],
    [Math.floor((rest % HOUR_MS) / MINUTE_MS), 'minute', 'short'],
    [Math.round((rest % MINUTE_MS) / 1000), 'second', 'short']
  ]
  const shown = parts.filter(([amount]) => amount > 0).map(([amount, unit, width]) => formatAmount(amount, unit, r.locale, width))
  if (shown.length === 0) return formatAmount(0, 'minute', r.locale, 'short')
  const text = joinAmounts(shown, r.locale)

  return ms < 0 ? `-${text}` : text
}

function spanEnds(r: Reader, start: Moment, end: Moment): string {
  const brief = start.type === 'instant' && end.type === 'instant' && !start.dated && !end.dated
  const describe = (moment: Moment) => {
    if (!brief || moment.type !== 'instant') return describeMoment(r, moment)
    const day = dateIn(moment.epoch, moment.zone)
    const weekday = compareDates(day, dateIn(r.now, moment.zone)) === 0 ? '' : ` ${formatWeekday(day, r.locale, 'short')}`

    return `${formatClock(moment.epoch, moment.zone, r.locale)}${weekday}${moment.zone === r.zone ? '' : ` (${moment.label ?? zoneLabel(moment.zone)})`}`
  }

  return `${describe(start)} → ${describe(end)}`
}

function clockSpan(r: Reader, start: Moment, end: Moment, unit: ClockUnit | 'time', absolute: boolean): TimeAnswer {
  const signedMs = Math.round((momentEpoch(r, end) - momentEpoch(r, start)) / 1000) * 1000
  const ms = absolute ? Math.abs(signedMs) : signedMs
  const size = unit === 'time' ? HOUR_MS : UNIT_MS[unit]
  const display = unit === 'time' ? breakdown(r, ms) : formatAmount(ms / size, unit, r.locale)
  const ends = absolute && signedMs < 0 ? spanEnds(r, end, start) : spanEnds(r, start, end)

  return { value: durationValue(ms, size, unit === 'time' ? 'hour' : unit), display, steps: [...start.steps, ...end.steps, ends, `= ${display}`] }
}

/**
 * The time from `start` to `end`: calendar days, weeks, months or years between their dates, or
 * the exact time between their instants for hours and below. With no unit, dates count days and
 * times break into days, hours and minutes.
 */
export function spanAnswer(r: Reader, start: Moment, end: Moment, unit: SpanUnit | null, absolute = false): Answer {
  const clocked = isClocked(start) || isClocked(end)
  if (unit === 'time' || unit === 'hour' || unit === 'minute' || unit === 'second') return { ...clockSpan(r, start, end, unit, absolute), clocked }
  if (unit === null && (start.type === 'instant' || end.type === 'instant')) return { ...clockSpan(r, start, end, 'time', absolute), clocked }

  return { ...calendarSpan(r, start, end, unit ?? 'day', absolute), clocked }
}
