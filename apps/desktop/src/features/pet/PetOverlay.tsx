import { useStore } from '@nanostores/react'
import { type CSSProperties, type HTMLAttributes, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PET_FRAME_HEIGHT, PET_FRAME_WIDTH, type PetPrefs, type PetRect, type PetSnapshot } from '../../../shared/pet.ts'
import { $prefs } from '../../store/backend.ts'
import { isEditable } from '../../store/edit-target.ts'
import { $windows, desktopArea } from '../../store/windows.ts'
import { $petPrefs, setPetPrefs } from './actions.ts'
import { petHiddenWhy } from './hide.ts'
import { extrasOf, heldApprovalOf, petPose, useDocumentVisible, usePetUi, useReducedMotion, useSince, useWakeAfter } from './hooks.ts'
import { $petInfo, $petSheet } from './info.ts'
import { PetView } from './PetView.tsx'
import { avoid, clampPoint, cursorRect, overlaps, type Point, type Size, spotFromPoint, walkTo } from './placement.ts'
import type { LoadedSheet } from './sheet.ts'
import { PERK_MS } from './sprite.ts'
import { extrasLayout, followRectDesktop, stageTarget } from './stage.ts'
import { $petChatRequest, $petHeldApproval, $petSnapshot } from './transport.ts'

/** A cursor resting on the pet this long, without a click, sends it aside. */
const LINGER_MS = 1600
/** How long the pet stays stepped aside before it walks back to its spot. */
const DODGE_MS = 45_000
/** A click this close to the pet means the person is working there. */
const NEAR = 36

const sameRect = (a: PetRect | null, b: PetRect | null): boolean => a === b || Boolean(a && b && Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y) && Math.round(a.width) === Math.round(b.width) && Math.round(a.height) === Math.round(b.height))

function useDesktopArea(): PetRect {
  const prefs = useStore($prefs)
  const [area, setArea] = useState<PetRect>(() => desktopArea())

  useEffect(() => {
    const measure = () => setArea(previous => {
      const next = desktopArea()

      return sameRect(previous, next) ? previous : next
    })
    measure()
    window.addEventListener('resize', measure)

    return () => window.removeEventListener('resize', measure)
  }, [prefs.dockAutoHide])

  return area
}

/** The text field with the keys, or the caret's line in a large editor (a Docs page), with room around it. */
function fieldRect(element: HTMLElement): PetRect | null {
  const box = element.getBoundingClientRect()

  if (box.width <= 640 && box.height <= 260) {
    return { x: box.x - 10, y: box.y - 10, width: box.width + 20, height: box.height + 20 }
  }

  const selection = window.getSelection()
  const caret = selection && selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null

  return caret && (caret.width || caret.height || caret.x || caret.y) ? { x: caret.x - 90, y: caret.y - 40, width: caret.width + 180, height: caret.height + 80 } : null
}

function useFocusedField(group: RefObject<HTMLElement | null>): PetRect | null {
  const [rect, setRect] = useState<PetRect | null>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const measure = () => {
      timer = null
      const active = document.activeElement
      const next = isEditable(active) && !group.current?.contains(active) ? fieldRect(active) : null
      setRect(previous => (sameRect(previous, next) ? previous : next))
    }
    const soon = () => {
      timer ??= setTimeout(measure, 250)
    }

    measure()
    document.addEventListener('focusin', soon)
    document.addEventListener('focusout', soon)
    document.addEventListener('selectionchange', soon)
    window.addEventListener('resize', soon)

    return () => {
      document.removeEventListener('focusin', soon)
      document.removeEventListener('focusout', soon)
      document.removeEventListener('selectionchange', soon)
      window.removeEventListener('resize', soon)

      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [group])

  return rect
}

/** Walk to each new point: a linear move as long as the walk takes (none when instant), facing the way it goes. */
function useWalk(point: Point, instant: boolean): { ms: number; dir: -1 | 0 | 1; moving: boolean } {
  const last = useRef(point)
  const [walk, setWalk] = useState<{ ms: number; dir: -1 | 0 | 1; moving: boolean }>({ ms: 0, dir: 0, moving: false })

  useLayoutEffect(() => {
    const from = last.current
    last.current = point

    if (from.x === point.x && from.y === point.y) {
      return
    }

    const next = walkTo(from, point)

    if (instant || next.ms < 40) {
      setWalk({ ms: 0, dir: 0, moving: false })

      return
    }

    setWalk({ ms: next.ms, dir: next.dir, moving: true })
    const timer = setTimeout(() => setWalk({ ms: 0, dir: 0, moving: false }), next.ms)

    return () => clearTimeout(timer)
  }, [point.x, point.y, instant])

  return walk
}

