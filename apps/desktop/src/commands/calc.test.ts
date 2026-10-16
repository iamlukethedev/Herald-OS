import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CALC_HISTORY_MAX, type CalcHistoryEntry } from '../../shared/calc.ts'
import type { CalcContext, EvalResult, LineResult } from '../features/calc/engine/index.ts'
import type { FunctionSummary } from '../features/calc/graph/sampling.ts'
import { matchIntent } from '../lib/voice/intents.ts'
import { COMMAND_ID, type CommandContext, defineCommands, resetCommands, validateArgs } from '../store/os-commands.ts'
import { calcCommands } from './calc.ts'
import { commandGroups } from './index.ts'

// The stores read the preload bridge and the viewport when they load; tests run without a DOM.
const edges = vi.hoisted(() => {
  const entries: CalcHistoryEntry[] = []
  const calc = { history: vi.fn(async (limit?: number) => entries.slice(0, limit)), clearHistory: vi.fn(async () => undefined), addHistory: vi.fn(async () => undefined) }

  Object.assign(globalThis, {
    window: { innerWidth: 1440, innerHeight: 900, heraldOS: { calc, prefs: { set: async (patch: Record<string, unknown>) => patch } } },
    document: { documentElement: { dataset: {}, style: { setProperty: () => undefined, removeProperty: () => undefined } } }
  })

  return { entries, calc }
})

const engine = vi.hoisted(() => ({ loadEngine: vi.fn(), evaluate: vi.fn(), evaluateDocument: vi.fn(), convert: vi.fn(), compileFunction: vi.fn(), formatValue: vi.fn() }))
const graph = vi.hoisted(() => ({ summarizeFunction: vi.fn(), parseSheetPlot: vi.fn(), sampleFunction: vi.fn() }))
const app = vi.hoisted(() => ({
  openCalc: vi.fn(),
  recordCalc: vi.fn(),
  clearHistory: vi.fn(),
  readSheetSeries: vi.fn(),
  calcContext: vi.fn(),
  searchHistory: vi.fn((entries: readonly CalcHistoryEntry[], _query: string, limit = 50) => entries.slice(0, limit))
}))

vi.mock('../features/calc/engine/index.ts', () => engine)
vi.mock('../features/calc/graph/sampling.ts', () => graph)
vi.mock('../features/calc/graph/sheets-source.ts', () => ({ readSheetSeries: app.readSheetSeries }))
vi.mock('../features/calc/open.ts', () => ({ openCalc: app.openCalc }))
vi.mock('../features/calc/context.ts', () => ({ calcContext: app.calcContext, systemZone: () => 'Australia/Sydney', mentionsCurrency: () => false }))
vi.mock('../features/calc/history/search.ts', () => ({ searchHistory: app.searchHistory }))
vi.mock('../features/calc/history/store.ts', async () => {
  const { atom } = await import('nanostores')

  return { $calcHistory: atom([]), loadHistory: async () => undefined, recordCalc: app.recordCalc, clearHistory: app.clearHistory }
})
vi.mock('../features/calc/engine/vocabulary.ts', () => ({ UNIT_WORDS: new Set(['km', 'miles', 'litre', 'cups']), LENGTH_WORDS: new Set(['km', 'miles']), CURRENCY_WORDS: new Set(['dollars', 'euros']), MATH_WORDS: new Set() }))
vi.mock('../features/calc/engine/zones.ts', () => ({ zoneNames: () => ['tokyo', 'new york'], findZone: () => null, evaluateZoneLine: () => null }))

const AGENT: CommandContext = { source: 'agent' }
const VOICE: CommandContext = { source: 'voice' }
const UI: CommandContext = { source: 'ui' }
const CONTEXT: CalcContext = { locale: 'en-AU', now: Date.UTC(2026, 9, 16), zone: 'Australia/Sydney', rates: { base: 'EUR', date: '2026-10-15', fetchedAt: 0, rates: { EUR: 1, USD: 1.08, BRL: 6.1 } } }

