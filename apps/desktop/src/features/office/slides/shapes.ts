import type { ArrowHead, Box, CustomPath, Dash, ShapeKind } from './deck.ts'
import { evaluateGeometry, pathData, round, scalePathData, type ShapePart } from './shapes-geometry.ts'
import { PRESETS } from './shapes-presets.ts'

export { CONNECTORS, connectorPath, type ConnectorGeometry } from './shapes-connectors.ts'
export { PART_FILLS, type PartFill, type ShapePart } from './shapes-geometry.ts'

/*
 * The preset shapes as SVG paths, worked out from DrawingML's preset definitions with the same
 * adjust values and defaults, so a shape here and the same shape in PowerPoint have one outline;
 * the parts PowerPoint shades or leaves unfilled; and the box text sits in inside each.
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

/** What the toolbar's shape picker and the Insert menu's short list offer, in order (four rows of six with the line). */
export const INSERTABLE: ShapeKind[] = [
  'rect',
  'roundRect',
  'ellipse',
  'triangle',
  'rtTriangle',
  'diamond',
  'parallelogram',
  'trapezoid',
  'pentagon',
  'hexagon',
  'octagon',
  'plus',
  'rightArrow',
  'leftArrow',
  'upArrow',
  'downArrow',
  'leftRightArrow',
  'chevron',
  'star5',
  'heart',
  'cloud',
  'wedgeRoundRectCallout',
  'can'
]

export interface ShapeGroup {
  name: string
  kinds: readonly ShapeKind[]
}

/** Every preset in the groups PowerPoint's shape gallery has, in its order. */
export const SHAPE_GROUPS: readonly ShapeGroup[] = [
  { name: 'Rectangles', kinds: ['rect', 'roundRect', 'snip1Rect', 'snip2SameRect', 'round1Rect', 'round2SameRect'] },
  {
    name: 'Basic shapes',
    kinds: [
      'ellipse',
      'triangle',
      'rtTriangle',
      'parallelogram',
      'trapezoid',
      'diamond',
      'pentagon',
      'hexagon',
      'heptagon',
      'octagon',
      'decagon',
      'dodecagon',
      'pie',
      'chord',
      'teardrop',
      'frame',
      'halfFrame',
      'corner',
      'diagStripe',
      'plus',
      'plaque',
      'can',
      'cube',
      'bevel',
      'donut',
      'noSmoking',
      'blockArc',
      'foldedCorner',
      'smileyFace',
      'heart',
      'lightningBolt',
      'sun',
      'moon',
      'cloud',
      'bracketPair',
      'bracePair',
      'leftBracket',
      'rightBracket',
      'leftBrace',
      'rightBrace'
    ]
  },
  {
    name: 'Arrows',
    kinds: ['rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'leftRightArrow', 'upDownArrow', 'quadArrow', 'bentArrow', 'uturnArrow', 'stripedRightArrow', 'notchedRightArrow', 'homePlate', 'chevron']
  },
  { name: 'Equation shapes', kinds: ['mathPlus', 'mathMinus', 'mathMultiply', 'mathDivide', 'mathEqual', 'mathNotEqual'] },
  {
    name: 'Flowchart',
    kinds: [
      'flowChartProcess',
      'flowChartAlternateProcess',
      'flowChartDecision',
      'flowChartInputOutput',
      'flowChartPredefinedProcess',
      'flowChartInternalStorage',
      'flowChartDocument',
      'flowChartMultidocument',
      'flowChartTerminator',
      'flowChartPreparation',
      'flowChartManualInput',
      'flowChartManualOperation',
      'flowChartConnector',
      'flowChartOffpageConnector',
      'flowChartPunchedCard',
      'flowChartPunchedTape',
      'flowChartSummingJunction',
      'flowChartOr',
      'flowChartCollate',
      'flowChartSort',
      'flowChartExtract',
      'flowChartMerge',
      'flowChartOnlineStorage',
      'flowChartDelay',
      'flowChartMagneticDisk',
      'flowChartDisplay'
    ]
  },
  { name: 'Stars and banners', kinds: ['star4', 'star5', 'star6', 'star8', 'star10', 'star12', 'wave', 'doubleWave'] },
  { name: 'Callouts', kinds: ['wedgeRectCallout', 'wedgeRoundRectCallout', 'wedgeEllipseCallout', 'cloudCallout'] }
]

/** Each preset's adjust values where the file says nothing. */
export const ADJUST_DEFAULTS: Partial<Record<ShapeKind, Record<string, number>>> = Object.fromEntries(
  Object.entries(PRESETS).flatMap(([kind, definition]) => (definition.av ? [[kind, definition.av]] : []))
)

const geometry = (kind: ShapeKind, w: number, h: number, adjust: Record<string, number> = {}) => evaluateGeometry(PRESETS[kind] ?? PRESETS.rect, w, h, adjust)

/** The paths a preset is drawn with in a `w` by `h` box, in drawing order, each with how it is filled and whether it is outlined. */
export function shapeParts(kind: ShapeKind, w: number, h: number, adjust: Record<string, number> = {}): ShapePart[] {
  return geometry(kind, w, h, adjust).parts.map(({ segments, ...part }) => ({ ...part, d: pathData(segments) }))
}

/** A preset's outline in a `w` by `h` box as one SVG path: every part PowerPoint outlines, so stroking it draws the shape's lines. */
export function shapePath(kind: ShapeKind, w: number, h: number, adjust: Record<string, number> = {}): string {
  const parts = shapeParts(kind, w, h, adjust)
  const outlined = parts.filter((part) => part.stroke)

  return (outlined.length ? outlined : parts).map((part) => part.d).join(' ')
}

/** The part of a preset's box its text is laid out in, before the text body's insets. */
export const textArea = (kind: ShapeKind, w: number, h: number, adjust: Record<string, number> = {}): Box => geometry(kind, w, h, adjust).text

/** A freeform's paths stretched over a `w` by `h` box, filled by the even-odd rule as PowerPoint fills freeforms. */
export const customParts = (paths: readonly CustomPath[], w: number, h: number): ShapePart[] =>
  paths.map((path) => ({ d: scalePathData(path.d, path.width ? w / path.width : 1, path.height ? h / path.height : 1), fill: path.fill === false ? 'none' : 'normal', stroke: path.stroke !== false, evenOdd: true }))

type P = [number, number]

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
