import { type CSSProperties, useEffect, useId, useRef, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import { useT } from '../../store/i18n.ts'
import { useReducedMotion } from '../pet/hooks.ts'
import './roadster.css'
import { FLIGHT_MS, poseAt, type RoadsterPose, SCENE, STILL_MS, STILL_POSE, TRUCK } from './timeline.ts'

export interface RoadsterFlightProps {
  /** The flight ended or was dismissed: the host takes the scene away. */
  onDone: () => void
  /** Over its container (the Pet Room) rather than the whole window. */
  contained?: boolean
  /**
   * The flight was not asked for (the Pet Room's): the press that ends it is taken, with the click
   * that follows, so it does nothing in the app. Asked-for flights let the press through.
   */
  claimsClick?: boolean
}

/** A taken press's click comes after the flight is gone; if none comes by then, nothing waits for it. */
export const CLAIMED_CLICK_MS = 1000

/** Take the one click that follows a taken press. */
function claimFollowingClick(): void {
  const take = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    release()
  }
  const release = () => {
    clearTimeout(timer)
    window.removeEventListener('click', take, true)
  }
  const timer = setTimeout(release, CLAIMED_CLICK_MS)
  window.addEventListener('click', take, true)
}

interface Puff {
  cx: number
  cy: number
  r: number
  style: CSSProperties
}

/** The smoke, the same every flight: puffs that start at the car and roll out both ways along the ground. */
const PUFFS: readonly Puff[] = Array.from({ length: 28 }, (_, i) => {
  const side = i % 2 === 0 ? 1 : -1
  const far = Math.floor(i / 2) / 13

  return {
    cx: 330 + side * (8 + ((i * 7) % 30)),
    cy: SCENE.ground - 16 - (i % 3) * 6,
    r: 44 + ((i * 13) % 26),
    style: {
      '--puff-dx': `${Math.round(side * (60 + far * 820))}px`,
      '--puff-dy': `${-(10 + ((i * 17) % 50))}px`,
      '--puff-scale': (1.6 + far * 1.6 + ((i * 5) % 7) / 10).toFixed(2),
      '--puff-delay': `${120 + Math.floor(i / 2) * 70}ms`,
      '--puff-ms': `${2200 + ((i * 37) % 600)}ms`,
      '--puff-opacity': (0.6 + ((i * 11) % 30) / 100).toFixed(2)
    } as CSSProperties
  }
})

/** Floodlights below the bottom edge, their beams cutting up through the smoke. */
const BEAMS = [
  { from: [120, 940], to: [[470, -120], [760, -120]], sweep: '5deg', opacity: 0.2 },
  { from: [1480, 940], to: [[880, -120], [1160, -120]], sweep: '-4deg', opacity: 0.18 },
  { from: [660, 940], to: [[520, -120], [640, -120]], sweep: '3deg', opacity: 0.12 }
] as const

const STRIPS = Array.from({ length: 25 }, (_, i) => 18 + i * 64)

/** The four vapor jets under the body's corners; the far side's sit a little behind and dimmer. */
const JETS = [
  { x: -104, far: true },
  { x: -96, far: false },
  { x: 92, far: false },
  { x: 100, far: true }
] as const

const transformOf = (pose: RoadsterPose): string => `translate(${pose.x.toFixed(1)} ${pose.y.toFixed(1)}) rotate(${pose.angle.toFixed(2)})`

