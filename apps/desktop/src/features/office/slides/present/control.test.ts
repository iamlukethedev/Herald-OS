import { afterEach, describe, expect, it, vi } from 'vitest'
import { $presentation } from '../store.ts'
import { presentationKeys, setPresentingShortcut } from './control.ts'
import { begin } from './state.ts'

vi.mock('../store.ts', async () => {
  const { atom } = await import('nanostores')

  return { $presentation: atom(null) }
})

const deck = { slides: ['a', 'b', 'c'].map((id) => ({ id, hidden: false })) } as Parameters<typeof begin>[0]

function press(key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) {
  const event = { key, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...mods, preventDefault: vi.fn(), stopPropagation: vi.fn() }

  return event as unknown as KeyboardEvent & typeof event
}

afterEach(() => {
  setPresentingShortcut(null)
  $presentation.set(null)
})

describe('presentation keys', () => {
  it('moves the one presentation every view shows, and keeps plain keys from the editor beneath', () => {
    $presentation.set(begin(deck, 'slides-1', 0, 0))
    const onKey = presentationKeys()
    const next = press('ArrowRight')

    onKey(next)

    expect($presentation.get()?.at).toBe(1)
    expect(next.preventDefault).toHaveBeenCalled()
    expect(next.stopPropagation).toHaveBeenCalled()
  })

  it('lets a view take a key first', () => {
    $presentation.set(begin(deck, 'slides-1', 0, 0))
    const onKey = presentationKeys(() => (event) => event.key === 'ArrowRight')

    onKey(press('ArrowRight'))

    expect($presentation.get()?.at).toBe(0)
  })

  it('hands keys with modifiers to the presenting shortcut, since the window’s menus do not hear them', () => {
    $presentation.set(begin(deck, 'slides-1', 0, 0))
    const shortcut = vi.fn((event: KeyboardEvent) => event.key === 'p' && event.metaKey && event.altKey)
    setPresentingShortcut(shortcut)
    const onKey = presentationKeys()
    const toggle = press('p', { metaKey: true, altKey: true })
    const copy = press('c', { metaKey: true })

    onKey(toggle)
    onKey(copy)

    expect(shortcut).toHaveBeenCalledTimes(2)
    expect(toggle.preventDefault).toHaveBeenCalled()
    expect(copy.preventDefault).not.toHaveBeenCalled()
    expect(copy.stopPropagation).not.toHaveBeenCalled()
    expect($presentation.get()?.at).toBe(0)
  })

  it('does nothing when nothing is being presented', () => {
    const shortcut = vi.fn(() => true)
    setPresentingShortcut(shortcut)
    const event = press('p', { metaKey: true, altKey: true })

    presentationKeys()(event)

    expect(shortcut).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