function command(id: string) {
  const found = calcCommands.find(entry => entry.id === id)

  if (!found) {
    throw new Error(`no command ${id}`)
  }

  return found
}

const run = async (id: string, args: Record<string, unknown>, context: CommandContext = AGENT) => command(id).run(args, context)

const answer = (input: string, display: string, exact: string, extra: Partial<EvalResult> = {}): EvalResult => ({ ok: true, input, value: { kind: 'number', exact, number: Number(exact) }, display, spoken: display, steps: [`${input} = ${display}`], ...extra })

const curve = (patch: Partial<FunctionSummary> = {}): FunctionSummary => ({ xMin: -10, xMax: 10, yMin: -4, yMax: 96, zeros: [-2, 2], extrema: [{ x: 0, y: -4, kind: 'min' }], asymptotes: [], gaps: [], samples: [[0, -4]], ...patch })

beforeEach(() => {
  vi.clearAllMocks()
  app.calcContext.mockResolvedValue(CONTEXT)
  graph.parseSheetPlot.mockReturnValue(null)
  edges.entries.length = 0
})

describe('the calc commands', () => {
  it('use ids the registry accepts, read or act, and no argument declares choices', () => {
    expect(Object.fromEntries(calcCommands.map(entry => [entry.id, entry.tier]))).toEqual({ 'calc.eval': 'read', 'calc.convert': 'read', 'calc.plot': 'act', 'calc.open': 'act', 'calc.history': 'read' })

    for (const entry of calcCommands) {
      expect(COMMAND_ID.test(entry.id), entry.id).toBe(true)

      for (const arg of entry.args) {
        expect(arg.enum, `${entry.id} ${arg.name}`).toBeUndefined()
      }
    }
  })

  it('check their arguments the way the registry does', () => {
    expect(validateArgs(command('calc.eval'), {})).toEqual({ error: expect.stringContaining('calc.eval needs "text"') })
    expect(validateArgs(command('calc.eval'), { expression: '2 + 2' })).toEqual({ args: { text: '2 + 2' } })
    expect(validateArgs(command('calc.convert'), { value: 5, from: 'km' })).toEqual({ error: expect.stringContaining('needs "to"') })
    expect(validateArgs(command('calc.convert'), { value: 5, from: 'km', to: 'mi' })).toEqual({ args: { value: '5', from: 'km', to: 'mi' } })
    expect(validateArgs(command('calc.plot'), { expression: 'x^2', from: '-5', show: 'false' })).toEqual({ args: { expression: 'x^2', from: -5, show: false } })
    expect(validateArgs(command('calc.history'), { limit: 'ten' })).toEqual({ error: expect.stringContaining('"limit" must be a number') })
    // Nothing is filled in that was not given: "open" means the window as it was.
    expect(validateArgs(command('calc.open'), {})).toEqual({ args: {} })
    expect(validateArgs(command('calc.history'), {})).toEqual({ args: {} })
  })

  it('work a sum out with its working and record it once', async () => {
    engine.evaluate.mockResolvedValue(answer('20% of 84.50', '16.90', '16.9', { steps: ['20% of 84.50 = 0.2 × 84.50', '= 16.90'] }))
    const result = await run('calc.eval', { text: '20% of 84.50' })

    expect(engine.evaluate).toHaveBeenCalledWith('20% of 84.50', CONTEXT)
    expect(result).toEqual({
      ok: true,
      summary: '20% of 84.50 = 16.90',
      spoken: '20% of 84.50 is 16.90',
      data: { input: '20% of 84.50', display: '16.90', value: '16.9', kind: 'number', steps: ['20% of 84.50 = 0.2 × 84.50', '= 16.90'] }
    })
    expect(app.recordCalc).toHaveBeenCalledTimes(1)
    expect(app.recordCalc).toHaveBeenCalledWith({ input: '20% of 84.50', result: '16.90', source: 'hermes', context: 'Hermes' })
  })

  it("say which day's rates a currency used", async () => {
    engine.evaluate.mockResolvedValue(answer('100 USD in BRL', 'R$564.81', '564.814814814814814815', { value: { kind: 'currency', exact: '564.814814814814814815', number: 564.81, unit: 'BRL', fraction: '15250/27' }, spoken: '564.81 Brazilian reais', usesRates: true }))
    const result = await run('calc.eval', { text: '100 USD in BRL' })

    expect(result.summary).toBe('100 USD in BRL = R$564.81 (ECB reference rates of 2026-10-15)')
    expect(result.spoken).toBe('100 USD is 564.81 Brazilian reais')
    expect(result.data).toMatchObject({ kind: 'currency', unit: 'BRL', fraction: '15250/27', ratesDate: '2026-10-15' })
  })

  it('give every line of a note, and the last value as the answer', async () => {
    const lines: LineResult[] = [
      { index: 0, kind: 'value', source: 'budget = 1,200', name: 'budget', display: '1,200' },
      { index: 1, kind: 'blank', source: '' },
      { index: 2, kind: 'value', source: 'budget * 12', display: '14,400' },
      { index: 3, kind: 'error', source: '5 kg + 2 m', error: "A mass and a length don't add up" }
    ]
    engine.evaluate.mockResolvedValue(answer('budget = 1,200\n\nbudget * 12\n5 kg + 2 m', '14,400', '14400', { lines }))
    const result = await run('calc.eval', { text: 'budget = 1,200\n\nbudget * 12\n5 kg + 2 m' })

    expect(result.summary).toBe('budget * 12 = 14,400; 1 line has no answer')
    expect(result.spoken).toBe('budget times 12 is 14,400')
    expect(result.data?.lines).toEqual([
      { index: 0, source: 'budget = 1,200', display: '1,200' },
      { index: 2, source: 'budget * 12', display: '14,400' },
      { index: 3, source: '5 kg + 2 m', error: "A mass and a length don't add up" }
    ])
  })

  it('fail with the engine\'s words, so voice hands the question to Hermes, and record nothing', async () => {
    engine.evaluate.mockResolvedValue({ ok: false, input: 'banana + 2', steps: [], error: 'Herald Calc does not know "banana"' })
    const result = await run('calc.eval', { text: 'banana + 2' }, VOICE)

    expect(result).toMatchObject({ ok: false, error: 'Herald Calc does not know "banana"', summary: 'Herald Calc does not know "banana"' })
    expect(app.recordCalc).not.toHaveBeenCalled()
  })

  it('keep where a calculation came from in the history', async () => {
    engine.evaluate.mockResolvedValue(answer('2 + 2', '4', '4'))

    for (const source of ['voice', 'agent', 'palette', 'cli'] as const) {
      await run('calc.eval', { text: '2 + 2' }, { source })
    }

    expect(app.recordCalc.mock.calls.map(([entry]) => [entry.source, entry.context])).toEqual([
      ['voice', 'Voice'],
      ['hermes', 'Hermes'],
      ['command', ''],
      ['command', '']
    ])
  })

  it('read spoken math the English way, in the region where it can, and typed math in the locale', async () => {
    engine.evaluate.mockResolvedValue(answer('1.5 * 4', '6', '6'))

    for (const locale of ['de-DE', 'fr-CA', 'en-AU', 'de-CH']) {
      app.calcContext.mockResolvedValue({ ...CONTEXT, locale })
      await run('calc.eval', { text: '1.5 * 4' }, VOICE)
    }

    await run('calc.eval', { text: '1,5 * 4' }, AGENT)

    expect(engine.evaluate.mock.calls.map(([, context]) => context.locale)).toEqual(['en-US', 'en-CA', 'en-AU', 'de-CH', 'de-CH'])
  })

  it('say the answer in words fit to speak', async () => {
    const spoken = async (input: string, value: string) => {
      engine.evaluate.mockResolvedValue(answer(input, value, value))

      return (await run('calc.eval', { text: input }, VOICE)).spoken
    }

    const time = async (input: string, value: string) => {
      engine.evaluate.mockResolvedValue(answer(input, value, '2026-10-16T10:00:00+09:00', { value: { kind: 'time', exact: '2026-10-16T10:00:00+09:00', number: 0, zone: 'Asia/Tokyo' }, spoken: value }))

      return (await run('calc.eval', { text: input }, VOICE)).spoken
    }

    expect(await spoken('2 * 3', '6')).toBe('2 times 3 is 6')
    expect(await spoken('sqrt(16) + 2^10', '1028')).toBe('the square root of 16 plus 2 to the power of 10 is 1028')
    expect(await spoken('5^2 - 10 / 4', '22.5')).toBe('5 squared minus 10 divided by 4 is 22.5')
    expect(await spoken('days until december 25', '70 days')).toBe('70 days until december 25')
    expect(await time('time in tokyo', '10:00 am in Tokyo')).toBe("It's 10:00 am in Tokyo")
    expect(await time('time in tokyo', '10:00 am')).toBe("It's 10:00 am in tokyo")
    expect(await time('9am sydney in new york', '6:00 pm in New York')).toBe("That's 6:00 pm in New York")
  })

  it('convert an amount with the same answer', async () => {
    engine.convert.mockResolvedValue(answer('5 km in miles', '3.11 mi', '3.10685596', { value: { kind: 'unit', exact: '3.10685596', number: 3.10685596, unit: 'mi' }, spoken: '3.11 miles' }))
    const result = await run('calc.convert', { value: '5', from: 'km', to: 'miles' }, UI)

    expect(engine.convert).toHaveBeenCalledWith('5', 'km', 'miles', CONTEXT)
    expect(app.calcContext).toHaveBeenCalledWith('5 km in miles')
    expect(result).toMatchObject({ ok: true, summary: '5 km in miles = 3.11 mi', spoken: '5 km is 3.11 miles', data: { kind: 'unit', unit: 'mi', value: '3.10685596' } })
    expect(app.recordCalc).toHaveBeenCalledWith({ input: '5 km in miles', result: '3.11 mi', source: 'command', context: '' })
  })
})

