import type { CompiledFunction } from '../engine/types.ts'
import type { SheetPlotRef } from './types.ts'
import { niceStep, ticksIn } from './viewport.ts'

/* Sampling functions for drawing and for Hermes's summary of a graph: pure, so it is unit-tested. */

export interface SampledCurve {
  /** Continuous pieces in order of x; a gap, a jump or an asymptote ends one. */
  segments: Array<Array<[number, number]>>
  /** The x of each vertical asymptote found. */
  asymptotes: number[]
  /** The finite y range seen, the blow-ups beside an asymptote left out; null when it had no value anywhere. */
  yRange: [number, number] | null
}

export interface FunctionSummary {
  xMin: number
  xMax: number
  yMin: number | null
  yMax: number | null
  /** Where it crosses zero. */
  zeros: number[]
  extrema: Array<{ x: number; y: number; kind: 'min' | 'max' }>
  asymptotes: number[]
  /** Ranges of x where it has no value ("sqrt(x)" below 0). */
  gaps: Array<[number, number]>
  /** A few points to quote. */
  samples: Array<[number, number]>
}

type Point = [number, number]
type Range = [number, number]

interface Found {
  at: number
  /** The closest points on either side. */
  left: Point
  right: Point
  kind: 'jump' | 'pole' | 'hole'
}

/** A pixel's width is halved at most this many times where the curve bends or jumps. */
const MAX_DEPTH = 10
/** Evaluations one pixel's width may spend on bends, so a curve that never settles (sin(1/x) near 0) stays cheap. */
const PIXEL_BUDGET = 32
/** Halvings that tell a jump from a steep stretch, and that find where the values stop. */
const JUMP_STEPS = 32
const EDGE_STEPS = 52
/** How far past the view, in views, a curve runs before it is cut. */
const BAND = 2
const SUMMARY_SAMPLES = 1024
const MOST_LISTED = 24

const finite = (value: number): boolean => Number.isFinite(value)

const safely =
  (fn: CompiledFunction) =>
  (x: number): number => {
    try {
      const y = fn(x)

      return typeof y === 'number' ? y : Number.NaN
    } catch {
      return Number.NaN
    }
  }

/** Up to a quarter step off a regular grid, the same at the same x wherever the view is: panning does not shimmer, and no sample lands on a pole by luck. */
function jitter(index: number): number {
  const noise = Math.sin(index * 12.9898) * 43758.5453

  return (noise - Math.floor(noise) - 0.5) * 0.5
}

function gridOf(xMin: number, xMax: number, step: number, intervals: number): number[] {
  const xs = [xMin]
  const first = Math.ceil(xMin / step)
  const count = Math.min(intervals + 2, Math.floor(xMax / step) - first + 1)

  for (let offset = 0; offset < count; offset++) {
    const x = (first + offset + jitter(first + offset)) * step

    if (x > xs[xs.length - 1] + step * 0.2 && x < xMax - step * 0.2) {
      xs.push(x)
    }
  }

  xs.push(xMax)

  return xs
}

/** The range the values mostly keep to: all of them, unless a few run far off (beside an asymptote), which are left out. */
function typicalRange(values: readonly number[]): Range | null {
  const sorted = values.filter(finite).sort((p, q) => p - q)

  if (!sorted.length) {
    return null
  }

  const min = sorted[0]
  const max = sorted[sorted.length - 1]

  if (sorted.length < 16) {
    return [min, max]
  }

  const at = (share: number) => sorted[Math.round(share * (sorted.length - 1))]
  const low = at(0.03)
  const high = at(0.97)
  const spread = high - low

  return min >= low - spread && max <= high + spread ? [min, max] : [Math.max(min, low - spread * 0.15), Math.min(max, high + spread * 0.15)]
}

function merged(values: readonly number[], within: number): number[] {
  const out: number[] = []

  for (const value of [...values].sort((p, q) => p - q)) {
    if (!out.length || value - out[out.length - 1] > within) {
      out.push(value)
    }
  }

  return out
}

