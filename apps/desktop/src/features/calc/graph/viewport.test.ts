import { describe, expect, it } from 'vitest'
import { formatReadout, formatTick } from './format.ts'
import { clampView, fitView, type GraphViewport, largerStep, lerpView, minorStep, nearestPoint, niceStep, panBy, sameView, screenX, screenY, ticksIn, worldX, worldY, xRangeFor, yRangeIn, zoomAbout } from './viewport.ts'

const view: GraphViewport = { xMin: -10, xMax: 10, yMin: -5, yMax: 5 }
const size = { width: 400, height: 200 }

describe('where the plane lands on the canvas', () => {
  it('puts the view’s corners on the canvas’s, y growing upwards', () => {
    expect([screenX(view, size, -10), screenY(view, size, -5)]).toEqual([0, 200])
    expect([screenX(view, size, 10), screenY(view, size, 5)]).toEqual([400, 0])
    expect([screenX(view, size, 0), screenY(view, size, 0)]).toEqual([200, 100])
  })

  it('reads a canvas point back as the point it shows', () => {
    for (const [x, y] of [
      [1.25, -3.5],
      [-7, 4.75]
    ]) {
      expect(worldX(view, size, screenX(view, size, x))).toBeCloseTo(x, 12)
      expect(worldY(view, size, screenY(view, size, y))).toBeCloseTo(y, 12)
    }
  })
})

describe('moving and zooming', () => {
  it('moves the plane with the pointer', () => {
    const moved = panBy(view, size, 40, -20)

    expect(moved).toEqual({ xMin: -12, xMax: 8, yMin: -6, yMax: 4 })
  })

  it('zooms about a point, which stays where it was on screen', () => {
    const at: [number, number] = [4, -2]
    const before = [screenX(view, size, at[0]), screenY(view, size, at[1])]
    const zoomed = zoomAbout(view, 0.5, at)

    expect(zoomed.xMax - zoomed.xMin).toBeCloseTo(10, 12)
    expect(zoomed.yMax - zoomed.yMin).toBeCloseTo(5, 12)
    expect(screenX(zoomed, size, at[0])).toBeCloseTo(before[0], 9)
    expect(screenY(zoomed, size, at[1])).toBeCloseTo(before[1], 9)
  })

  it('zooms one axis alone when asked', () => {
    const wider = zoomAbout(view, 2, [0, 0], 'x')

    expect(wider).toEqual({ xMin: -20, xMax: 20, yMin: -5, yMax: 5 })
  })

  it('stops zooming before floating point gives out', () => {
    let zoomed = view

    for (let step = 0; step < 200; step++) {
      zoomed = zoomAbout(zoomed, 0.2, [1, 1])
    }

    expect(zoomed.xMax - zoomed.xMin).toBeGreaterThan(0)
    expect(zoomed.xMax - zoomed.xMin).toBeGreaterThanOrEqual(1e-10)
    expect(zoomAbout(view, 1e30, [0, 0]).xMax - zoomAbout(view, 1e30, [0, 0]).xMin).toBeLessThanOrEqual(1e15)
  })

  it('mends a view with no width', () => {
    const mended = clampView({ xMin: 3, xMax: 3, yMin: 0, yMax: 1 })

    expect(mended.xMax).toBeGreaterThan(mended.xMin)
    expect((mended.xMin + mended.xMax) / 2).toBe(3)
  })
})

