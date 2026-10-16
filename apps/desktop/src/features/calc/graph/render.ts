import { formatTick } from './format.ts'
import type { GraphTheme } from './theme.ts'
import { type GraphViewport, largerStep, minorStep, niceStep, type PlotSize, screenX, screenY, ticksIn } from './viewport.ts'

/* One frame of the Graph view on a 2D canvas: grid, axes and their labels, asymptotes, curves, points and the trace. */

type Pair = readonly [number, number]

export interface CurvePaint {
  colour: string
  segments: ReadonlyArray<readonly Pair[]>
  asymptotes: readonly number[]
}

export interface SeriesPaint {
  colour: string
  points: readonly Pair[]
}

export interface TracePaint {
  x: number
  dots: ReadonlyArray<{ colour: string; x: number; y: number }>
}

export interface GraphFrame {
  size: PlotSize
  view: GraphViewport
  /** Device pixels a CSS pixel. */
  dpr: number
  theme: GraphTheme
  curves: readonly CurvePaint[]
  series: readonly SeriesPaint[]
  trace: TracePaint | null
  compact: boolean
  locale?: string
}

interface AxisTicks {
  step: number
  ticks: number[]
  labels: string[]
}

/** Ticks about `spacing` pixels apart, spread further while their labels would touch. */
function axisTicks(min: number, max: number, pixels: number, spacing: number, room: (labels: string[]) => number, locale?: string): AxisTicks {
  let step = niceStep(max - min, pixels / spacing)

  for (let tries = 0; ; tries++) {
    const ticks = ticksIn(min, max, step)
    const labels = ticks.map(value => formatTick(value, step, locale))

    if (tries >= 4 || (step / (max - min)) * pixels >= room(labels)) {
      return { step, ticks, labels }
    }

    step = largerStep(step)
  }
}

const onStep = (value: number, step: number): boolean => Math.abs(value / step - Math.round(value / step)) < 1e-6

/** Screen coordinates kept where the canvas still draws them exactly. */
const held = (value: number): number => Math.min(1e6, Math.max(-1e6, value))

