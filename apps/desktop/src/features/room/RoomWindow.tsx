import type { ApprovalChoice } from '@herald-os/client'
import { useStore } from '@nanostores/react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { liveOutside } from '../../../shared/room.ts'
import { $prefs } from '../../store/backend.ts'
import { $connection } from '../../store/gateway.ts'
import { runCommand } from '../../store/os-commands.ts'
import { isMainSurface, openSurface, relayToMain } from '../../store/shell.ts'
import { useDocumentVisible, useReducedMotion } from '../pet/hooks.ts'
import { $petInfo } from '../pet/info.ts'
import { flyoversOn } from '../roadster/flight.ts'
import { useRoomFlyover } from '../roadster/room-flyover.ts'
import { useRoomAssignment } from './assignment.ts'
import { roomBridge } from './bridge.ts'
import { roomTotal } from './model/costs.ts'
import { factsOf } from './model/facts.ts'
import { summarizeRoom } from './model/summary.ts'
import type { RoomFact } from './model/types.ts'
import { $roomPrefs } from './prefs.ts'
import { RoomReplay } from './replay/RoomReplay.tsx'
import { roomNotices, sameFacts } from './scene/labels.ts'
import { RoomScene } from './scene/RoomScene.tsx'
import { $room, answerRoomApproval, openRoomAgent, useRoomFeed } from './store.ts'

const RoadsterFlight = lazy(() => import('../roadster/RoadsterFlight.tsx').then(m => ({ default: m.RoadsterFlight })))

/** Facts that grow with time ('quiet for 4 minutes during a turn') are worked out again this often. */
const FACTS_MS = 30_000

/** The time now, again every `everyMs` while `running`. */
function useNow(everyMs: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) {
      return
    }

    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), everyMs)

    return () => clearInterval(timer)
  }, [everyMs, running])

  return now
}

/** Settings > Pet, in the Hermes window (its own window in panels mode). */
function openPetSettings(): void {
  if (isMainSurface) {
    void runCommand('settings.open', { section: 'pet' }, { source: 'ui' })

    return
  }

  relayToMain({ type: 'os', args: ['settings.open'], payload: { section: 'pet' } })
  openSurface('main')
}

const answer = (agentId: string, choice: ApprovalChoice) => void answerRoomApproval(agentId, choice)

/** Whether there is a log to play back: it is kept now, or days of it are still on disk. */
function useLogged(kept: boolean): boolean {
  const [onDisk, setOnDisk] = useState(false)

  useEffect(() => {
    let current = true

    void roomBridge()
      ?.logDays()
      .then(
        days => current && setOnDisk(days.length > 0),
        () => undefined
      )

    return () => {
      current = false
    }
  }, [kept])

  return kept || onDisk
}

/** The Room's window content, in a floating window (desktop mode, `active` false while minimized) or its own window (panels mode). */
export function RoomWindow({ active = true }: { active?: boolean }) {
  const [replaying, setReplaying] = useState(false)
  const visible = useDocumentVisible()
  const live = active && visible
  useRoomFeed(live && !replaying)
  const state = useStore($room)
  const prefs = useStore($roomPrefs)
  const info = useStore($petInfo)
  const connection = useStore($connection)
  const reduced = useReducedMotion()
  const now = useNow(FACTS_MS, live)
  const agents = useMemo(() => Object.values(state.agents), [state.agents])
  const assignment = useRoomAssignment(agents)
  const shownFacts = useRef<Record<string, RoomFact[]>>({})
  const facts = useMemo(() => {
    const before = shownFacts.current
    const next = Object.fromEntries(
      agents.map(agent => {
        const fresh = factsOf(agent, state, now)
        const kept = before[agent.id]

        return [agent.id, kept && sameFacts(kept, fresh) ? kept : fresh]
      })
    )
    shownFacts.current = next

    return next
  }, [agents, state, now])
  const summary = useMemo(() => summarizeRoom(state, now), [state, now])
  const notices = useMemo(
    () => roomNotices({ connected: connection === 'open', state: { toolProgress: state.toolProgress, caps: state.caps }, pets: info.installed.length }),
    [connection, state.toolProgress, state.caps, info.installed.length]
  )
  const desks = useMemo(() => Object.values(state.desks ?? {}), [state.desks])
  const total = useMemo(() => (prefs.costTotal ? roomTotal(state) : null), [prefs.costTotal, state])
  const logged = useLogged(prefs.log)
  const flyovers = flyoversOn(useStore($prefs))
  const flyover = useRoomFlyover({ handoffs: state.handoffs, agents: state.agents, settled: state.updatedAt > 0, live: live && !replaying, enabled: flyovers })

  if (replaying) {
    return <RoomReplay active={active} onExit={() => setReplaying(false)} />
  }

  return (
    <div className="relative h-full w-full">
      <RoomScene
        agents={agents}
        handoffs={state.handoffs}
        assignment={assignment}
        installed={info.installed}
        steps={prefs.steps}
        motion={reduced ? 'still' : prefs.motion}
        active={live}
        settled={state.updatedAt > 0}
        facts={facts}
        desks={desks}
        deskNames={prefs.deskNames}
        lane={prefs.elsewhere}
        laneLive={liveOutside(prefs)}
        summary={summary}
        notices={notices}
        meters={prefs.costs}
        total={total}
        onOpen={openRoomAgent}
        onAnswer={answer}
        onPetSettings={openPetSettings}
        onTimeLapse={logged ? () => setReplaying(true) : undefined}
      />
      {flyover.flight !== 0 && flyovers && (
        <Suspense fallback={null}>
          <RoadsterFlight key={flyover.flight} contained claimsClick onDone={flyover.land} />
        </Suspense>
      )}
    </div>
  )
}
