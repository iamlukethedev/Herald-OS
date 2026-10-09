import type { Box } from './deck.ts'

/*
 * DrawingML's shape geometry, worked out as PowerPoint works it out: adjust values, guides written
 * in DrawingML's own formula language (`x2 +- r 0 dx1`), paths through those guides, and a text
 * rectangle. Presets and connectors are written in this language (shapes-presets.ts and
 * shapes-connectors.ts), so each reads line for line against DrawingML's preset definitions.
 *
 * Guides: `name op arg…`, separated by semicolons. Paths: `M x y`, `L x y`, `A wR hR stAng swAng`,
 * `Q x1 y1 x y`, `C x1 y1 x2 y2 x y` and `Z`, every argument a guide, a built-in (w, h, l, t, r, b,
 * hc, vc, ss, ls, wd2…, cd4…) or a number. Angles are 60,000ths of a degree, clockwise from three
 * o'clock; an arc starts at the current point, as DrawingML's arcTo does.
 */

export type P = [number, number]

/** How a part is filled: with the shape's fill, a shade darker or lighter, or not at all (DrawingML's path fill modes). */
export const PART_FILLS = ['normal', 'darken', 'darkenLess', 'lighten', 'lightenLess', 'none'] as const

export type PartFill = (typeof PART_FILLS)[number]

/** One of the paths a shape is drawn with, in drawing order. */
export interface ShapePart {
  d: string
  fill: PartFill
  stroke: boolean
  /** Filled by the even-odd rule, so an outline inside another cuts a hole. */
  evenOdd?: boolean
}

export interface PathDefinition {
  d: string
  fill?: PartFill
  stroke?: boolean
  /** The path's own units across and down, stretched over the box (DrawingML's path `w` and `h`). */
  w?: number
  h?: number
  evenOdd?: boolean
}

export interface GeometryDefinition {
  /** Adjust values and their defaults (DrawingML's avLst). */
  av?: Record<string, number>
  /** Guides in order (DrawingML's gdLst). */
  gd?: string
  /** A plain string is a path filled and outlined as the shape is. */
  paths: (PathDefinition | string)[]
  /** Left, top, right and bottom of the text rectangle; the whole box when absent. */
  text?: string
}

/** A path command with its points worked out: an arc keeps its radii and direction, and ends at its last point. */
export interface Segment {
  op: 'M' | 'L' | 'Q' | 'C' | 'A' | 'Z'
  points: P[]
  arc?: { rx: number; ry: number; sweep: 0 | 1 }
}

export interface Geometry {
  parts: (Omit<ShapePart, 'd'> & { segments: Segment[] })[]
  text: Box
  /** Names a definition uses that are neither guides, adjust values nor built-ins (none, for a sound definition). */
  missing: string[]
}

type Arg = string | number

interface Compiled {
  av: Record<string, number>
  guides: { name: string; op: string; args: Arg[] }[]
  paths: { commands: { op: Segment['op']; args: Arg[] }[]; fill: PartFill; stroke: boolean; w?: number; h?: number; evenOdd: boolean }[]
  text: Arg[] | null
}

const ARITY: Record<Segment['op'], number> = { M: 2, L: 2, A: 4, Q: 4, C: 6, Z: 0 }

const UNIT = 60000

const radians = (value: number): number => (value / UNIT / 180) * Math.PI

const arg = (raw: string): Arg => (/^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw)

const words = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean)

function compilePath(definition: PathDefinition | string): Compiled['paths'][number] {
  const path = typeof definition === 'string' ? { d: definition } : definition
  const tokens = words(path.d)
  const commands: Compiled['paths'][number]['commands'] = []

  for (let at = 0; at < tokens.length; ) {
    const op = tokens[at] as Segment['op']
    const count = ARITY[op] ?? 0

    commands.push({ op, args: tokens.slice(at + 1, at + 1 + count).map(arg) })
    at += 1 + count
  }

  return { commands, fill: path.fill ?? 'normal', stroke: path.stroke ?? true, w: path.w, h: path.h, evenOdd: path.evenOdd ?? false }
}

const compiled = new WeakMap<GeometryDefinition, Compiled>()

function compile(definition: GeometryDefinition): Compiled {
  let result = compiled.get(definition)

  if (!result) {
    const guides = (definition.gd ?? '')
      .split(';')
      .map(words)
      .filter((line) => line.length >= 2)
      .map(([name, op, ...args]) => ({ name, op, args: args.map(arg) }))

    result = { av: definition.av ?? {}, guides, paths: definition.paths.map(compilePath), text: definition.text ? words(definition.text).map(arg) : null }
    compiled.set(definition, result)
  }

  return result
}

