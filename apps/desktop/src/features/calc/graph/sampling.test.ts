import { describe, expect, it } from 'vitest'
import { parseSheetPlot, sampleFunction, summarizeFunction } from './sampling.ts'

type Segment = Array<[number, number]>

const view: [number, number] = [-6, 6]

/** No segment runs across x, so no line is drawn through it. */
const crosses = (segments: Segment[], x: number): boolean => segments.some(segment => segment[0][0] < x && segment[segment.length - 1][0] > x)

/** The biggest step up or down between neighbouring points of any segment. */
const biggestStep = (segments: Segment[]): number => Math.max(0, ...segments.flatMap(segment => segment.slice(1).map(([, y], index) => Math.abs(y - segment[index][1]))))

/** How far the function strays from the lines drawn between its points, at their middles. */
const strayFrom = (fn: (x: number) => number, segments: Segment[]): number =>
  Math.max(0, ...segments.flatMap(segment => segment.slice(1).map(([x, y], index) => Math.abs(fn((x + segment[index][0]) / 2) - (y + segment[index][1]) / 2))))

const increasing = (segments: Segment[]): boolean => segments.every(segment => segment.every(([x], index) => index === 0 || x > segment[index - 1][0]))

describe('sampling a function to draw', () => {
  it('draws sin(x) * x as one smooth segment', () => {
    const fn = (x: number) => Math.sin(x) * x
    const curve = sampleFunction(fn, -10, 10, { samples: 600, yView: [-9, 9] })
    // A pixel's height at 600 samples across 18 units of y.
    const pixel = 18 / (600 * 0.6)

    expect(curve.segments).toHaveLength(1)
    expect(curve.asymptotes).toEqual([])
    expect(increasing(curve.segments)).toBe(true)
    expect(curve.segments[0][0]).toEqual([-10, fn(-10)])
    expect(curve.segments[0].at(-1)).toEqual([10, fn(10)])
    expect(strayFrom(fn, curve.segments)).toBeLessThan(pixel)
    expect(curve.yRange?.[0]).toBeCloseTo(fn(10), 9)
    expect(curve.yRange?.[1]).toBeCloseTo(7.9167, 2)
  })

  it('finds tan’s asymptotes and draws no line through them', () => {
    const curve = sampleFunction(Math.tan, -5, 5, { samples: 600, yView: view })
    const poles = [-1.5, -0.5, 0.5, 1.5].map(k => k * Math.PI)

    expect(curve.asymptotes).toHaveLength(4)
    curve.asymptotes.forEach((x, index) => expect(x).toBeCloseTo(poles[index], 6))
    poles.forEach(pole => expect(crosses(curve.segments, pole)).toBe(false))
    expect(curve.segments.flat().every(([, y]) => Math.abs(y) <= 30)).toBe(true)
    expect(curve.yRange![1]).toBeLessThan(40)
  })

  it('finds the asymptote of 1/x and of 1/(x - 2), whatever the view', () => {
    const reciprocal = sampleFunction(x => 1 / x, -5, 5, { samples: 500, yView: view })
    const shifted = sampleFunction(x => 1 / (x - 2), -10, 10, { samples: 777 })
    const onTheEdge = sampleFunction(x => 1 / x, 0, 5, { samples: 400, yView: view })

    expect(reciprocal.asymptotes).toHaveLength(1)
    expect(reciprocal.asymptotes[0]).toBeCloseTo(0, 9)
    expect(reciprocal.segments).toHaveLength(2)
    expect(crosses(reciprocal.segments, 0)).toBe(false)
    expect(shifted.asymptotes).toHaveLength(1)
    expect(shifted.asymptotes[0]).toBeCloseTo(2, 9)
    expect(crosses(shifted.segments, 2)).toBe(false)
    expect(onTheEdge.asymptotes).toHaveLength(1)
    expect(onTheEdge.asymptotes[0]).toBeCloseTo(0, 9)
  })

  it('finds the asymptote of 1/x², where both sides head up', () => {
    const curve = sampleFunction(x => 1 / (x * x), -3, 3, { samples: 500, yView: [-1, 9] })

    expect(curve.asymptotes).toHaveLength(1)
    expect(curve.asymptotes[0]).toBeCloseTo(0, 9)
    expect(crosses(curve.segments, 0)).toBe(false)
  })

  it('leaves sqrt(x) and log(x) out below 0, log with an asymptote and sqrt without', () => {
    const root = sampleFunction(Math.sqrt, -5, 5, { samples: 500, yView: [-3, 3] })
    const log = sampleFunction(Math.log, -5, 5, { samples: 500, yView: [-3, 3] })

    expect(root.segments).toHaveLength(1)
    expect(root.segments[0][0][0]).toBeCloseTo(0, 9)
    expect(root.segments[0][0][1]).toBeLessThan(1e-3)
    expect(root.asymptotes).toEqual([])
    expect(log.segments).toHaveLength(1)
    expect(log.segments[0][0][0]).toBeLessThan(1e-3)
    expect(log.segments[0][0][1]).toBeLessThanOrEqual(-3)
    expect(log.asymptotes).toHaveLength(1)
    expect(log.asymptotes[0]).toBeCloseTo(0, 9)
  })

  it('draws floor(x) and sign(x) as steps, with no line up or down between them', () => {
    const floor = sampleFunction(Math.floor, -3.5, 3.5, { samples: 700, yView: [-5, 5] })
    const sign = sampleFunction(Math.sign, -2, 2, { samples: 400, yView: [-2, 2] })

    expect(floor.segments).toHaveLength(8)
    expect(floor.asymptotes).toEqual([])
    floor.segments.forEach(segment => expect(new Set(segment.map(([, y]) => y)).size).toBe(1))
    floor.segments.slice(1).forEach(segment => expect(segment[0][0]).toBeCloseTo(Math.round(segment[0][0]), 9))
    expect(sign.segments).toHaveLength(2)
    expect(sign.asymptotes).toEqual([])
    expect(biggestStep(sign.segments)).toBe(0)
  })

  it('keeps sin(1/x) near 0 bounded and quick, with no asymptote', () => {
    const started = performance.now()
    const curve = sampleFunction(x => Math.sin(1 / x), -1, 1, { samples: 800, yView: [-1.5, 1.5] })
    const points = curve.segments.reduce((count, segment) => count + segment.length, 0)

    expect(performance.now() - started).toBeLessThan(1000)
    expect(points).toBeGreaterThan(800)
    expect(points).toBeLessThan(60_000)
    expect(curve.asymptotes).toEqual([])
    expect(curve.segments.flat().every(([, y]) => Math.abs(y) <= 1)).toBe(true)
  })

  it('draws a steep straight line whole, and a function that throws or has no value as nothing', () => {
    const steep = sampleFunction(x => 1e6 * x, -1, 1, { samples: 400, yView: [-5, 5] })
    const throwing = sampleFunction(() => {
      throw new Error('no')
    }, -1, 1)

    expect(steep.segments).toHaveLength(1)
    expect(steep.asymptotes).toEqual([])
    expect(throwing).toEqual({ segments: [], asymptotes: [], yRange: null })
    expect(sampleFunction(() => Number.NaN, -1, 1).yRange).toBeNull()
    expect(sampleFunction(x => x, 1, -1).segments).toEqual([])
  })
})