describe('ticks', () => {
  it('steps by 1, 2 or 5 times a power of ten', () => {
    expect(niceStep(10, 10)).toBe(1)
    expect(niceStep(20, 10)).toBe(2)
    expect(niceStep(43, 10)).toBe(5)
    expect(niceStep(0.07, 10)).toBeCloseTo(0.005, 15)
    expect(niceStep(3e6, 5)).toBe(500000)
    expect([largerStep(1), largerStep(2), largerStep(5), largerStep(0.5)]).toEqual([2, 5, 10, 1])
    expect([minorStep(1), minorStep(2), minorStep(5)]).toEqual([0.2, 0.5, 1])
  })

  it('lists multiples of the step without float noise', () => {
    expect(ticksIn(0, 1, 0.1)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1])
    expect(ticksIn(-0.25, 0.25, 0.1)).toEqual([-0.2, -0.1, 0, 0.1, 0.2])
    expect(Object.is(ticksIn(-1, 1, 1)[1], 0)).toBe(true)
  })

  it('labels ticks with the decimals their step needs, in the locale', () => {
    expect(formatTick(1500, 500, 'en-US')).toBe('1,500')
    expect(formatTick(0.5, 0.5, 'de-DE')).toBe('0,5')
    expect(formatTick(0.3, 0.1, 'en-US')).toBe('0.3')
    expect(formatTick(2e6, 1e6, 'en-US')).toBe('2 × 10⁶')
    expect(formatTick(5e-5, 5e-5, 'en-US')).toBe('5 × 10⁻⁵')
    expect(formatTick(1e-17, 1, 'en-US')).toBe('0')
  })

  it('reads a traced value to about four significant digits', () => {
    expect(formatReadout(Math.PI / 2, 'en-US')).toBe('1.571')
    expect(formatReadout(-0.000123456, 'en-US')).toBe('-0.0001235')
    expect(formatReadout(12345.6, 'en-US')).toBe('12,346')
    expect(formatReadout(1234.5, 'de-DE')).toBe('1.235')
    expect(formatReadout(6.02214e23, 'en-US')).toBe('6.022 × 10²³')
    expect(formatReadout(Number.NaN)).toBe('—')
  })
})

describe('reading the data', () => {
  const column: Array<[number, number]> = [
    [1, 1200],
    [2, 980],
    [3, 1500],
    [4, 1320]
  ]

  it('fits the x range asked for, else the points’ with room, else −10 to 10', () => {
    expect(xRangeFor([column], -2, 2)).toEqual([-2, 2])
    expect(xRangeFor([column], 2, 2)).toEqual([0.88, 4.12])
    expect(xRangeFor([[[5, 1]]])).toEqual([4, 6])
    expect(xRangeFor([])).toEqual([-10, 10])
  })

  it('reads the y range of the points in view, and the point nearest a traced x', () => {
    expect(yRangeIn(column, [1.5, 3.5])).toEqual([980, 1500])
    expect(yRangeIn(column, [5, 6])).toBeNull()
    expect(nearestPoint(column, 2.4)).toEqual([2, 980])
    expect(nearestPoint(column, 2.6)).toEqual([3, 1500])
    expect(nearestPoint(column, -100)).toEqual([1, 1200])
    expect(nearestPoint(column, 100)).toEqual([4, 1320])
  })
})

describe('fitting and easing', () => {
  it('shows the x range asked for and what is drawn there, with room', () => {
    const fitted = fitView([-5, 5], [[-2, 23]], size)

    expect([fitted.xMin, fitted.xMax]).toEqual([-5, 5])
    expect(fitted.yMin).toBeLessThan(-2)
    expect(fitted.yMax).toBeGreaterThan(23)
  })

  it('brings the x-axis in when the values sit close to it', () => {
    expect(fitView([0, 10], [[1, 10]], size).yMin).toBeLessThan(0)
    expect(fitView([0, 10], [[100, 110]], size).yMin).toBeGreaterThan(90)
  })

  it('shows a flat line with room about it, and square units with nothing to draw', () => {
    const flat = fitView([-10, 10], [[3, 3]], size)
    const empty = fitView([-10, 10], [null], size)

    expect(flat.yMin).toBeLessThan(3)
    expect(flat.yMax).toBeGreaterThan(3)
    expect(empty).toEqual({ xMin: -10, xMax: 10, yMin: -5, yMax: 5 })
  })

  it('eases between views, spans in proportion', () => {
    const from = { xMin: -1, xMax: 1, yMin: -1, yMax: 1 }
    const to = { xMin: -100, xMax: 100, yMin: -100, yMax: 100 }
    const half = lerpView(from, to, 0.5)

    expect(lerpView(from, to, 0)).toBe(from)
    expect(lerpView(from, to, 1)).toBe(to)
    expect(half.xMax - half.xMin).toBeCloseTo(20, 9)
    expect(sameView(lerpView(from, to, 1 - 1e-12), to)).toBe(true)
  })
})
