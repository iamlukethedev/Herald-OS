import fs from 'node:fs/promises'
import path from 'node:path'
import { CALC_RATES_MAX_AGE_MS, CALC_RATES_RETRY_MS, CALC_RATES_URL, type CalcPrefs, type CalcRates, type CalcRatesState } from '../../shared/calc.ts'
import { writeTextAtomic } from '../atomic-write.ts'
import { log } from '../log.ts'

/*
 * Herald Calc's currency rates (shared/calc.ts), the app's only network call: the ECB's daily
 * reference rates through Frankfurter, kept in `calc/rates.json` in Herald's data folder with the
 * last fetch when it failed, so a restart neither fetches the day's rates again nor retries a
 * failure within the hour. A fetch is a plain GET of CALC_RATES_URL with an Accept header and
 * nothing else: no cookies, no query, nothing about the person.
 *
 * get() fetches first unless it asks for the cache only or the setting is off, and only when
 * there are no rates or they are older than CALC_RATES_MAX_AGE_MS and no fetch failed within
 * CALC_RATES_RETRY_MS; `refresh` fetches whatever the rates' age and the last failure. Callers
 * asking at once share one fetch. Its status is the first of these that holds:
 * - off: the setting is off; nothing is fetched and the saved rates answer, or none.
 * - none: no rates; `error` says why when the last fetch failed.
 * - offline: the last fetch failed; the rates from before it answer and `error` says why.
 * - fresh: the rates were fetched within CALC_RATES_MAX_AGE_MS.
 * - cached: older rates, read without fetching because the caller asked for the cache only.
 */

const FETCH_TIMEOUT_MS = 10_000
/** Frankfurter's answer is about 2 KB; anything this large is not it. */
const ANSWER_MAX = 256 * 1024
const CODE = /^[A-Z]{3}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

export interface RatesOptions {
  /** Answer from the saved rates without fetching. */
  cached?: boolean
  /** Fetch now, whatever the rates' age and the last failure, unless the setting is off. */
  refresh?: boolean
}

export interface RatesServiceOptions {
  /** `calc/rates.json` in Herald's data folder. */
  file: string
  /** Herald Calc's preferences as saved now (readPrefs().calc). */
  prefs: () => Partial<CalcPrefs> | undefined
  fetch?: typeof fetch
  now?: () => number
  /** After each fetch: new rates or a failure both change what get() answers. */
  onChange?: () => void
}

/** What rates.json holds. */
interface Saved {
  rates: CalcRates | null
  /** The last fetch, when it failed; null once one works. */
  failure: { at: number; error: string } | null
}

const EMPTY: Saved = { rates: null, failure: null }

/** A fetch that failed: `reason` in a few plain words for the windows, the message for the log. */
class RatesFailure extends Error {
  constructor(readonly reason: string, detail = reason) {
    super(detail)
  }
}

const unexpected = (detail: string) => new RatesFailure('an unexpected answer', detail)

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const shown = (value: unknown): string => String(value).slice(0, 40)

/** A real calendar date, YYYY-MM-DD. */
function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY.test(value)) {
    return false
  }

  const time = Date.parse(`${value}T00:00:00Z`)

  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value)
}

/** Whether `t` is less than `span` before `now`; a time after `now` (the clock went back) is not. */
const within = (now: number, t: number, span: number): boolean => now >= t && now - t < span

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failureOf(error: unknown): RatesFailure {
  if (error instanceof RatesFailure) {
    return error
  }

  const name = isRecord(error) ? error.name : undefined

  if (name === 'TimeoutError' || name === 'AbortError') {
    return new RatesFailure('no answer in 10 seconds')
  }

  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ''

  return new RatesFailure('no connection', `${messageOf(error)}${cause}`)
}

function recordOf(raw: unknown): { date: string; quote: string; rate: number } {
  const { date, base, quote, rate } = isRecord(raw) ? raw : {}

  if (base !== 'EUR') {
    throw unexpected(`a rate based on ${shown(base)}`)
  }

  if (!isDay(date)) {
    throw unexpected(`a rate dated ${shown(date)}`)
  }

  if (typeof quote !== 'string' || !CODE.test(quote)) {
    throw unexpected(`a rate for ${shown(quote)}`)
  }

  if (!isPositive(rate)) {
    throw unexpected(`a rate of ${shown(rate)} for ${quote}`)
  }

  if (quote === 'EUR' && rate !== 1) {
    throw unexpected(`a euro worth ${rate} euros`)
  }

  return { date, quote, rate }
}

/**
 * The rates in Frankfurter's answer, checked record by record; throws when any record is not as
 * documented. They are the latest date's, EUR itself 1.
 */
export function ratesFromAnswer(body: unknown, fetchedAt: number): CalcRates {
  if (!Array.isArray(body) || body.length === 0) {
    throw unexpected('not a list of rates')
  }

  const records = body.map(recordOf)
  const date = records.reduce((latest, record) => (record.date > latest ? record.date : latest), '')
  const rates: Record<string, number> = { EUR: 1 }

  for (const record of records) {
    // A currency the ECB no longer publishes would answer with its last rate, however old.
    if (record.date !== date || record.quote === 'EUR') {
      continue
    }

    if (Object.hasOwn(rates, record.quote) && rates[record.quote] !== record.rate) {
      throw unexpected(`two rates for ${record.quote}`)
    }

    rates[record.quote] = record.rate
  }

  if (Object.keys(rates).length < 2) {
    throw unexpected('no currency but the euro')
  }

  return { base: 'EUR', date, fetchedAt, rates: Object.fromEntries(Object.entries(rates).sort(([a], [b]) => (a < b ? -1 : 1))) }
}

