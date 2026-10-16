import { useStore } from '@nanostores/react'
import { IconFocusCentered, IconMinus, IconPlus } from '@tabler/icons-react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../../lib/cn.ts'
import { motion } from '../../../lib/motion.ts'
import { $locale } from '../../../store/i18n.ts'
import { useReducedMotion } from '../../pet/hooks.ts'
import type { CompiledFunction } from '../engine/types.ts'
import { formatReadout } from './format.ts'
import { type CurvePaint, drawGraph, type SeriesPaint, type TracePaint } from './render.ts'
import { type SampledCurve, sampleFunction } from './sampling.ts'
import { curveColour, type GraphTheme, swatchOf, useGraphTheme } from './theme.ts'
import { centreOf, easeOut, fitView, type GraphViewport, lerpView, nearestPoint, panBy, type PlotSize, sameView, worldX, worldY, xRangeFor, yRangeIn, zoomAbout } from './viewport.ts'

/* The Graph view's canvas: draws the plots, and pans, zooms and traces under the pointer, fingers and keys. */

export interface Plot {
  id: string
  /** As the list and the readout name it. */
  label: string
  /** Its place in the palette. */
  colour: number
  fn?: CompiledFunction
  points?: ReadonlyArray<readonly [number, number]>
}

export interface GraphCanvasProps {
  plots: readonly Plot[]
  xMin?: number
  xMax?: number
  compact?: boolean
  /** What is drawn, for the canvas's label: "Graph of sin(x) * x". */
  description: string
  /** Shown over an empty graph. */
  hint?: string
  className?: string
}

interface Spot {
  x: number
  y: number
}

type Gesture = { kind: 'pan'; last: Spot; moved: boolean; touch: boolean } | { kind: 'trace' } | { kind: 'pinch'; view: GraphViewport; distance: number; middle: Spot }

interface ReadoutRow {
  id: string
  colour: number
  label: string
  text: string
}

interface Readout {
  rows: ReadoutRow[]
  /** The side away from the crosshair. */
  side: 'left' | 'right'
}

const ZOOM_STEP = 1.6
/** How long after the last move a gesture counts as going on, drawn at half the samples. */
const SETTLE_MS = 140

const identities = new WeakMap<object, number>()
let identified = 0

const identityOf = (value: object): number => {
  let identity = identities.get(value)

  if (identity === undefined) {
    identity = ++identified
    identities.set(value, identity)
  }

  return identity
}

const evaluate = (fn: CompiledFunction, x: number): number => {
  try {
    const y = fn(x)

    return typeof y === 'number' ? y : Number.NaN
  } catch {
    return Number.NaN
  }
}