describe('calc.plot', () => {
  const square = (x: number) => x * x - 4

  it('needs a function or a sheet, and a range that runs forwards', async () => {
    expect(await run('calc.plot', {})).toMatchObject({ ok: false, error: expect.stringContaining('needs a function of x') })
    expect(await run('calc.plot', { expression: ' ; ' })).toMatchObject({ ok: false })
    expect(await run('calc.plot', { workbook: 'Budget.xlsx' })).toMatchObject({ ok: false, error: expect.stringContaining('"workbook" and its "range"') })
    expect(await run('calc.plot', { expression: 'x', from: 5, to: 5 })).toMatchObject({ ok: false, error: 'calc.plot: "from" must be less than "to"' })
    expect(app.openCalc).not.toHaveBeenCalled()
  })

  it('says what a function does and shows the graph', async () => {
    engine.compileFunction.mockResolvedValue(square)
    graph.summarizeFunction.mockReturnValue(curve())
    const result = await run('calc.plot', { expression: 'x^2 - 4' })

    expect(engine.compileFunction).toHaveBeenCalledWith('x^2 - 4', { variable: 'x' })
    expect(graph.summarizeFunction).toHaveBeenCalledWith(square, -10, 10)
    expect(result.summary).toBe('x^2 - 4, x from -10 to 10: y runs from -4 to 96; it crosses zero at x = -2 and 2; a local minimum at (0, -4). Showing it in Herald Calc')
    expect(result.data).toEqual({ functions: [{ expression: 'x^2 - 4', ...curve() }], series: [], shown: true })
    expect(app.openCalc).toHaveBeenCalledWith({ view: 'graph', plot: { entries: ['x^2 - 4'], xMin: -10, xMax: 10 } })
  })

  it('answers without a window when show is false, over the range asked for', async () => {
    engine.compileFunction.mockResolvedValue(square)
    graph.summarizeFunction.mockReturnValue(curve({ xMin: 0.5, xMax: 4, yMin: 0.25, yMax: 2, zeros: [], extrema: [], asymptotes: [0] }))
    const result = await run('calc.plot', { expression: 'y = 1/x', from: 0.5, to: 4, show: false })

    expect(engine.compileFunction).toHaveBeenCalledWith('1/x', { variable: 'x' })
    expect(graph.summarizeFunction).toHaveBeenCalledWith(square, 0.5, 4)
    expect(result.summary).toBe('y = 1/x, x from 0.5 to 4: y runs from 0.25 to 2; it never crosses zero; a vertical asymptote at x = 0')
    expect(result.data).toMatchObject({ shown: false })
    expect(app.openCalc).not.toHaveBeenCalled()
  })

  it('reads several functions, each with its own variable', async () => {
    engine.compileFunction.mockResolvedValue(square)
    graph.summarizeFunction.mockReturnValue(curve())
    await run('calc.plot', { expression: 'sin(x) * x; f(t) = t^2\nplot cos(x)', show: false })

    expect(engine.compileFunction.mock.calls).toEqual([
      ['sin(x) * x', { variable: 'x' }],
      ['t^2', { variable: 't' }],
      ['cos(x)', { variable: 'x' }]
    ])
  })

  it("passes on the engine's words when a function does not read", async () => {
    engine.compileFunction.mockRejectedValue(new Error('"banana" is not a function of x'))

    expect(await run('calc.plot', { expression: 'banana' })).toMatchObject({ ok: false, error: '"banana" is not a function of x' })
    expect(app.openCalc).not.toHaveBeenCalled()
  })

  it("gives a sheet's numbers and shows them, fitted to the points", async () => {
    const series = { label: 'Budget.xlsx · column B', points: [[1, 1200], [2, 80.5], [3, 300]] as Array<[number, number]> }
    app.readSheetSeries.mockResolvedValue(series)
    const result = await run('calc.plot', { workbook: 'Budget.xlsx', range: 'B:B' })

    expect(app.readSheetSeries).toHaveBeenCalledWith({ workbook: 'Budget.xlsx', range: 'B:B' })
    expect(result.summary).toBe('Budget.xlsx · column B: 3 numbers from 80.5 to 1200, sum 1580.5, mean 526.833333333, first 1200, last 300. Showing it in Herald Calc')
    expect(result.data).toMatchObject({ series: [{ label: 'Budget.xlsx · column B', count: 3, min: 80.5, max: 1200, sum: 1580.5, first: 1200, last: 300 }] })
    expect(app.openCalc).toHaveBeenCalledWith({ view: 'graph', plot: { series: [series] } })
    expect(engine.compileFunction).not.toHaveBeenCalled()
  })

  it('reads a sheet named in words', async () => {
    graph.parseSheetPlot.mockImplementation((text: string) => (text === 'column C of Sales.xlsx' ? { workbook: 'Sales.xlsx', range: 'C:C' } : null))
    app.readSheetSeries.mockResolvedValue({ label: 'Sales.xlsx · column C', points: [[1, 5]] })
    const result = await run('calc.plot', { expression: 'column C of Sales.xlsx', show: false })

    expect(app.readSheetSeries).toHaveBeenCalledWith({ workbook: 'Sales.xlsx', range: 'C:C' })
    expect(result.summary).toBe('Sales.xlsx · column C: 1 number from 5 to 5, sum 5, mean 5, first 5, last 5')
  })

  it('says when a sheet cannot be read', async () => {
    app.readSheetSeries.mockRejectedValue(new Error('No workbook called Budget.xlsx is open or in your files'))

    expect(await run('calc.plot', { workbook: 'Budget.xlsx', range: 'B:B' })).toMatchObject({ ok: false, error: 'No workbook called Budget.xlsx is open or in your files' })
  })
})

