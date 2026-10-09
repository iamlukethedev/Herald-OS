import { describe, expect, it } from 'vitest'
import { CONNECTOR_PRESETS } from './deck.ts'
import { connectorPath } from './shapes-connectors.ts'

const points = (path: string): number[][] => [...path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((match) => [Number(match[1]), Number(match[2])])

const near = (vector: number[]) => vector.map((value) => Math.round(value * 1000) / 1000 + 0)

describe('connector paths', () => {
  it('runs every preset from the top left of its box to the bottom right, through finite points', () => {
    const adjusts: Record<string, number>[] = [{}, { adj1: -50000, adj2: 150000, adj3: 250000 }]

    for (const preset of CONNECTOR_PRESETS) {
      for (const adjust of adjusts) {
        const path = connectorPath(preset, 200, 100, adjust)
        const all = points(path.d)

        expect(path.d, preset).toMatch(/^M0,0 /)
        expect(all.flat().every(Number.isFinite), preset).toBe(true)
        expect(all.at(-1), preset).toEqual([200, 100])
        expect(path.start, preset).toEqual([0, 0])
        expect(path.end, preset).toEqual([200, 100])
        expect(Math.hypot(...path.startDirection), preset).toBeCloseTo(1)
        expect(Math.hypot(...path.endDirection), preset).toBeCloseTo(1)
      }
    }
  })

  it('draws a straight connector as a line', () => {
    const path = connectorPath('straightConnector1', 200, 100)

    expect(path.d).toBe('M0,0 L200,100')
    expect(near(path.endDirection)).toEqual(near([2 / Math.sqrt(5), 1 / Math.sqrt(5)]))
    expect(near(path.startDirection)).toEqual(near([-2 / Math.sqrt(5), -1 / Math.sqrt(5)]))
  })

  it('bends at right angles where its adjust values put the turns', () => {
    expect(connectorPath('bentConnector2', 200, 100).d).toBe('M0,0 L200,0 L200,100')
    expect(connectorPath('bentConnector3', 200, 100).d).toBe('M0,0 L100,0 L100,100 L200,100')
    expect(connectorPath('bentConnector3', 200, 100, { adj1: -25000 }).d).toBe('M0,0 L-50,0 L-50,100 L200,100')
    expect(connectorPath('bentConnector4', 200, 100, { adj1: 25000, adj2: 150000 }).d).toBe('M0,0 L50,0 L50,150 L200,150 L200,100')
    expect(connectorPath('bentConnector5', 200, 100, { adj1: 10000, adj2: 50000, adj3: 90000 }).d).toBe('M0,0 L20,0 L20,50 L180,50 L180,100 L200,100')
  })

  it('leaves each end along its end segment', () => {
    const two = connectorPath('bentConnector2', 200, 100)
    const four = connectorPath('bentConnector4', 200, 100, { adj1: 25000, adj2: 150000 })

    expect(near(two.startDirection)).toEqual([-1, 0])
    expect(near(two.endDirection)).toEqual([0, 1])
    expect(near(four.endDirection)).toEqual([0, -1])
    expect(near(connectorPath('bentConnector3', 200, 100).endDirection)).toEqual([1, 0])
  })

  it('curves through its turns, leaving each end along the curve', () => {
    const two = connectorPath('curvedConnector2', 200, 100)
    const three = connectorPath('curvedConnector3', 200, 100)

    expect(two.d).toBe('M0,0 C100,0 200,50 200,100')
    expect(near(two.startDirection)).toEqual([-1, 0])
    expect(near(two.endDirection)).toEqual([0, 1])
    expect(three.d).toBe('M0,0 C50,0 100,25 100,50 C100,75 150,100 200,100')
    expect(near(three.endDirection)).toEqual([1, 0])
    expect(connectorPath('curvedConnector4', 200, 100).d.match(/C/g)).toHaveLength(3)
    expect(connectorPath('curvedConnector5', 200, 100).d.match(/C/g)).toHaveLength(4)
  })

  it('stops short of its ends by the trim, along the end segments', () => {
    expect(connectorPath('bentConnector3', 200, 100, {}, { start: 10, end: 6 }).d).toBe('M10,0 L100,0 L100,100 L194,100')
    expect(connectorPath('straightConnector1', 30, 40, {}, { end: 10 }).d).toBe('M0,0 L24,32')
    expect(connectorPath('curvedConnector2', 200, 100, {}, { end: 8 }).d).toBe('M0,0 C100,0 200,50 200,92')
    expect(connectorPath('straightConnector1', 3, 4, {}, { start: 100 }).d).toBe('M1.5,2 L3,4')
  })
})