const ANGLES: Record<string, number> = { cd2: 10800000, cd4: 5400000, cd8: 2700000, '3cd4': 16200000, '3cd8': 8100000, '5cd8': 13500000, '7cd8': 18900000 }

function builtin(name: string, w: number, h: number): number | undefined {
  const ss = Math.min(w, h)

  switch (name) {
    case 'w':
    case 'r':
      return w
    case 'h':
    case 'b':
      return h
    case 'l':
    case 't':
      return 0
    case 'hc':
      return w / 2
    case 'vc':
      return h / 2
    case 'ss':
      return ss
    case 'ls':
      return Math.max(w, h)
  }

  if (name in ANGLES) {
    return ANGLES[name]
  }

  const part = /^(w|h|ss)d(\d+)$/.exec(name)

  return part ? (part[1] === 'w' ? w : part[1] === 'h' ? h : ss) / Number(part[2]) : undefined
}

/** One of DrawingML's guide formulas; a division by nothing gives nothing, as in PowerPoint. */
function formula(op: string, x: number, y: number, z: number): number | undefined {
  switch (op) {
    case '*/':
      return z === 0 ? 0 : (x * y) / z
    case '+-':
      return x + y - z
    case '+/':
      return z === 0 ? 0 : (x + y) / z
    case '?:':
      return x > 0 ? y : z
    case 'abs':
      return Math.abs(x)
    case 'at2':
      return (Math.atan2(y, x) / Math.PI) * 180 * UNIT
    case 'cat2':
      return x * Math.cos(Math.atan2(z, y))
    case 'cos':
      return x * Math.cos(radians(y))
    case 'max':
      return Math.max(x, y)
    case 'min':
      return Math.min(x, y)
    case 'mod':
      return Math.sqrt(x * x + y * y + z * z)
    case 'pin':
      return y < x ? x : y > z ? z : y
    case 'sat2':
      return x * Math.sin(Math.atan2(z, y))
    case 'sin':
      return x * Math.sin(radians(y))
    case 'sqrt':
      return Math.sqrt(Math.max(0, x))
    case 'tan':
      return x * Math.tan(radians(y))
    case 'val':
      return x
    default:
      return undefined
  }
}

/**
 * An arc as DrawingML draws one: from `from`, on the ellipse of radii `wR` and `hR` at the angle
 * `stAng` (an angle seen from the ellipse's centre, not the ellipse's parameter), through `swAng`,
 * in steps of at most a quarter turn so each is one SVG arc.
 */
function arc(from: P, wR: number, hR: number, stAng: number, swAng: number): Segment[] {
  const rx = Math.abs(wR)
  const ry = Math.abs(hR)
  const start = radians(stAng)
  const turn = Math.PI * 2
  const param = (angle: number) => {
    const t = Math.atan2(rx * Math.sin(angle), ry * Math.cos(angle))

    return t + turn * Math.round((angle - t) / turn)
  }
  const t1 = param(start)
  const t2 = param(start + radians(swAng))
  const centre: P = [from[0] - rx * Math.cos(t1), from[1] - ry * Math.sin(t1)]
  const at = (t: number): P => [centre[0] + rx * Math.cos(t), centre[1] + ry * Math.sin(t)]

  if (Math.abs(t2 - t1) < 1e-9) {
    return []
  }

  if (rx < 1e-9 || ry < 1e-9) {
    return [{ op: 'L', points: [at(t2)] }]
  }

  const steps = Math.max(1, Math.ceil(Math.abs(t2 - t1) / (Math.PI / 2) - 1e-9))
  const sweep = t2 > t1 ? 1 : 0

  return Array.from({ length: steps }, (_, index): Segment => ({ op: 'A', points: [at(t1 + ((t2 - t1) * (index + 1)) / steps)], arc: { rx, ry, sweep } }))
}

const pin = (low: number, value: number, high: number): number => Math.max(low, Math.min(high, value))

