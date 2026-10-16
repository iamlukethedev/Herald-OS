import { describe, expect, it } from 'vitest'
import { CAR_BASE, FLIGHT_MS, poseAt, SCENE, STILL_MS, STILL_POSE, TRUCK } from './timeline.ts'

const REST_Y = SCENE.ground - CAR_BASE
const at = (from: number, to: number, step = 10): number[] => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step)

describe('the roadster’s flight', () => {
  it('runs three to four seconds, and the still frame under reduced motion is brief', () => {
    expect(FLIGHT_MS).toBeGreaterThanOrEqual(3000)
    expect(FLIGHT_MS).toBeLessThanOrEqual(4000)
    expect(STILL_MS).toBeLessThan(FLIGHT_MS)
  })

  it('fires the jets from a standstill, on the ground, before it moves', () => {
    const start = poseAt(0)

    expect(start).toMatchObject({ angle: 0, jets: 0 })
    expect(start.y).toBe(REST_Y)

    for (const ms of at(200, 440)) {
      const pose = poseAt(ms)

      expect(pose.jets).toBe(1)
      expect(pose.x).toBe(start.x)
      expect(Math.abs(pose.y - REST_Y)).toBeLessThan(2)
    }
  })

  it('then shoots straight up for a split second, level', () => {
    const climb = at(460, 740).map(poseAt)

    expect(climb.every(pose => pose.x === climb[0]!.x && pose.angle === 0)).toBe(true)
    expect(climb.at(-1)!.y).toBeLessThan(REST_Y - 100)
    climb.slice(1).forEach((pose, i) => expect(pose.y).toBeLessThan(climb[i]!.y))
  })

  it('pitches nose up into one whole backward flip, the jets dying away as it turns', () => {
    const angles = at(750, 2000).map(ms => poseAt(ms).angle)

    angles.slice(1).forEach((angle, i) => expect(angle).toBeLessThanOrEqual(angles[i]!))
    expect(poseAt(850).angle).toBeLessThan(0)
    expect(poseAt(2000).angle).toBeCloseTo(-360)
    expect(poseAt(1400).jets).toBe(0)
  })

  it('arcs over the truck with room to spare and never comes back down to land', () => {
    const arc = at(760, FLIGHT_MS).map(poseAt)
    const overTruck = arc.filter(pose => pose.x >= TRUCK.left - 140 && pose.x <= TRUCK.right + 140)

    expect(overTruck.length).toBeGreaterThan(0)
    expect(overTruck.every(pose => pose.y + CAR_BASE < TRUCK.top - 100)).toBe(true)
    arc.slice(1).forEach((pose, i) => {
      expect(pose.x).toBeGreaterThanOrEqual(arc[i]!.x)
      expect(pose.y).toBeLessThanOrEqual(arc[i]!.y)
    })
  })

  it('follows one parabola: the climb flattens at an even rate', () => {
    const ys = [1000, 1500, 2000, 2500].map(ms => poseAt(ms).y)
    const first = ys.slice(1).map((y, i) => y - ys[i]!)
    const second = first.slice(1).map((d, i) => d - first[i]!)

    expect(second[0]).toBeCloseTo(second[1]!, 6)
    expect(second[0]).toBeGreaterThan(0)
  })

  it('leaves through the top right, and the scene fades in and out', () => {
    const end = poseAt(3300)

    expect(end.x).toBeGreaterThan(SCENE.width)
    expect(end.y).toBeLessThan(0)
    expect(poseAt(FLIGHT_MS).opacity).toBe(0)
    expect(poseAt(FLIGHT_MS / 2).opacity).toBe(1)
  })

  it('shows the still frame level over the truck with the jets off', () => {
    expect(STILL_POSE.jets).toBe(0)
    expect(STILL_POSE.x).toBeGreaterThan(TRUCK.left)
    expect(STILL_POSE.x).toBeLessThan(TRUCK.right)
    expect(STILL_POSE.y + CAR_BASE).toBeLessThan(TRUCK.top)
  })
})