export function GraphCanvas({ plots, xMin, xMax, compact = false, description, hint, className }: GraphCanvasProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const helpId = useId()
  const theme = useGraphTheme(probe)
  const locale = useStore($locale)
  const reduced = useReducedMotion()
  const [readout, setReadout] = useState<Readout | null>(null)
  const [range, setRange] = useState('')
  const [dragging, setDragging] = useState(false)

  const latest = useRef<{ plots: readonly Plot[]; theme: GraphTheme | null; locale: string | undefined; compact: boolean; reduced: boolean; xMin?: number; xMax?: number }>({ plots, theme, locale, compact, reduced, xMin, xMax })
  const size = useRef<PlotSize>({ width: 0, height: 0 })
  const view = useRef<GraphViewport | null>(null)
  /** The view follows the fit until the person moves it. */
  const auto = useRef(true)
  const animation = useRef<{ from: GraphViewport; to: GraphViewport; start: number; duration: number } | null>(null)
  const traceX = useRef<number | null>(null)
  /** Something has been drawn: from then on a new fit eases in rather than jumps. */
  const drewPlots = useRef(false)
  const busyUntil = useRef(0)
  const frame = useRef(0)
  const settleTimer = useRef(0)
  const rangeTimer = useRef(0)
  const shown = useRef({ readout: '', range: '' })
  const cache = useRef(new Map<string, { fn: CompiledFunction; key: string; curve: SampledCurve }>())
  const pointers = useRef(new Map<number, Spot>())
  const gesture = useRef<Gesture | null>(null)
  const paintRef = useRef<(now: number) => void>(() => undefined)

  useLayoutEffect(() => {
    latest.current = { plots, theme, locale, compact, reduced, xMin, xMax }
  })

  const schedule = useCallback(() => {
    if (!frame.current) {
      frame.current = requestAnimationFrame(now => {
        frame.current = 0
        paintRef.current(now)
      })
    }
  }, [])

  const fitted = useCallback((): GraphViewport => {
    const { plots: drawn, xMin: left, xMax: right } = latest.current
    const x = xRangeFor(drawn.flatMap(plot => (plot.points ? [plot.points] : [])), left, right)
    const ys = drawn.map(plot => (plot.fn ? sampleFunction(plot.fn, x[0], x[1], { samples: 400 }).yRange : yRangeIn(plot.points ?? [], x)))

    return fitView(x, ys, size.current)
  }, [])

  /** Show `target`, easing there from the view now unless motion is reduced. */
  const goTo = useCallback(
    (target: GraphViewport, ease: boolean, duration: number = motion.slow) => {
      const from = view.current

      animation.current = from && ease && !latest.current.reduced && !sameView(from, target) ? { from, to: target, start: performance.now(), duration } : null

      if (!animation.current) {
        view.current = target
      }

      schedule()
    },
    [schedule]
  )

  /** Where an eased move would end, so steps taken quickly add up. */
  const heading = (): GraphViewport | null => animation.current?.to ?? view.current

  /** The person moved the view: it stops following the fit, and draws coarser until they stop. */
  const touched = () => {
    auto.current = false
    animation.current = null
    busyUntil.current = performance.now() + SETTLE_MS
  }

  const fit = useCallback(() => {
    auto.current = true
    goTo(fitted(), true)
  }, [fitted, goTo])

  const sampled = (plot: Plot, fn: CompiledFunction, current: GraphViewport, samples: number): SampledCurve => {
    const key = `${current.xMin}|${current.xMax}|${current.yMin}|${current.yMax}|${samples}`
    const known = cache.current.get(plot.id)

    if (known && known.fn === fn && known.key === key) {
      return known.curve
    }

    const curve = sampleFunction(fn, current.xMin, current.xMax, { samples, yView: [current.yMin, current.yMax] })
    cache.current.set(plot.id, { fn, key, curve })

    return curve
  }

  const traced = (current: GraphViewport, colours: GraphTheme): { paint: TracePaint; rows: ReadoutRow[] } | null => {
    const x = traceX.current

    if (x === null || x < current.xMin || x > current.xMax) {
      return null
    }

    const dots: Array<TracePaint['dots'][number]> = []
    const rows: ReadoutRow[] = []
    const write = (value: number) => formatReadout(value, latest.current.locale)

    for (const plot of latest.current.plots) {
      const colour = curveColour(colours, plot.colour)

      if (plot.fn) {
        const y = evaluate(plot.fn, x)

        if (Number.isFinite(y)) {
          dots.push({ colour, x, y })
        }

        rows.push({ id: plot.id, colour: plot.colour, label: plot.label, text: `x = ${write(x)}  ${Number.isFinite(y) ? `y = ${write(y)}` : 'no value'}` })
      } else if (plot.points?.length) {
        const [px, py] = nearestPoint(plot.points, x)
        dots.push({ colour, x: px, y: py })
        rows.push({ id: plot.id, colour: plot.colour, label: plot.label, text: `x = ${write(px)}  y = ${write(py)}` })
      }
    }

    return { paint: { x, dots }, rows }
  }

  const showReadout = (rows: ReadoutRow[] | null, side: Readout['side']) => {
    const text = rows ? `${side}|${rows.map(row => `${row.id}:${row.colour}:${row.label}:${row.text}`).join('|')}` : ''

    if (text !== shown.current.readout) {
      shown.current.readout = text
      setReadout(rows?.length ? { rows, side } : null)
    }
  }

  const describe = (current: GraphViewport) => {
    const write = (value: number) => formatReadout(value, latest.current.locale)
    const text = `x from ${write(current.xMin)} to ${write(current.xMax)}, y from ${write(current.yMin)} to ${write(current.yMax)}`

    if (text !== shown.current.range && !rangeTimer.current) {
      rangeTimer.current = window.setTimeout(() => {
        rangeTimer.current = 0
        setRange(shown.current.range)
      }, 250)
    }

    shown.current.range = text
  }

  const paint = (now: number) => {
    const element = canvas.current
    const context = element?.getContext('2d')
    const { theme: colours, plots: drawn, compact: small, locale: language } = latest.current
    const { width, height } = size.current

    if (!element || !context || !colours || width < 2 || height < 2) {
      return
    }

    view.current ??= fitted()
    const moving = animation.current

    if (moving) {
      const t = (now - moving.start) / moving.duration
      view.current = lerpView(moving.from, moving.to, easeOut(t))

      if (t >= 1) {
        animation.current = null
      } else {
        schedule()
      }
    }

    const current = view.current
    const dpr = window.devicePixelRatio || 1
    const [deviceWidth, deviceHeight] = [Math.round(width * dpr), Math.round(height * dpr)]

    if (element.width !== deviceWidth || element.height !== deviceHeight) {
      element.width = deviceWidth
      element.height = deviceHeight
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    const busy = now < busyUntil.current || animation.current !== null
    const samples = Math.max(16, Math.round(busy ? width / 2 : width))
    const curves: CurvePaint[] = []
    const series: SeriesPaint[] = []

    for (const plot of drawn) {
      const colour = curveColour(colours, plot.colour)

      if (plot.fn) {
        const curve = sampled(plot, plot.fn, current, samples)
        curves.push({ colour, segments: curve.segments, asymptotes: curve.asymptotes })
      } else if (plot.points) {
        series.push({ colour, points: plot.points })
      }
    }

    const trace = traced(current, colours)
    drewPlots.current ||= drawn.length > 0
    drawGraph(context, { size: size.current, view: current, dpr, theme: colours, curves, series, trace: trace?.paint ?? null, compact: small, locale: language })
    showReadout(trace?.rows ?? null, trace && (trace.paint.x - current.xMin) / (current.xMax - current.xMin) < 0.45 ? 'right' : 'left')
    describe(current)

    // Drawn coarse while moving: once it stops, draw it again in full.
    if (busy && !animation.current) {
      window.clearTimeout(settleTimer.current)
      settleTimer.current = window.setTimeout(schedule, Math.max(16, busyUntil.current - now + 16))
    }
  }

  useLayoutEffect(() => {
    paintRef.current = paint
  })

  const plotsKey = useMemo(() => plots.map(plot => `${plot.id}:${plot.colour}:${plot.fn ? identityOf(plot.fn) : plot.points ? identityOf(plot.points) : ''}`).join('|'), [plots])
  const asked = useRef<{ xMin?: number; xMax?: number }>({ xMin, xMax })

  useEffect(() => {
    if (asked.current.xMin !== xMin || asked.current.xMax !== xMax) {
      asked.current = { xMin, xMax }
      auto.current = true
    }

    const ids = new Set(plotsKey.split('|').map(key => key.split(':')[0]))

    for (const id of cache.current.keys()) {
      if (!ids.has(id)) {
        cache.current.delete(id)
      }
    }

    if (auto.current && size.current.width >= 2) {
      goTo(fitted(), view.current !== null && drewPlots.current)
    } else {
      schedule()
    }
  }, [plotsKey, xMin, xMax, fitted, goTo, schedule])

  useEffect(schedule, [theme, locale, compact, schedule])

  useEffect(() => {
    const element = wrap.current

    if (!element) {
      return
    }

    const measure = (width: number, height: number) => {
      const before = size.current

      if (before.width === width && before.height === height) {
        return
      }

      size.current = { width, height }

      if (width < 2 || height < 2) {
        return
      }

      if (auto.current || !view.current || before.width < 2 || before.height < 2) {
        animation.current = null
        view.current = fitted()
      } else {
        // The plane keeps its scale and centre; the window shows more or less of it.
        const [cx, cy] = centreOf(view.current)
        const spanX = ((view.current.xMax - view.current.xMin) * width) / before.width
        const spanY = ((view.current.yMax - view.current.yMin) * height) / before.height
        view.current = { xMin: cx - spanX / 2, xMax: cx + spanX / 2, yMin: cy - spanY / 2, yMax: cy + spanY / 2 }
      }

      schedule()
    }

    const box = element.getBoundingClientRect()
    measure(box.width, box.height)
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width, entry.contentRect.height))
    observer.observe(element)

    return () => observer.disconnect()
  }, [fitted, schedule])

  useEffect(() => {
    let query: MediaQueryList | null = null
    const listen = () => {
      query?.removeEventListener('change', listen)
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      query.addEventListener('change', listen)
      schedule()
    }

    listen()

    return () => query?.removeEventListener('change', listen)
  }, [schedule])

  useEffect(
    () => () => {
      // A remount (React's development double mount too) schedules again only from a cleared frame.
      cancelAnimationFrame(frame.current)
      frame.current = 0
      window.clearTimeout(settleTimer.current)
      window.clearTimeout(rangeTimer.current)
      rangeTimer.current = 0
    },
    []
  )

  const spotOf = (event: { clientX: number; clientY: number }): Spot => {
    const rect = canvas.current?.getBoundingClientRect()

    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  const traceAt = (px: number) => {
    const current = view.current

    if (current) {
      traceX.current = worldX(current, size.current, px)
      schedule()
    }
  }

  useEffect(() => {
    const element = canvas.current

    if (!element) {
      return
    }

    // A pinch on a Mac trackpad arrives as a wheel event with ctrlKey, and needs the stronger zoom.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const current = view.current

      if (!current) {
        return
      }

      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.current.height : 1
      const delta = Math.max(-300, Math.min(300, event.deltaY * unit))
      const spot = spotOf(event)
      touched()
      view.current = zoomAbout(current, Math.exp(delta * (event.ctrlKey ? 0.01 : 0.0015)), [worldX(current, size.current, spot.x), worldY(current, size.current, spot.y)])

      if (traceX.current !== null) {
        traceX.current = worldX(view.current, size.current, spot.x)
      }

      schedule()
    }

    element.addEventListener('wheel', onWheel, { passive: false })

    return () => element.removeEventListener('wheel', onWheel)
  }, [schedule])

  const startPinch = () => {
    const [p, q] = [...pointers.current.values()]

    if (view.current && p && q) {
      gesture.current = { kind: 'pinch', view: view.current, distance: Math.max(1, Math.hypot(p.x - q.x, p.y - q.y)), middle: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } }
    }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return
    }

    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    const spot = spotOf(event)
    pointers.current.set(event.pointerId, spot)
    animation.current = null

    if (pointers.current.size >= 2) {
      startPinch()
      traceX.current = null
      schedule()

      return
    }

    if (event.shiftKey || event.altKey) {
      gesture.current = { kind: 'trace' }
      traceAt(spot.x)

      return
    }

    gesture.current = { kind: 'pan', last: spot, moved: false, touch: event.pointerType !== 'mouse' }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const spot = spotOf(event)
    const current = view.current
    const active = gesture.current

    if (pointers.current.has(event.pointerId)) {
      pointers.current.set(event.pointerId, spot)
    }

    if (!current) {
      return
    }

    if (active?.kind === 'pan') {
      const [dx, dy] = [spot.x - active.last.x, spot.y - active.last.y]

      if (!active.moved && Math.hypot(dx, dy) < 3) {
        return
      }

      if (!active.moved) {
        active.moved = true
        setDragging(true)
      }

      touched()
      view.current = panBy(current, size.current, dx, dy)
      active.last = spot
      traceX.current = null
      schedule()
    } else if (active?.kind === 'pinch') {
      const [p, q] = [...pointers.current.values()]

      if (!p || !q) {
        return
      }

      const middle = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }
      const anchor: [number, number] = [worldX(active.view, size.current, active.middle.x), worldY(active.view, size.current, active.middle.y)]
      touched()
      view.current = panBy(zoomAbout(active.view, active.distance / Math.max(1, Math.hypot(p.x - q.x, p.y - q.y)), anchor), size.current, middle.x - active.middle.x, middle.y - active.middle.y)
      schedule()
    } else if (active?.kind === 'trace' || (!active && event.pointerType !== 'touch')) {
      traceAt(spot.x)
    }
  }

  const onPointerEnd = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(event.pointerId)
    const active = gesture.current

    if (active?.kind === 'pinch') {
      const rest = [...pointers.current.values()][0]
      gesture.current = rest ? { kind: 'pan', last: rest, moved: true, touch: true } : null

      return
    }

    // A tap with a finger traces where it lands.
    if (active?.kind === 'pan' && !active.moved && active.touch && event.type === 'pointerup') {
      traceAt(spotOf(event).x)
    }

    if (!pointers.current.size) {
      gesture.current = null
      setDragging(false)
    }

    schedule()
  }

  const onPointerLeave = () => {
    if (!gesture.current && traceX.current !== null) {
      traceX.current = null
      schedule()
    }
  }

  const zoomStep = (factor: number) => {
    const base = heading()

    if (base) {
      auto.current = false
      goTo(zoomAbout(base, factor, centreOf(base)), true, motion.base)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const base = heading()

    if (!base || event.metaKey || event.ctrlKey) {
      return
    }

    const { width, height } = size.current
    const moves: Record<string, [number, number]> = { ArrowLeft: [width * 0.12, 0], ArrowRight: [-width * 0.12, 0], ArrowUp: [0, height * 0.12], ArrowDown: [0, -height * 0.12] }

    if (event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const visible = view.current ?? base
      const span = visible.xMax - visible.xMin
      const from = traceX.current ?? centreOf(visible)[0]
      traceX.current = Math.min(visible.xMax, Math.max(visible.xMin, from + (event.key === 'ArrowLeft' ? -span : span) / 100))
      schedule()
    } else if (moves[event.key]) {
      auto.current = false
      goTo(panBy(base, size.current, ...moves[event.key]), true, motion.base)
    } else if (event.key === '+' || event.key === '=') {
      zoomStep(1 / ZOOM_STEP)
    } else if (event.key === '-' || event.key === '_') {
      zoomStep(ZOOM_STEP)
    } else if (event.key === '0') {
      fit()
    } else if (event.key === 'Escape' && traceX.current !== null) {
      traceX.current = null
      schedule()
    } else {
      return
    }

    event.preventDefault()
  }

  const label = [description, range].filter(Boolean).join('; ')

  return (
    <div ref={wrap} className={cn('relative min-h-0 min-w-0 overflow-hidden', compact ? 'min-h-36' : 'min-h-64', className)}>
      <span ref={probe} aria-hidden className="hidden" />
      <canvas
        ref={canvas}
        role="application"
        aria-roledescription="graph"
        aria-label={label}
        aria-describedby={helpId}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerLeave={onPointerLeave}
        onDoubleClick={fit}
        onKeyDown={onKeyDown}
        className={cn('absolute inset-0 block size-full touch-none rounded-[inherit] outline-none select-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-inset', dragging ? 'cursor-grabbing' : 'cursor-crosshair')}
      />
      <p id={helpId} className="sr-only">
        Drag to move the graph, scroll or pinch to zoom, double-click to fit it. Keys: arrows move, plus and minus zoom, 0 fits, Shift with left or right traces the curves, Escape stops tracing.
      </p>
      {hint && !plots.length ? <p className={cn('pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-fg-4', compact ? 'text-[11.5px]' : 'text-[13px]')}>{hint}</p> : null}
      {readout ? (
        <div
          role="status"
          className={cn(
            'pointer-events-none absolute top-2 flex max-w-[min(70%,22rem)] flex-col gap-0.5 rounded-lg border border-line bg-surface px-2 py-1.5 font-mono text-fg-2 shadow-card',
            readout.side === 'left' ? 'left-2' : 'right-2',
            compact ? 'text-[10.5px]' : 'text-[12px]'
          )}
        >
          {readout.rows.map(row => (
            <p key={row.id} title={row.label} className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden className={cn('size-2 shrink-0 rounded-full', swatchOf(row.colour))} />
              <span className="sr-only">{row.label}: </span>
              <span className="overflow-hidden text-ellipsis whitespace-pre">{row.text}</span>
            </p>
          ))}
        </div>
      ) : null}
      {compact ? null : (
        <div className="absolute right-2 bottom-2 flex flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-card">
          <button type="button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomStep(1 / ZOOM_STEP)} className="flex size-8 items-center justify-center text-fg-2 hover:bg-white/8 hover:text-fg">
            <IconPlus size={15} />
          </button>
          <button type="button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomStep(ZOOM_STEP)} className="flex size-8 items-center justify-center border-t border-line text-fg-2 hover:bg-white/8 hover:text-fg">
            <IconMinus size={15} />
          </button>
          <button type="button" aria-label="Fit the graph to what it draws" title="Fit (0)" onClick={fit} className="flex size-8 items-center justify-center border-t border-line text-fg-2 hover:bg-white/8 hover:text-fg">
            <IconFocusCentered size={15} />
          </button>
        </div>
      )}
    </div>
  )
}
