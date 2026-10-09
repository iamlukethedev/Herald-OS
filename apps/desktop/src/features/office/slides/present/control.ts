import { atom } from 'nanostores'
import { useEffect, useRef } from 'react'
import { $presentation } from '../store.ts'
import { type Presentation, press } from './state.ts'

/*
 * Moving the presentation from any view: one state in the store, the keys of every window it shows
 * in applied to it, and the audience window on another display, opened and drawn from here.
 */

/** The name the audience window opens under; Herald's main process lets only it open, on another display. */
export const AUDIENCE_WINDOW_NAME = 'herald-slides-audience'

/** The audience window, while the slides show on another display. */
export const $audience = atom<Window | null>(null)

/** Whether another display is there for the slides while the presenter view stays on this one. */
export function canUseTwoDisplays(): boolean {
  return typeof window !== 'undefined' && (window.screen as Screen & { isExtended?: boolean }).isExtended === true
}

/** Open the audience window, which Herald puts full screen on another display; null when it cannot. */
export function openAudienceWindow(): Window | null {
  const open = $audience.get()

  if (open && !open.closed) {
    return open
  }

  const win = window.open('about:blank', AUDIENCE_WINDOW_NAME, 'popup')
  $audience.set(win)

  return win
}

/** Close the audience window, if one is open. */
export function closeAudienceWindow(): void {
  const win = $audience.get()
  $audience.set(null)

  if (win && !win.closed) {
    win.close()
  }
}

/** The page went full screen for the presentation, so leaving full screen ends it. */
let fullScreened = false

/** Put the page full screen for the presentation; leaving it (the system takes Escape for that, before the page) ends the presentation. */
export function enterFullScreen(): void {
  document.documentElement.requestFullscreen?.().then(
    () => {
      fullScreened = true

      if (!$presentation.get()) {
        stopPresenting()
      }
    },
    () => {}
  )
}

/** End the presentation in every view: the audience window closes and the screen leaves full screen. */
export function stopPresenting(): void {
  fullScreened = false
  $presentation.set(null)
  closeAudienceWindow()

  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {})
  }
}

/** End the presentation when the page leaves the full screen it went to for it. */
export function useFullScreenEnd(): void {
  useEffect(() => {
    const onChange = () => {
      if (fullScreened && !document.fullscreenElement) {
        stopPresenting()
      }
    }
    document.addEventListener('fullscreenchange', onChange)

    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
}

/** Apply a move to the presentation under way; a move that ends it ends it everywhere. */
export function act(move: (state: Presentation) => Presentation | null): void {
  const state = $presentation.get()

  if (!state) {
    return
  }

  const after = move(state)

  if (after === null) {
    stopPresenting()
  } else if (after !== state) {
    $presentation.set(after)
  }
}

/**
 * Keys pressed in a window move the presentation, the same whichever view they are pressed in;
 * `first` may take a key before they do (true: taken). Keys without modifiers go no further, so
 * that the editor under the presentation never acts on them.
 */
export function usePresentationKeys(win: Window | null, first?: (event: KeyboardEvent) => boolean): void {
  const before = useRef(first)
  before.current = first

  useEffect(() => {
    if (!win) {
      return
    }

    const onKey = (event: KeyboardEvent) => {
      const state = $presentation.get()

      if (!state || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) {
        return
      }

      const taken = before.current?.(event) ?? false
      const after = taken ? state : press(state, event.key)
      event.stopPropagation()

      if (after === undefined) {
        return
      }

      event.preventDefault()

      if (!taken) {
        act(() => after)
      }
    }
    win.addEventListener('keydown', onKey, true)

    return () => win.removeEventListener('keydown', onKey, true)
  }, [win])
}
