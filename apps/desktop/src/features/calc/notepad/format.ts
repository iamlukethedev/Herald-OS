import type { CalcRatesState } from '../../../../shared/calc.ts'

/** An error as a person reads it, without Electron's "Error invoking remote method" wrapping. */
export function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)

  return text.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '').trim() || 'Something went wrong'
}

/** The ECB's date for the rates (YYYY-MM-DD) as the locale writes a day: "15 Oct", or "15 Oct 2025" in another year. */
export function ratesDay(date: string, locale: string | undefined, now = Date.now()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)

  if (!match) {
    return date
  }

  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  const sameYear = day.getUTCFullYear() === new Date(now).getUTCFullYear()

  return day.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric', timeZone: 'UTC' })
}

/** The footer's quiet line about the rates: which day's they are, and a hint when they cannot be fresh. */
export function ratesLabel(state: CalcRatesState | null, locale: string | undefined, now = Date.now()): { text: string; hint: string | null } {
  const hint = state?.status === 'offline' ? 'offline' : state?.status === 'off' ? 'updates off' : null

  if (!state?.rates) {
    return { text: 'No currency rates yet', hint }
  }

  return { text: `Rates from ${ratesDay(state.rates.date, locale, now)}`, hint }
}
