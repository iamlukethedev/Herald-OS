import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CALC_RATES_MAX_AGE_MS, CALC_RATES_RETRY_MS, CALC_RATES_URL } from '../../shared/calc.ts'

vi.mock('../log.ts', () => ({ log: vi.fn() }))

const { log } = await import('../log.ts')
const { RatesService, ratesFromAnswer } = await import('./rates.ts')

const NOON = Date.UTC(2026, 9, 15, 12, 0)
const HOUR = 60 * 60_000
const DAY = '2026-10-15'
const RATES = { EUR: 1, GBP: 0.8623, JPY: 168.42, USD: 1.1208 }

/** Frankfurter's answer for one day, the euro itself included. */
const answer = (date = DAY) => [
  { date, base: 'EUR', quote: 'EUR', rate: 1 },
  { date, base: 'EUR', quote: 'USD', rate: 1.1208 },
  { date, base: 'EUR', quote: 'GBP', rate: 0.8623 },
  { date, base: 'EUR', quote: 'JPY', rate: 168.42 }
]

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const record = (patch: Record<string, unknown>) => ({ date: DAY, base: 'EUR', quote: 'USD', rate: 1.1208, ...patch })

const folders: string[] = []

afterEach(() => {
  vi.mocked(log).mockClear()

  for (const folder of folders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calc-rates-'))
  folders.push(root)
  const file = path.join(root, 'calc', 'rates.json')
  const clock = { now: NOON }
  const prefs = { fetchRates: true }
  const fetch = vi.fn<typeof globalThis.fetch>(async () => ok(answer()))
  const onChange = vi.fn()
  const start = () => new RatesService({ file, prefs: () => prefs, fetch, now: () => clock.now, onChange })
  const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>

  return { root, file, clock, prefs, fetch, onChange, start, onDisk }
}

describe('the currency rates', () => {
  it('are fetched the first time and kept in calc/rates.json', async () => {
    const { start, fetch, onChange, onDisk } = setup()
    const rates = { base: 'EUR', date: DAY, fetchedAt: NOON, rates: RATES }

    expect(await start().get()).toEqual({ rates, status: 'fresh' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onDisk()).toEqual({ v: 1, rates, failure: null })
  })

  it('answer from what was kept without fetching for 24 hours, after a restart too', async () => {
    const { start, fetch, clock } = setup()
    const service = start()
    await service.get()

    clock.now = NOON + CALC_RATES_MAX_AGE_MS - 1
    expect(await service.get()).toMatchObject({ status: 'fresh', rates: { fetchedAt: NOON } })
    expect(await start().get()).toMatchObject({ status: 'fresh', rates: { fetchedAt: NOON } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('are fetched again once they are 24 hours old', async () => {
    const { start, fetch, clock } = setup()
    const service = start()
    await service.get()

    clock.now = NOON + CALC_RATES_MAX_AGE_MS
    fetch.mockResolvedValueOnce(ok(answer('2026-10-16')))
    expect(await service.get()).toMatchObject({ status: 'fresh', rates: { date: '2026-10-16', fetchedAt: NOON + CALC_RATES_MAX_AGE_MS } })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('are never fetched for the cache only, and are cached once older than a day', async () => {
    const { start, fetch, clock } = setup()
    const service = start()

    expect(await service.get({ cached: true })).toEqual({ rates: null, status: 'none' })
    expect(await service.get({ cached: true, refresh: true })).toEqual({ rates: null, status: 'none' })
    expect(fetch).not.toHaveBeenCalled()

    await service.get()
    clock.now = NOON + 3 * CALC_RATES_MAX_AGE_MS
    expect(await service.get({ cached: true })).toMatchObject({ status: 'cached', rates: { date: DAY, fetchedAt: NOON } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('are never fetched with the setting off, not even to refresh, and answer off with what was kept', async () => {
    const { start, fetch, clock, prefs } = setup()
    const service = start()
    prefs.fetchRates = false

    expect(await service.get()).toEqual({ rates: null, status: 'off' })
    expect(await service.get({ refresh: true })).toEqual({ rates: null, status: 'off' })
    expect(fetch).not.toHaveBeenCalled()

    prefs.fetchRates = true
    const { rates } = await service.get()
    prefs.fetchRates = false
    clock.now = NOON + 3 * CALC_RATES_MAX_AGE_MS

    expect(await service.get()).toEqual({ rates, status: 'off' })
    expect(await service.get({ refresh: true })).toEqual({ rates, status: 'off' })
    expect(await start().get()).toEqual({ rates, status: 'off' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('answer offline with the last ones after a failed fetch, tried again only after an hour, after a restart too', async () => {
    const { start, fetch, clock, onChange, onDisk } = setup()
    const service = start()
    const { rates } = await service.get()
    const failedAt = NOON + CALC_RATES_MAX_AGE_MS

    clock.now = failedAt
    fetch.mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.frankfurter.dev') }))
    expect(await service.get()).toEqual({ rates, status: 'offline', error: 'no connection' })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('calc', 'cannot fetch the currency rates: fetch failed: getaddrinfo ENOTFOUND api.frankfurter.dev')
    expect(onDisk()).toEqual({ v: 1, rates, failure: { at: failedAt, error: 'no connection' } })
    expect(onChange).toHaveBeenCalledTimes(2)

    clock.now = failedAt + CALC_RATES_RETRY_MS - 1
    expect(await service.get()).toEqual({ rates, status: 'offline', error: 'no connection' })
    expect(await start().get()).toEqual({ rates, status: 'offline', error: 'no connection' })
    expect(await start().get({ cached: true })).toEqual({ rates, status: 'offline', error: 'no connection' })
    expect(fetch).toHaveBeenCalledTimes(2)

    clock.now = failedAt + CALC_RATES_RETRY_MS
    expect(await start().get()).toMatchObject({ status: 'fresh', rates: { fetchedAt: failedAt + CALC_RATES_RETRY_MS } })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(onDisk()).toMatchObject({ failure: null })
  })

  it('answer none after a failed fetch with nothing kept yet, and say why', async () => {
    const { start, fetch, clock } = setup()

    fetch.mockResolvedValueOnce(new Response('busy', { status: 503 }))
    expect(await start().get()).toEqual({ rates: null, status: 'none', error: 'the server answered 503' })

    clock.now += CALC_RATES_RETRY_MS
    fetch.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))
    expect(await start().get()).toEqual({ rates: null, status: 'none', error: 'no answer in 10 seconds' })
  })

  it('are refreshed at once whatever their age and the last failure, but never with the setting off', async () => {
    const { start, fetch, clock, prefs } = setup()
    const service = start()
    await service.get()

    clock.now += HOUR
    expect(await service.get({ refresh: true })).toMatchObject({ status: 'fresh', rates: { fetchedAt: NOON + HOUR } })

    fetch.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await service.get({ refresh: true })).toMatchObject({ status: 'offline', error: 'no connection' })
    expect(await service.get({ refresh: true })).toMatchObject({ status: 'fresh' })
    expect(fetch).toHaveBeenCalledTimes(4)

    prefs.fetchRates = false
    expect(await service.get({ refresh: true })).toMatchObject({ status: 'off' })
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('are fetched once for the windows that ask at the same time', async () => {
    const { start, fetch } = setup()
    let reply: (response: Response) => void = () => undefined
    fetch.mockImplementationOnce(() => new Promise<Response>(resolve => (reply = resolve)))
    const service = start()

    const asked = [service.get(), service.get(), service.get({ refresh: true }), service.get({ cached: true })]
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    reply(ok(answer()))
    const answers = await Promise.all(asked)

    expect(answers.slice(0, 3).map(state => state.status)).toEqual(['fresh', 'fresh', 'fresh'])
    expect(answers[3]).toEqual({ rates: null, status: 'none' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('are asked for with exactly the documented URL and only an Accept header: no cookies, no query, nothing about the person', async () => {
    const { start, fetch } = setup()
    await start().get()

    expect(CALC_RATES_URL).toBe('https://api.frankfurter.dev/v2/providers/ecb/rates')
    expect(fetch).toHaveBeenCalledWith(CALC_RATES_URL, { headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) })
    expect(Object.keys(fetch.mock.calls[0][1] ?? {}).sort()).toEqual(['headers', 'signal'])
  })

  it('keep the last good ones when an answer is refused, and say it was unexpected', async () => {
    const { start, fetch, clock } = setup()
    const service = start()
    const { rates } = await service.get()

    for (const reply of [ok({ rates: { USD: 1.1 } }), ok([record({ base: 'USD' })]), new Response('<!doctype html>', { status: 200 }), ok('x'.repeat(300 * 1024))]) {
      clock.now += HOUR
      fetch.mockResolvedValueOnce(reply)
      expect(await service.get({ refresh: true })).toEqual({ rates, status: 'offline', error: 'an unexpected answer' })
    }
  })

  it('read as none when rates.json is damaged or not whole, and the next fetch replaces it', async () => {
    const { start, file } = setup()
    const whole = { base: 'EUR', date: DAY, fetchedAt: NOON, rates: RATES }
    fs.mkdirSync(path.dirname(file), { recursive: true })

    for (const content of [
      '{"v": 1, "rates": {"base": "EUR"',
      JSON.stringify({ v: 2, rates: whole, failure: null }),
      JSON.stringify({ v: 1, rates: { ...whole, rates: { ...RATES, EUR: 2 } }, failure: null }),
      JSON.stringify({ v: 1, rates: { ...whole, rates: { ...RATES, usd: 1.1 } }, failure: null }),
      JSON.stringify({ v: 1, rates: { ...whole, rates: { EUR: 1 } }, failure: null }),
      JSON.stringify({ v: 1, rates: { ...whole, date: 'yesterday' }, failure: null })
    ]) {
      fs.writeFileSync(file, content)
      expect(await start().get({ cached: true }), content).toEqual({ rates: null, status: 'none' })
    }

    expect(await start().get()).toEqual({ rates: whole, status: 'fresh' })
  })

  it('never throw: a fetch that throws at once, or a folder they cannot be kept in, still gets an answer', async () => {
    const { root, clock } = setup()
    const blocker = path.join(root, 'blocker')
    fs.writeFileSync(blocker, '')
    const file = path.join(blocker, 'rates.json')
    const broken = new RatesService({
      file,
      prefs: () => undefined,
      fetch: () => {
        throw new Error('no network stack')
      },
      now: () => clock.now
    })

    expect(await broken.get()).toEqual({ rates: null, status: 'none', error: 'no connection' })

    const unkept = new RatesService({ file, prefs: () => undefined, fetch: async () => ok(answer()), now: () => clock.now })
    expect(await unkept.get()).toEqual({ rates: { base: 'EUR', date: DAY, fetchedAt: NOON, rates: RATES }, status: 'fresh' })
    expect(log).toHaveBeenCalledWith('calc', expect.stringMatching(/^cannot save the currency rates: /))
  })
})

describe("Frankfurter's answer", () => {
  it('is refused unless every record is a rate of the euro as documented', () => {
    const malformed: unknown[] = [
      null,
      {},
      'rates',
      [],
      [record({ base: 'USD' })],
      [record({ quote: 'usd' })],
      [record({ quote: 'US' })],
      [record({ quote: 'USDT' })],
      [record({ rate: 0 })],
      [record({ rate: -1.12 })],
      [record({ rate: '1.12' })],
      [record({ rate: null })],
      [record({ date: '2026-13-01' })],
      [record({ date: '2026-02-30' })],
      [record({ date: '15/10/2026' })],
      [record({ date: undefined })],
      [record({}), record({ quote: 'EUR', rate: 1.2 })],
      [record({}), record({ rate: 1.3 })],
      [record({ quote: 'EUR', rate: 1 })],
      [record({}), 'USD']
    ]

    for (const body of malformed) {
      expect(() => ratesFromAnswer(body, NOON), JSON.stringify(body)).toThrow()
    }
  })

  it("gives the latest date's rates, the euro 1 even when the answer leaves it out", () => {
    const body = [record({}), record({ quote: 'GBP', rate: 0.8623 }), record({ date: '2022-03-01', quote: 'RUB', rate: 117.3 }), record({})]

    expect(ratesFromAnswer(body, NOON)).toEqual({ base: 'EUR', date: DAY, fetchedAt: NOON, rates: { EUR: 1, GBP: 0.8623, USD: 1.1208 } })
  })
})