describe('summarizing a function for Hermes', () => {
  it('finds the zeros and the minimum of x^2 - 2', () => {
    const summary = summarizeFunction(x => x ** 2 - 2, -5, 5)

    expect(summary.zeros).toHaveLength(2)
    expect(summary.zeros[0]).toBeCloseTo(-Math.SQRT2, 8)
    expect(summary.zeros[1]).toBeCloseTo(Math.SQRT2, 8)
    expect(summary.extrema).toEqual([{ x: 0, y: -2, kind: 'min' }])
    expect([summary.yMin, summary.yMax]).toEqual([-2, 23])
    expect(summary.asymptotes).toEqual([])
    expect(summary.gaps).toEqual([])
    expect(summary.samples).toContainEqual([-4, 14])
    expect(summary.samples).toContainEqual([0, -2])
  })

  it('finds where sin(x) crosses zero and turns', () => {
    const summary = summarizeFunction(Math.sin, -7, 7)
    const zeros = [-2, -1, 0, 1, 2].map(k => k * Math.PI)
    const turns = [-1.5, -0.5, 0.5, 1.5].map(k => k * Math.PI)

    expect(summary.zeros).toHaveLength(5)
    summary.zeros.forEach((x, index) => expect(x).toBeCloseTo(zeros[index], 8))
    expect(summary.extrema.map(extremum => extremum.kind)).toEqual(['max', 'min', 'max', 'min'])
    summary.extrema.forEach((extremum, index) => expect(extremum.x).toBeCloseTo(turns[index], 7))
    expect(summary.extrema.map(extremum => extremum.y)).toEqual([1, -1, 1, -1])
    expect([summary.yMin, summary.yMax]).toEqual([-1, 1])
    expect(summary.zeros).toContain(0)
  })

  it('reports asymptotes and gaps, and a y range without the blow-ups', () => {
    const tan = summarizeFunction(Math.tan, -3, 3)
    const log = summarizeFunction(Math.log, -2, 2)
    const root = summarizeFunction(x => Math.sqrt(x - 1), -4, 4)

    expect(tan.asymptotes).toEqual([-1.5707963268, 1.5707963268])
    expect(Math.abs(tan.yMin!)).toBeLessThan(100)
    expect(tan.zeros).toEqual([0])
    expect(log.gaps).toEqual([[-2, 0]])
    expect(log.asymptotes).toEqual([0])
    expect(log.zeros).toEqual([1])
    expect(root.gaps).toEqual([[-4, 1]])
    expect(root.asymptotes).toEqual([])
    expect(root.yMin).toBeCloseTo(0, 4)
  })

  it('finds a zero that only touches the axis', () => {
    const summary = summarizeFunction(x => (x - 1) ** 2, -3, 3)

    expect(summary.zeros).toEqual([1])
    expect(summary.extrema).toEqual([{ x: 1, y: 0, kind: 'min' }])
  })
})

