import { Fragment, type SVGProps, useId } from 'react'
import type { Fill, Gradient, Stroke, Theme } from '../deck.ts'
import { dashArray, type ShapePart } from '../shapes.ts'
import { cssColor, resolveColor } from '../themes.ts'

/*
 * A shape's paths painted as PowerPoint paints them: each part filled with the shape's fill (a
 * colour, or a gradient laid across the shape's box), a shade darker or lighter, or not at all,
 * and outlined where the preset outlines it. A shaded part is the fill with black or white over
 * it, so a gradient shades as a colour does.
 */

const SHADES = { darken: ['#000000', 0.4], darkenLess: ['#000000', 0.2], lighten: ['#ffffff', 0.4], lightenLess: ['#ffffff', 0.2] } as const

const sortedStops = (gradient: Pick<Gradient, 'stops'>) => [...gradient.stops].sort((a, b) => a.at - b.at)

/** A gradient as a CSS image: along its angle, or out from the middle to the corners. */
export function gradientCss(gradient: Pick<Gradient, 'stops' | 'angle' | 'radial'>, theme: Theme): string {
  const stops = sortedStops(gradient).map((stop) => `${cssColor(stop.color, theme, stop.alpha ?? 1)} ${Math.round(stop.at * 1000) / 10}%`)

  return gradient.radial ? `radial-gradient(ellipse farthest-corner at 50% 50%, ${stops.join(', ')})` : `linear-gradient(${gradient.angle + 90}deg, ${stops.join(', ')})`
}

/** Where a gradient at `angle` degrees (0 left to right, 90 top to bottom) starts and ends in a `w` by `h` box, so its end colours just reach the corners. */
export function gradientLine(angle: number, w: number, h: number): { x1: number; y1: number; x2: number; y2: number } {
  const radians = (angle * Math.PI) / 180
  const dx = Math.cos(radians)
  const dy = Math.sin(radians)
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2
  const at = (value: number) => Math.round(value * 1000) / 1000

  return { x1: at(w / 2 - dx * half), y1: at(h / 2 - dy * half), x2: at(w / 2 + dx * half), y2: at(h / 2 + dy * half) }
}

function GradientDef({ id, gradient, theme, width, height }: { id: string; gradient: Gradient; theme: Theme; width: number; height: number }) {
  const stops = sortedStops(gradient).map((stop, index) => <stop key={index} offset={stop.at} stopColor={resolveColor(stop.color, theme)} stopOpacity={stop.alpha} />)

  if (gradient.radial) {
    const w = Math.max(width, 0.001) * Math.SQRT1_2
    const h = Math.max(height, 0.001) * Math.SQRT1_2

    return (
      <radialGradient id={id} gradientUnits="userSpaceOnUse" cx={0} cy={0} r={1} gradientTransform={`translate(${width / 2} ${height / 2}) scale(${w} ${h})`}>
        {stops}
      </radialGradient>
    )
  }

  return (
    <linearGradient id={id} gradientUnits="userSpaceOnUse" {...gradientLine(gradient.angle, width, height)}>
      {stops}
    </linearGradient>
  )
}

/** An id unique to this element in this slide view, fit for `url(#…)`. */
const usePaintId = (): string => `hs-paint-${useId().replace(/[^\w-]/g, '')}`

/** A shape's parts, filled and outlined, in an SVG over the element's box (mirrored with the element). */
export function ShapeGeometry({ parts, fill, stroke, theme, width, height, flipH, flipV }: { parts: readonly ShapePart[]; fill: Fill | null; stroke: Stroke | null; theme: Theme; width: number; height: number; flipH?: boolean; flipV?: boolean }) {
  const id = usePaintId()

  if (!fill && !stroke) {
    return null
  }

  const paint = fill ? (fill.gradient ? `url(#${id})` : cssColor(fill.color, theme)) : 'none'
  const opacity = fill && !fill.gradient ? fill.alpha : undefined
  const outline: SVGProps<SVGPathElement> | null =
    stroke && stroke.width > 0 ? { stroke: cssColor(stroke.color, theme), strokeOpacity: stroke.alpha, strokeWidth: stroke.width, strokeDasharray: dashArray(stroke.dash, stroke.width), strokeLinejoin: 'miter' } : null
  const flip = flipH || flipV ? `scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})` : undefined

  return (
    <svg className="hs-geom" width={Math.max(1, width)} height={Math.max(1, height)} style={{ transform: flip, transformOrigin: 'center' }} aria-hidden="true">
      {fill?.gradient && (
        <defs>
          <GradientDef id={id} gradient={fill.gradient} theme={theme} width={width} height={height} />
        </defs>
      )}
      {parts.map((part, index) => {
        const filled = Boolean(fill) && part.fill !== 'none'
        const lined = part.stroke ? outline : null
        const rule = part.evenOdd ? 'evenodd' : undefined

        if (!filled && !lined) {
          return null
        }

        if (!filled || part.fill === 'normal') {
          return <path key={index} d={part.d} fill={filled ? paint : 'none'} fillOpacity={filled ? opacity : undefined} fillRule={rule} stroke="none" {...lined} />
        }

        const [shade, amount] = SHADES[part.fill as keyof typeof SHADES]

        return (
          <Fragment key={index}>
            <path d={part.d} fill={paint} fillOpacity={opacity} fillRule={rule} stroke="none" />
            <path d={part.d} fill={shade} fillOpacity={amount * (opacity ?? 1)} fillRule={rule} stroke="none" {...lined} />
          </Fragment>
        )
      })}
    </svg>
  )
}