interface Traced {
  /** The curve as evaluated, nothing cut off. */
  segments: Point[][]
  asymptotes: number[]
  gaps: Range[]
  /** What the evenly spaced samples mostly keep to. */
  typical: Range | null
  /** Every finite value drawn. */
  full: Range | null
}

/**
 * The curve between xMin and xMax: one sample a pixel to start, each pixel's width halved where the
 * curve bends more than half a pixel off a straight line. A step of more than a pixel is followed
 * down to tell a jump or a pole (a cut, and for a pole an asymptote) from a steep stretch (a line);
 * a pole the values keep their sign across (1/x² at 0) shows as a peak among the samples instead.
 * Where it stops having values, the edge is found by halving and the curve ends there.
 */
function trace(fn: CompiledFunction, xMin: number, xMax: number, samples: number, yView: Range | null): Traced {
  const intervals = Math.round(Math.min(4096, Math.max(8, samples)))
  const width = xMax - xMin
  const step = width / intervals
  const evaluate = safely(fn)
  let budget = intervals * 40 + 4096
  let local = 0

  const f = (x: number): number => {
    budget--

    return evaluate(x)
  }

  const xs = gridOf(xMin, xMax, step, intervals)
  const ys = xs.map(f)
  const typical = typicalRange(ys)
  const view = yView ?? typical ?? [-1, 1]
  const span = view[1] - view[0] || Math.max(Math.abs(view[0]), 1)
  // A pixel's height, taking the plot to be about 0.6 times as tall as it is wide.
  const pixel = span / (intervals * 0.6)
  const tolerance = pixel * 0.5
  const jump = pixel
  const low = view[0] - span * BAND
  const high = view[1] + span * BAND
  const reach = typical ? Math.max(Math.abs(typical[0]), Math.abs(typical[1]), typical[1] - typical[0]) : 1

  const segments: Point[][] = []
  const asymptotes: number[] = []
  const gaps: Range[] = []
  let current: Point[] = []
  let hole: number | null = null
  let lowest = Number.POSITIVE_INFINITY
  let highest = Number.NEGATIVE_INFINITY

  const emit = (x: number, y: number) => {
    const last = current[current.length - 1]

    if (last && x <= last[0]) {
      return
    }

    current.push([x, y])
    lowest = Math.min(lowest, y)
    highest = Math.max(highest, y)
  }

  const cut = () => {
    if (current.length) {
      segments.push(current)
    }

    current = []
  }

  /**
   * Approaching `edge` from `side`, the values grow without end (log near 0 counts; sqrt near 0
   * does not). `nearest` is how well the edge is known: closer than that, a sample could be past it.
   */
  const blowsUp = (edge: number, side: -1 | 1, nearest: number): boolean => {
    const near = Math.min(step / 2, Math.max(nearest, Math.abs(edge) * 1e-15, Number.MIN_VALUE))
    const ratio = (near / step) ** 0.1
    const trail: number[] = []

    for (let distance = step, count = 0; count <= 10; distance *= ratio, count++) {
      const x = edge + side * distance

      if (x === edge) {
        break
      }

      const y = f(x)

      if (!finite(y)) {
        break
      }

      trail.push(y)
    }

    const count = trail.length

    if (count < 4) {
      return false
    }

    const last = trail[count - 1]
    const before = trail[count - 2] - trail[count - 3]
    const after = last - trail[count - 2]

    return Math.abs(last) > reach * 2 && after !== 0 && Math.sign(after) === Math.sign(before) && Math.abs(after) >= Math.abs(before) * 0.8
  }

  /** The last point with a value from (a, fa) toward b, which has none, and how far past it the values may still go on. */
  const edgeFrom = (a: number, fa: number, b: number): [number, number, number] => {
    let inside = a
    let value = fa
    let outside = b

    for (let halving = 0; halving < EDGE_STEPS; halving++) {
      const middle = (inside + outside) / 2

      if (middle === inside || middle === outside) {
        break
      }

      const y = f(middle)

      if (finite(y)) {
        inside = middle
        value = y
      } else {
        outside = middle
      }
    }

    return [inside, value, Math.abs(outside - inside)]
  }

  const beyond = (p: number, q: number): boolean => (p > high && q > high) || (p < low && q < low)

  /**
   * A jump, a pole or a hole between two points, followed down by the bigger change; null for a
   * steep but unbroken stretch, and for anything wholly past the band, where nothing shows.
   */
  const breakIn = (a: number, fa: number, b: number, fb: number): Found | null => {
    const first = Math.abs(fb - fa)
    let left: Point = [a, fa]
    let right: Point = [b, fb]

    for (let halving = 0; halving < JUMP_STEPS; halving++) {
      const middle = (left[0] + right[0]) / 2

      if (middle === left[0] || middle === right[0]) {
        break
      }

      const y = f(middle)

      if (!finite(y)) {
        return { at: middle, left, right, kind: 'hole' }
      }

      if (Math.abs(y - left[1]) >= Math.abs(right[1] - y)) {
        right = [middle, y]
      } else {
        left = [middle, y]
      }

      if (Math.abs(right[1] - left[1]) <= Math.max(tolerance, first * 0.25) || beyond(left[1], right[1])) {
        return null
      }
    }

    const at = (left[0] + right[0]) / 2
    const known = right[0] - left[0]

    return { at, left, right, kind: blowsUp(at, -1, known) || blowsUp(at, 1, known) ? 'pole' : 'jump' }
  }

  const refine = (a: number, fa: number, b: number, fb: number, depth: number): void => {
    const middle = (a + b) / 2

    if (depth >= MAX_DEPTH || middle === a || middle === b || local <= 0 || budget <= 0) {
      // Out of evaluations, a flip through huge values is taken for a pole rather than drawn across the view.
      if ((fa > high && fb < low) || (fa < low && fb > high)) {
        cut()
      }

      emit(b, fb)

      return
    }

    if (Math.abs(fb - fa) > jump && !beyond(fa, fb)) {
      local -= 4
      const found = breakIn(a, fa, b, fb)

      if (found) {
        split(a, fa, b, fb, found, depth + 1)

        return
      }
    }

    local--
    const fm = f(middle)

    if (!finite(fm)) {
      leave(a, fa, middle, depth + 1)
      enter(middle, b, fb, depth + 1)

      return
    }

    // Past the band and heading away from the view: nothing there to see.
    const away = beyond(fa, fb) && (fa > high ? fm > high && fm <= Math.max(fa, fb) : fm < low && fm >= Math.min(fa, fb))

    if (!away && Math.abs(fm - (fa + fb) / 2) > tolerance) {
      refine(a, fa, middle, fm, depth + 1)
      refine(middle, fm, b, fb, depth + 1)

      return
    }

    emit(middle, fm)
    emit(b, fb)
  }

  /** The curve on either side of what `breakIn` found. */
  const split = (a: number, fa: number, b: number, fb: number, found: Found, depth: number) => {
    const [[left, fl], [right, fr]] = [found.left, found.right]

    if (left > a) {
      refine(a, fa, left, fl, depth)
    }

    if (found.kind === 'hole') {
      leave(left, fl, found.at, depth)
      enter(found.at, right, fr, depth)
    } else {
      cut()

      if (found.kind === 'pole') {
        asymptotes.push(found.at)
      }

      emit(right, fr)
    }

    if (right < b) {
      refine(right, fr, b, fb, depth)
    }
  }

  /** From (a, fa) the function stops having values before b. */
  const leave = (a: number, fa: number, b: number, depth: number) => {
    const [x, y, known] = edgeFrom(a, fa, b)

    if (x > a) {
      refine(a, fa, x, y, depth)
    }

    if (blowsUp(x, -1, known)) {
      asymptotes.push(x)
    }

    cut()
    hole = x
  }

  /** After a, where it has no value, the function has values again by (b, fb). */
  const enter = (a: number, b: number, fb: number, depth: number) => {
    const [x, y, known] = edgeFrom(b, fb, a)

    if (blowsUp(x, 1, known)) {
      asymptotes.push(x)
    }

    if (hole !== null && x - hole > width * 1e-9) {
      gaps.push([hole, x])
    }

    hole = null
    emit(x, y)

    if (x < b) {
      refine(x, y, b, fb, depth)
    }
  }

  /** How far the sample at `index` sits off the straight line through its neighbours. */
  const offLine = (index: number): number => {
    if (index <= 0 || index >= xs.length - 1) {
      return 0
    }

    const [x0, x1, x2] = [xs[index - 1], xs[index], xs[index + 1]]
    const [y0, y1, y2] = [ys[index - 1], ys[index], ys[index + 1]]

    if (!finite(y0) || !finite(y2)) {
      return Number.POSITIVE_INFINITY
    }

    return Math.abs(y1 - (y0 + ((y2 - y0) * (x1 - x0)) / (x2 - x0)))
  }

  const past = (y: number): boolean => y > high || y < low

  /**
   * A pole the values do not change sign across (1/x² at 0): the top of the peak of |f| between a
   * and b, when the values climb without end there. Halving on the bigger change can miss it.
   */
  const poleIn = (a: number, b: number): { at: number; left: Point; right: Point } | null => {
    const ratio = (Math.sqrt(5) - 1) / 2
    const size = (x: number): number => {
      const y = Math.abs(f(x))

      return Number.isNaN(y) ? -1 : y
    }

    let [lower, upper] = [a, b]
    let [c, d] = [upper - ratio * (upper - lower), lower + ratio * (upper - lower)]
    let [sc, sd] = [size(c), size(d)]

    for (let step = 0; step < 80 && c < d; step++) {
      if (sc > sd) {
        upper = d
        d = c
        sd = sc
        c = upper - ratio * (upper - lower)
        sc = size(c)
      } else {
        lower = c
        c = d
        sc = sd
        d = lower + ratio * (upper - lower)
        sd = size(d)
      }
    }

    const at = (lower + upper) / 2
    const known = upper - lower

    return blowsUp(at, -1, known) || blowsUp(at, 1, known) ? { at, left: [lower, f(lower)], right: [upper, f(upper)] } : null
  }

  const poles: Array<{ at: number; left: Point; right: Point }> = []

  for (let index = 1; index < xs.length - 1 && budget > 0; index++) {
    const [y0, y1, y2] = [ys[index - 1], ys[index], ys[index + 1]]

    if (finite(y0) && finite(y1) && finite(y2) && past(y1) && Math.sign(y0) === Math.sign(y1) && Math.sign(y1) === Math.sign(y2) && Math.abs(y1) >= Math.abs(y0) && Math.abs(y1) >= Math.abs(y2)) {
      const pole = poleIn(xs[index - 1], xs[index + 1])

      if (pole && !poles.some(known => Math.abs(known.at - pole.at) <= width * 1e-9)) {
        poles.push(pole)
      }
    }
  }

  poles.sort((p, q) => p.at - q.at)
  let nextPole = 0

  if (finite(ys[0])) {
    emit(xs[0], ys[0])
  } else {
    hole = xs[0]
  }

  for (let index = 0; index < xs.length - 1; index++) {
    const [a, b] = [xs[index], xs[index + 1]]
    const [fa, fb] = [ys[index], ys[index + 1]]
    local = PIXEL_BUDGET

    while (nextPole < poles.length && poles[nextPole].at <= a) {
      nextPole++
    }

    const pole = poles[nextPole]

    if (finite(fa) && finite(fb)) {
      if (pole && pole.at < b && finite(pole.left[1]) && finite(pole.right[1])) {
        nextPole++
        refine(a, fa, pole.left[0], pole.left[1], 0)
        cut()
        asymptotes.push(pole.at)
        emit(pole.right[0], pole.right[1])
        refine(pole.right[0], pole.right[1], b, fb, 0)
      } else if (Math.max(offLine(index), offLine(index + 1)) > tolerance) {
        refine(a, fa, b, fb, 0)
      } else {
        emit(b, fb)
      }
    } else if (finite(fa)) {
      leave(a, fa, b, 0)
    } else if (finite(fb)) {
      enter(a, b, fb, 0)
    }
  }

  cut()

  if (hole !== null && xMax - hole > width * 1e-9) {
    gaps.push([hole, xMax])
  }

  return { segments, asymptotes: merged(asymptotes, width * 1e-9), gaps, typical, full: lowest <= highest ? [lowest, highest] : null }
}

