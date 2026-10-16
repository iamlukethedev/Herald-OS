import { $locale } from '../../store/i18n.ts'
import { CURRENCY_WORDS } from './engine/vocabulary.ts'
import type { CalcContext } from './engine/types.ts'

/** The person's IANA time zone, from the platform. */
export function systemZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

const SYMBOLS = /[$€£¥₹₩₽₺₪₫฿₱₦₴₡₲₵₸₼₾]/u

/** Whether the words name a currency, so a calculation needs the rates. */
export function mentionsCurrency(text: string): boolean {
  if (SYMBOLS.test(text)) {
    return true
  }

  return text
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .some(word => word.length > 0 && CURRENCY_WORDS.has(word))
}

/**
 * The context for a calculation now. Rates come from main: cached, or fetched first (at most once a
 * day, and only while the setting allows) when `text` names a currency.
 */
export async function calcContext(text = ''): Promise<CalcContext> {
  const state = await window.heraldOS.calc.rates(mentionsCurrency(text) ? {} : { cached: true }).catch(() => null)

  return { locale: $locale.get(), now: Date.now(), zone: systemZone(), rates: state?.rates ?? null }
}
