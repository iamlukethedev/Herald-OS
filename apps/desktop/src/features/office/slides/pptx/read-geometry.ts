import type { CustomPath } from '../deck.ts'
import { attr, child, childrenNamed, elements, flagAttr, numberAttr, type XmlElement } from './xml.ts'

/*
 * DrawingML's custom geometry (`a:custGeom`) as Herald's freeform paths: each path's points worked
 * out from its guides, and written as SVG path data with absolute moves, lines, curves and closes
 * only, its arcs turned into cubic curves of at most a quarter turn each.
 */

type Point = [number, number]

type Guides = Map<string, number>

/** DrawingML's angles are in 60,000ths of a degree. */
const DEGREE = 60000

const radians = (angle: number): number => (angle / DEGREE) * (Math.PI / 180)

/** The guides every shape has: its size and what follows from it, and the usual angles. */
function builtIns(w: number, h: number): Guides {
  const ss = Math.min(w, h)
  const guides: [string, number][] = [
    ['w', w],
    ['h', h],
    ['l', 0],
    ['t', 0],
    ['r', w],
    ['b', h],
    ['hc', w / 2],
    ['vc', h / 2],
    ['ss', ss],
    ['ls', Math.max(w, h)],
    ['cd2', 180 * DEGREE],
    ['cd4', 90 * DEGREE],
    ['cd8', 45 * DEGREE],
    ['3cd4', 270 * DEGREE],
    ['3cd8', 135 * DEGREE],
    ['5cd8', 225 * DEGREE],
    ['7cd8', 315 * DEGREE]
  ]

  for (const n of [2, 3, 4, 5, 6, 8, 10, 12, 16, 32]) {
    guides.push([`wd${n}`, w / n], [`hd${n}`, h / n], [`ssd${n}`, ss / n])
  }

  return new Map(guides)
}

/** A literal number, or the value of the guide it names; null when it is neither. */
function valueOf(raw: string | undefined, guides: Guides): number | null {
  const text = raw?.trim() ?? ''
  const literal = Number(text)

  return text && Number.isFinite(literal) ? literal : (guides.get(text) ?? null)
}

/** A guide's formula (`val 5000`, `+- w 0 hd2`…) worked out; null when it cannot be. */
function evaluate(formula: string, guides: Guides): number | null {
  const [operator, ...args] = formula.trim().split(/\s+/)
  const values = args.map((arg) => valueOf(arg, guides))

  if (values.some((value) => value === null)) {
    return null
  }

  const [x = Number.NaN, y = Number.NaN, z = Number.NaN] = values as number[]
  const results: Record<string, () => number> = {
    val: () => x,
    '*/': () => (z ? (x * y) / z : 0),
    '+-': () => x + y - z,
    '+/': () => (z ? (x + y) / z : 0),
    '?:': () => (x > 0 ? y : z),
    abs: () => Math.abs(x),
    at2: () => (Math.atan2(y, x) * 180 * DEGREE) / Math.PI,
    cat2: () => x * Math.cos(Math.atan2(z, y)),
    cos: () => x * Math.cos(radians(y)),
    max: () => Math.max(x, y),
    min: () => Math.min(x, y),
    mod: () => Math.hypot(x, y, z),
    pin: () => (y < x ? x : y > z ? z : y),
    sat2: () => x * Math.sin(Math.atan2(z, y)),
    sin: () => x * Math.sin(radians(y)),
    sqrt: () => Math.sqrt(x),
    tan: () => x * Math.tan(radians(y))
  }
  const result = results[operator]?.()

  return result !== undefined && Number.isFinite(result) ? result : null
}

/** The shape's guides: the built-in ones, then its adjust values and its own guides in order; one that cannot be worked out is left out. */
function guidesOf(geometry: XmlElement, w: number, h: number): Guides {
  const guides = builtIns(w, h)

  for (const guide of [...childrenNamed(child(geometry, 'a:avLst'), 'a:gd'), ...childrenNamed(child(geometry, 'a:gdLst'), 'a:gd')]) {
    const name = attr(guide, 'name')
    const value = evaluate(attr(guide, 'fmla') ?? '', guides)

    if (name && value !== null) {
      guides.set(name, value)
    }
  }

  return guides
}

const number = (value: number): string => String(Math.round(value * 100) / 100 || 0)

const written = (points: readonly Point[]): string => points.map(([x, y]) => `${number(x)} ${number(y)}`).join(' ')

/** The angle in an ellipse's own terms at which its edge lies `angle` from its centre, in the same turn. */
function along(angle: number, wR: number, hR: number): number {
  const own = Math.atan2(wR * Math.sin(angle), hR * Math.cos(angle))
  const turn = 2 * Math.PI

  return angle + (own - angle - turn * Math.round((own - angle) / turn))
}

