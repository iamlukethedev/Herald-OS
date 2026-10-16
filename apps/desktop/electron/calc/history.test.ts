import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CALC_HISTORY_MAX, CALC_HISTORY_TEXT_MAX } from '../../shared/calc.ts'
import { HistoryStore } from './history.ts'

const NOON = Date.UTC(2026, 9, 15, 12, 0)

const folders: string[] = []

afterEach(() => {
  for (const folder of folders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calc-history-'))
  folders.push(root)
  const file = path.join(root, 'calc', 'history.json')
  const clock = { now: NOON }
  const onChange = vi.fn()
  const start = () => new HistoryStore({ file, now: () => clock.now, onChange })
  const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8')) as { v: number; entries: unknown[] }

  return { file, clock, onChange, store: start(), start, onDisk }
}

const keypad = (input: string, result: string, extra: Record<string, unknown> = {}) => ({ input, result, source: 'keypad', ...extra })
const shown = (entry: { input: string; result: string }) => `${entry.input} = ${entry.result}`

describe("Herald Calc's history", () => {
  it('keeps calculations newest first in calc/history.json, there after a restart', async () => {
    const { store, start, clock, onChange, onDisk } = setup()

    await store.add([keypad('2 + 2', '4')])
    clock.now += 1000
    await store.add([{ input: '20% of 84.50', result: '16.90', source: 'notes', context: 'Groceries · tip' }])

    const entries = await store.list()
    expect(entries).toEqual([
      { id: expect.stringMatching(/^[0-9a-f]{12}$/), at: NOON + 1000, input: '20% of 84.50', result: '16.90', source: 'notes', context: 'Groceries · tip' },
      { id: expect.stringMatching(/^[0-9a-f]{12}$/), at: NOON, input: '2 + 2', result: '4', source: 'keypad' }
    ])
    expect(entries[0].id).not.toBe(entries[1].id)
    expect(onDisk()).toEqual({ v: 1, entries })
    expect(await start().list()).toEqual(entries)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('takes a batch in the order its calculations were made, the last of them the newest', async () => {
    const { store } = setup()

    await store.add([keypad('1 + 1', '2'), keypad('2 + 2', '4'), keypad('3 + 3', '6')])
    expect((await store.list()).map(shown)).toEqual(['3 + 3 = 6', '2 + 2 = 4', '1 + 1 = 2'])
  })

  it('checks what a window sends: text trimmed and cut to size, entries without an input, a result or a known source dropped, at never later than now', async () => {
    const { store, onChange } = setup()

    await store.add([
      keypad(` ${'9'.repeat(CALC_HISTORY_TEXT_MAX + 50)} `, '1'),
      { input: '1 + 1', result: '2', source: 'mouse' },
      keypad('', '2'),
      keypad('3 + 3', ' '),
      { input: '4 * 4', result: 16, source: 'keypad' },
      'nonsense',
      null,
      ['5', '5'],
      keypad('6 * 6', '36', { at: 'yesterday', context: 42 }),
      keypad('7 * 7', '49', { at: NOON - 5000, context: '  ' }),
      keypad('8 * 8', '64', { at: NOON + 60_000, id: 'mine', extra: true })
    ])

    const entries = await store.list()
    expect(entries).toEqual([
      { id: expect.any(String), at: NOON, input: '8 * 8', result: '64', source: 'keypad' },
      { id: expect.any(String), at: NOON, input: '6 * 6', result: '36', source: 'keypad' },
      { id: expect.any(String), at: NOON, input: '9'.repeat(CALC_HISTORY_TEXT_MAX), result: '1', source: 'keypad' },
      { id: expect.any(String), at: NOON - 5000, input: '7 * 7', result: '49', source: 'keypad' }
    ])
    expect(entries[0].id).not.toBe('mine')

    await store.add([keypad(`${'a'.repeat(CALC_HISTORY_TEXT_MAX - 1)}😀`, 'emoji')])
    expect((await store.list(1))[0].input).toBe('a'.repeat(CALC_HISTORY_TEXT_MAX - 1))

    for (const sent of ['2 + 2', [], null, { input: '2 + 2', result: '4', source: 'keypad' }]) {
      await store.add(sent)
    }

    expect(await store.list()).toHaveLength(5)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('drops a calculation with the same input and result as the newest, kept or in the same batch', async () => {
    const { store, onChange } = setup()

    await store.add([keypad('12 * 3', '36')])
    await store.add([{ input: '12 * 3', result: '36', source: 'notes', context: 'Other note' }])
    expect(await store.list()).toHaveLength(1)
    expect(onChange).toHaveBeenCalledTimes(1)

    await store.add([keypad('5 + 5', '10'), keypad('5 + 5', '10'), keypad('12 * 3', '36'), keypad('12 * 3', '37')])
    expect((await store.list()).map(shown)).toEqual(['12 * 3 = 37', '12 * 3 = 36', '5 + 5 = 10', '12 * 3 = 36'])
  })

  it('keeps at most CALC_HISTORY_MAX entries, the oldest going first', async () => {
    const { store, clock } = setup()

    await store.add(Array.from({ length: CALC_HISTORY_MAX }, (_, index) => keypad(`${index} + 0`, `${index}`)))
    clock.now += 1000
    await store.add([keypad('1 + 1', '2'), keypad('2 + 2', '4')])

    const entries = await store.list()
    expect(entries).toHaveLength(CALC_HISTORY_MAX)
    expect(entries.slice(0, 3).map(shown)).toEqual(['2 + 2 = 4', '1 + 1 = 2', `${CALC_HISTORY_MAX - 1} + 0 = ${CALC_HISTORY_MAX - 1}`])
    expect(entries.at(-1)?.input).toBe('2 + 0')
  })

  it('lists as many as asked, all of them when the limit is not a number', async () => {
    const { store } = setup()
    await store.add(['1', '2', '3', '4', '5'].map(n => keypad(`${n} * 1`, n)))

    expect((await store.list(2)).map(entry => entry.result)).toEqual(['5', '4'])
    expect(await store.list(2.9)).toHaveLength(2)
    expect(await store.list(0)).toEqual([])
    expect(await store.list(-3)).toEqual([])

    for (const limit of [undefined, '2', null, NaN, Infinity, { limit: 2 }]) {
      expect(await store.list(limit), String(limit)).toHaveLength(5)
    }
  })

  it('is cleared by removing its file, and tells the windows when there was something to clear', async () => {
    const { store, start, file, onChange } = setup()
    await store.add([keypad('1 + 1', '2')])
    await store.clear()

    expect(fs.existsSync(file)).toBe(false)
    expect(await store.list()).toEqual([])
    expect(await start().list()).toEqual([])
    expect(onChange).toHaveBeenCalledTimes(2)

    await store.clear()
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('writes one change at a time, so adds from many windows at once all land', async () => {
    const { store, start, onDisk } = setup()

    await Promise.all(Array.from({ length: 20 }, (_, index) => store.add([keypad(`${index} * 2`, `${index * 2}`)])))

    expect(await store.list()).toHaveLength(20)
    expect(onDisk().entries).toHaveLength(20)
    expect(await start().list()).toHaveLength(20)
  })

  it('reads a damaged history.json as empty, and a tampered one keeping only its whole entries', async () => {
    const { file, start } = setup()
    fs.mkdirSync(path.dirname(file), { recursive: true })

    fs.writeFileSync(file, '{"v": 1, "entries": [')
    expect(await start().list()).toEqual([])

    const whole = { id: 'a1b2c3', at: NOON, input: '2 + 2', result: '4', source: 'voice' }
    fs.writeFileSync(file, JSON.stringify({ v: 1, entries: [whole, { ...whole, id: '../x' }, { ...whole, source: 'mouse' }, { ...whole, at: -1 }, { ...whole, input: '' }, 'x', null] }))
    expect(await start().list()).toEqual([whole])
  })
})
