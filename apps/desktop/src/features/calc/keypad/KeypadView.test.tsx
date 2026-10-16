/**
 * @vitest-environment happy-dom
 * The keypad as the window shows it, with the engine, prefs and history stood in for.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { updatePrefs } from '../../../store/backend.ts'
import { recordCalc } from '../history/store.ts'
import { KeypadView } from './KeypadView.tsx'
import { INITIAL_KEYPAD } from './machine.ts'
import { INITIAL_PROGRAMMER } from './programmer-machine.ts'
import { $keypad, $programmer } from './store.ts'

vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

/** The engine's exact answers in these tests, by expression. */
const answers = vi.hoisted(() => new Map([['2 + 3 * 4', '14']]))

vi.mock('../engine/index.ts', () => ({
  evaluate: vi.fn(async (input: string) => {
    const exact = answers.get(input)

    return exact === undefined ? { ok: false, input, steps: [], error: 'Not in this test' } : { ok: true, input, steps: [], value: { kind: 'number', exact, number: Number(exact) }, display: exact }
  })
}))
vi.mock('../context.ts', () => ({ calcContext: async () => ({ locale: 'en-US', now: 0, zone: 'UTC', rates: null }) }))
vi.mock('../history/store.ts', () => ({ recordCalc: vi.fn() }))
vi.mock('../../pet/hooks.ts', () => ({ useReducedMotion: () => true }))
vi.mock('../../../store/windows.ts', async () => {
  const { atom } = await import('nanostores')

  return { $focusedWindowId: atom(null) }
})
vi.mock('../../../store/i18n.ts', async () => {
  const { atom } = await import('nanostores')

  return { $locale: atom('en-US') }
})
vi.mock('../../../store/backend.ts', async () => {
  const { atom } = await import('nanostores')
  const { mergeCalcPrefs } = await import('../../../../shared/calc.ts')
  const prefs = atom<{ calc?: unknown }>({})

  return { $prefs: prefs, updatePrefs: vi.fn(async (patch: { calc?: unknown }) => prefs.set({ calc: mergeCalcPrefs(prefs.get().calc, patch.calc) })) }
})

let host: HTMLDivElement
let root: Root

/** Let the engine's answers land before looking. */
const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)))
const type = (...keys: string[]) =>
  act(() => {
    for (const key of keys) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    }
  })
const key = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const display = () => host.querySelector('[aria-live="polite"] .sr-only')?.textContent

beforeEach(() => {
  // Each '=' keeps a new id, so the history takes every one.
  $keypad.set({ ...INITIAL_KEYPAD, last: $keypad.get().last })
  $programmer.set({ ...INITIAL_PROGRAMMER, last: $programmer.get().last })
  vi.mocked(recordCalc).mockClear()
  vi.mocked(updatePrefs).mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('KeypadView', () => {
  it('works with precedence from the keyboard, previews, and keeps each = in the history', async () => {
    act(() => root.render(<KeypadView active />))
    type('2', '+', '3', '*', '4')
    await settle()

    expect(display()).toBe('4')
    expect(host.textContent).toContain('2 + 3 × 4')
    expect(host.textContent).toContain('= 14')

    type('Enter')
    await settle()
    await settle()

    expect(display()).toBe('14')
    expect(host.textContent).toContain('2 + 3 × 4 =')
    expect(recordCalc).toHaveBeenCalledWith({ input: '2 + 3 × 4', result: '14', source: 'keypad' })
  })

  it('presses keys under the pointer, and leaves the keyboard alone while inactive or typing elsewhere', () => {
    act(() => root.render(<KeypadView active={false} />))
    type('5')

    expect(display()).toBe('0')

    act(() => {
      key('7')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })

    expect(display()).toBe('7')

    act(() => root.render(<KeypadView active />))
    const field = document.createElement('input')
    document.body.append(field)
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: '9', bubbles: true }))
    })
    field.remove()

    expect(display()).toBe('7')
    expect(key('Clear')).not.toBeNull()
  })

  it('switches to the programmer keypad, saves the choice and shows every base', async () => {
    act(() => root.render(<KeypadView active />))
    const programmer = [...host.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find(button => button.textContent === 'Programmer')
    act(() => programmer?.click())
    await settle()

    expect(updatePrefs).toHaveBeenCalledWith({ calc: { keypad: 'programmer' } })
    expect(host.querySelector('[aria-label="Bits"]')).not.toBeNull()

    type('2', '5', '5')

    expect(host.querySelector('button[aria-label^="Hexadecimal"]')?.textContent).toContain('FF')
    expect(host.querySelector('button[aria-label^="Binary"]')?.textContent).toContain('1111 1111')
    expect(key('A')?.disabled).toBe(true)
  })
})
