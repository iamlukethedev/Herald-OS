import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { CALC_HISTORY_MAX, type CalcChange, type CalcHistoryEntry, type CalcHistoryInput } from '../../../../shared/calc.ts'

type Store = typeof import('./store.ts')

const entry = (input: string, result: string, at: number): CalcHistoryEntry => ({ id: `id-${at}`, at, input, result, source: 'notes' })

/** Main's side of window.heraldOS.calc, as far as the history goes. */
function fakeCalc(initial: CalcHistoryEntry[] = []) {
  let listeners: ((what: CalcChange) => void)[] = []
  const calc = {
    entries: initial,
    history: vi.fn(async (_limit?: number): Promise<CalcHistoryEntry[]> => calc.entries),
    addHistory: vi.fn(async (_entries: CalcHistoryInput[]): Promise<void> => undefined),
    clearHistory: vi.fn(async (): Promise<void> => {
      calc.entries = []
    }),
    onChanged: vi.fn((listener: (what: CalcChange) => void) => {
      listeners.push(listener)

      return () => {
        listeners = listeners.filter(other => other !== listener)
      }
    }),
    emit: (what: CalcChange) => listeners.forEach(listener => listener(what))
  }

  return calc
}

/** A promise settled from outside, for a read still on its way. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>(done => {
    resolve = done
  })

  return { promise, resolve }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/** The batches the store sent, each as the inputs and results in it. */
const batches = (calc: ReturnType<typeof fakeCalc>) => calc.addHistory.mock.calls.map(([sent]) => sent.map(item => `${item.input} = ${item.result}`))

let calc: ReturnType<typeof fakeCalc>
let store: Store
let errors: MockInstance<typeof console.error>

beforeEach(async () => {
  calc = fakeCalc()
  vi.stubGlobal('window', { heraldOS: { calc } })
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.resetModules()
  store = await import('./store.ts')
})

afterEach(() => {
  errors.mockRestore()
  vi.unstubAllGlobals()
})

describe('loading the history', () => {
  it('reads all of it, newest first as main sends it, and says when it has', async () => {
    calc.entries = [entry('2 + 2', '4', 20), entry('1 + 1', '2', 10)]

    expect(store.$calcHistoryLoaded.get()).toBe(false)

    await store.loadHistory()

    expect(calc.history).toHaveBeenCalledWith(CALC_HISTORY_MAX)
    expect(store.$calcHistory.get()).toEqual(calc.entries)
    expect(store.$calcHistoryLoaded.get()).toBe(true)
  })

  it('follows changes from every window, subscribing once however often it loads', async () => {
    await store.loadHistory()
    await store.loadHistory()

    expect(calc.onChanged).toHaveBeenCalledTimes(1)

    calc.entries = [entry('3 × 3', '9', 30)]
    calc.emit('history')
    await settle()

    expect(store.$calcHistory.get()).toEqual(calc.entries)

    calc.emit('notes')
    calc.emit('rates')
    await settle()

    expect(calc.history).toHaveBeenCalledTimes(3)
  })

  it('reads once more after a change that came during a read, however many came', async () => {
    const first = deferred<CalcHistoryEntry[]>()
    calc.history.mockImplementationOnce(() => first.promise)
    const loading = store.loadHistory()
    await settle()

    calc.emit('history')
    calc.emit('history')
    calc.emit('history')
    calc.entries = [entry('5 + 5', '10', 50)]
    first.resolve([])
    await loading
    await settle()

    expect(calc.history).toHaveBeenCalledTimes(2)
    expect(store.$calcHistory.get()).toEqual(calc.entries)
  })

  it('keeps what it had when a read fails, says so in the log, and does not reject', async () => {
    await store.loadHistory()
    calc.entries = [entry('7 × 6', '42', 60)]
    await store.loadHistory()
    calc.history.mockRejectedValueOnce(new Error('disk gone'))

    await expect(store.loadHistory()).resolves.toBeUndefined()

    expect(store.$calcHistory.get()).toEqual([entry('7 × 6', '42', 60)])
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('[herald-os] calc.history failed: Error: disk gone'))
  })

  it('marks the history read even when the first read fails', async () => {
    calc.history.mockRejectedValueOnce(new Error('no'))
    await store.loadHistory()

    expect(store.$calcHistoryLoaded.get()).toBe(true)
    expect(store.$calcHistory.get()).toEqual([])
  })
})

