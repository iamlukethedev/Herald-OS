import type { CalcHistoryEntry } from '../../../../shared/calc.ts'

/* The days the history shows its calculations under, and their times, in the person's locale. */

export interface DayGroup {
  /** The local day, YYYY-MM-DD. */
  key: string
  label: string
  entries: CalcHistoryEntry[]
}

/** Midnight, local time, of the day `t` falls on, `days` later. */
export function startOfDay(t: number, days = 0): number {
  const date = new Date(t)

  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime()
}

/** The local day `t` falls on, as 2026-10-14. */
export function dayKey(t: number): string {
  const date = new Date(t)

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const formats = new Map<string, Intl.DateTimeFormat>()

/** One formatter per locale and shape; an unknown locale falls back to the system's. */
function formatter(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`
  let format = formats.get(key)

  if (!format) {
    try {
      format = new Intl.DateTimeFormat(locale, options)
    } catch {
      format = new Intl.DateTimeFormat(undefined, options)
    }

    formats.set(key, format)
  }

  return format
}

/** "Today", "Yesterday", or the day in the locale ("Mon, 12 Oct"), with its year when it is not this one. */
export function dayLabel(t: number, now: number, locale?: string): string {
  const key = dayKey(t)

  if (key === dayKey(now)) {
    return 'Today'
  }

  if (key === dayKey(startOfDay(now, -1))) {
    return 'Yesterday'
  }

  const thisYear = new Date(t).getFullYear() === new Date(now).getFullYear()

  return formatter(locale, thisYear ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(t)
}

/** The time of day in the locale: "9:05 am", "09:05". */
export function timeLabel(t: number, locale?: string): string {
  return formatter(locale, { hour: 'numeric', minute: '2-digit' }).format(t)
}

/**
 * Entries under the day each was made, in the order given: each day where its first entry is and
 * its entries in their order, so the newest days come first in a list newest first, and the day of
 * the best match first in a search.
 */
export function groupByDay(entries: readonly CalcHistoryEntry[], now: number, locale?: string): DayGroup[] {
  const groups = new Map<string, DayGroup>()

  for (const entry of entries) {
    const key = dayKey(entry.at)
    let group = groups.get(key)

    if (!group) {
      group = { key, label: dayLabel(entry.at, now, locale), entries: [] }
      groups.set(key, group)
    }

    group.entries.push(entry)
  }

  return [...groups.values()]
}
