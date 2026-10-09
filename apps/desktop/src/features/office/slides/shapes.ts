import type { ArrowHead, Box, Dash, ShapeKind } from './deck.ts'

/*
 * The preset shapes as SVG paths, worked out from DrawingML's preset definitions with the same
 * adjust values and defaults, so a shape here and the same shape in PowerPoint have one outline;
 * and the box text sits in inside each.
 */

export const SHAPE_NAMES: Record<ShapeKind, string> = {
  rect: 'Rectangle',
  roundRect: 'Rounded rectangle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  rtTriangle: 'Right triangle',
  diamond: 'Diamond',
  parallelogram: 'Parallelogram',
  trapezoid: 'Trapezoid',
  pentagon: 'Pentagon',
  hexagon: 'Hexagon',
  octagon: 'Octagon',
  plus: 'Cross',
  star5: 'Star',
  rightArrow: 'Right arrow',
  leftArrow: 'Left arrow',
  upArrow: 'Up arrow',
  downArrow: 'Down arrow',
  leftRightArrow: 'Double arrow',
  chevron: 'Chevron',
  homePlate: 'Pentagon arrow',
  wedgeRectCallout: 'Callout',
  wedgeRoundRectCallout: 'Rounded callout',
  snip1Rect: 'Snipped rectangle',
  snip2SameRect: 'Snipped top corners',
  round1Rect: 'Rounded corner',
  round2SameRect: 'Rounded top corners',
  plaque: 'Plaque',
  foldedCorner: 'Folded corner',
  frame: 'Frame',
  halfFrame: 'Half frame',
  corner: 'L-shape',
  diagStripe: 'Diagonal stripe',
  bevel: 'Bevel',
  heptagon: 'Heptagon',
  decagon: 'Decagon',
  dodecagon: 'Dodecagon',
  star4: '4-point star',
  star6: '6-point star',
  star8: '8-point star',
  star10: '10-point star',
  star12: '12-point star',
  donut: 'Donut',
  noSmoking: 'No symbol',
  blockArc: 'Block arc',
  pie: 'Pie',
  chord: 'Chord',
  teardrop: 'Teardrop',
  heart: 'Heart',
  lightningBolt: 'Lightning bolt',
  sun: 'Sun',
  moon: 'Moon',
  cloud: 'Cloud',
  smileyFace: 'Smiley face',
  can: 'Cylinder',
  cube: 'Cube',
  bracketPair: 'Double bracket',
  bracePair: 'Double brace',
  leftBracket: 'Left bracket',
  rightBracket: 'Right bracket',
  leftBrace: 'Left brace',
  rightBrace: 'Right brace',
  upDownArrow: 'Up-down arrow',
  quadArrow: 'Quad arrow',
  notchedRightArrow: 'Notched arrow',
  stripedRightArrow: 'Striped arrow',
  bentArrow: 'Bent arrow',
  uturnArrow: 'U-turn arrow',
  wedgeEllipseCallout: 'Oval callout',
  cloudCallout: 'Cloud callout',
  mathPlus: 'Plus',
  mathMinus: 'Minus',
  mathMultiply: 'Multiply',
  mathDivide: 'Division',
  mathEqual: 'Equal',
  mathNotEqual: 'Not equal',
  wave: 'Wave',
  doubleWave: 'Double wave',
  flowChartProcess: 'Process',
  flowChartAlternateProcess: 'Alternate process',
  flowChartDecision: 'Decision',
  flowChartInputOutput: 'Data',
  flowChartPredefinedProcess: 'Predefined process',
  flowChartInternalStorage: 'Internal storage',
  flowChartDocument: 'Document',
  flowChartMultidocument: 'Multidocument',
  flowChartTerminator: 'Terminator',
  flowChartPreparation: 'Preparation',
  flowChartManualInput: 'Manual input',
  flowChartManualOperation: 'Manual operation',
  flowChartConnector: 'Connector',
  flowChartOffpageConnector: 'Off-page connector',
  flowChartPunchedCard: 'Card',
  flowChartPunchedTape: 'Punched tape',
  flowChartSummingJunction: 'Summing junction',
  flowChartOr: 'Or',
  flowChartCollate: 'Collate',
  flowChartSort: 'Sort',
  flowChartExtract: 'Extract',
  flowChartMerge: 'Merge',
  flowChartOnlineStorage: 'Stored data',
  flowChartDelay: 'Delay',
  flowChartMagneticDisk: 'Magnetic disk',
  flowChartDisplay: 'Display'
}

