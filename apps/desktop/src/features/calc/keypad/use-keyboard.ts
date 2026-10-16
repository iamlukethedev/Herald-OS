import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { $focusedWindowId } from '../../../store/windows.ts'

const FLASH_MS = 130

export function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

/** Enter and Space belong to a focused control, such as a key reached with Tab. */
function activatesControl(target: EventTarget | null, key: string): boolean {
  return (key === 'Enter' || key === ' ') && target instanceof HTMLElement && target.closest('button, a[href], [role="button"], [role="tab"], [role="menuitem"]') !== null
}

/** Whether a key press belongs to the window the keypad is in; every surface is a window of its own in panels mode. */
function inKeypadWindow(root: HTMLElement | null, target: EventTarget | null): boolean {
  const frame = root?.closest<HTMLElement>('[data-window-id]')

  if (!frame) {
    return true
  }

  if (target instanceof Node && frame.contains(target)) {
    return true
  }

  return (target === null || target === document.body || target === document.documentElement) && $focusedWindowId.get() === frame.dataset.windowId
}

/**
 * The keyboard while `enabled`, never while someone types in a field: `onKey` gets each plain key
 * (no Command, Control or Alt) and returns whether it used it, which then does nothing else.
 */
export function useKeypadKeyboard(enabled: boolean, root: RefObject<HTMLElement | null>, onKey: (key: string) => boolean): void {
  const handler = useRef(onKey)

  useLayoutEffect(() => {
    handler.current = onKey
  })

  useEffect(() => {
    if (!enabled) {
      return
    }

    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || (event.repeat && event.key !== 'Backspace')) {
        return
      }

      if (isTyping(event.target) || activatesControl(event.target, event.key) || !inKeypadWindow(root.current, event.target)) {
        return
      }

      if (handler.current(event.key)) {
        event.preventDefault()
      }
    }

    window.addEventListener('keydown', listener)

    return () => window.removeEventListener('keydown', listener)
  }, [enabled, root])
}

/** The key the keyboard pressed last, for a moment, so its button flashes. */
export function useFlash(): [string | null, (key: string) => void] {
  const [flash, setFlash] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
      }
    },
    []
  )

  const trigger = useCallback((key: string) => {
    setFlash(key)

    if (timer.current !== null) {
      window.clearTimeout(timer.current)
    }

    timer.current = window.setTimeout(() => setFlash(null), FLASH_MS)
  }, [])

  return [flash, trigger]
}
