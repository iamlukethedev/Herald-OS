// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalcChange, CalcNote } from '../../../../shared/calc.ts'
import type { DocumentResult, LineResult } from '../engine/types.ts'
import { recordCalc } from '../history/store.ts'
import { $notepadSignal, $notesSidebar, signalNotepad } from '../store.ts'
import { Notepad } from './Notepad.tsx'
import { WELCOME_NOTE } from './welcome.ts'

const calc = vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const notes = new Map<string, CalcNote>()
  const listeners = new Set<(what: CalcChange) => void>()
  const counters = { clock: 1000, ids: 0 }
  const bridge = {
    rates: vi.fn(async () => ({ rates: null, status: 'none' as const })),
    listNotes: vi.fn(async () => [...notes.values()].map(note => ({ id: note.id, title: note.text.split('\n')[0] || 'Untitled', preview: '', createdAt: note.createdAt, updatedAt: note.updatedAt }))),
    readNote: vi.fn(async (id: string) => notes.get(id) ?? null),
    saveNote: vi.fn(async (input: { id?: string; text: string }) => {
      const id = input.id ?? `note-${++counters.ids}`
      const note: CalcNote = { id, text: input.text, createdAt: notes.get(id)?.createdAt ?? counters.clock, updatedAt: ++counters.clock }
      notes.set(id, note)

      return note
    }),
    deleteNote: vi.fn(async (id: string) => {
      notes.delete(id)
    }),
    history: vi.fn(async () => []),
    addHistory: vi.fn(async () => undefined),
    clearHistory: vi.fn(async () => undefined),
    onChanged: vi.fn((listener: (what: CalcChange) => void) => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    })
  }
  Object.assign(window, { heraldOS: { calc: bridge } })

  return { bridge, notes, counters }
})

/** Sums of two whole numbers work out; headings, comments and functions of x are read; anything else is a gentle error. */
function fakeDocument(text: string): DocumentResult {
  const lines = text.split('\n').map((source, index): LineResult => {
    const trimmed = source.trim()
    const sum = /^(\d+) \+ (\d+)$/.exec(trimmed)
    const fn = /^(\w+) = (.*\bx\b.*)$/.exec(trimmed)

    if (!trimmed) {
      return { index, kind: 'blank', source }
    }

    if (trimmed.startsWith('#')) {
      return { index, kind: 'heading', source, label: trimmed.replace(/^#+\s*/, '') }
    }

    if (trimmed.startsWith('//')) {
      return { index, kind: 'comment', source }
    }

    if (fn) {
      return { index, kind: 'function', source, name: fn[1], plot: { name: fn[1], expression: fn[2], variable: 'x', index } }
    }

    if (sum) {
      const result = Number(sum[1]) + Number(sum[2])

      return { index, kind: 'value', source, display: String(result), value: { kind: 'number', exact: String(result), number: result }, steps: [`${sum[1]} + ${sum[2]}`, `= ${result}`], tokens: [{ from: 0, to: sum[1].length, type: 'number' }] }
    }

    return { index, kind: 'error', source, error: 'Herald cannot read this line yet' }
  })
  const values = lines.filter(line => line.kind === 'value')
  const total = values.reduce((sum, line) => sum + (line.value?.number ?? 0), 0)

  return { lines, total: null, totalDisplay: values.length ? String(total) : null, usesRates: false, functions: [] }
}

vi.mock('../engine/index.ts', () => ({ evaluateDocument: vi.fn(async (text: string) => fakeDocument(text)) }))
vi.mock('../history/store.ts', () => ({ recordCalc: vi.fn(), clearHistory: vi.fn(async () => undefined) }))
vi.mock('../graph/GraphView.tsx', () => ({ GraphView: ({ entries }: { entries: Array<{ text: string }> }) => <div data-testid="graph">{entries.map(entry => entry.text).join(' | ')}</div> }))

let host: HTMLDivElement
let root: Root

/** Let time pass in short steps with React rendering between them, so a timer an effect sets in one step fires in a later one. */
async function settle(ms = 0) {
  let left = ms

  do {
    const step = Math.min(left, 20)
    left -= step
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step)
    })
  } while (left > 0)
}

async function open(width = 900) {
  act(() => root.render(<Notepad active width={width} />))
  await settle(200)
}

const textarea = () => host.querySelector('textarea')!
const results = () => [...host.querySelectorAll('[aria-label="Results"] button')].map(button => button.textContent)
const total = () => host.querySelector('footer [aria-live]')?.textContent
const button = (name: string) => [...host.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === name || element.textContent?.trim() === name) ?? null

async function type(text: string) {
  const element = textarea()
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, text)
    element.setSelectionRange(text.length, text.length)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle(0)
}