describe('keeping a calculation', () => {
  it('sends the calculations of one moment in one batch, each with its time', async () => {
    store.recordCalc({ input: '20% of 84.50', result: '16.90', source: 'keypad' })
    store.recordCalc({ input: '3 × 4.50', result: '13.50', source: 'notes', context: 'Café', at: 1234 })

    expect(calc.addHistory).not.toHaveBeenCalled()

    await settle()

    expect(calc.addHistory).toHaveBeenCalledTimes(1)
    const [sent] = calc.addHistory.mock.calls[0]
    expect(sent).toEqual([
      { input: '20% of 84.50', result: '16.90', source: 'keypad', at: expect.any(Number) },
      { input: '3 × 4.50', result: '13.50', source: 'notes', context: 'Café', at: 1234 }
    ])
  })

  it('keeps nothing without a result or an input, and trims what it keeps', async () => {
    store.recordCalc({ input: '2 +', result: '', source: 'notes' })
    store.recordCalc({ input: '2 +', result: '   ', source: 'notes' })
    store.recordCalc({ input: '  ', result: '4', source: 'notes' })
    await settle()

    expect(calc.addHistory).not.toHaveBeenCalled()

    store.recordCalc({ input: '  2 + 2 ', result: ' 4 ', source: 'notes', context: '   ' })
    await settle()

    expect(calc.addHistory.mock.calls[0][0]).toEqual([{ input: '2 + 2', result: '4', source: 'notes', at: expect.any(Number) }])
  })

  it('keeps the same input and result twice in a row once, in one batch or across them', async () => {
    store.recordCalc({ input: '2 + 2', result: '4', source: 'notes' })
    store.recordCalc({ input: '2  +  2', result: '4', source: 'keypad' })
    await settle()
    store.recordCalc({ input: '2 + 2', result: '4', source: 'notes' })
    await settle()

    expect(batches(calc)).toEqual([['2 + 2 = 4']])

    store.recordCalc({ input: '2 + 3', result: '5', source: 'notes' })
    store.recordCalc({ input: '2 + 2', result: '4', source: 'notes' })
    await settle()

    expect(batches(calc)).toEqual([['2 + 2 = 4'], ['2 + 3 = 5', '2 + 2 = 4']])
  })

  it('counts the newest calculation another window kept as the one before', async () => {
    calc.entries = [entry('9 × 9', '81', 90)]
    await store.loadHistory()
    store.recordCalc({ input: '9 × 9', result: '81', source: 'voice' })
    await settle()

    expect(calc.addHistory).not.toHaveBeenCalled()
  })

  it('never throws, and a batch main refused goes to the log', async () => {
    calc.addHistory.mockRejectedValueOnce(new Error('refused'))
    store.recordCalc({ input: '1 / 3', result: '0.333', source: 'notes' })
    await settle()

    expect(errors).toHaveBeenCalledWith(expect.stringContaining('[herald-os] calc.addHistory failed: Error: refused'))

    vi.stubGlobal('window', {})

    expect(() => store.recordCalc({ input: '1 / 4', result: '0.25', source: 'notes' })).not.toThrow()

    await settle()

    expect(errors).toHaveBeenCalledWith(expect.stringContaining('[herald-os] calc.addHistory failed: TypeError'))
  })
})

describe('clearing the history', () => {
  it('forgets every calculation, after which the same one is kept again', async () => {
    calc.entries = [entry('2 + 2', '4', 20)]
    await store.loadHistory()
    store.recordCalc({ input: '6 × 7', result: '42', source: 'notes' })
    await settle()

    await store.clearHistory()

    expect(calc.clearHistory).toHaveBeenCalledTimes(1)
    expect(store.$calcHistory.get()).toEqual([])

    store.recordCalc({ input: '6 × 7', result: '42', source: 'notes' })
    await settle()

    expect(batches(calc)).toEqual([['6 × 7 = 42'], ['6 × 7 = 42']])
  })

  it('keeps the same calculation again once another window cleared the history', async () => {
    await store.loadHistory()
    store.recordCalc({ input: '6 × 7', result: '42', source: 'notes' })
    await settle()

    calc.entries = []
    calc.emit('history')
    await settle()
    store.recordCalc({ input: '6 × 7', result: '42', source: 'notes' })
    await settle()

    expect(batches(calc)).toEqual([['6 × 7 = 42'], ['6 × 7 = 42']])
  })

  it('rejects with what went wrong and keeps the list', async () => {
    calc.entries = [entry('2 + 2', '4', 20)]
    await store.loadHistory()
    calc.clearHistory.mockRejectedValueOnce(new Error('locked'))

    await expect(store.clearHistory()).rejects.toThrow('locked')

    expect(store.$calcHistory.get()).toEqual([entry('2 + 2', '4', 20)])
  })

  it('does not let a read from before the clear bring the old entries back', async () => {
    const before = deferred<CalcHistoryEntry[]>()
    calc.history.mockImplementationOnce(() => before.promise)
    const loading = store.loadHistory()

    await store.clearHistory()
    before.resolve([entry('2 + 2', '4', 20)])
    await loading

    expect(store.$calcHistory.get()).toEqual([])
  })
})