/**
 * An arc (`a:arcTo`) as cubic curves from `from`: along the ellipse of radii `wR` and `hR` whose
 * edge `from` is at the start angle, through the swing angle (both in 60,000ths of a degree,
 * clockwise, as seen from the centre), in pieces of at most a quarter turn.
 */
export function arcCurves(from: Point, wR: number, hR: number, start: number, swing: number): { curves: Point[][]; to: Point } {
  if (!swing) {
    return { curves: [], to: from }
  }

  const first = along(radians(start), wR, hR)
  const last = along(radians(start + swing), wR, hR)
  const centre: Point = [from[0] - wR * Math.cos(first), from[1] - hR * Math.sin(first)]
  const pieces = Math.max(1, Math.ceil(Math.abs(last - first) / (Math.PI / 2) - 1e-9))
  const step = (last - first) / pieces
  const k = (4 / 3) * Math.tan(step / 4)
  const at = (angle: number): Point => [centre[0] + wR * Math.cos(angle), centre[1] + hR * Math.sin(angle)]
  const curves: Point[][] = []
  let to = from

  for (let piece = 0; piece < pieces; piece++) {
    const a = first + step * piece
    const b = a + step
    const p0 = at(a)
    to = at(b)
    curves.push([
      [p0[0] - k * wR * Math.sin(a), p0[1] + k * hR * Math.cos(a)],
      [to[0] + k * wR * Math.sin(b), to[1] - k * hR * Math.cos(b)],
      to
    ])
  }

  return { curves, to }
}

/** How many points each drawing command takes. */
const POINTS: Record<string, number> = { 'a:moveTo': 1, 'a:lnTo': 1, 'a:cubicBezTo': 3, 'a:quadBezTo': 2 }

/** A path's commands as SVG path data; null when a point or an arc names a guide that cannot be worked out. */
function pathData(path: XmlElement, guides: Guides): string | null {
  const out: string[] = []
  let current: Point = [0, 0]
  let start: Point = [0, 0]

  // SVG path data starts with a move; DrawingML's pen starts at the path's top left.
  const begin = () => {
    if (!out.length) {
      out.push('M 0 0')
    }
  }

  for (const command of elements(path)) {
    if (command.name === 'a:close') {
      if (out.length) {
        out.push('Z')
      }

      current = start
      continue
    }

    if (command.name === 'a:arcTo') {
      const [wR, hR, stAng, swAng] = ['wR', 'hR', 'stAng', 'swAng'].map((name) => valueOf(attr(command, name), guides))

      if (wR === null || hR === null || stAng === null || swAng === null) {
        return null
      }

      const arc = arcCurves(current, wR, hR, stAng, swAng)
      begin()
      out.push(...arc.curves.map((curve) => `C ${written(curve)}`))
      current = arc.to
      continue
    }

    const wanted = POINTS[command.name]

    if (!wanted) {
      continue
    }

    const points = childrenNamed(command, 'a:pt')
      .slice(0, wanted)
      .map((pt) => [valueOf(attr(pt, 'x'), guides), valueOf(attr(pt, 'y'), guides)])

    if (points.length < wanted || points.some(([x, y]) => x === null || y === null)) {
      return null
    }

    const at = points as Point[]
    const letter = command.name === 'a:moveTo' ? 'M' : command.name === 'a:lnTo' ? 'L' : command.name === 'a:cubicBezTo' ? 'C' : 'Q'

    if (letter !== 'M') {
      begin()
    }

    out.push(`${letter} ${written(at)}`)
    current = at[at.length - 1]

    if (letter === 'M') {
      start = current
    }
  }

  return out.join(' ')
}

/**
 * A custom geometry as freeform paths over a shape `width` by `height` EMU (the units of a path
 * that gives no size of its own); null when it has no path or a guide it draws with cannot be
 * worked out, as the shape is then drawn as its box.
 */
export function readGeometry(geometry: XmlElement, width: number, height: number): CustomPath[] | null {
  const guides = guidesOf(geometry, width, height)
  const paths: CustomPath[] = []

  for (const path of childrenNamed(child(geometry, 'a:pathLst'), 'a:path')) {
    const d = pathData(path, guides)

    if (d === null) {
      return null
    }

    if (d) {
      paths.push({
        width: numberAttr(path, 'w', 0) || width || 1,
        height: numberAttr(path, 'h', 0) || height || 1,
        d,
        ...(attr(path, 'fill') === 'none' ? { fill: false } : {}),
        ...(flagAttr(path, 'stroke') === false ? { stroke: false } : {})
      })
    }
  }

  return paths.length ? paths : null
}
