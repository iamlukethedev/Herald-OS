import { DAY_MS, MINUTE_MS, dayNumber, wallTime, type CivilDate } from './dates-calendar.ts'

/*
 * How dates, times and durations read in the person's locale, through Intl only. Calendar dates
 * are formatted at their UTC midnight, so the machine's own zone never shows through.
 */

const dateFormatters = new Map<string, Intl.DateTimeFormat>()
const numberFormatters = new Map<string, Intl.NumberFormat>()
const listFormatters = new Map<string, Intl.ListFormat | null>()

/** The locale when Intl can read it, else undefined (the system's). */
export function usableLocale(locale: string | undefined): string | undefined {
  if (!locale) return undefined
  try {
    return Intl.getCanonicalLocales(locale)[0]
  } catch {
    return undefined
  }
}

function dateFormatter(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ''} ${JSON.stringify(options)}`
  let formatter = dateFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options)
    dateFormatters.set(key, formatter)
  }

  return formatter
}

function numberFormatter(locale: string | undefined, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale ?? ''} ${JSON.stringify(options)}`
  let formatter = numberFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options)
    numberFormatters.set(key, formatter)
  }

  return formatter
}

/** "Fri, Nov 6", or "Fri, Nov 6, 2027" with the year. */
export function formatDate(date: CivilDate, locale: string | undefined, withYear: boolean): string {
  const options: Intl.DateTimeFormatOptions = withYear ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' } : { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }

  return dateFormatter(locale, options).format(dayNumber(date) * DAY_MS)
}

/** "Friday", or "Fri" short. */
export function formatWeekday(date: CivilDate, locale: string | undefined, width: 'long' | 'short'): string {
  return dateFormatter(locale, { weekday: width, timeZone: 'UTC' }).format(dayNumber(date) * DAY_MS)
}

/** "February 2026". */
export function formatMonth(date: CivilDate, locale: string | undefined): string {
  return dateFormatter(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(dayNumber(date) * DAY_MS)
}

/** The time of day in `zone`: "6:00 PM", "18:00". */
export function formatClock(epoch: number, zone: string, locale: string | undefined): string {
  return dateFormatter(locale, { hour: 'numeric', minute: '2-digit', timeZone: zone }).format(epoch)
}

/** A wall-clock time with no zone: "2:30 AM". */
export function formatWallClock(hour: number, minute: number, locale: string | undefined): string {
  return dateFormatter(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(hour * 3_600_000 + minute * MINUTE_MS)
}

/** The date and time in `zone`: "Fri, Oct 16, 2026, 1:16 PM". */
export function formatDateTime(epoch: number, zone: string, locale: string | undefined): string {
  return dateFormatter(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone }).format(epoch)
}

/** "22:00", the time of day in UTC. */
export function formatUtcClock(epoch: number): string {
  const { hour, minute } = wallTime(epoch, 'UTC')

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** "UTC+11", "UTC−4", "UTC+5:30". */
export function formatOffset(offsetMs: number): string {
  const minutes = Math.round(offsetMs / MINUTE_MS)
  const size = Math.abs(minutes)
  const rest = size % 60

  return `UTC${minutes < 0 ? '−' : '+'}${Math.floor(size / 60)}${rest ? `:${String(rest).padStart(2, '0')}` : ''}`
}

/** "70 days", "1 day", "8.5 hours", "30 min": at most two decimals, in the locale's digits. */
export function formatAmount(amount: number, unit: string, locale: string | undefined, width: 'long' | 'short' = 'long'): string {
  return numberFormatter(locale, { style: 'unit', unit, unitDisplay: width, maximumFractionDigits: 2 }).format(amount)
}

export function formatNumber(amount: number, locale: string | undefined): string {
  return numberFormatter(locale, { maximumFractionDigits: 2 }).format(amount)
}

/** Amounts side by side the way the locale lists units: "10 weeks 1 day". */
export function joinAmounts(amounts: string[], locale: string | undefined): string {
  const key = locale ?? ''
  if (!listFormatters.has(key)) {
    let formatter: Intl.ListFormat | null
    try {
      formatter = new Intl.ListFormat(locale, { type: 'unit', style: 'narrow' })
    } catch {
      formatter = null
    }
    listFormatters.set(key, formatter)
  }

  return listFormatters.get(key)?.format(amounts) ?? amounts.join(' ')
}

/** The locale's decimal mark: "." or ",". */
export function decimalMark(locale: string | undefined): string {
  return numberFormatter(locale, {}).formatToParts(1.5).find((part) => part.type === 'decimal')?.value ?? '.'
}

/** The locale writes the day before the month in numeric dates (25/12/2026 rather than 12/25/2026). */
export function writesDayFirst(locale: string | undefined): boolean {
  const order = dateFormatter(locale, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' })
    .formatToParts(0)
    .map((part) => part.type)

  return order.indexOf('day') < order.indexOf('month')
}

interface WeekInfo {
  firstDay: number
}

/** The weekday the locale's weeks start on: 1 Monday … 7 Sunday. */
export function weekStart(locale: string | undefined): number {
  try {
    const tag = new Intl.Locale(locale ?? new Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo }

    return (tag.getWeekInfo?.() ?? tag.weekInfo)?.firstDay ?? 1
  } catch {
    return 1
  }
}