describe('calc.open', () => {
  it('opens Herald Calc on what was asked for', async () => {
    expect(await run('calc.open', {}, UI)).toEqual({ ok: true, summary: 'Opened Herald Calc', spoken: 'Opening Herald Calc.' })
    expect(await run('calc.open', { keypad: 'Scientific' }, UI)).toMatchObject({ ok: true, summary: 'Opened the scientific keypad in Herald Calc' })
    expect(await run('calc.open', { view: 'history' }, UI)).toMatchObject({ ok: true, summary: 'Opened the calculation history in Herald Calc' })
    expect(await run('calc.open', { text: 'rent = 1,200' }, UI)).toMatchObject({ ok: true, summary: 'Started a new note in Herald Calc' })

    expect(app.openCalc.mock.calls).toEqual([[{}], [{ view: 'keypad', keypad: 'scientific' }], [{ view: 'history' }], [{ view: 'notes', text: 'rent = 1,200' }]])
  })

  it('refuses a view or keypad it does not have', async () => {
    expect(await run('calc.open', { view: 'sideways' }, UI)).toMatchObject({ ok: false, error: 'calc.open: "view" must be notes, keypad, graph or history' })
    expect(await run('calc.open', { keypad: 'abacus' }, UI)).toMatchObject({ ok: false, error: 'calc.open: "keypad" must be classic, scientific or programmer' })
    expect(app.openCalc).not.toHaveBeenCalled()
  })
})

