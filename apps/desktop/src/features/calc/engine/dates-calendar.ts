/*
 * Calendar dates and wall-clock times in a time zone, never the machine's own: dates count days
 * from 1970-01-01 in the proleptic Gregorian calendar, and zones go through Intl's own data.
 */

/** A calendar date; month 1–12. */
export interface CivilDate {
  year: number
  month: number
  day: number
}

/** A calendar date and a wall-clock time on it. */
export interface WallTime extends CivilDate {
  hour: number
  minute: number
  second: number
}

/** How a wall-clock time maps to an instant: once, never (the clocks jumped over it) or twice. */
export type Fold = 'exact' | 'gap' | 'overlap'

export const DAY_MS = 86_400_000
export const HOUR_MS = 3_600_000
export const MINUTE_MS = 60_000

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1]
}

/** A real date in the years the engine writes (1–9999). */
export function isValidDate({ year, month, day }: CivilDate): boolean {
  return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day) && year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
}

/** Days from 1970-01-01 to the date. */
export function dayNumber({ year, month, day }: CivilDate): number {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yearOfEra = y - era * 400
  const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear

  return era * 146_097 + dayOfEra - 719_468
}

/** The date `days` after 1970-01-01. */
export function fromDayNumber(days: number): CivilDate {
  const z = days + 719_468
  const era = Math.floor(z / 146_097)
  const dayOfEra = z - era * 146_097
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365)
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100))
  const shifted = Math.floor((5 * dayOfYear + 2) / 153)
  const month = shifted < 10 ? shifted + 3 : shifted - 9

  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day: dayOfYear - Math.floor((153 * shifted + 2) / 5) + 1 }
}

/** ISO weekday: 1 Monday … 7 Sunday. */
export function isoWeekday(date: CivilDate): number {
  return ((((dayNumber(date) + 3) % 7) + 7) % 7) + 1
}

export function addDays(date: CivilDate, days: number): CivilDate {
  return fromDayNumber(dayNumber(date) + days)
}

/** Calendar months later (or earlier); a day the month lacks becomes its last ("Jan 31 + 1 month" is Feb 28). */
export function addMonths(date: CivilDate, months: number): { date: CivilDate; clamped: boolean } {
  const total = date.year * 12 + date.month - 1 + months
  const year = Math.floor(total / 12)
  const month = total - year * 12 + 1
  const last = daysInMonth(year, month)

  return { date: { year, month, day: Math.min(date.day, last) }, clamped: date.day > last }
}

/** Negative when `a` is earlier than `b`. */
export function compareDates(a: CivilDate, b: CivilDate): number {
  return dayNumber(a) - dayNumber(b)
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** YYYY-MM-DD. */
export function isoDate({ year, month, day }: CivilDate): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`
}

/** A YYYY-MM-DD string as a date, or null. */
export function parseIsoDate(text: string): CivilDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return null
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }

  return isValidDate(date) ? date : null
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>()
const canonicalZones = new Map<string, string | null>()

/** The zone as Intl names it ("europe/paris" is "Europe/Paris"), or null when Intl does not know it. */
export function canonicalZone(zone: string): string | null {
  if (!canonicalZones.has(zone)) {
    let canonical: string | null
    try {
      canonical = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
    } catch {
      canonical = null
    }
    canonicalZones.set(zone, canonical)
  }

  return canonicalZones.get(zone) ?? null
}

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    zoneFormatters.set(zone, formatter)
  }

  return formatter
}

/** The date and wall-clock time in `zone` at `epoch`. */
export function wallTime(epoch: number, zone: string): WallTime {
  const wall: WallTime = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 }
  for (const part of zoneFormatter(zone).formatToParts(epoch)) {
    if (part.type in wall) wall[part.type as keyof WallTime] = Number(part.value)
  }

  return wall
}

function wallMs(wall: WallTime): number {
  return dayNumber(wall) * DAY_MS + wall.hour * HOUR_MS + wall.minute * MINUTE_MS + wall.second * 1000
}

/** How far `zone` is ahead of UTC at `epoch`, in ms. */
export function offsetAt(epoch: number, zone: string): number {
  const whole = Math.floor(epoch / 1000) * 1000

  return wallMs(wallTime(whole, zone)) - whole
}

/** The instant a wall-clock time in `zone` names: a time the clocks skipped moves on by the jump, and one they repeat is the first. */
export function zonedEpoch(wall: WallTime, zone: string): { epoch: number; fold: Fold } {
  const local = wallMs(wall)
  const before = local - offsetAt(local - DAY_MS, zone)
  const after = local - offsetAt(local + DAY_MS, zone)
  const fits = [before, after].filter((epoch) => epoch + offsetAt(epoch, zone) === local)
  if (fits.length === 0) return { epoch: before, fold: 'gap' }

  return { epoch: Math.min(...fits), fold: fits.length === 2 && before !== after ? 'overlap' : 'exact' }
}

/** The date in `zone` at `epoch`. */
export function dateIn(epoch: number, zone: string): CivilDate {
  const { year, month, day } = wallTime(epoch, zone)

  return { year, month, day }
}

/** The instant the date starts in `zone`. */
export function startOfDay(date: CivilDate, zone: string): number {
  return zonedEpoch({ ...date, hour: 0, minute: 0, second: 0 }, zone).epoch
}

/** ISO 8601 with the zone's offset at that instant: "2026-10-15T18:00:00-04:00". */
export function isoInstant(epoch: number, zone: string): string {
  const whole = Math.floor(epoch / 1000) * 1000
  const wall = wallTime(whole, zone)
  const offset = Math.round((wallMs(wall) - whole) / MINUTE_MS)
  const size = Math.abs(offset)

  return `${isoDate(wall)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}${offset < 0 ? '-' : '+'}${pad(Math.floor(size / 60))}:${pad(size % 60)}`
}