describe('reading what sheet a plot names', () => {
  it.each([
    ['column B of Budget.xlsx', { workbook: 'Budget.xlsx', range: 'B:B' }],
    ['col b in Budget.xlsx', { workbook: 'Budget.xlsx', range: 'B:B' }],
    ['plot column B of Budget.xlsx', { workbook: 'Budget.xlsx', range: 'B:B' }],
    ['graph the column C from Budget.csv', { workbook: 'Budget.csv', range: 'C:C' }],
    ['draw B2:B40 of ~/Documents/Sales.xlsx', { workbook: '~/Documents/Sales.xlsx', range: 'B2:B40' }],
    ['B2:B40 from ~/Documents/Sales.xlsx', { workbook: '~/Documents/Sales.xlsx', range: 'B2:B40' }],
    ['b2:b40 in /Users/sam/Documents/Sales.xls', { workbook: '/Users/sam/Documents/Sales.xls', range: 'B2:B40' }],
    ['$B$2:$B$9 in Sales.xlsx', { workbook: 'Sales.xlsx', range: 'B2:B9' }],
    ['Budget.xlsx column C', { workbook: 'Budget.xlsx', range: 'C:C' }],
    ['Budget.xlsx, col C', { workbook: 'Budget.xlsx', range: 'C:C' }],
    ['~/My Files/Q1 Budget.xlsx B:B', { workbook: '~/My Files/Q1 Budget.xlsx', range: 'B:B' }],
    ['column B of sheet Expenses in Budget.xlsx', { workbook: 'Budget.xlsx', range: 'B:B', sheet: 'Expenses' }],
    ['column B in the Expenses sheet of Budget.xlsx', { workbook: 'Budget.xlsx', range: 'B:B', sheet: 'Expenses' }],
    ["column B of sheet 'Q1 sales' in Budget.xlsx", { workbook: 'Budget.xlsx', range: 'B:B', sheet: 'Q1 sales' }],
    ["'Q1 sales'!B2:B9 of Budget.xlsx", { workbook: 'Budget.xlsx', range: 'B2:B9', sheet: 'Q1 sales' }],
    ['Budget.xlsx sheet Expenses column C', { workbook: 'Budget.xlsx', range: 'C:C', sheet: 'Expenses' }],
    ['column B of ~/My Documents/Plan of Action.xlsx', { workbook: '~/My Documents/Plan of Action.xlsx', range: 'B:B' }],
    ['column B of “Budget 2026.xlsx”.', { workbook: 'Budget 2026.xlsx', range: 'B:B' }]
  ])('reads “%s”', (text, ref) => {
    expect(parseSheetPlot(text)).toEqual(ref)
  })

  it.each(['sin(x) * x', 'x^2 - 2', 'column B', 'Budget.xlsx', 'column B of Budget', 'column ABCD of Budget.xlsx', 'y = 2x + 1'])('reads “%s” as no sheet', text => {
    expect(parseSheetPlot(text)).toBeNull()
  })
})