describe('calc.history', () => {
  const entry = (id: string, input: string, result: string, at: number, extra: Partial<CalcHistoryEntry> = {}): CalcHistoryEntry => ({ id, input, result, at, source: 'notes', ...extra })

  it('reads the latest calculations', async () => {
    edges.entries.push(entry('c', '20% of 84.50', '16.90', Date.UTC(2026, 9, 16, 2), { source: 'hermes', context: 'Hermes' }), entry('b', 'monthly payment', '$2,104.11', Date.UTC(2026, 9, 15), { context: 'Mortgage · monthly' }), entry('a', '5 km in miles', '3.11 mi', Date.UTC(2026, 9, 14), { source: 'voice' }))
    const result = await run('calc.history', {})

    expect(edges.calc.history).toHaveBeenCalledWith(CALC_HISTORY_MAX)
    expect(app.searchHistory).toHaveBeenCalledWith(edges.entries, '', 10)
    expect(result.summary).toBe('3 calculations, newest first: 20% of 84.50 = 16.90, monthly payment = $2,104.11 and 5 km in miles = 3.11 mi')
    expect(result.items).toEqual([
      { input: '20% of 84.50', result: '16.90', at: '2026-10-16T02:00:00.000Z', source: 'hermes', context: 'Hermes' },
      { input: 'monthly payment', result: '$2,104.11', at: '2026-10-15T00:00:00.000Z', source: 'notes', context: 'Mortgage · monthly' },
      { input: '5 km in miles', result: '3.11 mi', at: '2026-10-14T00:00:00.000Z', source: 'voice', context: '' }
    ])
    expect(result.data).toEqual({ query: '', count: 3 })
  })

  it('searches by words, at most 50 at a time', async () => {
    edges.entries.push(entry('b', 'monthly payment', '$2,104.11', 1, { context: 'Mortgage · monthly' }))
    const result = await run('calc.history', { query: 'that mortgage thing', limit: 80 })

    expect(app.searchHistory).toHaveBeenCalledWith(edges.entries, 'that mortgage thing', 50)
    expect(result.summary).toBe('The best match: monthly payment = $2,104.11')

    await run('calc.history', { limit: 0 })
    expect(app.searchHistory).toHaveBeenLastCalledWith(edges.entries, '', 1)
  })

  it('reads the last one aloud', async () => {
    edges.entries.push(entry('c', '15% of 340', '51', 1))

    expect(await run('calc.history', { limit: 1 }, VOICE)).toMatchObject({ summary: 'The last calculation: 15% of 340 = 51', spoken: 'Your last calculation: 15% of 340 is 51.' })
  })

  it('says when there is nothing to find', async () => {
    expect((await run('calc.history', {})).summary).toBe('No calculations yet')
    expect((await run('calc.history', { query: 'taxes' })).summary).toBe('No calculation matches "taxes"')
  })

  it('only ever reads the history', async () => {
    await run('calc.history', { query: 'clear everything' })

    expect(command('calc.history').args.map(arg => arg.name)).toEqual(['query', 'limit'])
    expect(edges.calc.clearHistory).not.toHaveBeenCalled()
    expect(app.clearHistory).not.toHaveBeenCalled()
  })
})

