// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalcHistoryEntry } from '../../../../shared/calc.ts'
import { $locale } from '../../../store/i18n.ts'
import { dayLabel } from './days.ts'
import { HistoryView, type HistoryViewProps } from './HistoryView.tsx'

// Main's side of the history: what it reads back, and the calls the view makes.
const bridge = vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const state = { entries: [] as CalcHistoryEntry[] }
  const calc = {
    history: vi.fn(async () => state.entries),
    addHistory: vi.fn(async () => undefined),
    clearHistory: vi.fn(async () => {
      state.entries = []
    }),
    onChanged: vi.fn(() => () => undefined)
  }
  Object.assign(window, { heraldOS: { calc } })

  return { state, calc }
})

const on = (day: number, hour = 12, month = 9, year = 2026) => new Date(year, month, day, hour).getTime()
const NOW = on(14, 15)

const MORTGAGE: CalcHistoryEntry = { id: 'm', at: on(14, 9), input: '450,000 at 6% over 30 years', result: '$2,697.98', source: 'notes', context: 'Mortgage · monthly' }
const TIP: CalcHistoryEntry = { id: 't', at: on(13, 10), input: '20% of 84.50', result: '16.90', source: 'keypad' }
const MILES: CalcHistoryEntry = { id: 'k', at: on(2, 9), input: '12 km in miles', result: '7.46 mi', source: 'hermes' }

let root: Root | null = null
let container: HTMLElement
const writeText = vi.fn(async (_text: string) => undefined)

async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function show(props: Partial<HistoryViewProps> = {}) {
  const all: HistoryViewProps = { query: '', onQueryChange: () => undefined, ...props }

  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }

  await act(async () => root?.render(<HistoryView {...all} />))
  await settle()
}

const text = () => container.textContent ?? ''
const headings = () => [...container.querySelectorAll('h3')].map(heading => heading.textContent)
const rows = () => [...container.querySelectorAll<HTMLButtonElement>('li > button')]
const button = (label: string) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label)

  if (!found) {
    throw new Error(`no button "${label}"`)
  }

  return found
}
const searchInput = () => container.querySelector<HTMLInputElement>('input')!
const press = (element: Element, key: string) => element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  bridge.state.entries = [MORTGAGE, TIP, MILES]
  bridge.calc.clearHistory.mockClear()
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  vi.useRealTimers()
})