/** What the Insert menu offers, in order. */
export const INSERTABLE: ShapeKind[] = ['rect', 'roundRect', 'ellipse', 'triangle', 'rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'star5', 'wedgeRoundRectCallout', 'diamond', 'hexagon']

/** Each preset's adjust values where the file says nothing. */
export const ADJUST_DEFAULTS: Partial<Record<ShapeKind, Record<string, number>>> = {
  roundRect: { adj: 16667 },
  triangle: { adj: 50000 },
  parallelogram: { adj: 25000 },
  trapezoid: { adj: 25000 },
  hexagon: { adj: 25000 },
  octagon: { adj: 29289 },
  plus: { adj: 25000 },
  star5: { adj: 19098 },
  rightArrow: { adj1: 50000, adj2: 50000 },
  leftArrow: { adj1: 50000, adj2: 50000 },
  upArrow: { adj1: 50000, adj2: 50000 },
  downArrow: { adj1: 50000, adj2: 50000 },
  leftRightArrow: { adj1: 50000, adj2: 50000 },
  chevron: { adj: 50000 },
  homePlate: { adj: 50000 },
  wedgeRectCallout: { adj1: -20833, adj2: 62500 },
  wedgeRoundRectCallout: { adj1: -20833, adj2: 62500, adj3: 16667 }
}

const pin = (low: number, value: number, high: number): number => Math.max(low, Math.min(high, value))

type P = [number, number]

const polygon = (points: P[]): string => `M${points.map(([x, y]) => `${round(x)},${round(y)}`).join(' L')} Z`

const round = (value: number): number => Math.round(value * 1000) / 1000

/** The rounded rectangle's outline, clockwise from the top left, with `notch` (a callout's tail) let in on one side. */
function roundedOutline(w: number, h: number, r: number, notch?: { side: 'top' | 'right' | 'bottom' | 'left'; from: number; to: number; tip: P }): string {
  const arc = (x: number, y: number) => (r > 0 ? ` A${round(r)},${round(r)} 0 0 1 ${round(x)},${round(y)}` : ` L${round(x)},${round(y)}`)
  const tail = (side: 'top' | 'right' | 'bottom' | 'left'): string => {
    if (notch?.side !== side) {
      return ''
    }

    const [a, b] = side === 'top' || side === 'right' ? [notch.from, notch.to] : [notch.to, notch.from]
    const at = (value: number): P => (side === 'top' ? [value, 0] : side === 'bottom' ? [value, h] : side === 'right' ? [w, value] : [0, value])

    return ` L${round(at(a)[0])},${round(at(a)[1])} L${round(notch.tip[0])},${round(notch.tip[1])} L${round(at(b)[0])},${round(at(b)[1])}`
  }

  return `M${round(r)},0${tail('top')} L${round(w - r)},0${arc(w, r)}${tail('right')} L${w},${round(h - r)}${arc(w - r, h)}${tail('bottom')} L${round(r)},${h}${arc(0, h - r)}${tail('left')} L0,${round(r)}${arc(r, 0)} Z`
}

/** Where a callout's tail meets its box and where it points, as DrawingML places it. */
function calloutTail(w: number, h: number, adj1: number, adj2: number): { side: 'top' | 'right' | 'bottom' | 'left'; from: number; to: number; tip: P } {
  const dxPos = (w * adj1) / 100000
  const dyPos = (h * adj2) / 100000
  const tip: P = [w / 2 + dxPos, h / 2 + dyPos]
  const vertical = Math.abs(dyPos) - Math.abs((dxPos * h) / Math.max(w, 1e-6)) > 0

  if (vertical) {
    const [from, to] = dxPos > 0 ? [(w * 7) / 12, (w * 10) / 12] : [(w * 2) / 12, (w * 5) / 12]

    return { side: dyPos > 0 ? 'bottom' : 'top', from, to, tip }
  }

  const [from, to] = dyPos > 0 ? [(h * 7) / 12, (h * 10) / 12] : [(h * 2) / 12, (h * 5) / 12]

  return { side: dxPos > 0 ? 'right' : 'left', from, to, tip }
}

function star(w: number, h: number, adj: number): P[] {
  const a = pin(0, adj, 50000)
  const outerX = ((w / 2) * 105146) / 100000
  const outerY = ((h / 2) * 110557) / 100000
  const middleY = ((h / 2) * 110557) / 100000
  const points: P[] = []

  for (let i = 0; i < 10; i++) {
    const outer = i % 2 === 0
    const angle = ((-90 + 36 * i) * Math.PI) / 180
    const rx = outer ? outerX : (outerX * a) / 50000
    const ry = outer ? outerY : (outerY * a) / 50000
    points.push([w / 2 + rx * Math.cos(angle), middleY + ry * Math.sin(angle)])
  }

  return points
}

/** A preset's outline in a `w` by `h` box, as SVG path data. */
export function shapePath(kind: ShapeKind, w: number, h: number, adjust: Record<string, number> = {}): string {
  const value = (name: string): number => adjust[name] ?? ADJUST_DEFAULTS[kind]?.[name] ?? 0
  const ss = Math.max(1e-6, Math.min(w, h))
  const hc = w / 2
  const vc = h / 2

  switch (kind) {
    case 'rect':
      return polygon([
        [0, 0],
        [w, 0],
        [w, h],
        [0, h]
      ])
    case 'roundRect':
      return roundedOutline(w, h, (ss * pin(0, value('adj'), 50000)) / 100000)
    case 'ellipse':
      return `M0,${round(vc)} A${round(hc)},${round(vc)} 0 1 1 ${w},${round(vc)} A${round(hc)},${round(vc)} 0 1 1 0,${round(vc)} Z`
    case 'triangle':
      return polygon([
        [0, h],
        [(w * pin(0, value('adj'), 100000)) / 100000, 0],
        [w, h]
      ])
    case 'rtTriangle':
      return polygon([
        [0, 0],
        [0, h],
        [w, h]
      ])
    case 'diamond':
      return polygon([
        [hc, 0],
        [w, vc],
        [hc, h],
        [0, vc]
      ])
    case 'parallelogram': {
      const x2 = (ss * pin(0, value('adj'), (100000 * w) / ss)) / 100000

      return polygon([
        [0, h],
        [x2, 0],
        [w, 0],
        [w - x2, h]
      ])
    }
    case 'trapezoid': {
      const x2 = (ss * pin(0, value('adj'), (50000 * w) / ss)) / 100000

      return polygon([
        [0, h],
        [x2, 0],
        [w - x2, 0],
        [w, h]
      ])
    }
    case 'pentagon':
      return polygon([
        [hc, 0],
        [w, h * 0.381966],
        [w * 0.809017, h],
        [w * 0.190983, h],
        [0, h * 0.381966]
      ])
    case 'hexagon': {
      const x1 = (ss * pin(0, value('adj'), (50000 * w) / ss)) / 100000

      return polygon([
        [0, vc],
        [x1, 0],
        [w - x1, 0],
        [w, vc],
        [w - x1, h],
        [x1, h]
      ])
    }
    case 'octagon': {
      const x1 = (ss * pin(0, value('adj'), 50000)) / 100000

      return polygon([
        [0, x1],
        [x1, 0],
        [w - x1, 0],
        [w, x1],
        [w, h - x1],
        [w - x1, h],
        [x1, h],
        [0, h - x1]
      ])
    }
    case 'plus': {
      const x1 = (ss * pin(0, value('adj'), 50000)) / 100000

      return polygon([
        [0, x1],
        [x1, x1],
        [x1, 0],
        [w - x1, 0],
        [w - x1, x1],
        [w, x1],
        [w, h - x1],
        [w - x1, h - x1],
        [w - x1, h],
        [x1, h],
        [x1, h - x1],
        [0, h - x1]
      ])
    }
    case 'star5':
      return polygon(star(w, h, value('adj')))
    case 'rightArrow': {
      const dy = (h * pin(0, value('adj1'), 100000)) / 200000
      const x1 = w - (ss * pin(0, value('adj2'), (100000 * w) / ss)) / 100000

      return polygon([
        [0, vc - dy],
        [x1, vc - dy],
        [x1, 0],
        [w, vc],
        [x1, h],
        [x1, vc + dy],
        [0, vc + dy]
      ])
    }
    case 'leftArrow': {
      const dy = (h * pin(0, value('adj1'), 100000)) / 200000
      const x2 = (ss * pin(0, value('adj2'), (100000 * w) / ss)) / 100000

      return polygon([
        [0, vc],
        [x2, 0],
        [x2, vc - dy],
        [w, vc - dy],
        [w, vc + dy],
        [x2, vc + dy],
        [x2, h]
      ])
    }
    case 'upArrow': {
      const dx = (w * pin(0, value('adj1'), 100000)) / 200000
      const y2 = (ss * pin(0, value('adj2'), (100000 * h) / ss)) / 100000

      return polygon([
        [0, y2],
        [hc, 0],
        [w, y2],
        [hc + dx, y2],
        [hc + dx, h],
        [hc - dx, h],
        [hc - dx, y2]
      ])
    }
    case 'downArrow': {
      const dx = (w * pin(0, value('adj1'), 100000)) / 200000
      const y1 = h - (ss * pin(0, value('adj2'), (100000 * h) / ss)) / 100000

      return polygon([
        [0, y1],
        [hc - dx, y1],
        [hc - dx, 0],
        [hc + dx, 0],
        [hc + dx, y1],
        [w, y1],
        [hc, h]
      ])
    }
    case 'leftRightArrow': {
      const dy = (h * pin(0, value('adj1'), 100000)) / 200000
      const x2 = (ss * pin(0, value('adj2'), (50000 * w) / ss)) / 100000

      return polygon([
        [0, vc],
        [x2, 0],
        [x2, vc - dy],
        [w - x2, vc - dy],
        [w - x2, 0],
        [w, vc],
        [w - x2, h],
        [w - x2, vc + dy],
        [x2, vc + dy],
        [x2, h]
      ])
    }
    case 'chevron': {
      const x1 = (ss * pin(0, value('adj'), (100000 * w) / ss)) / 100000

      return polygon([
        [0, 0],
        [w - x1, 0],
        [w, vc],
        [w - x1, h],
        [0, h],
        [x1, vc]
      ])
    }
    case 'homePlate': {
      const x1 = w - (ss * pin(0, value('adj'), (100000 * w) / ss)) / 100000

      return polygon([
        [0, 0],
        [x1, 0],
        [w, vc],
        [x1, h],
        [0, h]
      ])
    }
    case 'wedgeRectCallout':
      return roundedOutline(w, h, 0, calloutTail(w, h, value('adj1'), value('adj2')))
    case 'wedgeRoundRectCallout':
      return roundedOutline(w, h, (ss * pin(0, value('adj3'), 50000)) / 100000, calloutTail(w, h, value('adj1'), value('adj2')))
    default:
      return polygon([
        [0, 0],
        [w, 0],
        [w, h],
        [0, h]
      ])
  }
}

/** The part of a preset's box its text is laid out in, before the text body's insets. */
export function textArea(kind: ShapeKind, w: number, h: number, adjust: Record<string, number> = {}): Box {
  const value = (name: string): number => adjust[name] ?? ADJUST_DEFAULTS[kind]?.[name] ?? 0
  const ss = Math.max(1e-6, Math.min(w, h))
  const area = (l: number, t: number, r: number, b: number): Box => ({ x: l, y: t, width: Math.max(1, r - l), height: Math.max(1, b - t) })

  switch (kind) {
    case 'roundRect':
    case 'wedgeRoundRectCallout': {
      const inset = ((ss * pin(0, value(kind === 'roundRect' ? 'adj' : 'adj3'), 50000)) / 100000) * 0.29289

      return area(inset, inset, w - inset, h - inset)
    }
    case 'ellipse':
      return area(w / 2 - (w / 2) * Math.SQRT1_2, h / 2 - (h / 2) * Math.SQRT1_2, w / 2 + (w / 2) * Math.SQRT1_2, h / 2 + (h / 2) * Math.SQRT1_2)
    case 'triangle': {
      const apex = (w * pin(0, value('adj'), 100000)) / 100000

      return area(apex / 2, h / 2, (apex + w) / 2, h)
    }
    case 'rtTriangle':
      return area(0, (h * 7) / 12, (w * 7) / 12, h)
    case 'diamond':
      return area(w / 4, h / 4, (w * 3) / 4, (h * 3) / 4)
    case 'parallelogram':
    case 'trapezoid': {
      const x2 = (ss * pin(0, value('adj'), (100000 * w) / ss)) / 100000

      return area(x2 / 2, 0, w - x2 / 2, h)
    }
    case 'pentagon':
      return area(w * 0.191, h * 0.382, w * 0.809, h)
    case 'hexagon': {
      const x1 = (ss * pin(0, value('adj'), (50000 * w) / ss)) / 100000

      return area(x1 / 2, h * 0.146, w - x1 / 2, h * 0.854)
    }
    case 'octagon': {
      const x1 = (ss * pin(0, value('adj'), 50000)) / 100000

      return area(x1 / 2, x1 / 2, w - x1 / 2, h - x1 / 2)
    }
    case 'plus': {
      const x1 = (ss * pin(0, value('adj'), 50000)) / 100000

      return area(0, x1, w, h - x1)
    }
    case 'star5':
      return area(w * 0.31, h * 0.38, w * 0.69, h * 0.76)
    case 'rightArrow': {
      const dy = (h * pin(0, value('adj1'), 100000)) / 200000

      return area(0, h / 2 - dy, w - ((ss * pin(0, value('adj2'), (100000 * w) / ss)) / 100000) * 0.5, h / 2 + dy)
    }
    case 'leftArrow': {
      const dy = (h * pin(0, value('adj1'), 100000)) / 200000

      return area(((ss * pin(0, value('adj2'), (100000 * w) / ss)) / 100000) * 0.5, h / 2 - dy, w, h / 2 + dy)
    }
    case 'upArrow': {
      const dx = (w * pin(0, value('adj1'), 100000)) / 200000

      return area(w / 2 - dx, ((ss * pin(0, value('adj2'), (100000 * h) / ss)) / 100000) * 0.5, w / 2 + dx, h)
    }
    case 'downArrow': {
      const dx = (w * pin(0, value('adj1'), 100000)) / 200000

      return area(w / 2 - dx, 0, w / 2 + dx, h - ((ss * pin(0, value('adj2'), (100000 * h) / ss)) / 100000) * 0.5)
    }
    case 'leftRightArrow': {
      const dy = (h * pin(0, value('adj1'), 100000)) / 200000
      const x2 = (ss * pin(0, value('adj2'), (50000 * w) / ss)) / 100000

      return area(x2 * 0.5, h / 2 - dy, w - x2 * 0.5, h / 2 + dy)
    }
    case 'chevron': {
      const x1 = (ss * pin(0, value('adj'), (100000 * w) / ss)) / 100000

      return area(x1, 0, w - x1, h)
    }
    case 'homePlate': {
      const x1 = w - (ss * pin(0, value('adj'), (100000 * w) / ss)) / 100000

      return area(0, 0, (x1 + w) / 2, h)
    }
    default:
      return area(0, 0, w, h)
  }
}

/** DrawingML's dash patterns, in multiples of the line's width. */
const DASH_PATTERNS: Record<Dash, number[] | null> = { solid: null, dash: [4, 3], dot: [1, 1], dashDot: [4, 3, 1, 3], longDash: [8, 3] }

export function dashArray(dash: Dash, width: number): string | undefined {
  const pattern = DASH_PATTERNS[dash]

  return pattern ? pattern.map((part) => round(part * Math.max(width, 0.5))).join(' ') : undefined
}

export const DASH_NAMES: Record<Dash, string> = { solid: 'Solid', dash: 'Dashed', dot: 'Dotted', dashDot: 'Dash and dot', longDash: 'Long dashes' }

/** An arrow head's size for a line `width` wide, as PowerPoint sizes its medium heads. */
export const headSize = (width: number): number => Math.max(4, width * 3)

/**
 * An arrow head at `tip`, pointing away from `from`: its path, whether it is filled, and how far
 * the line must stop short of the tip so it does not show through.
 */
export function arrowHead(head: ArrowHead, tip: P, from: P, width: number): { d: string; filled: boolean; inset: number } | null {
  if (head === 'none') {
    return null
  }

  const size = headSize(width)
  const length = Math.hypot(tip[0] - from[0], tip[1] - from[1]) || 1
  const ux = (tip[0] - from[0]) / length
  const uy = (tip[1] - from[1]) / length
  const at = (along: number, across: number): P => [tip[0] - ux * along - uy * across, tip[1] - uy * along + ux * across]
  const path = (points: P[], close = true) => `M${points.map(([x, y]) => `${round(x)},${round(y)}`).join(' L')}${close ? ' Z' : ''}`

  switch (head) {
    case 'triangle':
      return { d: path([tip, at(size, size / 2), at(size, -size / 2)]), filled: true, inset: size * 0.8 }
    case 'stealth':
      return { d: path([tip, at(size, size / 2), at(size * 0.65, 0), at(size, -size / 2)]), filled: true, inset: size * 0.6 }
    case 'arrow':
      return { d: path([at(size, size / 2), tip, at(size, -size / 2)], false), filled: false, inset: 0 }
    // A diamond and a dot sit centred on the end, as PowerPoint draws them.
    case 'diamond':
      return { d: path([at(-size / 2, 0), at(0, size / 2), at(size / 2, 0), at(0, -size / 2)]), filled: true, inset: 0 }
    case 'oval': {
      const r = size / 2

      return { d: `M${round(tip[0] - r)},${round(tip[1])} a${round(r)},${round(r)} 0 1 0 ${round(r * 2)},0 a${round(r)},${round(r)} 0 1 0 ${round(-r * 2)},0 Z`, filled: true, inset: 0 }
    }
  }
}