export function drawGraph(context: CanvasRenderingContext2D, frame: GraphFrame): void {
  const { size, view, dpr, theme, compact, locale } = frame
  const { width, height } = size
  const fontSize = compact ? 10 : 11
  const toX = (x: number) => held(screenX(view, size, x))
  const toY = (y: number) => held(screenY(view, size, y))
  // A 1-pixel line sits on whole device pixels.
  const crisp = (value: number) => (Math.round(value * dpr - 0.5 * (dpr % 2)) + 0.5 * (dpr % 2)) / dpr

  context.clearRect(0, 0, width, height)
  context.font = `${fontSize}px ${theme.font}`
  context.lineJoin = 'round'
  context.lineCap = 'round'

  const widest = (labels: string[]) => Math.max(0, ...labels.map(text => context.measureText(text).width))
  const across = axisTicks(view.xMin, view.xMax, width, compact ? 72 : 96, labels => widest(labels) + 16, locale)
  const up = axisTicks(view.yMin, view.yMax, height, compact ? 40 : 56, () => fontSize * 2, locale)

  const vertical = (x: number) => {
    const px = crisp(toX(x))
    context.moveTo(px, 0)
    context.lineTo(px, height)
  }

  const horizontal = (y: number) => {
    const py = crisp(toY(y))
    context.moveTo(0, py)
    context.lineTo(width, py)
  }

  context.lineWidth = 1
  context.strokeStyle = theme.grid
  const minorX = minorStep(across.step)
  const minorY = minorStep(up.step)

  context.globalAlpha = 0.45
  context.beginPath()

  if ((minorX / (view.xMax - view.xMin)) * width >= 7) {
    ticksIn(view.xMin, view.xMax, minorX)
      .filter(x => !onStep(x, across.step))
      .forEach(vertical)
  }

  if ((minorY / (view.yMax - view.yMin)) * height >= 7) {
    ticksIn(view.yMin, view.yMax, minorY)
      .filter(y => !onStep(y, up.step))
      .forEach(horizontal)
  }

  context.stroke()
  context.globalAlpha = 1
  context.beginPath()
  across.ticks.filter(x => x !== 0).forEach(vertical)
  up.ticks.filter(y => y !== 0).forEach(horizontal)
  context.stroke()

  const showsX = view.yMin <= 0 && view.yMax >= 0
  const showsY = view.xMin <= 0 && view.xMax >= 0
  context.strokeStyle = theme.axis
  context.beginPath()

  if (showsY) {
    vertical(0)
  }

  if (showsX) {
    horizontal(0)
  }

  context.stroke()

  const label = (text: string, x: number, y: number) => {
    context.globalAlpha = 0.75
    context.strokeText(text, x, y)
    context.globalAlpha = 1
    context.fillText(text, x, y)
  }

  context.fillStyle = theme.label
  context.strokeStyle = theme.halo
  context.lineWidth = 3
  // Labels sit beside their axis, or along the edge it went past.
  const xLabels = Math.min(height - fontSize - 4, Math.max(4, toY(0) + 5))
  context.textAlign = 'center'
  context.textBaseline = 'top'
  across.ticks.forEach((x, index) => {
    const px = toX(x)

    if (x !== 0 && px > 14 && px < width - 14) {
      label(across.labels[index], px, xLabels)
    }
  })

  const yWidth = widest(up.labels)
  let yLabels = toX(0) - 6
  context.textAlign = 'right'

  if (yLabels - yWidth < 4) {
    yLabels = Math.max(4, toX(0) + 6)
    context.textAlign = 'left'
  }

  if (context.textAlign === 'left' && yLabels + yWidth > width - 4) {
    yLabels = width - 4
    context.textAlign = 'right'
  }

  context.textBaseline = 'middle'
  up.ticks.forEach((y, index) => {
    const py = toY(y)

    if (y !== 0 && py > 8 && py < height - 8 && Math.abs(py - (xLabels + fontSize / 2)) > fontSize) {
      label(up.labels[index], yLabels, py)
    }
  })

  if (showsX && showsY) {
    context.textAlign = 'right'
    context.textBaseline = 'top'
    label(formatTick(0, across.step, locale), toX(0) - 5, toY(0) + 5)
  }

  context.lineWidth = 1
  context.setLineDash([4, 4])

  for (const curve of frame.curves) {
    context.strokeStyle = curve.colour
    context.globalAlpha = 0.5
    context.beginPath()
    curve.asymptotes.filter(x => x >= view.xMin && x <= view.xMax).forEach(vertical)
    context.stroke()
  }

  context.setLineDash([])
  context.globalAlpha = 1
  const weight = compact ? 1.75 : 2.25

  for (const curve of frame.curves) {
    const singles: Pair[] = []
    context.strokeStyle = curve.colour
    context.fillStyle = curve.colour
    context.lineWidth = weight
    context.beginPath()

    for (const segment of curve.segments) {
      if (segment.length === 1) {
        singles.push(segment[0])

        continue
      }

      segment.forEach(([x, y], index) => (index ? context.lineTo(toX(x), toY(y)) : context.moveTo(toX(x), toY(y))))
    }

    context.stroke()

    for (const [x, y] of singles) {
      context.beginPath()
      context.arc(toX(x), toY(y), weight * 0.9, 0, Math.PI * 2)
      context.fill()
    }
  }

  for (const series of frame.series) {
    const points = series.points
    const first = Math.max(0, points.findIndex(([x]) => x >= view.xMin) - 1)
    const after = points.findIndex(([x]) => x > view.xMax)
    const shown = points.slice(first, after < 0 ? points.length : after + 1)

    if (!shown.length) {
      continue
    }

    context.strokeStyle = series.colour
    context.fillStyle = series.colour
    context.lineWidth = compact ? 1.5 : 1.75
    context.beginPath()
    shown.forEach(([x, y], index) => (index ? context.lineTo(toX(x), toY(y)) : context.moveTo(toX(x), toY(y))))
    context.stroke()

    if (width / shown.length >= 5) {
      context.lineWidth = 1.5

      for (const [x, y] of shown) {
        context.beginPath()
        context.arc(toX(x), toY(y), compact ? 2.25 : 3, 0, Math.PI * 2)
        context.strokeStyle = theme.halo
        context.stroke()
        context.fill()
      }
    }
  }

  if (frame.trace) {
    context.strokeStyle = theme.axis
    context.lineWidth = 1
    context.beginPath()
    vertical(frame.trace.x)
    context.stroke()

    for (const dot of frame.trace.dots) {
      const [px, py] = [toX(dot.x), toY(dot.y)]

      if (py < -8 || py > height + 8) {
        continue
      }

      context.beginPath()
      context.arc(px, py, compact ? 3.5 : 4.5, 0, Math.PI * 2)
      context.fillStyle = dot.colour
      context.fill()
      context.lineWidth = 2
      context.strokeStyle = theme.halo
      context.stroke()
    }
  }
}