function seed(...texts: string[]) {
  texts.forEach((text, index) => calc.notes.set(`seed-${index}`, { id: `seed-${index}`, text, createdAt: 1, updatedAt: 100 - index }))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 16, 13, 41))
  localStorage.clear()
  calc.notes.clear()
  calc.counters.ids = 0
  Object.values(calc.bridge).forEach(mock => mock.mockClear())
  vi.mocked(recordCalc).mockClear()
  $notepadSignal.set(null)
  $notesSidebar.set('auto')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('Notepad', () => {
  it('starts the very first run on a Welcome note, worked out and drawn', async () => {
    await open()

    expect(calc.bridge.saveNote).toHaveBeenCalledWith({ text: WELCOME_NOTE })
    expect(textarea().value).toBe(WELCOME_NOTE)
    expect(host.querySelector('[data-testid="graph"]')?.textContent).toBe('sin(x) * x')
    expect(host.querySelector('[data-os-target="calc-note:note-1"]')?.textContent).toContain('# Welcome to Herald Calc')
    expect(localStorage.getItem('herald-calc:welcomed')).toBe('1')
  })

  it('works each line out a moment after typing, beside it, and saves once typing rests', async () => {
    seed('1 + 1')
    await open()

    expect(results()).toEqual(['2'])
    expect(total()).toBe('2')

    await type('1 + 1\n2 + 3')

    expect(results()).toEqual(['2'])

    await settle(80)

    expect(results()).toEqual(['2', '5'])
    expect(total()).toBe('7')
    expect(calc.bridge.saveNote).not.toHaveBeenCalled()

    await settle(400)

    expect(calc.bridge.saveNote).toHaveBeenCalledWith({ id: 'seed-0', text: '1 + 1\n2 + 3' })
  })

  it('keeps an error quiet while its line is typed, then shows it gently', async () => {
    seed('1 + 1')
    await open()
    await type('1 + 1\n5 km in')
    await settle(100)

    expect(button('Herald cannot read this line yet')).toBeNull()

    await settle(2600)

    expect(button('Herald cannot read this line yet')).not.toBeNull()
  })

  it('saves at once when the editor is left, and records the finished line in the history', async () => {
    seed('1 + 1')
    await open()
    await type('1 + 1\n2 + 3')
    act(() => void textarea().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await settle(0)

    expect(calc.bridge.saveNote).toHaveBeenCalledWith({ id: 'seed-0', text: '1 + 1\n2 + 3' })
    expect(recordCalc).not.toHaveBeenCalled()

    await settle(100)

    expect(recordCalc).toHaveBeenCalledExactlyOnceWith({ input: '2 + 3', result: '5', source: 'notes', context: '1 + 1' })
  })

  it('saves typing before opening another note, and opens the note asked for', async () => {
    seed('1 + 1', '4 + 4')
    await open()

    expect(textarea().value).toBe('1 + 1')

    await type('1 + 1\n3 + 3')
    act(() => (host.querySelector('[data-os-target="calc-note:seed-1"]') as HTMLButtonElement).click())
    await settle(100)

    expect(calc.bridge.saveNote).toHaveBeenCalledWith({ id: 'seed-0', text: '1 + 1\n3 + 3' })
    expect(textarea().value).toBe('4 + 4')
    expect(results()).toEqual(['8'])
    expect(localStorage.getItem('herald-calc:open-note')).toBe('seed-1')
  })

  it('deletes a note and brings it back on Undo', async () => {
    seed('Groceries\n1 + 1', '4 + 4')
    await open()
    act(() => button('Delete Groceries')!.click())
    await settle(100)

    expect(calc.bridge.deleteNote).toHaveBeenCalledWith('seed-0')
    expect(textarea().value).toBe('4 + 4')
    expect(host.textContent).toContain('Deleted “Groceries”')

    act(() => button('Undo')!.click())
    await settle(100)

    expect(calc.bridge.saveNote).toHaveBeenLastCalledWith({ text: 'Groceries\n1 + 1' })
    expect(textarea().value).toBe('Groceries\n1 + 1')
  })

  it('shows how a result was worked out, and puts it on a new line below', async () => {
    seed('1 + 1\n4 + 4')
    await open()
    act(() => button('2: show the working')!.click())
    await settle(0)

    expect(host.querySelector('[role="dialog"][aria-label="How this was worked out"]')?.textContent).toContain('= 2')

    act(() => button('Insert 2 on a new line below')!.click())
    await settle(0)

    expect(textarea().value).toBe('1 + 1\n2\n4 + 4')
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('starts a note a request asks for without taking the keyboard', async () => {
    seed('1 + 1')
    await open()
    act(() => signalNotepad('new', '6 + 7', false))
    await settle(100)

    expect(calc.bridge.saveNote).toHaveBeenCalledWith({ text: '6 + 7' })
    expect(textarea().value).toBe('6 + 7')
    expect(results()).toEqual(['13'])
    expect(document.activeElement).not.toBe(textarea())
  })

  it('opens the notes list over the note in a narrow window', async () => {
    seed('1 + 1')
    await open(360)

    expect(host.querySelector('aside')).toBeNull()

    act(() => $notesSidebar.set('open'))

    expect(host.querySelector('aside')?.className).toContain('absolute')
  })
})