describe('Herald Calc on the voice fast path', () => {
  beforeEach(() => {
    resetCommands()
    defineCommands(Object.values(commandGroups).flat())
  })

  it('opens Herald Calc by its phrases', () => {
    expect(matchIntent('open the calculator')).toMatchObject({ command: 'calc.open', args: {} })
    expect(matchIntent('open calculator')).toMatchObject({ command: 'calc.open', args: {} })
    expect(matchIntent('Hey Hermes, open Herald Calc.')).toMatchObject({ command: 'calc.open', args: {} })
    expect(matchIntent('open calc')).toMatchObject({ command: 'calc.open', args: {} })
    expect(matchIntent('show the calculator')).toMatchObject({ command: 'calc.open', args: {} })
    expect(matchIntent('open the scientific calculator')).toMatchObject({ command: 'calc.open', args: { keypad: 'scientific' } })
    expect(matchIntent('open the programmer calculator')).toMatchObject({ command: 'calc.open', args: { keypad: 'programmer' } })
    expect(matchIntent("open the programmer's calculator")).toMatchObject({ command: 'calc.open', args: { keypad: 'programmer' } })
    expect(matchIntent('open the graphing calculator')).toMatchObject({ command: 'calc.open', args: { view: 'graph' } })
    expect(matchIntent('show my calculations')).toMatchObject({ command: 'calc.open', args: { view: 'history' } })
    expect(matchIntent('what was my last calculation')).toMatchObject({ command: 'calc.history', args: { limit: 1 } })
  })

  it('answers spoken math and leaves every other phrase where it was', () => {
    expect(matchIntent('whats 15% of 340')).toMatchObject({ command: 'calc.eval', args: { text: '15% of 340' } })
    expect(matchIntent('how many miles is 10 km')).toMatchObject({ command: 'calc.eval', args: { text: '10 km in miles' } })
    expect(matchIntent('what time is it in tokyo')).toMatchObject({ command: 'calc.eval', args: { text: 'time in tokyo' } })
    expect(matchIntent('whats 15% of my rent')).toBeNull()
    expect(matchIntent('explain compound interest')).toBeNull()
    expect(matchIntent('switch to missions')).toMatchObject({ command: 'page.open' })
    expect(matchIntent('how much battery is left')).toMatchObject({ command: 'power.status' })
    expect(matchIntent('what is Hermes doing')).toMatchObject({ command: 'room.status' })
    expect(matchIntent('what is the pet doing')).toMatchObject({ command: 'pet.status' })
    expect(matchIntent('new spreadsheet')).toMatchObject({ command: 'sheets.new' })
    expect(matchIntent('open sheets')).toMatchObject({ command: 'sheets.open' })
  })
})