/** Saved rates, checked as strictly as fetched ones; null when they are not whole. */
function savedRates(raw: unknown): CalcRates | null {
  if (!isRecord(raw) || raw.base !== 'EUR' || !isDay(raw.date) || !isTime(raw.fetchedAt) || !isRecord(raw.rates)) {
    return null
  }

  const entries = Object.entries(raw.rates)

  if (raw.rates.EUR !== 1 || entries.length < 2 || !entries.every((entry): entry is [string, number] => CODE.test(entry[0]) && isPositive(entry[1]))) {
    return null
  }

  return { base: 'EUR', date: raw.date, fetchedAt: raw.fetchedAt, rates: Object.fromEntries(entries) }
}

function savedOf(raw: unknown): Saved {
  if (!isRecord(raw) || raw.v !== 1) {
    return EMPTY
  }

  const failure: Record<string, unknown> = isRecord(raw.failure) ? raw.failure : {}
  const { at } = failure
  const error = typeof failure.error === 'string' && failure.error ? failure.error.slice(0, 200) : 'the last fetch failed'

  return { rates: savedRates(raw.rates), failure: isTime(at) ? { at, error } : null }
}

export class RatesService {
  private readonly file: string
  private readonly prefs: () => Partial<CalcPrefs> | undefined
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly onChange?: () => void
  private saved: Promise<Saved> | null = null
  private inflight: Promise<void> | null = null

  constructor({ file, prefs, fetch: fetchImpl = fetch, now = Date.now, onChange }: RatesServiceOptions) {
    this.file = file
    this.prefs = prefs
    this.fetch = fetchImpl
    this.now = now
    this.onChange = onChange
  }

  /** The rates and their status (see the top of this file); never throws. */
  async get({ cached = false, refresh = false }: RatesOptions = {}): Promise<CalcRatesState> {
    try {
      const on = this.prefs()?.fetchRates !== false

      if (on && !cached && (refresh || this.due(await this.load()))) {
        await this.fetchShared()
      }

      return this.stateOf(await this.load(), on)
    } catch (error) {
      log('calc', `cannot answer with the currency rates: ${messageOf(error)}`)

      return { rates: null, status: 'none', error: 'the saved rates cannot be read' }
    }
  }

  /** No rates or old ones, and no fetch failed within the hour. */
  private due(saved: Saved): boolean {
    const now = this.now()

    if (saved.failure && within(now, saved.failure.at, CALC_RATES_RETRY_MS)) {
      return false
    }

    return !saved.rates || !within(now, saved.rates.fetchedAt, CALC_RATES_MAX_AGE_MS)
  }

  private stateOf({ rates, failure }: Saved, on: boolean): CalcRatesState {
    if (!on) {
      return { rates, status: 'off' }
    }

    if (failure) {
      return { rates, status: rates ? 'offline' : 'none', error: failure.error }
    }

    if (!rates) {
      return { rates: null, status: 'none' }
    }

    return { rates, status: within(this.now(), rates.fetchedAt, CALC_RATES_MAX_AGE_MS) ? 'fresh' : 'cached' }
  }

  private load(): Promise<Saved> {
    this.saved ??= this.read()

    return this.saved
  }

  private async read(): Promise<Saved> {
    try {
      return savedOf(JSON.parse(await fs.readFile(this.file, 'utf8')))
    } catch {
      return EMPTY
    }
  }

  /** Fetch, or wait for the fetch already under way. */
  private fetchShared(): Promise<void> {
    this.inflight ??= this.attempt().finally(() => {
      this.inflight = null
    })

    return this.inflight
  }

  private async attempt(): Promise<void> {
    const before = await this.load()
    const at = this.now()
    let next: Saved

    try {
      next = { rates: await this.request(), failure: null }
    } catch (error) {
      const failure = failureOf(error)
      log('calc', `cannot fetch the currency rates: ${failure.message}`)
      next = { rates: before.rates, failure: { at, error: failure.reason } }
    }

    this.saved = Promise.resolve(next)

    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      await writeTextAtomic(this.file, `${JSON.stringify({ v: 1, ...next }, null, 2)}\n`)
    } catch (error) {
      log('calc', `cannot save the currency rates: ${messageOf(error)}`)
    }

    this.onChange?.()
  }

  private async request(): Promise<CalcRates> {
    const response = await this.fetch(CALC_RATES_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })

    if (!response.ok) {
      throw new RatesFailure(`the server answered ${response.status}`)
    }

    const text = await response.text()

    if (text.length > ANSWER_MAX) {
      throw unexpected(`${text.length} characters long`)
    }

    let body: unknown

    try {
      body = JSON.parse(text)
    } catch {
      throw unexpected('not JSON')
    }

    return ratesFromAnswer(body, this.now())
  }
}