function clipEdge(from: Point, to: Point, low: number, high: number): [Point, Point] | null {
  const [x0, y0] = from
  const [x1, y1] = to

  if ((y0 < low && y1 < low) || (y0 > high && y1 > high)) {
    return null
  }

  const at = (y: number): Point => [x0 + ((x1 - x0) * (y - y0)) / (y1 - y0), y]

  return [y0 < low ? at(low) : y0 > high ? at(high) : from, y1 < low ? at(low) : y1 > high ? at(high) : to]
}

/** The segments cut to the band from `low` to `high`; a piece that leaves it and comes back is two pieces. */
function clipped(segments: readonly Point[][], low: number, high: number): Point[][] {
  const out: Point[][] = []

  for (const segment of segments) {
    if (segment.length === 1) {
      if (segment[0][1] >= low && segment[0][1] <= high) {
        out.push(segment)
      }

      continue
    }

    let piece: Point[] = []

    for (let index = 1; index < segment.length; index++) {
      const edge = clipEdge(segment[index - 1], segment[index], low, high)
      const last = piece[piece.length - 1]

      if (!edge || !last || last[0] !== edge[0][0] || last[1] !== edge[0][1]) {
        if (piece.length) {
          out.push(piece)
        }

        piece = edge ? [edge[0]] : []
      }

      if (edge) {
        piece.push(edge[1])
      }
    }

    if (piece.length) {
      out.push(piece)
    }
  }

  return out
}

