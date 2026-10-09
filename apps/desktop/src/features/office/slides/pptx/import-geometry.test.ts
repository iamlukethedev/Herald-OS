import { describe, expect, it } from 'vitest'
import { arcCurves, readGeometry } from './read-geometry.ts'
import { parseXml } from './xml.ts'

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'

/** Degrees in DrawingML's 60,000ths. */
const deg = (degrees: number): number => degrees * 60000

type Point = [number, number]

const geometry = (inner: string) => parseXml(`<a:custGeom xmlns:a="${A}">${inner}</a:custGeom>`)

const path = (commands: string, attrs = '') => `<a:pathLst><a:path${attrs}>${commands}</a:path></a:pathLst>`

const point = (x: string | number, y: string | number) => `<a:pt x="${x}" y="${y}"/>`

/** Where a cubic curve from `from` is at `t`. */
function along(from: Point, [c1, c2, to]: Point[], t: number): Point {
  const u = 1 - t

  return [0, 1].map((axis) => u * u * u * from[axis] + 3 * u * u * t * c1[axis] + 3 * u * t * t * c2[axis] + t * t * t * to[axis]) as Point
}

describe('arcCurves', () => {
  it('turns a quarter of a circle into one curve that keeps to the circle', () => {
    const { curves, to } = arcCurves([0, 100], 100, 100, deg(180), deg(90))
    const middle = along([0, 100], curves[0], 0.5)

    expect(curves).toHaveLength(1)
    expect(to[0]).toBeCloseTo(100)
    expect(to[1]).toBeCloseTo(0)
    expect(Math.hypot(middle[0] - 100, middle[1] - 100)).toBeCloseTo(100, 1)
  })

  it('goes round in pieces of at most a quarter turn, either way', () => {
    const back = arcCurves([0, 0], 50, 50, 0, deg(-90))

    expect(arcCurves([0, 0], 50, 50, 0, deg(270)).curves).toHaveLength(3)
    expect(arcCurves([0, 0], 50, 50, 0, deg(-360)).curves).toHaveLength(4)
    expect(arcCurves([0, 0], 50, 50, 0, deg(100)).curves).toHaveLength(2)
    expect(back.to[0]).toBeCloseTo(-50)
    expect(back.to[1]).toBeCloseTo(-50)
  })

  it('follows an ellipse, its angles measured from its centre as the eye sees them', () => {
    const { curves, to } = arcCurves([0, 0], 200, 100, 0, deg(45))
    const reach = 1 / Math.sqrt(1 / 200 ** 2 + 1 / 100 ** 2)
    const middle = along([0, 0], curves[0], 0.5)

    expect(to[0]).toBeCloseTo(-200 + reach)
    expect(to[1]).toBeCloseTo(reach)
    expect(((middle[0] + 200) / 200) ** 2 + (middle[1] / 100) ** 2).toBeCloseTo(1, 3)
  })

  it('draws nothing for no swing', () => {
    expect(arcCurves([5, 5], 10, 10, deg(30), 0)).toEqual({ curves: [], to: [5, 5] })
  })
})

describe('readGeometry', () => {
  it('works points out from guides: the shape’s size and what follows from it, and the guides before', () => {
    const paths = readGeometry(
      geometry(
        `<a:avLst><a:gd name="adj" fmla="val 1000"/></a:avLst><a:gdLst><a:gd name="x1" fmla="*/ w 1 4"/><a:gd name="x2" fmla="+- x1 0 -10"/><a:gd name="y1" fmla="pin 0 adj h"/></a:gdLst>${path(`<a:moveTo>${point('x1', 't')}</a:moveTo><a:lnTo>${point('x2', 'y1')}</a:lnTo><a:lnTo>${point('r', 'vc')}</a:lnTo><a:close/>`)}`
      ),
      400,
      200
    )

    expect(paths).toEqual([{ width: 400, height: 200, d: 'M 100 0 L 110 200 L 400 100 Z' }])
  })

  it('works out every kind of formula', () => {
    const formulas = ['?: -1 5 7', 'abs -5', 'at2 1 1', 'cat2 10 3 4', 'sat2 10 3 4', 'cos 10 5400000', 'sin 10 5400000', 'tan 10 2700000', 'max 3 9', 'min 3 9', 'mod 3 4 0', 'sqrt 16', '+/ 2 4 3', 'val -0.5']
    const guides = formulas.map((formula, index) => `<a:gd name="g${index}" fmla="${formula}"/>`).join('')
    const commands = [0, 2, 4, 6, 8, 10, 12].map((index) => `<a:${index ? 'lnTo' : 'moveTo'}>${point(`g${index}`, `g${index + 1}`)}</a:${index ? 'lnTo' : 'moveTo'}>`).join('')

    expect(readGeometry(geometry(`<a:gdLst>${guides}</a:gdLst>${path(commands, ' w="10" h="10"')}`), 100, 100)).toEqual([{ width: 10, height: 10, d: 'M 7 5 L 2700000 6 L 8 0 L 10 10 L 9 3 L 5 4 L 2 -0.5' }])
  })

  it('gives each path its own size, or the shape’s, and keeps what it is drawn without', () => {
    const paths = readGeometry(geometry(`<a:pathLst><a:path w="20" h="10" stroke="0"><a:moveTo>${point(0, 0)}</a:moveTo><a:lnTo>${point(20, 10)}</a:lnTo></a:path><a:path fill="none"><a:lnTo>${point(5, 5)}</a:lnTo></a:path></a:pathLst>`), 300, 150)

    expect(paths).toEqual([
      { width: 20, height: 10, d: 'M 0 0 L 20 10', stroke: false },
      { width: 300, height: 150, d: 'M 0 0 L 5 5', fill: false }
    ])
  })

  it('starts a path that draws before it moves at its top left', () => {
    const [arc] = readGeometry(geometry(path('<a:arcTo wR="10" hR="10" stAng="cd2" swAng="cd4"/><a:close/>', ' w="20" h="20"')), 20, 20) ?? []

    expect(arc.d).toMatch(/^M 0 0 C [-\d. ]+ 10 -10 Z$/)
    expect(readGeometry(geometry(path('<a:close/>')), 10, 10)).toBeNull()
  })

  it('gives null where a point names what cannot be worked out, or there is nothing to draw', () => {
    expect(readGeometry(geometry(path(`<a:moveTo>${point('nowhere', 0)}</a:moveTo>`)), 10, 10)).toBeNull()
    expect(readGeometry(geometry(`<a:gdLst><a:gd name="odd" fmla="frob 1 2"/></a:gdLst>${path(`<a:moveTo>${point('odd', 0)}</a:moveTo>`)}`), 10, 10)).toBeNull()
    expect(readGeometry(geometry(path('<a:arcTo wR="wd2" hR="nowhere" stAng="0" swAng="cd4"/>')), 10, 10)).toBeNull()
    expect(readGeometry(geometry(path('<a:cubicBezTo><a:pt x="1" y="1"/></a:cubicBezTo>')), 10, 10)).toBeNull()
    expect(readGeometry(geometry(path('')), 10, 10)).toBeNull()
    expect(readGeometry(geometry(''), 10, 10)).toBeNull()
  })
})