/** The night scene and its roadster, alone in the window or over the Room: decorative, so hidden from assistive technology, and nothing in it can be clicked. */
export function RoadsterFlight({ onDone, contained = false, claimsClick = false }: RoadsterFlightProps) {
  const t = useT()
  const reduced = useReducedMotion()
  // Decided once: a flight does not turn still, or start moving, part of the way through.
  const [still] = useState(reduced)
  const ids = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const sceneRef = useRef<HTMLDivElement>(null)
  const carRef = useRef<SVGGElement>(null)
  const jetsRef = useRef<SVGGElement>(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  const start = still ? STILL_POSE : poseAt(0)

  useEffect(() => {
    let ended = false
    let frame = 0
    const end = () => {
      if (!ended) {
        ended = true
        doneRef.current()
      }
    }
    const timer = setTimeout(end, still ? STILL_MS : FLIGHT_MS)

    if (!still) {
      const began = performance.now()
      const tick = (now: number) => {
        const pose = poseAt(now - began)
        carRef.current?.setAttribute('transform', transformOf(pose))
        jetsRef.current?.setAttribute('opacity', pose.jets.toFixed(3))

        if (sceneRef.current) {
          sceneRef.current.style.opacity = pose.opacity.toFixed(3)
        }

        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    }

    // The input that ends an asked-for flight still reaches the app under it, except Escape, which was meant for the flight.
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) {
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
      }

      end()
    }
    const onPointer = (event: PointerEvent) => {
      if (claimsClick) {
        event.preventDefault()
        event.stopPropagation()
        claimFollowingClick()
      }

      end()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onPointer, true)

    return () => {
      ended = true
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onPointer, true)
    }
  }, [still, claimsClick])

  const url = (name: string) => `url(#${name}-${ids})`

  return (
    <div
      ref={sceneRef}
      className={cn('roadster pointer-events-none inset-0 overflow-hidden', contained ? 'absolute z-30' : 'fixed z-(--z-overlay)')}
      style={{ opacity: start.opacity }}
      data-roadster={still ? 'still' : 'flying'}
      aria-hidden="true"
    >
      <svg viewBox={`0 0 ${SCENE.width} ${SCENE.height}`} preserveAspectRatio="xMidYMax slice" className="absolute inset-0 h-full w-full">
        <defs>
          <linearGradient id={`sky-${ids}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="roadster-stop-night" stopOpacity="0.96" />
            <stop offset="0.84" className="roadster-stop-sky" stopOpacity="0.92" />
          </linearGradient>
          <linearGradient id={`vapor-${ids}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="roadster-stop-vapor" stopOpacity="0.95" />
            <stop offset="0.45" className="roadster-stop-vapor" stopOpacity="0.5" />
            <stop offset="1" className="roadster-stop-vapor" stopOpacity="0" />
          </linearGradient>
          <radialGradient id={`smoke-${ids}`}>
            <stop offset="0" className="roadster-stop-smoke" stopOpacity="0.95" />
            <stop offset="0.6" className="roadster-stop-smoke" stopOpacity="0.55" />
            <stop offset="1" className="roadster-stop-smoke" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`beam-${ids}`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" className="roadster-stop-beam" stopOpacity="1" />
            <stop offset="1" className="roadster-stop-beam" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`headbeam-${ids}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" className="roadster-stop-head" stopOpacity="0.32" />
            <stop offset="1" className="roadster-stop-head" stopOpacity="0" />
          </linearGradient>
          <filter id={`glow-${ids}`} x="-50%" y="-300%" width="200%" height="700%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>

        <rect width={SCENE.width} height={SCENE.height} fill={url('sky')} />

        <g>
          <rect x={TRUCK.left} y={TRUCK.top} width="212" height="186" rx="6" className="roadster-fill-truck" />
          <rect x={TRUCK.left + 10} y={TRUCK.top + 12} width="192" height="2" className="roadster-fill-truck-shade" />
          <rect x={TRUCK.left + 10} y={TRUCK.top + 166} width="192" height="2" className="roadster-fill-truck-shade" />
          <path d={`M ${TRUCK.left + 218} 731 L ${TRUCK.left + 218} 610 L ${TRUCK.right - 34} 610 Q ${TRUCK.right - 8} 612 ${TRUCK.right} 650 L ${TRUCK.right} 731 Z`} className="roadster-fill-truck-shade" />
          <path d={`M ${TRUCK.left + 230} 622 L ${TRUCK.right - 38} 622 Q ${TRUCK.right - 18} 626 ${TRUCK.right - 12} 656 L ${TRUCK.left + 230} 656 Z`} className="roadster-fill-truck-glass" />
          <rect x={TRUCK.left - 4} y="726" width={TRUCK.right - TRUCK.left + 4} height="10" rx="3" className="roadster-fill-truck-shade" />
          <rect x={TRUCK.left - 2} y={TRUCK.top + 150} width="4" height="12" className="roadster-fill-strip" />
          {[TRUCK.left + 46, TRUCK.left + 166, TRUCK.right - 38].map(cx => (
            <g key={cx}>
              <circle cx={cx} cy="740" r="20" className="roadster-fill-tyre" />
              <circle cx={cx} cy="740" r="9" className="roadster-stroke-rim" />
            </g>
          ))}
        </g>

        <g ref={carRef} transform={transformOf(start)}>
          <g ref={jetsRef} opacity={start.jets}>
            {JETS.map(jet => (
              <path
                key={jet.x}
                className="roadster-plume"
                d={`M ${jet.x - 4} 15 L ${jet.x + 4} 15 L ${jet.x + (jet.far ? 11 : 15)} 140 Q ${jet.x} 152 ${jet.x - (jet.far ? 11 : 15)} 140 Z`}
                fill={url('vapor')}
                opacity={jet.far ? 0.55 : 0.95}
              />
            ))}
            {JETS.map(jet => (
              <ellipse key={jet.x} cx={jet.x} cy="15" rx="7" ry="2.5" className="roadster-fill-head" opacity={jet.far ? 0.5 : 0.9} />
            ))}
          </g>
          <path d="M 134 -3 L 330 -42 L 330 38 Z" fill={url('headbeam')} />
          <path d="M -134 12 L -137 -4 Q -122 -12 -90 -14 L -58 -16 L 50 -14 Q 96 -10 128 -3 Q 139 1 137 8 L 127 14 L -126 14 Z" className="roadster-fill-body" />
          <path d="M -128 12 L 126 12 L 122 16 L -124 16 Z" className="roadster-fill-body-shade" />
          <path d="M -60 -15 C -40 -40 18 -42 54 -14 Z" className="roadster-fill-glass" />
          <path d="M -40 -26 C -20 -36 10 -36 30 -24" className="roadster-stroke-glint" />
          <path d="M -118 0 Q 0 -4 118 2" className="roadster-stroke-glint" opacity="0.5" />
          <rect x="110" y="-5" width="26" height="4" rx="2" className="roadster-fill-head" filter={url('glow')} />
          <rect x="110" y="-4.5" width="26" height="2.4" rx="1.2" className="roadster-fill-head" />
          <rect x="-138" y="-7" width="18" height="4.4" rx="2" className="roadster-fill-tail" filter={url('glow')} />
          <rect x="-138" y="-6.5" width="18" height="2.6" rx="1.3" className="roadster-fill-tail" />
          {[-84, 88].map(cx => (
            <g key={cx}>
              <circle cx={cx} cy="16" r="19" className="roadster-fill-tyre" />
              <circle cx={cx} cy="16" r="9" className="roadster-stroke-rim" />
            </g>
          ))}
        </g>

        {/* The ground goes over the car, so the jets stop where they meet it. */}
        <rect y={SCENE.ground} width={SCENE.width} height={SCENE.height - SCENE.ground} className="roadster-fill-ground" />

        <g>
          {STRIPS.map((x, i) => (
            <g key={x} className="roadster-strip-light" style={{ animationDelay: `${(i % 5) * 140}ms` }}>
              <rect x={x} y="771" width="30" height="4" rx="2" className="roadster-fill-strip" filter={url('glow')} />
              <rect x={x} y="771" width="30" height="3" rx="1.5" className="roadster-fill-strip" />
            </g>
          ))}
        </g>

        <g>
          {PUFFS.map((puff, i) => (
            <circle key={i} className="roadster-puff" cx={puff.cx} cy={puff.cy} r={puff.r} fill={url('smoke')} style={puff.style} />
          ))}
        </g>

        <g>
          {BEAMS.map(beam => (
            <polygon
              key={beam.from.join(',')}
              className="roadster-beam"
              points={[beam.from, ...beam.to].map(point => point.join(',')).join(' ')}
              fill={url('beam')}
              opacity={beam.opacity}
              style={{ transformOrigin: `${beam.from[0]}px ${beam.from[1]}px`, '--beam-sweep': beam.sweep } as CSSProperties}
            />
          ))}
        </g>
      </svg>
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 text-[12px] whitespace-nowrap text-paper/60">{t('roadster.skip')}</div>
    </div>
  )
}