const rangeOrNull = (range: readonly [number, number] | undefined): Range | null => (range && finite(range[0]) && finite(range[1]) && range[1] > range[0] ? [range[0], range[1]] : null)

/** Points to draw `fn` between xMin and xMax, adaptively finer where it bends, split at gaps, jumps and asymptotes, and cut a little past `yView`. */
export function sampleFunction(fn: CompiledFunction, xMin: number, xMax: number, options: { samples?: number; yView?: [number, number] } = {}): SampledCurve {
  if (!(finite(xMin) && finite(xMax) && xMax > xMin)) {
    return { segments: [], asymptotes: [], yRange: null }
  }

  const view = rangeOrNull(options.yView)
  const traced = trace(fn, xMin, xMax, options.samples ?? 512, view)
  const yRange = traced.asymptotes.length ? traced.typical : traced.full
  const around = view ?? traced.typical

  if (!around) {
    return { segments: traced.segments, asymptotes: traced.asymptotes, yRange }
  }

  const span = around[1] - around[0] || Math.max(Math.abs(around[0]), 1)

  return { segments: clipped(traced.segments, around[0] - span * BAND, around[1] + span * BAND), asymptotes: traced.asymptotes, yRange }
}

/** Where `f` crosses zero between a, where it is `fa`, and b, by halving. */
function rootBetween(f: (x: number) => number, a: number, fa: number, b: number): number {
  let low = a
  let high = b
  let value = fa

  for (let halving = 0; halving < 80; halving++) {
    const middle = (low + high) / 2

    if (middle === low || middle === high) {
      break
    }

    const y = f(middle)

    if (y === 0) {
      return middle
    }

    if (!finite(y)) {
      break
    }

    if (Math.sign(y) === Math.sign(value)) {
      low = middle
      value = y
    } else {
      high = middle
    }
  }

  return (low + high) / 2
}