function DesktopPet({ sheet, scale, snapshot, prefs }: { sheet: LoadedSheet; scale: number; snapshot: PetSnapshot; prefs: PetPrefs }) {
  const size: Size = { width: Math.round(PET_FRAME_WIDTH * scale), height: Math.round(PET_FRAME_HEIGHT * scale) }
  const area = useDesktopArea()
  const windows = useStore($windows)
  const ui = usePetUi(snapshot)
  const reduced = useReducedMotion()
  const visible = useDocumentVisible()
  const groupRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const field = useFocusedField(groupRef)
  const [dodge, setDodge] = useState<Point | null>(null)
  const [drag, setDrag] = useState<Point | null>(null)
  const [localSpot, setLocalSpot] = useState<{ x: number; y: number } | null>(null)
  const [leftFollow, setLeftFollow] = useState<number | null>(null)
  const [dropping, setDropping] = useState(false)

  const follow = snapshot.follow && snapshot.follow.at !== leftFollow && !ui.bubble && !ui.drop ? followRectDesktop(Object.values(windows), snapshot.follow) : null
  const target = stageTarget({ area, size, spot: localSpot ?? prefs.spot, approval: Boolean(snapshot.approval), follow, dodge, obstacles: field ? [field] : [] })
  const point = drag ?? target.point
  const walk = useWalk(point, reduced || drag !== null)
  const extras = extrasOf(snapshot, ui, !walk.moving)
  const layout = extrasLayout(point, size, area)
  const activitySince = useSince(snapshot.activity)
  const { pose, rest } = petPose(snapshot, walk.dir, activitySince, { dragging: drag !== null, dropping })
  const poseSince = useSince(pose)
  useWakeAfter(snapshot.activity === 'listening' ? PERK_MS - (Date.now() - activitySince) : null)

  const pointRef = useRef(point)
  pointRef.current = point
  const busyRef = useRef(false)
  busyRef.current = ui.bubble || ui.drop !== null || snapshot.approval !== null || drag !== null
  const linger = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restore = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (localSpot && prefs.spot && Math.abs(prefs.spot.x - localSpot.x) < 0.001 && Math.abs(prefs.spot.y - localSpot.y) < 0.001) {
      setLocalSpot(null)
    }
  }, [prefs.spot, localSpot])

  const approvalId = heldApprovalOf(snapshot, extras)

  useEffect(() => {
    $petHeldApproval.set(approvalId)
  }, [approvalId])

  useEffect(() => () => $petHeldApproval.set(null), [])

  const openBubble = () => {
    const active = document.activeElement
    restore.current = active instanceof HTMLElement && !groupRef.current?.contains(active) ? active : null
    ui.setBubble(true)
    setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 30)
  }

  const closeBubble = () => {
    ui.setBubble(false)
    const back = restore.current
    restore.current = null

    if (back?.isConnected) {
      back.focus({ preventScroll: true })
    }
  }

  const petUi = { ...ui, setBubble: (open: boolean) => (open ? openBubble() : closeBubble()) }
  const chatRequest = useStore($petChatRequest)
  const seenRequest = useRef(chatRequest)

  useEffect(() => {
    if (chatRequest !== seenRequest.current) {
      seenRequest.current = chatRequest
      openBubble()
    }
  }, [chatRequest])

  useEffect(() => {
    if (!ui.bubble && !ui.drop) {
      return
    }

    const onDown = (event: PointerEvent) => {
      if (!groupRef.current?.contains(event.target as Node)) {
        ui.setDrop(null)
        closeBubble()
      }
    }
    window.addEventListener('pointerdown', onDown, true)

    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [ui.bubble, ui.drop])

  useEffect(() => {
    if (!dodge) {
      return
    }

    const timer = setTimeout(() => setDodge(null), DODGE_MS)

    return () => clearTimeout(timer)
  }, [dodge])

  useEffect(() => {
    let last: Point | null = null
    const stepAside = (from: Point) => setDodge(avoid(pointRef.current, size, area, [cursorRect(from, 48)]))
    const clearLinger = () => {
      if (linger.current) {
        clearTimeout(linger.current)
        linger.current = null
      }
    }
    const onDown = (event: PointerEvent) => {
      const at = { x: event.clientX, y: event.clientY }

      if (!busyRef.current && !groupRef.current?.contains(event.target as Node) && overlaps({ ...pointRef.current, ...size }, cursorRect(at, NEAR))) {
        stepAside(at)
      }
    }
    const onMove = (event: MouseEvent) => {
      last = { x: event.clientX, y: event.clientY }

      if (!overlaps({ ...pointRef.current, ...size }, cursorRect(last, 1))) {
        clearLinger()

        return
      }

      if (!linger.current && !busyRef.current) {
        linger.current = setTimeout(() => {
          linger.current = null

          if (last && !busyRef.current) {
            stepAside(last)
          }
        }, LINGER_MS)
      }
    }

    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('mousemove', onMove, { passive: true })

    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('mousemove', onMove)
      clearLinger()
    }
  }, [size.width, size.height, area])

  const press = useRef<{ x: number; y: number; origin: Point; moved: boolean; id: number } | null>(null)
  const spriteProps: HTMLAttributes<HTMLDivElement> = {
    // The pet never takes the keys: pressing it leaves the focus where it was.
    onMouseDown: event => event.preventDefault(),
    onPointerDown: event => {
      if (event.button !== 0) {
        return
      }

      event.preventDefault()

      if (linger.current) {
        clearTimeout(linger.current)
        linger.current = null
      }

      event.currentTarget.setPointerCapture(event.pointerId)
      press.current = { x: event.clientX, y: event.clientY, origin: pointRef.current, moved: false, id: event.pointerId }
    },
    onPointerMove: event => {
      const current = press.current

      if (!current || current.id !== event.pointerId) {
        return
      }

      const dx = event.clientX - current.x
      const dy = event.clientY - current.y

      if (!current.moved && Math.hypot(dx, dy) < 4) {
        return
      }

      current.moved = true
      setDrag(clampPoint({ x: current.origin.x + dx, y: current.origin.y + dy }, size, area))
    },
    onPointerUp: event => {
      const current = press.current
      press.current = null

      if (!current || current.id !== event.pointerId) {
        return
      }

      if (current.moved) {
        const dropped = clampPoint({ x: current.origin.x + event.clientX - current.x, y: current.origin.y + event.clientY - current.y }, size, area)
        const spot = spotFromPoint(dropped, size, area)
        setLocalSpot(spot)
        setDrag(null)
        setDodge(null)
        setLeftFollow(snapshot.follow?.at ?? null)
        void setPetPrefs({ spot }).catch(() => setLocalSpot(null))

        return
      }

      if (!snapshot.approval) {
        petUi.setBubble(!ui.bubble)
      }
    },
    onPointerCancel: () => {
      press.current = null
      setDrag(null)
    }
  }

  const anchor: CSSProperties = { transform: `translate(${point.x}px, ${point.y}px)`, transition: walk.ms ? `transform ${walk.ms}ms linear` : undefined }
  const groupStyle: CSSProperties = { position: 'absolute', ...(layout.align === 'end' ? { right: -size.width } : { left: 0 }), ...(layout.above ? { bottom: -size.height } : { top: 0 }) }

  return (
    <div className="pointer-events-none absolute inset-0 z-(--z-pet) overflow-hidden">
      <div className="absolute top-0 left-0 size-0" style={anchor}>
        <PetView
          sheet={sheet}
          scale={scale}
          snapshot={snapshot}
          ui={petUi}
          extras={extras}
          layout={layout}
          pose={pose}
          poseSince={poseSince}
          rest={rest}
          reduced={reduced}
          paused={!visible}
          dropping={dropping}
          onDropping={setDropping}
          spriteProps={spriteProps}
          groupRef={groupRef}
          inputRef={inputRef}
          style={groupStyle}
        />
      </div>
    </div>
  )
}

/** Desktop mode: the pet on the desktop above Herald's windows, in this same window. */
export function PetOverlay() {
  const info = useStore($petInfo)
  const sheet = useStore($petSheet)
  const prefs = useStore($petPrefs)
  const snapshot = useStore($petSnapshot)
  const why = petHiddenWhy({
    enabled: info.enabled,
    installed: Boolean(info.slug),
    hidden: prefs.hidden,
    fullscreen: snapshot.hiddenBy === 'fullscreen',
    presenting: snapshot.hiddenBy === 'presenting',
    doNotDisturb: snapshot.hiddenBy === 'doNotDisturb'
  })

  if (why || !sheet) {
    return null
  }

  return <DesktopPet sheet={sheet} scale={info.scale} snapshot={snapshot} prefs={prefs} />
}
