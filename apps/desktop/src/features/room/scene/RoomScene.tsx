import type { ApprovalChoice } from '@herald-os/client'
import { IconPaw } from '@tabler/icons-react'
import { type RefObject, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { InstalledPet } from '../../../../shared/pet.ts'
import type { RoomMotion } from '../../../../shared/room.ts'
import { Pill } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import type { PetAssignment } from '../../petdex/assign.ts'
import { spriteCache } from '../../petdex/cache.ts'
import { petClock } from '../../petdex/clock.ts'
import type { RoomMeter } from '../model/costs.ts'
import type { RoomSummary } from '../model/summary.ts'
import type { RoomAgent, RoomDesk, RoomFact, RoomHandoff } from '../model/types.ts'
import { AgentOverlay } from './AgentOverlay.tsx'
import { ApprovalPopover, type PopoverPlacement, placePopover } from './ApprovalPopover.tsx'
import { createRoomEngine, type PetFrame, type PetMarks, type RoomEngine } from './engine.ts'
import { agentLine, EMPTY_LANE_TEXT, EMPTY_ROOM_TEXT, moreText, type RoomNotice } from './labels.ts'
import { AREA_DEFS, type DeskInput, deskSpot, laneCapacity, layoutRoom, MAX_PETS, pickShown, type RoomSpot, type SceneLayout } from './layout.ts'
import { paintPets } from './paint.ts'
import { RoomBackdrop } from './RoomBackdrop.tsx'
import { RoomHeader } from './RoomHeader.tsx'
import { holdSheets } from './sheets.ts'

export interface RoomSceneProps {
  agents: readonly RoomAgent[]
  handoffs: readonly RoomHandoff[]
  /** Each agent's pet and tint, from `assignPets`. */
  assignment: Readonly<Record<string, PetAssignment>>
  installed: readonly InstalledPet[]
  /** Step bubbles over the pets. */
  steps: boolean
  /** 'still' whenever Reduce Motion is on. */
  motion: RoomMotion
  /** Shown: false stops every tick. */
  active: boolean
  /** The Room has heard from Hermes, so what it holds at first was already there. */
  settled: boolean
  facts: Readonly<Record<string, readonly RoomFact[]>>
  /** The open documents, as desks in their areas. */
  desks?: readonly RoomDesk[]
  /** Desks show their documents' names. */
  deskNames?: boolean
  /** The lane for work outside Herald, which the person turned on. */
  lane?: boolean
  /** The lane shows live steps, which the person turned on as well. */
  laneLive?: boolean
  /** What the lane says at its top and while it is empty, for a scene that is not the live Room. */
  laneText?: { note: string; about: string; empty: string }
  /** Name tags, facts, Hermes's result summaries and the words on the furniture; off for a screensaver. */
  names?: boolean
  /** Pets open their conversations and signs open the approval card; off for a screensaver, which only ever shows. */
  interactive?: boolean
  /** The header and its notices; off for a screensaver. */
  chrome?: boolean
  summary?: RoomSummary | null
  notices?: readonly RoomNotice[]
  /** A token and cost meter on each name tag; off unless the person turns meters on, and never in a screensaver. */
  meters?: boolean
  /** The meters' total in the header, when the person shows it. */
  total?: RoomMeter | null
  onOpen: (agentId: string) => void
  onAnswer: (agentId: string, choice: ApprovalChoice) => void
  onPetSettings?: () => void
  /** Opens the time-lapse; the header offers it only when this is given. */
  onTimeLapse?: () => void
  className?: string
}

interface SceneSize {
  width: number
  height: number
  ratio: number
}

interface Marks {
  marks: Readonly<Record<string, PetMarks>>
  gone: ReadonlySet<string>
}

const NO_MARKS: Marks = { marks: {}, gone: new Set() }
const NO_FACTS: readonly RoomFact[] = []
const NO_DESKS: readonly RoomDesk[] = []
const WORKING = new Set<RoomAgent['phase']>(['tool', 'thinking', 'starting'])

const inLane = (agent: RoomAgent): boolean => agent.area === 'elsewhere'

/** The lane's order: active work first, then the most recently active. */
const laneOrder = (a: RoomAgent, b: RoomAgent): number =>
  Number(Boolean(b.elsewhere?.active)) - Number(Boolean(a.elsewhere?.active)) || (b.elsewhere?.lastActiveAt ?? 0) - (a.elsewhere?.lastActiveAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The element's laid-out size (transforms such as a window's opening animation do not count) and the display's pixel ratio. */
function useSceneSize(ref: RefObject<HTMLElement | null>): SceneSize | null {
  const [size, setSize] = useState<SceneSize | null>(null)

  useLayoutEffect(() => {
    const element = ref.current

    if (!element) {
      return
    }

    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight, ratio: Math.min(3, Math.max(1, window.devicePixelRatio || 1)) }
      setSize(current => (current && current.width === next.width && current.height === next.height && current.ratio === next.ratio ? current : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [ref])

  return size
}

/** The stations that glow, as a stable key: where a pet works (and the desk it works at), and the bench while one waits on it. */
function glowingSpots(agents: readonly RoomAgent[], layout: SceneLayout | null): string {
  const spots = new Set<RoomSpot>()
  const desks = new Set(layout?.stations.filter(station => station.wall === 'desk').map(station => station.id))

  for (const agent of agents) {
    if (WORKING.has(agent.phase) && agent.area !== 'bench' && agent.area !== 'lounge' && agent.area !== 'elsewhere') {
      spots.add(agent.area)

      if (agent.desk && desks.has(deskSpot(agent.desk))) {
        spots.add(deskSpot(agent.desk))
      }
    } else if (agent.area === 'bench' && (agent.phase === 'waiting' || agent.approval || agent.asking)) {
      spots.add('bench')
    }
  }

  return [...spots].sort().join(',')
}

/** How near a side a pet may stand before its bubble opens toward the middle of the room instead of over it. */
const EDGE_PX = 130

function place(root: HTMLElement, x: number, y: number, opacity: number, depth: number, width: number): void {
  root.dataset.edge = x < EDGE_PX ? 'left' : x > width - EDGE_PX ? 'right' : 'middle'
  root.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`
  root.style.opacity = opacity >= 1 ? '' : opacity.toFixed(3)
  root.style.zIndex = String(depth)
  root.style.visibility = ''
}

/**
 * The room: stations drawn once per size, every pet on one canvas, and over them the buttons, name
 * tags, bubbles and signs, which follow the pets through refs rather than React renders.
 */
export function RoomScene({
  agents,
  handoffs,
  assignment,
  installed,
  steps,
  motion,
  active,
  settled,
  facts,
  desks = NO_DESKS,
  deskNames = true,
  lane = false,
  laneLive = false,
  laneText,
  names = true,
  interactive = true,
  chrome = true,
  summary = null,
  notices = [],
  meters = false,
  total = null,
  onOpen,
  onAnswer,
  onPetSettings,
  onTimeLapse,
  className
}: RoomSceneProps) {
  const key = `room-scene:${useId()}`
  const floorRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<RoomEngine | null>(null)
  const roots = useRef(new Map<string, HTMLDivElement>())
  const rootCallbacks = useRef(new Map<string, (element: HTMLDivElement | null) => void>())
  const spots = useRef(new Map<string, { x: number; y: number }>())
  const ratioRef = useRef(1)
  const raisedRef = useRef<string | null>(null)
  const layoutRef = useRef<SceneLayout | null>(null)
  const agentsRef = useRef(agents)
  const shownBefore = useRef<ReadonlySet<string>>(new Set())
  const [marks, setMarks] = useState<Marks>(NO_MARKS)
  const [sign, setSign] = useState<{ id: string; requestId: string; placement: PopoverPlacement } | null>(null)
  const size = useSceneSize(floorRef)
  const deskInputs = useMemo<DeskInput[]>(() => desks.map(({ id, area, name }) => ({ id, area, name })), [desks])
  const metered = meters && names
  const layout = useMemo(() => (size ? layoutRoom(size.width, size.height, AREA_DEFS, { desks: deskInputs, lane, meters: metered }) : null), [size?.width, size?.height, deskInputs, lane, metered])
  const capacity = layout ? laneCapacity(layout) : 0
  const { shown, more, laneMore } = useMemo(() => {
    const room = pickShown(
      agents.filter(agent => !inLane(agent)),
      MAX_PETS,
      shownBefore.current
    )
    const outside = lane ? agents.filter(inLane).sort(laneOrder) : []

    return { shown: [...room.shown, ...outside.slice(0, capacity)], more: room.more, laneMore: Math.max(0, outside.length - capacity) }
  }, [agents, lane, capacity])
  const known = useMemo(() => new Set(agents.map(agent => agent.id)), [agents])
  const still = motion === 'still'
  const visible = shown.filter(agent => !marks.gone.has(agent.id))
  const raised = interactive && sign ? (visible.find(agent => agent.id === sign.id && agent.approval?.requestId === sign.requestId) ?? null) : null
  const raisedId = raised?.id ?? null
  const inRoom = agents.some(agent => !inLane(agent) && !(agent.kind === 'automation' && agent.phase === 'idle'))
  // Live work outside Herald may stand at a station or the bench: the lane is only empty when there is none at all.
  const laneEmpty = lane && !agents.some(agent => agent.kind === 'elsewhere')

  useEffect(() => {
    agentsRef.current = agents
    shownBefore.current = new Set(shown.map(agent => agent.id))

    for (const id of rootCallbacks.current.keys()) {
      if (!known.has(id)) {
        rootCallbacks.current.delete(id)
        spots.current.delete(id)
      }
    }
  }, [agents, shown, known])

  useEffect(() => {
    const paint = (frames: readonly PetFrame[], at: SceneLayout) => {
      const ctx = canvasRef.current?.getContext('2d')

      if (ctx) {
        paintPets(ctx, frames, at, ratioRef.current)
      }

      const placed = new Set<string>()
      frames.forEach((frame, index) => {
        spots.current.set(frame.id, { x: frame.x, y: frame.y })
        const root = frame.leaving ? null : roots.current.get(frame.id)

        if (root) {
          placed.add(frame.id)
          place(root, frame.x, frame.y, frame.opacity, raisedRef.current === frame.id ? frames.length + 1 : index + 1, at.wall.width)
        }
      })

      for (const [id, root] of roots.current) {
        if (!placed.has(id)) {
          root.style.visibility = 'hidden'
        }
      }
    }
    const engine = createRoomEngine({ clock: petClock, key, sheets: holdSheets(spriteCache, () => engineRef.current?.wake()), paint, marks: (next, gone) => setMarks({ marks: next, gone }) })
    engineRef.current = engine

    return () => {
      engine.dispose()

      if (engineRef.current === engine) {
        engineRef.current = null
      }
    }
  }, [key])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    layoutRef.current = layout

    if (!canvas || !layout || !size) {
      return
    }

    ratioRef.current = size.ratio
    canvas.width = Math.round(layout.width * size.ratio)
    canvas.height = Math.round(layout.height * size.ratio)
    engineRef.current?.wake()
  }, [layout, size?.ratio])

  useEffect(() => {
    engineRef.current?.setLayout(layout)
  }, [layout])

  useEffect(() => {
    engineRef.current?.setInput({ agents: shown, known, handoffs, assignment, installed, motion, settled })
  }, [shown, known, handoffs, assignment, installed, motion, settled])

  useEffect(() => {
    engineRef.current?.setRunning(active)
  }, [active])

  useEffect(() => {
    raisedRef.current = raisedId
    engineRef.current?.wake()
  }, [raisedId])

  useEffect(() => {
    if (!raisedId) {
      return
    }

    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null

      if (popoverRef.current?.contains(target) || target?.closest(`[data-room-sign="${CSS.escape(raisedId)}"]`)) {
        return
      }

      setSign(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSign(null)
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [raisedId])

  const rootRef = useCallback((id: string) => {
    let callback = rootCallbacks.current.get(id)

    if (!callback) {
      callback = element => {
        if (!element) {
          roots.current.delete(id)

          return
        }

        roots.current.set(id, element)
        const spot = spots.current.get(id)

        if (spot) {
          place(element, spot.x, spot.y, 1, 1, layoutRef.current?.wall.width ?? Number.POSITIVE_INFINITY)
        } else {
          element.style.visibility = 'hidden'
        }
      }
      rootCallbacks.current.set(id, callback)
    }

    return callback
  }, [])

  const onSign = useCallback((id: string) => {
    setSign(current => {
      const at = layoutRef.current
      const approval = agentsRef.current.find(entry => entry.id === id)?.approval

      if (!approval || !at || (current?.id === id && current.requestId === approval.requestId)) {
        return null
      }

      const spot = spots.current.get(id) ?? { x: at.width / 2, y: at.height / 2 }

      return { id, requestId: approval.requestId, placement: placePopover(spot, at.width, at.pet) }
    })
  }, [])

  const glowKey = glowingSpots(visible, layout)
  const glowing = useMemo(() => new Set(glowKey ? (glowKey.split(',') as RoomSpot[]) : []), [glowKey])

  return (
    <div className={cn('relative flex h-full w-full flex-col overflow-hidden text-fg', className)}>
      {chrome && <RoomHeader summary={summary} notices={notices} total={total} onPetSettings={onPetSettings} onTimeLapse={onTimeLapse} />}
      <div ref={floorRef} className="relative min-h-0 flex-1 overflow-hidden">
        {layout && <RoomBackdrop layout={layout} glowing={glowing} still={still} deskNames={deskNames && names} words={names} laneLive={laneLive} laneText={laneText} />}
        <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute top-0 left-0" style={layout ? { width: layout.width, height: layout.height } : undefined} />
        {layout && (
          <div className="pointer-events-none absolute inset-0">
            {visible.map(agent => (
              <AgentOverlay
                key={agent.id}
                agent={agent}
                pet={layout.pet}
                facts={facts[agent.id] ?? NO_FACTS}
                steps={steps}
                names={names}
                interactive={interactive && agent.kind !== 'elsewhere'}
                meters={meters}
                marks={marks.marks[agent.id] ?? null}
                still={still}
                signOpen={raised?.id === agent.id}
                rootRef={rootRef(agent.id)}
                onOpen={onOpen}
                onSign={onSign}
              >
                {raised?.id === agent.id && raised.approval && sign && (
                  <ApprovalPopover
                    approval={raised.approval}
                    placement={sign.placement}
                    pet={layout.pet}
                    still={still}
                    popoverRef={popoverRef}
                    onChoice={choice => {
                      setSign(null)
                      onAnswer(agent.id, choice)
                    }}
                  />
                )}
              </AgentOverlay>
            ))}
          </div>
        )}
        {layout && names && settled && !inRoom && (
          <div className="pointer-events-none absolute left-0 flex items-center justify-center px-6" style={{ width: layout.wall.width, top: layout.wall.height, bottom: layout.height - layout.door.y }}>
            <div className={cn('glass-card flex max-w-sm flex-col items-center gap-2.5 rounded-2xl px-6 py-5 text-center', !still && 'animate-rise')}>
              <span className="icon-tile size-10">
                <IconPaw size={20} />
              </span>
              <div className="text-[13px] leading-snug text-fg-2">{EMPTY_ROOM_TEXT}</div>
            </div>
          </div>
        )}
        {layout?.lane && names && (laneEmpty || laneMore > 0) && (
          <div className="pointer-events-none absolute flex justify-center px-2" style={{ left: layout.lane.x, width: layout.lane.width, ...(laneEmpty ? { top: layout.lane.y + 64 } : { bottom: 8 }) }}>
            {laneEmpty ? <span className="text-center text-[10.5px] leading-snug text-fg-4">{laneText?.empty ?? EMPTY_LANE_TEXT}</span> : <Pill tone="muted">{moreText(laneMore)}</Pill>}
          </div>
        )}
        {names && more > 0 && (
          <div className="absolute bottom-2 -translate-x-1/2" style={{ left: layout ? layout.wall.width / 2 : '50%' }} title={`The Room shows the busiest ${MAX_PETS}`}>
            <Pill tone="muted">{moreText(more)}</Pill>
          </div>
        )}
        {names && (
          <ul className="sr-only" aria-label="What the pets are doing">
            {agents
              .filter(agent => lane || !inLane(agent))
              .map(agent => (
                <li key={agent.id}>{agentLine(agent, facts[agent.id] ?? NO_FACTS)}</li>
              ))}
          </ul>
        )}
      </div>
    </div>
  )
}