/** A definition worked out for a `w` by `h` box with the given adjust values (the rest at their defaults). */
export function evaluateGeometry(definition: GeometryDefinition, w: number, h: number, adjust: Record<string, number> = {}): Geometry {
  const { av, guides, paths, text } = compile(definition)
  const values = new Map<string, number>()
  const missing = new Set<string>()
  const value = (token: Arg): number => {
    if (typeof token === 'number') {
      return token
    }

    const known = values.get(token) ?? builtin(token, w, h)

    if (known === undefined) {
      missing.add(token)

      return 0
    }

    return known
  }

  for (const [name, initial] of Object.entries(av)) {
    const given = adjust[name]

    values.set(name, typeof given === 'number' && Number.isFinite(given) ? given : initial)
  }

  for (const guide of guides) {
    const [x = 0, y = 0, z = 0] = guide.args.map(value)
    const result = formula(guide.op, x, y, z)

    if (result === undefined) {
      missing.add(guide.op)
    }

    values.set(guide.name, Number.isFinite(result) ? (result as number) : 0)
  }

  const parts = paths.map((path) => {
    const sx = path.w ? w / path.w : 1
    const sy = path.h ? h / path.h : 1
    const scaled = ([x, y]: P): P => [x * sx, y * sy]
    const segments: Segment[] = []
    let current: P = [0, 0]
    let first: P = [0, 0]

    for (const { op, args } of path.commands) {
      const numbers = args.map(value)

      if (!(op in ARITY)) {
        missing.add(op)
        continue
      }

      if (op === 'A') {
        const [wR = 0, hR = 0, stAng = 0, swAng = 0] = numbers

        for (const step of arc(current, wR, hR, stAng, swAng)) {
          current = step.points[0]
          segments.push({ ...step, points: [scaled(current)], arc: step.arc && { ...step.arc, rx: step.arc.rx * sx, ry: step.arc.ry * sy } })
        }

        continue
      }

      if (op === 'Z') {
        segments.push({ op, points: [] })
        current = first
        continue
      }

      const points: P[] = []

      for (let at = 0; at + 1 < numbers.length; at += 2) {
        points.push([numbers[at], numbers[at + 1]])
      }

      current = points.at(-1) ?? current

      if (op === 'M') {
        first = current
      }

      segments.push({ op, points: points.map(scaled) })
    }

    return { segments, fill: path.fill, stroke: path.stroke, ...(path.evenOdd ? { evenOdd: true } : {}) }
  })

  const [l, t, r, b] = text ? text.map(value) : [0, 0, w, h]
  const left = pin(0, Math.min(l, r), w)
  const top = pin(0, Math.min(t, b), h)
  const width = Math.max(Math.min(1, w), pin(0, Math.max(l, r), w) - left)
  const height = Math.max(Math.min(1, h), pin(0, Math.max(t, b), h) - top)

  return { parts, text: { x: Math.min(left, w - width), y: Math.min(top, h - height), width, height }, missing: [...missing] }
}

export const round = (value: number): number => {
  const rounded = Math.round(value * 1000) / 1000

  return Object.is(rounded, -0) ? 0 : rounded
}

const point = ([x, y]: P): string => `${round(x)},${round(y)}`

/** Segments as SVG path data. */
export function pathData(segments: readonly Segment[]): string {
  return segments
    .map((segment) => {
      if (segment.op === 'Z') {
        return 'Z'
      }

      if (segment.op === 'A' && segment.arc) {
        return `A${round(segment.arc.rx)},${round(segment.arc.ry)} 0 0 ${segment.arc.sweep} ${point(segment.points[0])}`
      }

      return `${segment.op}${segment.points.map(point).join(' ')}`
    })
    .join(' ')
}

/**
 * SVG path data stretched by `sx` across and `sy` down. Arcs stretch exactly only unrotated, the
 * only kind a custom path keeps (its arcs are cubic curves).
 */
export function scalePathData(d: string, sx: number, sy: number): string {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? []
  const out: string[] = []
  let command = ''
  let index = 0

  for (const token of tokens) {
    if (/^[a-zA-Z]$/.test(token)) {
      command = token.toUpperCase()
      index = 0
      out.push(token)
      continue
    }

    const number = Number(token)
    let scaled = number

    if (command === 'H') {
      scaled = number * sx
    } else if (command === 'V') {
      scaled = number * sy
    } else if (command === 'A') {
      const slot = index % 7
      scaled = slot === 0 || slot === 5 ? number * sx : slot === 1 || slot === 6 ? number * sy : number
    } else {
      scaled = index % 2 === 0 ? number * sx : number * sy
    }

    index++
    out.push(String(round(scaled)))
  }

  return out.join(' ').replace(/([a-zA-Z]) /g, '$1')
}
