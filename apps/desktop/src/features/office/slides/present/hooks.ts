import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface Size {
  width: number
  height: number
}

const same = (a: Size, b: Size) => a.width === b.width && a.height === b.height

/** A window's inner size, following it as it changes. */
export function useWindowSize(win: Window): Size {
  const [size, setSize] = useState<Size>(() => ({ width: win.innerWidth, height: win.innerHeight }))

  useLayoutEffect(() => {
    const onResize = () => {
      const now = { width: win.innerWidth, height: win.innerHeight }
      setSize((old) => (same(old, now) ? old : now))
    }
    onResize()
    win.addEventListener('resize', onResize)

    return () => win.removeEventListener('resize', onResize)
  }, [win])

  return size
}

/** An element's inner size, following it as it changes. */
export function useSize<T extends HTMLElement>(): [RefObject<T | null>, Size] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const element = ref.current

    if (!element) {
      return
    }

    const measure = () => {
      const now = { width: element.clientWidth, height: element.clientHeight }
      setSize((old) => (same(old, now) ? old : now))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  return [ref, size]
}

/** Whether the mouse has rested a while (the cursor and controls hide), and the call that wakes them. */
export function useIdle(ms = 2500): { idle: boolean; wake: () => void } {
  const [idle, setIdle] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wake = useCallback(() => {
    setIdle(false)

    if (timer.current) {
      clearTimeout(timer.current)
    }

    timer.current = setTimeout(() => setIdle(true), ms)
  }, [ms])

  useEffect(() => {
    wake()

    return () => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
    }
  }, [wake])

  return { idle, wake }
}

/** The time, again at each new second. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const wait = () => 1010 - (Date.now() % 1000)
    let timer = setTimeout(function tick() {
      setNow(Date.now())
      timer = setTimeout(tick, wait())
    }, wait())

    return () => clearTimeout(timer)
  }, [])

  return now
}

/** The size of a slide fitted in a box, and its scale (CSS pixels a point). */
export function fitIn(box: Size, slide: Size): Size & { scale: number } {
  const scale = Math.max(0.001, Math.min(box.width / slide.width, box.height / slide.height))

  return { width: slide.width * scale, height: slide.height * scale, scale }
}