/** Where the slope changes sign between a and b, halving on the sign of a central difference `h` wide. */
function turnBetween(f: (x: number) => number, a: number, b: number, kind: 'min' | 'max', h: number): Point | null {
  let low = a
  let high = b

  for (let halving = 0; halving < 80; halving++) {
    const middle = (low + high) / 2

    if (middle === low || middle === high) {
      break
    }

    const slope = f(middle + h) - f(middle - h)

    if (!finite(slope)) {
      return null
    }

    if (slope === 0) {
      low = middle
      high = middle

      break
    }

    if (slope > 0 === (kind === 'max')) {
      low = middle
    } else {
      high = middle
    }
  }

  const x = (low + high) / 2
  const y = f(x)
  const margin = (b - a) * 1e-6

  return finite(y) && x > a + margin && x < b - margin ? [x, y] : null
}

/** What a graph of `fn` shows between xMin and xMax, in numbers: x to about 10 digits of the range, y to 10 significant digits. */
export function summarizeFunction(fn: CompiledFunction, xMin: number, xMax: number): FunctionSummary {
  const summary: FunctionSummary = { xMin, xMax, yMin: null, yMax: null, zeros: [], extrema: [], asymptotes: [], gaps: [], samples: [] }

  if (!(finite(xMin) && finite(xMax) && xMax > xMin)) {
    return summary
  }

  const width = xMax - xMin
  const traced = trace(fn, xMin, xMax, SUMMARY_SAMPLES, null)
  const f = safely(fn)
  const typical = traced.typical ?? [0, 0]
  const scale = Math.max(Math.abs(typical[0]), Math.abs(typical[1]), typical[1] - typical[0], Number.MIN_VALUE)
  const quantum = 10 ** (Math.floor(Math.log10(width)) - 10)
  const atX = (x: number): number => Number((Math.round(x / quantum) * quantum).toPrecision(12)) || 0
  const atY = (y: number): number => (Math.abs(y) < scale * 1e-12 ? 0 : Number(y.toPrecision(10)) || 0)
  const zeros: number[] = []
  const extrema: FunctionSummary['extrema'] = []

  for (const segment of traced.segments) {
    let direction = 0
    let from = 0

    for (let index = 0; index < segment.length; index++) {
      const [x, y] = segment[index]
      const previous = segment[index - 1]

      if (y === 0 && (!previous || previous[1] !== 0)) {
        zeros.push(x)
      } else if (previous && previous[1] !== 0 && y !== 0 && Math.sign(previous[1]) !== Math.sign(y)) {
        zeros.push(rootBetween(f, previous[0], previous[1], x))
      }

      const change = previous ? y - previous[1] : 0

      if (Math.abs(change) <= scale * 1e-12) {
        continue
      }

      const sign = Math.sign(change)

      if (direction && sign !== direction) {
        const kind = direction > 0 ? 'max' : 'min'
        const turn = turnBetween(f, segment[from][0], x, kind, width * 1e-7)
        const ends = [segment[from][1], y]

        if (turn && (kind === 'max' ? turn[1] >= Math.max(...ends) : turn[1] <= Math.min(...ends))) {
          extrema.push({ x: turn[0], y: turn[1], kind })

          if (Math.abs(turn[1]) <= scale * 1e-9) {
            zeros.push(turn[0])
          }
        }
      }

      direction = sign
      from = index - 1
    }
  }

  summary.zeros = merged(zeros.map(atX), quantum * 10).slice(0, MOST_LISTED)
  summary.extrema = extrema.slice(0, MOST_LISTED).map(extremum => ({ x: atX(extremum.x), y: atY(extremum.y), kind: extremum.kind }))
  summary.asymptotes = traced.asymptotes.map(atX)
  summary.gaps = traced.gaps.map(([from, to]): Range => [atX(from), atX(to)])

  const range = traced.asymptotes.length ? traced.typical : traced.full

  if (range) {
    const ys = traced.asymptotes.length ? [] : extrema.map(extremum => extremum.y)
    summary.yMin = atY(Math.min(range[0], ...ys))
    summary.yMax = atY(Math.max(range[1], ...ys))
  }

  for (const x of ticksIn(xMin, xMax, niceStep(width, 6)).slice(0, 9)) {
    const y = f(x)

    if (finite(y)) {
      summary.samples.push([x, atY(y)])
    }
  }

  return summary
}

