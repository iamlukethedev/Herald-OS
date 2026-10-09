import { describe, expect, it } from 'vitest'
import { SHAPE_KINDS } from './deck.ts'
import { ADJUST_DEFAULTS, arrowHead, customParts, dashArray, INSERTABLE, PART_FILLS, SHAPE_GROUPS, SHAPE_NAMES, shapeParts, shapePath, textArea } from './shapes.ts'
import { evaluateGeometry } from './shapes-geometry.ts'
import { PRESETS } from './shapes-presets.ts'

const points = (path: string): number[][] => [...path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((match) => [Number(match[1]), Number(match[2])])

const numbers = (path: string): number[] => (path.match(/-?[\d.]+(e[-+]?\d+)?/g) ?? []).map(Number)

const moves = (path: string): number => (path.match(/M/g) ?? []).length

/** Each preset's adjust values pushed past either end, one at a time. */
function extremes(kind: (typeof SHAPE_KINDS)[number]): Record<string, number>[] {
  return Object.keys(ADJUST_DEFAULTS[kind] ?? {}).flatMap((name) => [-500000, 0, 1, 100000, 500000, 21600000].map((value) => ({ [name]: value })))
}

describe('preset shapes', () => {
  it('works out every preset from guides, adjust values and built-ins it knows', () => {
    for (const kind of SHAPE_KINDS) {
      expect(evaluateGeometry(PRESETS[kind], 200, 100).missing, kind).toEqual([])
    }
  })

  it('gives every preset finite path data and a text area inside its box, at its defaults and at extreme adjust values', () => {
    for (const kind of SHAPE_KINDS) {
      for (const [w, h] of [
        [200, 100],
        [40, 300],
        [10, 10]
      ]) {
        for (const adjust of [{}, ...extremes(kind)]) {
          const label = `${kind} ${w}x${h} ${JSON.stringify(adjust)}`
          const outline = shapePath(kind, w, h, adjust)
          const area = textArea(kind, w, h, adjust)

          expect(outline, label).toMatch(/^M/)
          expect(numbers(outline).every(Number.isFinite), label).toBe(true)
          expect(outline, label).not.toMatch(/NaN|Infinity/)
          expect(area.x, label).toBeGreaterThanOrEqual(0)
          expect(area.y, label).toBeGreaterThanOrEqual(0)
          expect(area.width, label).toBeGreaterThan(0)
          expect(area.height, label).toBeGreaterThan(0)
          expect(area.x + area.width, label).toBeLessThanOrEqual(w + 1e-9)
          expect(area.y + area.height, label).toBeLessThanOrEqual(h + 1e-9)
        }
      }
    }
  })

  it('draws arrows with PowerPoint’s default shaft and head', () => {
    expect(points(shapePath('rightArrow', 200, 100))).toEqual([
      [0, 25],
      [150, 25],
      [150, 0],
      [200, 50],
      [150, 100],
      [150, 75],
      [0, 75]
    ])
  })

  it('fits a star’s points to its box as PowerPoint does', () => {
    const star = points(shapePath('star5', 100, 100))

    expect(Math.min(...star.map(([, y]) => y))).toBeCloseTo(0)
    expect(Math.min(...star.map(([x]) => x))).toBeCloseTo(0, 1)
    expect(Math.max(...star.map(([x]) => x))).toBeCloseTo(100, 1)
    expect(Math.max(...star.map(([, y]) => y))).toBeCloseTo(100, 1)
  })

  it('puts a callout’s tail on the side it points to', () => {
    const below = points(shapePath('wedgeRectCallout', 200, 100))
    const right = points(shapePath('wedgeRectCallout', 200, 100, { adj1: 80000, adj2: 0 }))
    const oval = points(shapePath('wedgeEllipseCallout', 200, 100))

    expect(below.some(([x, y]) => y > 100 && x < 100)).toBe(true)
    expect(right.some(([x]) => x > 200)).toBe(true)
    expect(oval[0]).toEqual([58.334, 112.5])
  })

  it('honours adjust values and keeps them in range', () => {
    expect(shapePath('roundRect', 100, 50, { adj: 50000 })).toContain('A25,25')
    expect(shapePath('roundRect', 100, 50, { adj: 90000 })).toContain('A25,25')
    expect(points(shapePath('triangle', 100, 100, { adj: 0 }))[1]).toEqual([0, 0])
    expect(points(shapePath('sun', 100, 100, { adj: 0 }))).toEqual(points(shapePath('sun', 100, 100, { adj: 12500 })))
  })

  it('draws arcs from the current point at the angle seen from the centre, a full turn in quarters', () => {
    const pie = points(shapePath('pie', 200, 100))
    const circle = shapePath('flowChartConnector', 200, 100)

    expect(pie[0]).toEqual([200, 50])
    expect(pie.at(-2)).toEqual([100, 0])
    expect(pie.at(-1)).toEqual([100, 50])
    expect(circle.match(/A100,50 0 0 1/g)).toHaveLength(4)
    expect(points(shapePath('chord', 100, 100)).slice(0, 1)).toEqual([[85.355, 85.355]])
  })

  it('stretches a path drawn in units of its own over the box', () => {
    expect(points(shapePath('flowChartDecision', 200, 100))).toEqual([
      [0, 50],
      [100, 0],
      [200, 50],
      [100, 100]
    ])
  })

  it('lays text inside the shape', () => {
    const area = textArea('ellipse', 200, 100)

    expect(area.x).toBeCloseTo(100 - 100 * Math.SQRT1_2)
    expect(area.height).toBeCloseTo(100 * Math.SQRT1_2)
    expect(textArea('rect', 10, 10)).toEqual({ x: 0, y: 0, width: 10, height: 10 })
    expect(textArea('can', 100, 200)).toEqual({ x: 0, y: 25, width: 100, height: 162.5 })
    expect(textArea('rightArrow', 200, 100)).toEqual({ x: 0, y: 25, width: 175, height: 50 })
  })
})

describe('shape parts', () => {
  const fills = (kind: (typeof SHAPE_KINDS)[number]) => shapeParts(kind, 200, 100).map((part) => [part.fill, part.stroke])

  it('gives every preset parts that start with a move and say how they are filled', () => {
    for (const kind of SHAPE_KINDS) {
      const parts = shapeParts(kind, 200, 100)

      expect(parts.length, kind).toBeGreaterThan(0)
      expect(parts.every((part) => part.d.startsWith('M') && PART_FILLS.includes(part.fill)), kind).toBe(true)
      expect(parts.some((part) => part.stroke), kind).toBe(true)
    }
  })

  it('draws a plain shape as one part, filled and outlined', () => {
    expect(shapeParts('rect', 200, 100)).toEqual([{ d: 'M0,0 L200,0 L200,100 L0,100 Z', fill: 'normal', stroke: true }])
  })

  it('shades the parts PowerPoint shades, under one outline', () => {
    expect(fills('can')).toEqual([
      ['normal', false],
      ['lighten', false],
      ['none', true]
    ])
    expect(fills('cube')).toEqual([
      ['normal', false],
      ['darkenLess', false],
      ['lightenLess', false],
      ['none', true]
    ])
    expect(fills('bevel').map(([fill]) => fill)).toEqual(['normal', 'lightenLess', 'darkenLess', 'lighten', 'darken', 'none'])
    expect(fills('foldedCorner')).toContainEqual(['darkenLess', false])
    expect(fills('smileyFace')).toContainEqual(['darkenLess', true])
  })

  it('leaves holes open by the even-odd rule', () => {
    for (const kind of ['donut', 'noSmoking', 'frame'] as const) {
      const [part] = shapeParts(kind, 200, 100)

      expect(part.evenOdd, kind).toBe(true)
      expect(moves(part.d), kind).toBeGreaterThan(1)
    }
  })

  it('draws the lines PowerPoint draws over a shape without filling them', () => {
    for (const kind of ['flowChartPredefinedProcess', 'flowChartInternalStorage', 'flowChartSummingJunction', 'flowChartOr', 'flowChartMagneticDisk', 'flowChartSort', 'cloud', 'flowChartMultidocument'] as const) {
      expect(fills(kind), kind).toContainEqual(['none', true])
    }
  })

  it('outlines brackets and braces without closing them, though their fill is closed', () => {
    for (const kind of ['bracketPair', 'bracePair', 'leftBracket', 'rightBracket', 'leftBrace', 'rightBrace'] as const) {
      const [filled, outlined] = shapeParts(kind, 200, 100)

      expect([filled.fill, filled.stroke, outlined.fill, outlined.stroke], kind).toEqual(['normal', false, 'none', true])
      expect(filled.d, kind).toMatch(/Z$/)
      expect(shapePath(kind, 200, 100), kind).toBe(outlined.d)
      expect(shapePath(kind, 200, 100), kind).not.toContain('Z')
    }
  })

  it('stretches a freeform’s paths over the box, keeping which are filled and outlined', () => {
    const parts = customParts(
      [
        { width: 10, height: 10, d: 'M0,0 L10,0 C10,5 5,10 0,10 Z' },
        { width: 4, height: 2, d: 'M0,2 L4,0', fill: false },
        { width: 0, height: 0, d: 'M1,1 L2,2', stroke: false }
      ],
      200,
      100
    )

    expect(parts).toEqual([
      { d: 'M0 0 L200 0 C200 50 100 100 0 100 Z', fill: 'normal', stroke: true, evenOdd: true },
      { d: 'M0 100 L200 0', fill: 'none', stroke: true, evenOdd: true },
      { d: 'M1 1 L2 2', fill: 'normal', stroke: false, evenOdd: true }
    ])
  })
})

describe('the shape gallery', () => {
  it('puts every preset in one group, and offers only presets', () => {
    const grouped = SHAPE_GROUPS.flatMap((group) => group.kinds)

    expect([...grouped].sort()).toEqual([...SHAPE_KINDS].sort())
    expect(new Set(grouped).size).toBe(grouped.length)
    expect(SHAPE_GROUPS.map((group) => group.name)).toEqual(expect.arrayContaining(['Rectangles', 'Basic shapes', 'Arrows', 'Flowchart', 'Stars and banners', 'Callouts', 'Equation shapes']))
    expect(INSERTABLE.every((kind) => SHAPE_KINDS.includes(kind) && SHAPE_NAMES[kind])).toBe(true)
    expect(INSERTABLE.length % 6).toBe(5)
  })

  it('gives each preset DrawingML’s adjust defaults', () => {
    expect(ADJUST_DEFAULTS.can).toEqual({ adj: 25000 })
    expect(ADJUST_DEFAULTS.star5).toEqual({ adj: 19098, hf: 105146, vf: 110557 })
    expect(ADJUST_DEFAULTS.blockArc).toEqual({ adj1: 10800000, adj2: 0, adj3: 25000 })
    expect(ADJUST_DEFAULTS.rect).toBeUndefined()
  })
})

describe('line details', () => {
  it('draws dashes in multiples of the line’s width', () => {
    expect(dashArray('dash', 2)).toBe('8 6')
    expect(dashArray('solid', 2)).toBeUndefined()
  })

  it('makes heads that point along the line and shorten it where they are solid', () => {
    const head = arrowHead('triangle', [100, 0], [0, 0], 2)!

    expect(head.filled).toBe(true)
    expect(head.inset).toBeGreaterThan(0)
    expect(points(head.d)[0]).toEqual([100, 0])
    expect(arrowHead('none', [1, 1], [0, 0], 1)).toBeNull()
    expect(arrowHead('arrow', [10, 0], [0, 0], 1)!.filled).toBe(false)
  })
})
