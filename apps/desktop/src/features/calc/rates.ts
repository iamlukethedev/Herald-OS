import { atom } from 'nanostores'
import { CALC_RATES_MAX_AGE_MS, CALC_RATES_RETRY_MS, type CalcRatesState } from '../../../shared/calc.ts'
import { logFailure } from '../../lib/report.ts'

/* The currency rates as this window knows them; main fetches, caches and keeps to the setting. */

/** The rates as main last sent them; null until read. */
export const $calcRates = atom<CalcRatesState | null>(null)

let followers = 0
let unfollow: (() => void) | null = null
let askedAt = Number.NEGATIVE_INFINITY

function read(options: { cached?: boolean; refresh?: boolean }): Promise<CalcRatesState> {
  return window.heraldOS.calc.rates(options).then(state => {
    $calcRates.set(state)

    return state
  })
}

/** Read the cached rates and follow every window's changes to them, while anything here shows them. */
export function followRates(): () => void {
  followers++

  if (followers === 1) {
    void read({ cached: true }).catch(logFailure('calc.rates'))
    unfollow = window.heraldOS.calc.onChanged(what => {
      if (what === 'rates') {
        void read({ cached: true }).catch(logFailure('calc.rates'))
      }
    })
  }

  return () => {
    followers--

    if (followers === 0) {
      unfollow?.()
      unfollow = null
    }
  }
}

/**
 * A note names a currency: ask main for the rates in a way that may fetch them. Main fetches at most
 * once a day and only while the setting allows; this window asks no more than that either, or once
 * an hour after a fetch failed.
 */
export function ratesForCurrency(now = Date.now()): void {
  const wait = $calcRates.get()?.error ? CALC_RATES_RETRY_MS : CALC_RATES_MAX_AGE_MS

  if (now - askedAt < wait) {
    return
  }

  askedAt = now
  void read({}).catch(logFailure('calc.rates'))
}

/** Fetch the rates now, unless the setting is off; the state after. */
export function refreshRates(): Promise<CalcRatesState> {
  askedAt = Date.now()

  return read({ refresh: true })
}
