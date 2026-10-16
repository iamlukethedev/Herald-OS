import { useStore } from '@nanostores/react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { HeraldLogo } from '../../components/herald-logo.tsx'
import { Wallpaper } from '../../shell/Wallpaper.tsx'
import { $prefs } from '../../store/backend.ts'
import { useReducedMotion } from '../pet/hooks.ts'
import { useRoomScreensaver } from '../room/screensaver.ts'
import { flyoversOn } from '../roadster/flight.ts'

const RoomScreensaver = lazy(() => import('../room/RoomScreensaver.tsx').then(m => ({ default: m.RoomScreensaver })))
const RoadsterFlight = lazy(() => import('../roadster/RoadsterFlight.tsx').then(m => ({ default: m.RoadsterFlight })))

/** Input in the first moment after it appears is the tail of whatever the person was doing. */
const GRACE_MS = 1200
/** The roadster flies over the screensaver this long after it appears, then again this often. */
export const FLYOVER_FIRST_MS = 45_000
export const FLYOVER_EVERY_MS = 4 * 60_000

/**
 * Whether the idle flyover is up: never with Flyover animations off, nor under reduced motion, where
 * a scene popping up unasked is what the person turned off.
 */
function useIdleFlyover(): { up: boolean; flown: number; land: () => void } {
  const reduced = useReducedMotion()
  const prefs = useStore($prefs)
  const off = reduced || !flyoversOn(prefs)
  const [up, setUp] = useState(false)
  const flown = useRef(0)

  useEffect(() => {
    if (off || up) {
      return
    }

    const timer = setTimeout(
      () => {
        flown.current += 1
        setUp(true)
      },
      flown.current === 0 ? FLYOVER_FIRST_MS : FLYOVER_EVERY_MS
    )

    return () => clearTimeout(timer)
  }, [off, up])

  // Turning flyovers off ends a flight that is up rather than hiding it, so turning them on does not replay it.
  useEffect(() => {
    if (off) {
      setUp(false)
    }
  }, [off])

  return { up: up && !off, flown: flown.current, land: () => setUp(false) }
}

function Clock() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10_000)

    return () => clearInterval(timer)
  }, [])

  return (
    <>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-fg">
        <span className="text-[96px] leading-none font-semibold tabular-nums tracking-tight text-shadow-soft">{now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
        <span className="text-[20px] text-fg-2 text-shadow-soft">{now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
      </div>
      <div className="absolute bottom-10 left-1/2 -translate-x-1/2 opacity-70">
        <HeraldLogo height={28} />
      </div>
    </>
  )
}

/** The living wallpaper with a large clock, or the Pet Room when the person picked it, and now and then the roadster; the first key, click or pointer move ends it. */
export function Screensaver({ onDismiss }: { onDismiss: () => void }) {
  const room = useRoomScreensaver()
  const flyover = useIdleFlyover()

  useEffect(() => {
    const shownAt = Date.now()
    const dismiss = () => {
      if (Date.now() - shownAt > GRACE_MS) {
        onDismiss()
      }
    }
    const events = ['keydown', 'pointerdown', 'pointermove', 'wheel'] as const

    for (const name of events) {
      window.addEventListener(name, dismiss, { capture: true })
    }

    return () => {
      for (const name of events) {
        window.removeEventListener(name, dismiss, { capture: true })
      }
    }
  }, [onDismiss])

  return (
    <div className="absolute inset-0 z-(--z-boot) cursor-none overflow-hidden bg-bg" role="presentation" data-screensaver={room === null ? 'loading' : room ? 'room' : 'clock'}>
      <Wallpaper />
      {room === false && <Clock />}
      {room && (
        <Suspense fallback={null}>
          <RoomScreensaver />
        </Suspense>
      )}
      {flyover.up && (
        <Suspense fallback={null}>
          <RoadsterFlight key={flyover.flown} contained onDone={flyover.land} />
        </Suspense>
      )}
    </div>
  )
}