const EXTENSION = String.raw`\.(?:xlsx|xlsm|xls|csv|ods)`

/** A sheet's name: in quotes, or one word. */
const sheetName = (key: string): string => String.raw`(?:'(?<${key}1>[^']+)'|"(?<${key}2>[^"]+)"|“(?<${key}3>[^”]+)”|‘(?<${key}4>[^’]+)’|(?<${key}5>[^\s'"“”‘’,!]+))`

/** "column B", "col C", "B2:B40", "B:B", "Expenses!B2:B9". */
const CELLS = String.raw`(?:the\s+)?(?:(?:column|col\.?)\s+(?<column>[a-z]{1,3})|(?:${sheetName('prefix')}!)?(?<range>\$?[a-z]{1,3}\$?\d+(?::\$?[a-z]{1,3}\$?\d+)?|\$?[a-z]{1,3}:\$?[a-z]{1,3}))`

/** "of sheet Expenses", "in the Expenses sheet". */
const SHEET_AFTER = String.raw`(?:\s+(?:of|in|on|from)\s+(?:the\s+)?(?:sheet|tab)\s+${sheetName('after')}|\s+(?:of|in|on|from)\s+(?:the\s+)?${sheetName('afterNamed')}\s+(?:sheet|tab))`

/** "sheet Expenses,", "on the Expenses sheet". */
const SHEET_BEFORE = String.raw`(?:(?:on|in)\s+)?(?:the\s+)?(?:(?:sheet|tab)\s+${sheetName('before')}|${sheetName('beforeNamed')}\s+(?:sheet|tab)),?\s+`

