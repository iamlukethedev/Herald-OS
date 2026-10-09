import { afterEach, describe, expect, it, vi } from 'vitest'
import { keepFocusHome } from './focus.ts'

// Just enough of a page for where focus is: its body, what holds focus, and the next frame.
const body = { name: 'body' }
let nextFrame: (() => void) | null = null

function page(active: unknown) {
  vi.stubGlobal('document', { body, activeElement: active })
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => {
    nextFrame = run

    return 1
  })
}

const focusMovesTo = (active: unknown) => Object.assign(globalThis.document, { activeElement: active })
const holding = (...inside: unknown[]) => ({ contains: (node: unknown) => inside.includes(node) }) as unknown as Element
const stage = () => ({ focus: vi.fn(), isConnected: true })
const asElement = (target: ReturnType<typeof stage>) => target as unknown as HTMLElement

describe('keepFocusHome', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    nextFrame = null
  })

  it('gives the slide area the keyboard when the editor that holds it goes, as on Escape', () => {
    const caret = { name: 'editor' }
    const home = stage()
    page(caret)

    keepFocusHome(asElement(home), holding(caret))

    expect(home.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(nextFrame).toBeNull()
  })

  it('gives it the keyboard when focus has already fallen out to the page', () => {
    const home = stage()
    page(body)

    keepFocusHome(asElement(home), holding())

    expect(home.focus).toHaveBeenCalledTimes(1)
  })

  it('leaves focus the person moved elsewhere, and takes it back from a menu that drops it after the frame', () => {
    const list = { name: 'slide list' }
    const home = stage()
    page(list)

    keepFocusHome(asElement(home), holding())
    nextFrame?.()

    expect(home.focus).not.toHaveBeenCalled()

    const item = { name: 'menu item' }
    focusMovesTo(item)
    keepFocusHome(asElement(home), holding())
    focusMovesTo(body)
    nextFrame?.()

    expect(home.focus).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a slide area gone by the next frame, or none at all', () => {
    const item = { name: 'menu item' }
    const home = stage()
    page(item)

    keepFocusHome(asElement(home), holding())
    home.isConnected = false
    focusMovesTo(body)
    nextFrame?.()
    keepFocusHome(null, holding(body))

    expect(home.focus).not.toHaveBeenCalled()
  })
})
