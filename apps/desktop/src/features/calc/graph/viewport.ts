/*
 * The Graph view's arithmetic: which part of the plane is in view, where a point lands on the
 * canvas, the grid's ticks, zooming about a point and easing between views. Pure, so it is tested.
 */

export interface GraphViewport {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

/** The canvas in CSS pixels. */
export interface PlotSize {
  width: number
  height: number
}

export type Range = [number, number]

/** Spans narrower than this about `centre` lose their digits to floating point. */
const minSpan = (centre: number): number => Math.max(Math.abs(centre), 1) * 1e-10
const MAX_SPAN = 1e15
const MAX_CENTRE = 1e15

export const screenX = (view: GraphViewport, size: PlotSize, x: number): number => ((x - view.xMin) / (view.xMax - view.xMin)) * size.width

export const screenY = (view: GraphViewport, size: PlotSize, y: number): number => size.height - ((y - view.yMin) / (view.yMax - view.yMin)) * size.height

export const worldX = (view: GraphViewport, size: PlotSize, px: number): number => view.xMin + (px / size.width) * (view.xMax - view.xMin)

export const worldY = (view: GraphViewport, size: PlotSize, py: number): number => view.yMin + ((size.height - py) / size.height) * (view.yMax - view.yMin)

function clampAxis(min: number, max: number): Range {
  const middle = (min + max) / 2
  const centre = Number.isFinite(middle) ? Math.min(MAX_CENTRE, Math.max(-MAX_CENTRE, middle)) : 0
  const span = max - min
  const kept = Number.isFinite(span) ? Math.min(MAX_SPAN, Math.max(minSpan(centre), span)) : MAX_SPAN

  return kept === span && centre === middle ? [min, max] : [centre - kept / 2, centre + kept / 2]
}

/** The view with each span kept where floats still draw it, and its centre in reach. */
export function clampView(view: GraphViewport): GraphViewport {
  const [xMin, xMax] = clampAxis(view.xMin, view.xMax)
  const [yMin, yMax] = clampAxis(view.yMin, view.yMax)

  return { xMin, xMax, yMin, yMax }
}

/** The view moved with the pointer: `dx` and `dy` CSS pixels right and down. */
export function panBy(view: GraphViewport, size: PlotSize, dx: number, dy: number): GraphViewport {
  const across = (dx / size.width) * (view.xMax - view.xMin)
  const up = (dy / size.height) * (view.yMax - view.yMin)

  return clampView({ xMin: view.xMin - across, xMax: view.xMax - across, yMin: view.yMin + up, yMax: view.yMax + up })
}

function zoomAxis(min: number, max: number, at: number, factor: number): Range {
  const span = max - min
  const kept = Math.min(MAX_SPAN / span, Math.max(minSpan(at) / span, factor))

  return [at - (at - min) * kept, at + (max - at) * kept]
}

/** The view zoomed by `factor` (above 1 shows more) about the point `at`, which stays where it is on screen. */
export function zoomAbout(view: GraphViewport, factor: number, at: readonly [number, number], axes: 'both' | 'x' | 'y' = 'both'): GraphViewport {
  const [xMin, xMax] = axes === 'y' ? [view.xMin, view.xMax] : zoomAxis(view.xMin, view.xMax, at[0], factor)
  const [yMin, yMax] = axes === 'x' ? [view.yMin, view.yMax] : zoomAxis(view.yMin, view.yMax, at[1], factor)

  return clampView({ xMin, xMax, yMin, yMax })
}

/** The view's centre. */
export const centreOf = (view: GraphViewport): [number, number] => [(view.xMin + view.xMax) / 2, (view.yMin + view.yMax) / 2]

const powerOf = (value: number): number => 10 ** Math.floor(Math.log10(value) + 1e-9)

/** A step of 1, 2 or 5 times a power of ten that cuts `span` into about `parts` pieces. */
export function niceStep(span: number, parts: number): number {
  const raw = Math.abs(span) / Math.max(1, parts)

  if (!(raw > 0) || !Number.isFinite(raw)) {
    return 1
  }

  const power = powerOf(raw)
  const unit = raw / power

  return (unit < Math.SQRT2 ? 1 : unit < Math.sqrt(10) ? 2 : unit < Math.sqrt(50) ? 5 : 10) * power
}

/** The next nice step up: 1 to 2, 2 to 5, 5 to 10. */
export function largerStep(step: number): number {
  const power = powerOf(step)
  const unit = Math.round(step / power)

  return (unit === 1 ? 2 : unit === 2 ? 5 : 10) * power
}

/** The faint lines between ticks: fifths of a 1 or a 5, quarters of a 2. */
export function minorStep(step: number): number {
  return Math.round(step / powerOf(step)) === 2 ? step / 4 : step / 5
}

/** Decimal places a step of 1, 2 or 5 times a power of ten needs: 0.05 needs 2, 10 needs none. */
export const decimalsOf = (step: number): number => Math.max(0, -Math.floor(Math.log10(step) + 1e-9))

/** Multiples of `step` from `min` to `max`, without float noise (0.3, not 0.30000000000000004). */
export function ticksIn(min: number, max: number, step: number, limit = 2000): number[] {
  if (!(step > 0) || !Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    return []
  }

  const first = Math.ceil(min / step - 1e-9)
  const last = Math.floor(max / step + 1e-9)
  const decimals = Math.min(100, decimalsOf(step))
  const ticks: number[] = []

  for (let index = first; index <= last && ticks.length < limit; index++) {
    const value = decimals ? Number((index * step).toFixed(decimals)) : index * step
    ticks.push(value || 0)
  }

  return ticks
}

type Points = ReadonlyArray<readonly [number, number]>

export const DEFAULT_X: Range = [-10, 10]

/** The x range to fit: as asked, or the points' with a little room, or −10 to 10. */
export function xRangeFor(series: readonly Points[], xMin?: number, xMax?: number): Range {
  if (xMin !== undefined && xMax !== undefined && Number.isFinite(xMin) && Number.isFinite(xMax) && xMax > xMin) {
    return [xMin, xMax]
  }

  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY

  for (const points of series) {
    for (const [x] of points) {
      low = Math.min(low, x)
      high = Math.max(high, x)
    }
  }

  if (!(low <= high)) {
    return DEFAULT_X
  }

  const room = high > low ? (high - low) * 0.04 : 1

  return [low - room, high + room]
}

/** The y range of the points between `left` and `right`; null when none is there. */
export function yRangeIn(points: Points, [left, right]: Range): Range | null {
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY

  for (const [x, y] of points) {
    if (x >= left && x <= right) {
      low = Math.min(low, y)
      high = Math.max(high, y)
    }
  }

  return low <= high ? [low, high] : null
}

/** The point nearest `x` of points in order of x. */
export function nearestPoint(points: Points, x: number): readonly [number, number] {
  let [low, high] = [0, points.length - 1]

  while (high - low > 1) {
    const middle = (low + high) >> 1

    if (points[middle][0] < x) {
      low = middle
    } else {
      high = middle
    }
  }

  return Math.abs(points[low][0] - x) <= Math.abs(points[high][0] - x) ? points[low] : points[high]
}

/**
 * A view showing `x` and everything drawn in it, with room above and below; the x-axis joins in
 * when the values sit close to it. With nothing drawn, square units about 0.
 */
export function fitView(x: Range, ys: readonly (Range | null)[], size: PlotSize): GraphViewport {
  const [left, right] = x[1] > x[0] ? x : [x[0] - 1, x[0] + 1]
  const found = ys.filter((range): range is Range => range !== null && Number.isFinite(range[0]) && Number.isFinite(range[1]))

  if (!found.length) {
    const aspect = size.width > 0 && size.height > 0 ? size.height / size.width : 0.6
    const half = ((right - left) * aspect) / 2

    return clampView({ xMin: left, xMax: right, yMin: -half, yMax: half })
  }

  let low = Math.min(...found.map(range => range[0]))
  let high = Math.max(...found.map(range => range[1]))
  const span = high - low

  if (span <= Math.max(Math.abs(low), Math.abs(high), 1) * 1e-9) {
    const room = Math.max(Math.abs(low) * 0.5, 1)

    return clampView({ xMin: left, xMax: right, yMin: low - room, yMax: high + room })
  }

  if (low > 0 && low <= span * 0.5) {
    low = 0
  } else if (high < 0 && -high <= span * 0.5) {
    high = 0
  }

  const room = (high - low) * 0.08

  return clampView({ xMin: left, xMax: right, yMin: low - room, yMax: high + room })
}

function lerpAxis(fromMin: number, fromMax: number, toMin: number, toMax: number, t: number): Range {
  const centre = (fromMin + fromMax) / 2 + ((toMin + toMax) / 2 - (fromMin + fromMax) / 2) * t
  const span = (fromMax - fromMin) * ((toMax - toMin) / (fromMax - fromMin)) ** t

  return [centre - span / 2, centre + span / 2]
}

/** The view `t` of the way from `from` to `to`: centres glide evenly and spans in proportion, so a zoom feels steady. */
export function lerpView(from: GraphViewport, to: GraphViewport, t: number): GraphViewport {
  if (t <= 0) {
    return from
  }

  if (t >= 1) {
    return to
  }

  const [xMin, xMax] = lerpAxis(from.xMin, from.xMax, to.xMin, to.xMax, t)
  const [yMin, yMax] = lerpAxis(from.yMin, from.yMax, to.yMin, to.yMax, t)

  return { xMin, xMax, yMin, yMax }
}

export const easeOut = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3

/** Whether two views show the same thing to within a fraction of a pixel. */
export function sameView(a: GraphViewport, b: GraphViewport): boolean {
  const near = (p: number, q: number, span: number) => Math.abs(p - q) <= span * 1e-6

  return near(a.xMin, b.xMin, b.xMax - b.xMin) && near(a.xMax, b.xMax, b.xMax - b.xMin) && near(a.yMin, b.yMin, b.yMax - b.yMin) && near(a.yMax, b.yMax, b.yMax - b.yMin)
}