describe('the history view', () => {
  it('loads the history and shows it under its days, newest first', async () => {
    await show()

    expect(bridge.calc.history).toHaveBeenCalled()
    expect(headings()).toEqual(['Today', 'Yesterday', dayLabel(MILES.at, NOW, $locale.get())])
    expect(rows().map(row => row.querySelector('.truncate')?.textContent)).toEqual([MORTGAGE.input, TIP.input, MILES.input])
  })

  it('shows each calculation’s answer in tabular figures, where it came from and when', async () => {
    await show()
    const [mortgage, tip, miles] = rows()

    expect(mortgage.querySelector('.tabular-nums')?.textContent).toBe('$2,697.98')
    expect(mortgage.textContent).toContain('Mortgage · monthly')
    expect(mortgage.getAttribute('aria-label')).toContain('From a note')
    expect(tip.getAttribute('aria-label')).toContain('From a keypad')
    expect(miles.getAttribute('aria-label')).toContain('Worked out by Hermes')
    expect(mortgage.querySelector('time')?.getAttribute('dateTime')).toBe(new Date(MORTGAGE.at).toISOString())
  })

  it('says so calmly when there is nothing yet', async () => {
    bridge.state.entries = []
    await show()

    expect(text()).toContain('No calculations yet')
    expect(text()).not.toContain('Clear history')
  })

  it('shows what the search finds, and says when nothing matches', async () => {
    const onQueryChange = vi.fn()
    await show({ query: 'that mortgage thing', onQueryChange })

    expect(rows()).toHaveLength(1)
    expect(headings()).toEqual(['Today'])

    await show({ query: 'pizza', onQueryChange })

    expect(text()).toContain('Nothing matches “pizza”')

    await act(async () => button('Clear the search').click())

    expect(onQueryChange).toHaveBeenLastCalledWith('')
  })

  it('hands what is typed to the window', async () => {
    const onQueryChange = vi.fn()
    await show({ onQueryChange })
    const input = searchInput()

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'tip')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onQueryChange).toHaveBeenCalledWith('tip')
  })

  it('uses a calculation picked from the list, from the row or its Use action', async () => {
    const onUse = vi.fn()
    await show({ onUse })

    await act(async () => rows()[1].click())

    expect(onUse).toHaveBeenLastCalledWith(TIP)

    await act(async () => button(`Use ${MILES.input} in the note`).click())

    expect(onUse).toHaveBeenLastCalledWith(MILES)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('copies the result from its Copy action, and from the row when there is nothing to use it in', async () => {
    await show()

    await act(async () => button(`Copy ${TIP.result}`).click())
    await settle()

    expect(writeText).toHaveBeenLastCalledWith('16.90')
    expect(button(`Copied ${TIP.result}`)).toBeTruthy()

    await act(async () => rows()[0].click())
    await settle()

    expect(writeText).toHaveBeenLastCalledWith('$2,697.98')
  })

  it('tells the person when copying failed', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await show()

    await act(async () => button(`Copy ${TIP.result}`).click())
    await settle()

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not copy 16.90: denied')
    errors.mockRestore()
  })

  it('moves through the rows with the arrow keys, from the search and back to it', async () => {
    await show()
    const search = searchInput()
    search.focus()

    await act(async () => press(search, 'ArrowDown'))

    expect(document.activeElement).toBe(rows()[0])

    await act(async () => press(rows()[0], 'ArrowDown'))

    expect(document.activeElement).toBe(rows()[1])

    await act(async () => press(rows()[1], 'End'))

    expect(document.activeElement).toBe(rows()[2])

    await act(async () => press(rows()[2], 'ArrowDown'))

    expect(document.activeElement).toBe(rows()[2])

    await act(async () => press(rows()[2], 'Home'))
    await act(async () => press(rows()[0], 'ArrowUp'))

    expect(document.activeElement).toBe(search)
  })

  it('keeps one tab stop in the list, on the row last reached', async () => {
    await show()

    expect(rows().map(row => row.tabIndex)).toEqual([0, -1, -1])

    await act(async () => rows()[1].focus())

    expect(rows().map(row => row.tabIndex)).toEqual([-1, 0, -1])
  })

  it('clears the history only once the person confirms', async () => {
    await show()

    await act(async () => button('Clear history').click())

    expect(text()).toContain('Clear all 3 calculations?')
    expect(document.activeElement?.textContent).toBe('Cancel')

    await act(async () => button('Cancel').click())

    expect(text()).not.toContain('Clear all 3 calculations?')
    expect(bridge.calc.clearHistory).not.toHaveBeenCalled()

    await act(async () => button('Clear history').click())
    await act(async () => button('Clear').click())
    await settle()

    expect(bridge.calc.clearHistory).toHaveBeenCalledTimes(1)
    expect(text()).toContain('No calculations yet')
  })

  it('says why the history could not be cleared', async () => {
    bridge.calc.clearHistory.mockRejectedValueOnce(new Error("Error invoking remote method 'herald-os:calc:history-clear': Error: The file is locked"))
    await show()

    await act(async () => button('Clear history').click())
    await act(async () => button('Clear').click())
    await settle()

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not clear the history: The file is locked')
    expect(rows()).toHaveLength(3)
  })

  it('shows a page of rows at a time', async () => {
    bridge.state.entries = Array.from({ length: 130 }, (_, index) => ({ id: `e${index}`, at: NOW - index * 60_000, input: `${index} + 1`, result: String(index + 1), source: 'keypad' as const }))
    await show()

    expect(rows()).toHaveLength(100)

    await act(async () => button('Show more').click())

    expect(rows()).toHaveLength(130)
    expect(text()).not.toContain('Show more')
  })
})
