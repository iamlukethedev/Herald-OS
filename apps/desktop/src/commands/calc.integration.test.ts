import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalcRatesState } from '../../shared/calc.ts'
import { matchIntent } from '../lib/voice/intents.ts'
import { type CommandContext, defineCommands, resetCommands, runCommand } from '../store/os-commands.ts'
import { calcCommands } from './calc.ts'

// The calc commands with Herald Calc's real engine, graph helpers, vocabulary and places; only the
// preload bridge (the rates, the history) and the window are stand-ins.
const edges = vi.hoisted(() => {
  const rates: CalcRatesState = { rates: { base: 'EUR', date: '2026-10-15', fetchedAt: 0, rates: { EUR: 1, USD: 1.1, BRL: 6 } }, status: 'cached' }
  const calc = {
    rates: async () => rates,
    history: async () => [],
    addHistory: async () => undefined,
    clearHistory: async () => undefined,
    listNotes: async () => [],
    onChanged: () => () => undefined
  }

  Object.assign(globalThis, { window: { innerWidth: 1440, innerHeight: 900, heraldOS: { calc } } })

  return { opened: [] as unknown[] }
})

vi.mock('../features/calc/open.ts', () => ({ openCalc: (request: unknown) => void edges.opened.push(request) }))

const AGENT: CommandContext = { source: 'agent' }
const VOICE: CommandContext = { source: 'voice' }

const value = async (text: string, context: CommandContext = AGENT) => {
  const result = await runCommand('calc.eval', { text }, context)

  expect(result.ok, result.error).toBe(true)

  return result
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-16T01:00:00Z'))
})

afterAll(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  resetCommands()
  defineCommands(calcCommands)
  edges.opened.length = 0
})

describe('Herald Calc commands with the real engine', () => {
  it('works exactly where floats do not', async () => {
    expect((await value('0.1 + 0.2')).data?.value).toBe('0.3')
    expect((await value('2^100')).data?.value).toBe('1267650600228229401496703205376')
  })

  it('gives a percentage with its working', async () => {
    const result = await value('20% of 84.50')

    expect(Number(result.data?.value)).toBe(16.9)
    expect(result.data?.steps).toEqual(expect.arrayContaining([expect.any(String)]))
    expect(result.summary).toMatch(/^20% of 84\.50 = /)
  })

  it('converts units and currencies, naming the rates day', async () => {
    const miles = await value('5 km in miles')

    expect(miles.data?.kind).toBe('unit')
    expect(Number(miles.data?.value)).toBeCloseTo(3.106856, 5)

    const reais = await value('100 USD in BRL')

    expect(reais.data).toMatchObject({ kind: 'currency', unit: 'BRL', ratesDate: '2026-10-15' })
    expect(Number(reais.data?.value)).toBeCloseTo(545.4545, 3)
    expect(reais.summary).toContain('ECB reference rates of 2026-10-15')

    const converted = await runCommand('calc.convert', { value: '5', from: 'km', to: 'mi' }, AGENT)

    expect(Number(converted.data?.value)).toBeCloseTo(3.106856, 5)
  })

  it('converts a time of day from the place it is given, for Hermes and the command line', async () => {
    const london = await runCommand('calc.convert', { value: '9am', from: 'Tokyo', to: 'London' }, AGENT)

    expect(london.ok, london.error).toBe(true)
    expect(london.data).toMatchObject({ kind: 'time', zone: 'Europe/London' })
    expect(london.summary).toMatch(/^9am Tokyo in London = 1:00 AM/)
    expect((await runCommand('calc.convert', { value: '9am Sydney', from: 'Tokyo', to: 'London' }, AGENT)).summary).toMatch(/^9am Sydney in London = 11:00 PM/)
    expect(await runCommand('calc.convert', { value: '9am', from: 'Gotham', to: 'London' }, AGENT)).toMatchObject({ ok: false, error: expect.stringContaining('Gotham') })
    expect((await runCommand('calc.convert', { value: '1/2', from: 'in', to: 'cm' }, AGENT)).data?.value).toBe('1.27')
  })

  it('reads "in" after a plain number as inches for Hermes, the command line and the voice', async () => {
    const inches = await value('12 in cm')

    expect(inches.data).toMatchObject({ kind: 'unit', unit: 'cm', value: '30.48' })
    expect(inches.summary).toBe('12 in cm = 30.48 cm')
    expect((await value('x = 12\nx in cm')).data?.value).toBe('12')
    expect((await runCommand('calc.convert', { value: '12', from: 'in', to: 'cm' }, AGENT)).data?.value).toBe('30.48')

    const spoken = matchIntent("What's 12 in cm?")

    expect(spoken).toMatchObject({ command: 'calc.eval', args: { text: '12 inches in cm' } })
    expect((await value(String(spoken?.args.text), VOICE)).spoken).toMatch(/^12 inches is 30\.48 centimet(?:re|er)s$/)

    const height = matchIntent("what's 5 foot 10 in centimetres")

    expect(height).toMatchObject({ command: 'calc.eval', args: { text: '5 foot 10 inches in centimetres' } })
    expect((await value(String(height?.args.text), VOICE)).spoken).toMatch(/^5 foot 10 inches is 177\.8 centimet(?:re|er)s$/)
  })

  it('reads several lines as a note', async () => {
    const result = await value('budget = 1200\nbudget * 12')

    expect(Number(result.data?.value)).toBe(14400)
    expect(result.data?.lines).toHaveLength(2)
  })

  it('counts days to a date', async () => {
    const result = await value('days until Dec 25')

    expect(Number(result.data?.value)).toBe(70)
  })

  it('says where a function crosses zero without opening a window', async () => {
    const result = await runCommand('calc.plot', { expression: 'x^2 - 4', show: false }, AGENT)
    const zeros = (result.data?.functions as Array<{ zeros: number[] }> | undefined)?.[0]?.zeros ?? []

    expect(result.ok, result.error).toBe(true)
    expect(zeros).toHaveLength(2)
    expect(zeros[0]).toBeCloseTo(-2, 6)
    expect(zeros[1]).toBeCloseTo(2, 6)
    expect(edges.opened).toEqual([])
  })

  it('answers spoken math from the voice grammar', async () => {
    const percent = matchIntent("What's 15% of 340?")

    expect(percent).toMatchObject({ command: 'calc.eval', args: { text: '15% of 340' } })
    expect(Number((await value(String(percent?.args.text), VOICE)).data?.value)).toBe(51)

    const miles = matchIntent('how many miles is 10 km')

    expect(miles).toMatchObject({ command: 'calc.eval', args: { text: '10 km in miles' } })
    const distance = await value(String(miles?.args.text), VOICE)

    expect(Number(distance.data?.value)).toBeCloseTo(6.213712, 5)
    expect(distance.spoken).toMatch(/^10 km is 6\.21 miles$/)
    expect((await value('3 ft 4 in in cm', VOICE)).spoken).toMatch(/^3 ft 4 in is 101\.6 /)

    const tokyo = matchIntent('what time is it in tokyo')

    expect(tokyo).toMatchObject({ command: 'calc.eval', args: { text: 'time in tokyo' } })
    const time = await value(String(tokyo?.args.text), VOICE)

    expect(time.data).toMatchObject({ kind: 'time', zone: 'Asia/Tokyo' })
    expect(time.spoken).toMatch(/^It's .+ in Tokyo$/i)
    expect(time.spoken).not.toMatch(/in Tokyo.* in Tokyo/i)
  })
})
