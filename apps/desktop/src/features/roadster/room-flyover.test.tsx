// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { RoomAgent, RoomHandoff, RoomResult } from '../room/model/types.ts'
import { completedHandoffs, createFlyoverWatch, type FlyoverFeed, ROOM_FLYOVER_GAP_MS, useRoomFlyover } from './room-flyover.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const handoff = (id: string, kind: RoomHandoff['kind'], from: string): RoomHandoff => ({ id, kind, from, to: 's:parent', at: 1, trace: { source: 'frame', type: kind === 'note' ? 'subagent.spawn' : 'subagent.complete', at: 1 } })
const helper = (id: string, status: RoomResult['status'] | null): RoomAgent => ({ id, result: status ? { status } : null }) as unknown as RoomAgent

const agents: Record<string, RoomAgent> = {
  'h:ok': helper('h:ok', 'completed'),
  'h:failed': helper('h:failed', 'failed'),
  'h:timeout': helper('h:timeout', 'timeout'),
  'h:none': helper('h:none', null)
}

describe('the Pet Room’s task-complete flyover', () => {
  it('counts only new result handoffs whose helper’s work completed', () => {
    const handoffs = [handoff('a', 'note', 'h:ok'), handoff('b', 'result', 'h:ok'), handoff('c', 'result', 'h:failed'), handoff('d', 'result', 'h:timeout'), handoff('e', 'result', 'h:none'), handoff('f', 'result', 'h:gone')]

    expect(completedHandoffs(handoffs, agents, new Set())).toEqual(['b'])
    expect(completedHandoffs(handoffs, agents, new Set(['b']))).toEqual([])
  })

  it('flies for a helper that finishes once the Room is live, but not for what it held when it first heard from Hermes', () => {
    const watch = createFlyoverWatch()
    const base: FlyoverFeed = { handoffs: [], agents, settled: false, live: true, enabled: true, flying: false, now: 1_000_000 }
    const old = [handoff('old', 'result', 'h:ok')]

    expect(watch.feed({ ...base, handoffs: old })).toBe(false)
    expect(watch.feed({ ...base, handoffs: old, settled: true })).toBe(false)
    expect(watch.feed({ ...base, handoffs: [...old, handoff('new', 'result', 'h:ok')], settled: true })).toBe(true)
  })

  it('stays down while the Room is not live or a flight is up, and does not fly late for what came then', () => {
    const watch = createFlyoverWatch()
    const base: FlyoverFeed = { handoffs: [], agents, settled: true, live: true, enabled: true, flying: false, now: 1_000_000 }
    watch.feed(base)

    expect(watch.feed({ ...base, handoffs: [handoff('x', 'result', 'h:ok')], live: false })).toBe(false)
    expect(watch.feed({ ...base, handoffs: [handoff('x', 'result', 'h:ok')] })).toBe(false)
    expect(watch.feed({ ...base, handoffs: [handoff('x', 'result', 'h:ok'), handoff('y', 'result', 'h:ok')], flying: true })).toBe(false)
  })

  it('keeps a gap between flights, so a burst of finished helpers flies once', () => {
    const watch = createFlyoverWatch()
    const base: FlyoverFeed = { handoffs: [], agents, settled: true, live: true, enabled: true, flying: false, now: 1_000_000 }
    watch.feed(base)
    const one = [handoff('1', 'result', 'h:ok')]
    const two = [...one, handoff('2', 'result', 'h:ok')]
    const three = [...two, handoff('3', 'result', 'h:ok')]

    expect(watch.feed({ ...base, handoffs: one })).toBe(true)
    expect(watch.feed({ ...base, handoffs: two, now: base.now + ROOM_FLYOVER_GAP_MS - 1 })).toBe(false)
    expect(watch.feed({ ...base, handoffs: three, now: base.now + ROOM_FLYOVER_GAP_MS })).toBe(true)
  })

  it('flies nothing with Flyover animations off, and does not fly later for what finished meanwhile', () => {
    const watch = createFlyoverWatch()
    const base: FlyoverFeed = { handoffs: [], agents, settled: true, live: true, enabled: false, flying: false, now: 1_000_000 }
    watch.feed(base)
    const one = [handoff('1', 'result', 'h:ok')]

    expect(watch.feed({ ...base, handoffs: one })).toBe(false)
    expect(watch.feed({ ...base, handoffs: one, enabled: true })).toBe(false)
    expect(watch.feed({ ...base, handoffs: [...one, handoff('2', 'result', 'h:ok')], enabled: true })).toBe(true)
  })

  it('ends a flight that is up when Flyover animations are turned off', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    let flight = 0
    const Probe = (props: { handoffs: RoomHandoff[]; enabled: boolean }) => {
      flight = useRoomFlyover({ ...props, agents, settled: true, live: true }).flight

      return null
    }
    const one = [handoff('1', 'result', 'h:ok')]

    act(() => root.render(<Probe handoffs={[]} enabled />))
    act(() => root.render(<Probe handoffs={one} enabled />))
    expect(flight).not.toBe(0)

    act(() => root.render(<Probe handoffs={one} enabled={false} />))
    expect(flight).toBe(0)

    act(() => root.unmount())
  })
})