const CELLS_OF_FILE = new RegExp(String.raw`^${CELLS}${SHEET_AFTER}?\s+(?:of|in|from)\s+(?:the\s+)?(?:(?:file|workbook|spreadsheet)\s+)?(?<file>.+)$`, 'iu')

const FILE_THEN_CELLS = new RegExp(String.raw`^(?:the\s+)?["'“‘]?(?<file>.+?${EXTENSION})["'”’]?(?:\s*[,:]\s*|\s+|!)(?:${SHEET_BEFORE})?${CELLS}${SHEET_AFTER}?$`, 'iu')

const IS_WORKBOOK = new RegExp(`${EXTENSION}$`, 'i')

const unquoted = (text: string): string => text.trim().replace(/^["'“‘](.*)["'”’]$/u, '$1').trim()

/** "column B of Budget.xlsx", "B2:B40 in ~/Sales.xlsx", "Budget.xlsx column C": the cells to plot, or null. */
export function parseSheetPlot(text: string): SheetPlotRef | null {
  const asked = text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(?:please\s+)?(?:plot|graph|draw)(?:\s+me)?\s+/i, '')
    .replace(/[.!?]+$/, '')
  const groups = (CELLS_OF_FILE.exec(asked) ?? FILE_THEN_CELLS.exec(asked))?.groups

  if (!groups) {
    return null
  }

  const workbook = unquoted(groups.file ?? '')
  const column = groups.column?.toUpperCase()
  const range = column ? `${column}:${column}` : groups.range?.replace(/\$/g, '').toUpperCase()

  if (!range || !IS_WORKBOOK.test(workbook)) {
    return null
  }

  const named = (key: string): string | undefined => [1, 2, 3, 4, 5].map(index => groups[`${key}${index}`]).find(value => value !== undefined)
  const sheet = named('prefix') ?? named('after') ?? named('afterNamed') ?? named('before') ?? named('beforeNamed')

  return { workbook, range, ...(sheet ? { sheet } : {}) }
}
