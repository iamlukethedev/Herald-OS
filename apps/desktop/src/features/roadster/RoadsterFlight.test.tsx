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
    let inside: HTMLButtonElement
    let outside: HTMLButtonElement
    const heard = { inside: { press: 0, click: 0 }, outside: { press: 0, click: 0 } }
    const press = (target: HTMLElement, init: PointerEventInit = {}) => {
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ...init })
      target.dispatchEvent(event)

      return event
    }
    const click = (target: HTMLElement) => target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    /** A stand-in for the Pet Room: a container with a button, and the flight over it while `flying`. */
    function Room({ flying, claimsClick, onDone }: { flying: boolean; claimsClick: boolean; onDone: () => void }) {
      return (
        <div data-testid="room" className="relative">
          <button type="button" data-testid="inside" />
          {flying && <RoadsterFlight onDone={onDone} contained claimsClick={claimsClick} />}
        </div>
      )
    }

    function fly(claimsClick: boolean, onDone: () => void = vi.fn()): void {
      act(() => root.render(<Room flying claimsClick={claimsClick} onDone={onDone} />))
      const button = host.querySelector<HTMLButtonElement>('[data-testid="inside"]')!

      if (button !== inside) {
        inside = button
        inside.addEventListener('pointerdown', () => heard.inside.press++)
        inside.addEventListener('click', () => heard.inside.click++)
      }
    }

    const land = () => act(() => root.render(<Room flying={false} claimsClick onDone={vi.fn()} />))

    beforeEach(() => {
      heard.inside = { press: 0, click: 0 }
      heard.outside = { press: 0, click: 0 }
      outside = document.createElement('button')
      outside.addEventListener('pointerdown', () => heard.outside.press++)
      outside.addEventListener('click', () => heard.outside.click++)
      document.body.append(outside)
    })

    afterEach(() => {
      outside.remove()
    })

    it('reaches the app under an asked-for flight, click and all', () => {
      const onDone = vi.fn()
      fly(false, onDone)

      const event = press(inside)
      land()
      click(inside)

      expect(onDone).toHaveBeenCalledTimes(1)
      expect(event.defaultPrevented).toBe(false)
      expect(heard.inside).toEqual({ press: 1, click: 1 })
    })

    it('is taken over the Room by an unasked flight, with the click that follows it once the flight is gone', () => {
      const onDone = vi.fn()
      fly(true, onDone)

      const event = press(inside)
      land()
      click(inside)

      expect(onDone).toHaveBeenCalledTimes(1)
      expect(event.defaultPrevented).toBe(true)
      expect(heard.inside).toEqual({ press: 0, click: 0 })

      click(inside)
      expect(heard.inside.click).toBe(1)
    })

    it('ends an unasked flight but goes on to the app when it lands outside the Room', () => {
      const onDone = vi.fn()
      fly(true, onDone)

      const event = press(outside)
      land()
      click(outside)

      expect(onDone).toHaveBeenCalledTimes(1)
      expect(event.defaultPrevented).toBe(false)
      expect(heard.outside).toEqual({ press: 1, click: 1 })
    })

    it('takes no click after a press with any button but the primary one', () => {
      for (const button of [1, 2]) {
        fly(true)

        const event = press(inside, { button })
        land()
        click(inside)

        expect(event.defaultPrevented).toBe(true)
        expect(heard.inside.click).toBe(1)
        heard.inside.click = 0
      }
    })

    it.each(['pointercancel', 'contextmenu'])('stops waiting for the click on %s, which means none is coming', name => {
      const removed = vi.spyOn(window, 'removeEventListener')
      fly(true)

      press(inside)
      land()
      inside.dispatchEvent(new Event(name, { bubbles: true }))
      click(inside)

      expect(heard.inside.click).toBe(1)

      for (const listened of ['click', 'pointerdown', 'pointercancel', 'contextmenu']) {
        expect(removed).toHaveBeenCalledWith(listened, expect.any(Function), true)
      }
    })

    it('stops waiting for the click at the next press, so a later click elsewhere is never swallowed', () => {
      fly(true)

      press(inside)
      land()
      press(outside)
      click(outside)

      expect(heard.outside).toEqual({ press: 1, click: 1 })
    })

    it('stops waiting for that click soon, so a later click is never lost', () => {
      fly(true)

      press(inside)
      land()
      act(() => vi.advanceTimersByTime(CLAIMED_CLICK_MS))
      click(inside)

      expect(heard.inside.click).toBe(1)
    })

    it('takes nothing once an unasked flight has ended by itself', () => {
      fly(true)
      act(() => vi.advanceTimersByTime(FLIGHT_MS))
      land()

      const event = press(inside)
      click(inside)

      expect(event.defaultPrevented).toBe(false)
      expect(heard.inside).toEqual({ press: 1, click: 1 })
    })
  })
})
