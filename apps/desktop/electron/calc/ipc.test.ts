import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CalcNote } from '../../shared/calc.ts'
import { IPC } from '../../shared/ipc.ts'

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const electron = vi.hoisted(() => ({ windows: [] as unknown[], handle: vi.fn<(channel: string, listener: Listener) => void>() }))

vi.mock('electron', () => ({ ipcMain: { handle: electron.handle }, BrowserWindow: { getAllWindows: () => electron.windows } }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))

const { registerCalcIpc } = await import('./ipc.ts')

const NOON = Date.UTC(2026, 9, 15, 12, 0)
const ANSWER = [
  { date: '2026-10-15', base: 'EUR', quote: 'EUR', rate: 1 },
  { date: '2026-10-15', base: 'EUR', quote: 'USD', rate: 1.1208 }
]

const folders: string[] = []

afterEach(() => {
  for (const folder of folders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

function fakeWindow(destroyed = false) {
  const heard: unknown[] = []
  const win = { isDestroyed: () => destroyed, webContents: { isDestroyed: () => destroyed, send: (channel: string, what: unknown) => void heard.push([channel, what]) } }

  return { win, heard }
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calc-ipc-'))
  folders.push(root)
  const one = fakeWindow()
  const two = fakeWindow()
  const closed = fakeWindow(true)
  electron.windows = [one.win, two.win, closed.win]
  electron.handle.mockClear()
  const prefs = { fetchRates: true }
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(ANSWER)))
  registerCalcIpc({ dir: path.join(root, 'calc'), prefs: () => prefs, fetch, now: () => NOON })
  const handlers = new Map(electron.handle.mock.calls)

  const invoke = (channel: string, ...args: unknown[]): unknown => {
    const listener = handlers.get(channel)

    if (!listener) {
      throw new Error(`nothing handles ${channel}`)
    }

    return listener({} as IpcMainInvokeEvent, ...args)
  }

  return { root, handlers, invoke, prefs, fetch, one, two, closed }
}

const changed = (what: string) => [IPC.calcChanged, what]

describe("Herald Calc's IPC", () => {
  it('handles every Calc channel a window invokes', () => {
    const { handlers } = setup()
    const channels = Object.entries(IPC)
      .filter(([name]) => name.startsWith('calc') && name !== 'calcChanged')
      .map(([, channel]) => channel)

    expect([...handlers.keys()].sort()).toEqual(channels.sort())
  })

  it('saves, lists, reads and deletes notes, and tells every open window each time', async () => {
    const { invoke, one, two, closed } = setup()
    const note = (await invoke(IPC.calcNoteSave, { text: '# Rent\n1200 / 2' })) as CalcNote

    expect(one.heard).toEqual([changed('notes')])
    expect(two.heard).toEqual([changed('notes')])
    expect(closed.heard).toEqual([])
    expect(await invoke(IPC.calcNotesList)).toEqual([{ id: note.id, title: 'Rent', preview: '1200 / 2', createdAt: NOON, updatedAt: NOON }])
    expect(await invoke(IPC.calcNoteRead, note.id)).toEqual(note)

    await invoke(IPC.calcNoteDelete, note.id)
    expect(two.heard).toEqual([changed('notes'), changed('notes')])
    expect(await invoke(IPC.calcNoteRead, note.id)).toBeNull()
  })

  it('checks what a window sends before anything reaches the disk', async () => {
    const { invoke, root, one } = setup()

    expect(await invoke(IPC.calcNoteRead, '../../prefs')).toBeNull()
    await expect(invoke(IPC.calcNoteSave, 'just text')).rejects.toThrow('A note needs its text.')
    await expect(invoke(IPC.calcNoteSave, { id: '../escape', text: 'x' })).rejects.toThrow('That is not a note id.')
    await invoke(IPC.calcNoteDelete, { id: 'escape' })
    await invoke(IPC.calcHistoryAdd, 'not a list')
    expect(await invoke(IPC.calcHistory, 'all')).toEqual([])

    expect(one.heard).toEqual([])
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('takes only true for the cache or a refresh, and tells every window after each fetch', async () => {
    const { invoke, prefs, fetch, one } = setup()

    expect(await invoke(IPC.calcRates, { cached: true })).toEqual({ rates: null, status: 'none' })
    expect(fetch).not.toHaveBeenCalled()

    expect(await invoke(IPC.calcRates, { cached: 'yes' })).toMatchObject({ status: 'fresh', rates: { date: '2026-10-15', rates: { EUR: 1, USD: 1.1208 } } })
    expect(await invoke(IPC.calcRates, { refresh: 1 })).toMatchObject({ status: 'fresh' })
    expect(await invoke(IPC.calcRates, 'refresh')).toMatchObject({ status: 'fresh' })
    expect(fetch).toHaveBeenCalledTimes(1)

    expect(await invoke(IPC.calcRates, { refresh: true })).toMatchObject({ status: 'fresh' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(one.heard).toEqual([changed('rates'), changed('rates')])

    prefs.fetchRates = false
    expect(await invoke(IPC.calcRates, { refresh: true })).toMatchObject({ status: 'off', rates: { rates: { USD: 1.1208 } } })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('adds to and clears the history, and tells every window', async () => {
    const { invoke, one } = setup()

    await invoke(IPC.calcHistoryAdd, [{ input: '2 + 2', result: '4', source: 'keypad' }])
    expect(await invoke(IPC.calcHistory, 10)).toEqual([{ id: expect.any(String), at: NOON, input: '2 + 2', result: '4', source: 'keypad' }])

    await invoke(IPC.calcHistoryClear)
    expect(await invoke(IPC.calcHistory)).toEqual([])
    expect(one.heard).toEqual([changed('history'), changed('history')])
  })
})
