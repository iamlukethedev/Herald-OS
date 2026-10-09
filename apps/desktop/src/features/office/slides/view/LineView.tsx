import type { LineElement, Theme } from '../deck.ts'
import { arrowHead, connectorPath, dashArray } from '../shapes.ts'
import { cssColor } from '../themes.ts'

type P = [number, number]

const behind = (end: P, direction: P): P => [end[0] - direction[0], end[1] - direction[1]]

/**
 * A line or connector across its box, mirrored as it is flipped, with its arrow heads pointing
 * along its end segments; the line stops short where a solid head covers it. `hit` adds a wide
 * clear stroke for the editor to catch the pointer on.
 */
export function LineView({ element, theme, hit }: { element: LineElement; theme: Theme; hit?: boolean }) {
  const { stroke, width, height } = element
  const preset = element.connector?.preset ?? 'straightConnector1'
  const adjust = element.connector?.adjust
  const path = connectorPath(preset, width, height, adjust)
  const tail = arrowHead(element.start, path.start, behind(path.start, path.startDirection), stroke.width)
  const head = arrowHead(element.end, path.end, behind(path.end, path.endDirection), stroke.width)
  const drawn = tail?.inset || head?.inset ? connectorPath(preset, width, height, adjust, { start: tail?.inset, end: head?.inset }).d : path.d
  const color = cssColor(stroke.color, theme)
  const flip = element.flipH || element.flipV ? `matrix(${element.flipH ? -1 : 1} 0 0 ${element.flipV ? -1 : 1} ${element.flipH ? width : 0} ${element.flipV ? height : 0})` : undefined

  return (
    <svg className="hs-geom" width={Math.max(1, width)} height={Math.max(1, height)} aria-hidden="true">
      <g transform={flip}>
        {hit && <path d={path.d} fill="none" stroke="transparent" strokeWidth={Math.max(12, stroke.width + 8)} style={{ pointerEvents: 'stroke' }} />}
        <path d={drawn} fill="none" stroke={color} strokeOpacity={stroke.alpha} strokeWidth={stroke.width} strokeDasharray={dashArray(stroke.dash, stroke.width)} />
        {[head, tail].map((part, index) =>
          part ? <path key={index} d={part.d} fill={part.filled ? color : 'none'} fillOpacity={stroke.alpha} stroke={color} strokeOpacity={stroke.alpha} strokeWidth={part.filled ? stroke.width * 0.5 : stroke.width} strokeLinejoin="miter" /> : null
        )}
      </g>
    </svg>
  )
}
