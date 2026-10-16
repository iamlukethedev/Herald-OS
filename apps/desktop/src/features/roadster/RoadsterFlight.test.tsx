// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAIMED_CLICK_MS, RoadsterFlight } from './RoadsterFlight.tsx'
import { FLIGHT_MS, STILL_MS } from './timeline.ts'

vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

const motion = vi.hoisted(() => ({ reduced: false }))

vi.mock('../pet/hooks.ts', () => ({ useReducedMotion: () => motion.reduced }))

let host: HTMLDivElement
let root: Root

function show(onDone: () => void, contained = false, claimsClick = false): HTMLElement {
  act(() => root.render(<RoadsterFlight onDone={onDone} contained={contained} claimsClick={claimsClick} />))

  return host.querySelector<HTMLElement>('.roadster')!
}

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  motion.reduced = false
})

describe('the roadster flyover', () => {
  it('flies frame by frame, ends on its own after the flight and never takes the pointer', () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame')
    const onDone = vi.fn()
    const scene = show(onDone)

    expect(scene.dataset.roadster).toBe('flying')
    expect(scene.classList.contains('pointer-events-none')).toBe(true)
    expect(scene.getAttribute('aria-hidden')).toBe('true')
    expect(scene.querySelector('[role="img"], [aria-label]')).toBeNull()
    expect(scene.textContent).toContain('Press any key or click to skip')
    expect(frame).toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(FLIGHT_MS - 1))
    expect(onDone).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('moves the car as the frames come', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => frames.push(callback))
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const scene = show(vi.fn())
    const car = () => scene.querySelector('svg > g[transform]')?.getAttribute('transform')
    const before = car()

    act(() => frames.at(-1)!(1500))

    expect(car()).not.toBe(before)
    expect(Number(scene.style.opacity)).toBe(1)
  })

  it('shows one still frame under reduced motion, with nothing animating, and ends sooner', () => {
    motion.reduced = true
    const frame = vi.spyOn(window, 'requestAnimationFrame')
    const onDone = vi.fn()
    const scene = show(onDone)

    expect(scene.dataset.roadster).toBe('still')
    expect(scene.style.opacity).toBe('1')
    expect(frame).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(STILL_MS))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('ends on Escape, any other key or a click, once, and lets Escape go no further', () => {
    const inputs = [() => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }), () => new KeyboardEvent('keydown', { key: 'a', bubbles: true }), () => new PointerEvent('pointerdown', { bubbles: true })]

    for (const input of inputs) {
      const onDone = vi.fn()
      show(onDone)
      const event = input()

      window.dispatchEvent(event)
      window.dispatchEvent(input())

      expect(onDone).toHaveBeenCalledTimes(1)
      expect(event.defaultPrevented).toBe(event instanceof KeyboardEvent && event.key === 'Escape')

      act(() => root.render(<div />))
    }
  })

  it('ignores a key held down from before it appeared', () => {
    const onDone = vi.fn()
    show(onDone)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true }))

    expect(onDone).not.toHaveBeenCalled()
  })

  it('cleans up when it goes: no timer, frame or listener is left, and it does not report ending afterwards', () => {
    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    const set = vi.spyOn(globalThis, 'setTimeout')
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    const onDone = vi.fn()
    show(onDone)
    const listeners = added.mock.calls.filter(([name]) => name === 'keydown' || name === 'pointerdown')
    const ending = set.mock.results[set.mock.calls.findIndex(([, ms]) => ms === FLIGHT_MS)]?.value

    act(() => root.render(<div />))

    expect(listeners).toHaveLength(2)

    for (const [name, listener, options] of listeners) {
      expect(removed).toHaveBeenCalledWith(name, listener, options)
    }

    expect(ending).toBeDefined()
    expect(clear).toHaveBeenCalledWith(ending)
    expect(cancel).toHaveBeenCalled()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    act(() => vi.advanceTimersByTime(FLIGHT_MS * 2))
    expect(onDone).not.toHaveBeenCalled()
  })

  it('covers the whole window, or only its container in the Pet Room and the screensaver', () => {
    expect(show(vi.fn()).classList.contains('fixed')).toBe(true)
    act(() => root.render(<div />))
    expect(show(vi.fn(), true).classList.contains('absolute')).toBe(true)
  })

  describe('the press that ends it', () => {
    let button: HTMLButtonElement
    let pressed: ReturnType<typeof vi.fn<(event: Event) => void>>
    let clicked: ReturnType<typeof vi.fn<(event: Event) => void>>
    const press = () => {
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      button.dispatchEvent(event)

      return event
    }
    const click = () => button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    beforeEach(() => {
      button = document.createElement('button')
      pressed = vi.fn<(event: Event) => void>()
      clicked = vi.fn<(event: Event) => void>()
      button.addEventListener('pointerdown', pressed)
      button.addEventListener('click', clicked)
      document.body.append(button)
    })

    afterEach(() => {
      button.remove()
    })

    it('reaches the app under an asked-for flight, click and all', () => {
      const onDone = vi.fn()
      show(onDone)

      const event = press()
      act(() => root.render(<div />))
      click()

      expect(onDone).toHaveBeenCalledTimes(1)
      expect(event.defaultPrevented).toBe(false)
      expect(pressed).toHaveBeenCalledTimes(1)
      expect(clicked).toHaveBeenCalledTimes(1)
    })

    it('is taken by an unasked flight, with the click that follows it once the flight is gone', () => {
      const onDone = vi.fn()
      show(onDone, true, true)

      const event = press()
      act(() => root.render(<div />))
      click()

      expect(onDone).toHaveBeenCalledTimes(1)
      expect(event.defaultPrevented).toBe(true)
      expect(pressed).not.toHaveBeenCalled()
      expect(clicked).not.toHaveBeenCalled()

      click()
      expect(clicked).toHaveBeenCalledTimes(1)
    })

    it('stops waiting for that click soon, so a later click is never lost', () => {
      const removed = vi.spyOn(window, 'removeEventListener')
      show(vi.fn(), true, true)

      press()
      act(() => root.render(<div />))
      act(() => vi.advanceTimersByTime(CLAIMED_CLICK_MS))
      click()

      expect(clicked).toHaveBeenCalledTimes(1)
      expect(removed).toHaveBeenCalledWith('click', expect.any(Function), true)
    })

    it('takes nothing once an unasked flight has ended by itself', () => {
      show(vi.fn(), true, true)
      act(() => vi.advanceTimersByTime(FLIGHT_MS))
      act(() => root.render(<div />))

      const event = press()
      click()

      expect(event.defaultPrevented).toBe(false)
      expect(pressed).toHaveBeenCalledTimes(1)
      expect(clicked).toHaveBeenCalledTimes(1)
    })
  })
})
