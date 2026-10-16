import { useCallback, useEffect, useRef, useState } from 'react'
import type { RoomAgent, RoomHandoff } from '../room/model/types.ts'

/*
 * The Pet Room's task-complete flyover. A helper that finishes hands its result back to the agent
 * that spawned it (a `result` handoff, from `subagent.complete`); when the work completed, the
 * roadster flies over the Room. Handoffs already there when the Room first hears from Hermes are
 * history and fly nothing, and flights keep a gap between them so a burst of helpers flies once.
 */

/** At least this long between two flyovers in the Room. */
export const ROOM_FLYOVER_GAP_MS = 60_000

/** The result handoffs not in `before` whose helper's work completed. */
export function completedHandoffs(handoffs: readonly RoomHandoff[], agents: Readonly<Record<string, RoomAgent>>, before: ReadonlySet<string>): string[] {
  return handoffs.filter(handoff => handoff.kind === 'result' && !before.has(handoff.id) && agents[handoff.from]?.result?.status === 'completed').map(handoff => handoff.id)
}

export interface FlyoverFeed {
  handoffs: readonly RoomHandoff[]
  agents: Readonly<Record<string, RoomAgent>>
  /** The Room has heard from Hermes, so what it holds now was already there. */
  settled: boolean
  /** The Room is on screen and live (not minimized, hidden or replaying). */
  live: boolean
  /** A flight is up already. */
  flying: boolean
  now: number
}

/** Watches what the Room is fed and says when a flyover should start. */
export function createFlyoverWatch(gapMs: number = ROOM_FLYOVER_GAP_MS): { feed: (input: FlyoverFeed) => boolean } {
  let seen: ReadonlySet<string> | null = null
  let lastAt = Number.NEGATIVE_INFINITY

  return {
    feed({ handoffs, agents, settled, live, flying, now }) {
      if (!settled) {
        return false
      }

      const before = seen
      seen = new Set(handoffs.map(handoff => handoff.id))

      if (!before || !live || flying || now - lastAt < gapMs || completedHandoffs(handoffs, agents, before).length === 0) {
        return false
      }

      lastAt = now

      return true
    }
  }
}

/** The Room's flyover: the flight on screen (0 when none) and how to end it. */
export function useRoomFlyover(input: Omit<FlyoverFeed, 'flying' | 'now'>): { flight: number; land: () => void } {
  const watch = useRef<ReturnType<typeof createFlyoverWatch> | null>(null)
  const [flight, setFlight] = useState(0)
  const flying = flight !== 0
  const { handoffs, agents, settled, live } = input

  watch.current ??= createFlyoverWatch()

  useEffect(() => {
    if (watch.current?.feed({ handoffs, agents, settled, live, flying, now: Date.now() })) {
      setFlight(Date.now())
    }
  }, [handoffs, agents, settled, live, flying])

  const land = useCallback(() => setFlight(0), [])

  return { flight, land }
}
