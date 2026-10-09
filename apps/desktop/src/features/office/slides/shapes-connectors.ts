import type { ConnectorPreset } from './deck.ts'
import { evaluateGeometry, type GeometryDefinition, type P, pathData, type Segment } from './shapes-geometry.ts'

/*
 * DrawingML's connectors, from the top left of their box to the bottom right as the presets run
 * them (a flipped connector is the same path mirrored): straight, bent at right angles, or curved,
 * through one to four turns placed by adjust values that may reach outside the box.
 */

export const CONNECTORS: Record<ConnectorPreset, GeometryDefinition> = {
  straightConnector1: { paths: ['M l t L r b'] },
  bentConnector2: { paths: ['M l t L r t L r b'] },
  bentConnector3: { av: { adj1: 50000 }, gd: 'x1 */ w adj1 100000', paths: ['M l t L x1 t L x1 b L r b'] },
  bentConnector4: { av: { adj1: 50000, adj2: 50000 }, gd: 'x1 */ w adj1 100000; y2 */ h adj2 100000', paths: ['M l t L x1 t L x1 y2 L r y2 L r b'] },
  bentConnector5: {
    av: { adj1: 50000, adj2: 50000, adj3: 50000 },
    gd: 'x1 */ w adj1 100000; x3 */ w adj3 100000; y2 */ h adj2 100000',
    paths: ['M l t L x1 t L x1 y2 L x3 y2 L x3 b L r b']
  },
  curvedConnector2: { paths: ['M l t C wd2 t r hd2 r b'] },
  curvedConnector3: { av: { adj1: 50000 }, gd: 'x2 */ w adj1 100000; x1 +/ l x2 2; x3 +/ r x2 2; y3 */ h 3 4', paths: ['M l t C x1 t x2 hd4 x2 vc C x2 y3 x3 b r b'] },
  curvedConnector4: {
    av: { adj1: 50000, adj2: 50000 },
    gd: 'x2 */ w adj1 100000; x1 +/ l x2 2; x3 +/ r x2 2; x4 +/ x2 x3 2; x5 +/ x3 r 2; y4 */ h adj2 100000; y1 +/ t y4 2; y2 +/ t y1 2; y3 +/ y1 y4 2; y5 +/ b y4 2',
    paths: ['M l t C x1 t x2 y2 x2 y1 C x2 y3 x4 y4 x3 y4 C x5 y4 r y5 r b']
  },
  curvedConnector5: {
    av: { adj1: 50000, adj2: 50000, adj3: 50000 },
    gd: 'x3 */ w adj1 100000; x6 */ w adj3 100000; x1 +/ x3 x6 2; x2 +/ l x3 2; x4 +/ x3 x1 2; x5 +/ x6 x1 2; x7 +/ x6 r 2; y4 */ h adj2 100000; y1 +/ t y4 2; y2 +/ t y1 2; y3 +/ y1 y4 2; y5 +/ b y4 2; y6 +/ y5 y4 2; y7 +/ y5 b 2',
    paths: ['M l t C x2 t x3 y2 x3 y1 C x3 y3 x4 y4 x1 y4 C x5 y4 x6 y6 x6 y5 C x6 y7 x7 b r b']
  }
}

export interface ConnectorGeometry {
  d: string
  start: P
  end: P
  /** Which way the line leaves each end, as unit vectors pointing out of the line (the way an arrow head there points). */
  startDirection: P
  endDirection: P
}

const distance = (a: P, b: P): number => Math.hypot(b[0] - a[0], b[1] - a[1])

/** The unit vector out through `end` from the nearest point along the line that is not the end itself. */
function outward(end: P, along: readonly P[]): P {
  const from = along.find((point) => distance(point, end) > 1e-6)

  if (!from) {
    return [0, 0]
  }

  const length = distance(from, end)

  return [(end[0] - from[0]) / length, (end[1] - from[1]) / length]
}

/** A point moved toward the next point along the line, but never past it. */
function stepIn(end: P, direction: P, by: number, limit: number): P {
  const step = Math.min(by, limit)

  return [end[0] - direction[0] * step, end[1] - direction[1] * step]
}

/**
 * A connector preset in a `w` by `h` box: its path, its ends, and which way it leaves them.
 * `trim` stops the path short of its ends (where a solid arrow head covers them).
 */
export function connectorPath(preset: ConnectorPreset, w: number, h: number, adjust: Record<string, number> = {}, trim: { start?: number; end?: number } = {}): ConnectorGeometry {
  const segments: Segment[] = (evaluateGeometry(CONNECTORS[preset] ?? CONNECTORS.straightConnector1, w, h, adjust).parts[0]?.segments ?? []).map((segment) => ({ ...segment, points: [...segment.points] }))
  const points = segments.flatMap((segment) => segment.points)
  const start = points[0] ?? [0, 0]
  const end = points.at(-1) ?? start
  const startDirection = outward(start, points.slice(1))
  const endDirection = outward(end, points.slice(0, -1).reverse())
  // A curve's end moves only part of the way to its control point, and a single straight run only half its length, so the path keeps its shape.
  const share = (segment: Segment) => (segment.op === 'L' && segments.length > 2 ? 1 : 0.5)

  if (trim.start && segments.length > 1) {
    segments[0].points[0] = stepIn(start, startDirection, trim.start, distance(start, segments[1].points[0]) * share(segments[1]))
  }

  if (trim.end && segments.length > 1) {
    const last = segments.at(-1)!
    const before = last.points.length > 1 ? last.points.at(-2)! : (segments.at(-2)?.points.at(-1) ?? start)

    last.points[last.points.length - 1] = stepIn(end, endDirection, trim.end, distance(before, end) * share(last))
  }

  return { d: pathData(segments), start, end, startDirection, endDirection }
}
