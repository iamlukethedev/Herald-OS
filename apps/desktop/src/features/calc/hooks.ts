import { useStore } from '@nanostores/react'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { $locale } from '../../store/i18n.ts'
import { useDocumentVisible } from '../pet/hooks.ts'
import { mentionsCurrency, systemZone } from './context.ts'
import type { CalcContext } from './engine/types.ts'
import { $calcRates, followRates, ratesForCurrency } from './rates.ts'

const MINUTE_MS = 60_000

/** An element's size, kept current; zero until it is measured. */
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const element = ref.current

    if (!element) {
      return
    }

    const update = () => {
      const width = Math.round(element.clientWidth)
      const height = Math.round(element.clientHeight)
      setSize(current => (current.width === width && current.height === height ? current : { width, height }))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)

    return () => observer.disconnect()
  }, [ref])

  return size
}

/** Now, again at each new minute while the window shows, and as soon as it shows again. */
export function useMinute(): number {
  const visible = useDocumentVisible()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!visible) {
      return
    }

    const update = () => {
      const time = Date.now()
      setNow(current => (Math.floor(current / MINUTE_MS) === Math.floor(time / MINUTE_MS) ? current : time))
    }
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      timer = setTimeout(
        () => {
          update()
          schedule()
        },
        MINUTE_MS - (Date.now() % MINUTE_MS) + 50
      )
    }
    update()
    schedule()

    return () => clearTimeout(timer)
  }, [visible])

  return now
}

/**
 * What a note is worked out in: the locale, the time zone, now (each minute, so "days until" moves
 * on), and the currency rates (the cached ones, fetched first once the note names a currency).
 */
export function useCalcContext(text: string): CalcContext {
  const locale = useStore($locale)
  const state = useStore($calcRates)
  const now = useMinute()
  const currency = useMemo(() => mentionsCurrency(text), [text])
  const rates = state?.rates ?? null

  useEffect(() => followRates(), [])

  useEffect(() => {
    if (currency) {
      ratesForCurrency()
    }
  }, [currency, now])

  return useMemo(() => ({ locale, now, zone: systemZone(), rates }), [locale, now, rates])
}

/** `value`, or the one from before while `same` finds nothing changed: steady input for memoized children. */
export function useStable<T>(value: T, same: (a: T, b: T) => boolean): T {
  const ref = useRef(value)

  if (ref.current !== value && !same(ref.current, value)) {
    ref.current = value
  }

  return ref.current
}

/** Closes a popover when the pointer lands outside `ref` or Escape is pressed. */
export function useDismiss<T extends HTMLElement>(open: boolean, close: () => void): RefObject<T | null> {
  const ref = useRef<T | null>(null)
  const latest = useRef(close)
  latest.current = close

  useEffect(() => {
    if (!open) {
      return
    }

    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        latest.current()
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        latest.current()
      }
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)

    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return ref
}
