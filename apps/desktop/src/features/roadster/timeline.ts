/*
 * Where the roadster is at each moment of its flight, in the scene's own units: a 1600 by 900 view
 * whose ground runs along y = 760. The car's origin is the middle of its body; it rests with its
 * tyres on the ground and faces right, so a negative angle lifts the nose.
 */

export const SCENE = { width: 1600, height: 900, ground: 760 } as const

/** The whole flight, from the first puff of vapor to the scene gone. */
export const FLIGHT_MS = 3600
/** How long the single still frame shows when motion is reduced. */
export const STILL_MS = 1600

/** From the car's origin down to where its tyres touch the ground. */
export const CAR_BASE = 35

/** The box truck the car clears, which stands on the ground. */
export const TRUCK = { left: 820, right: 1112, top: 545 } as const

const REST = { x: 330, y: SCENE.ground - CAR_BASE }
/** The jets have fired for this long before the car leaves the ground. */
const LIFT_AT = 450
/** The straight climb off the ground ends here, this far up. */
const HOP_END = 750
const HOP = 150
/** The arc runs on until the car is well past the top right corner. */
const ARC_END = 3300
const ARC_RUN = 1750
const ARC_RISE = 700
const FLIP_START = HOP_END
const FLIP_END = 2000
/** After the flip the car leans a little into its climb. */
const LEAN = -12
const LEAN_MS = 600
const JETS_RAMP_MS = 200
const JETS_FULL_UNTIL = 900
const JETS_OUT_AT = 1300
const FADE_IN_MS = 250
const FADE_OUT_MS = 400

export interface RoadsterPose {
  x: number
  y: number
  /** Degrees; negative lifts the nose, -360 is one full backward flip. */
  angle: number
  /** How strongly the vapor jets fire, 0 to 1. */
  jets: number
  /** The whole scene's opacity, 0 to 1. */
  opacity: number
}

/** The frame shown alone under reduced motion: the car level over the truck, the jets off. */
export const STILL_POSE: RoadsterPose = { x: 960, y: 250, angle: -8, jets: 0, opacity: 1 }

const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value))
const progress = (ms: number, from: number, to: number): number => clamp((ms - from) / (to - from))
const easeInOut = (p: number): number => -(Math.cos(Math.PI * p) - 1) / 2

function jetsAt(ms: number): number {
  if (ms < JETS_FULL_UNTIL) {
    return progress(ms, 0, JETS_RAMP_MS)
  }

  return 1 - progress(ms, JETS_FULL_UNTIL, JETS_OUT_AT)
}

function placeAt(ms: number): { x: number; y: number } {
  if (ms < LIFT_AT) {
    // The car strains against the ground while the jets build.
    const strain = ms > 150 ? Math.sin(ms / 16) * 1.2 : 0

    return { x: REST.x, y: REST.y + strain }
  }

  if (ms < HOP_END) {
    return { x: REST.x, y: REST.y - HOP * progress(ms, LIFT_AT, HOP_END) ** 1.5 }
  }

  // One parabola: x runs on evenly while y climbs ever less steeply, with its top past the corner.
  const u = progress(ms, HOP_END, ARC_END)

  return { x: REST.x + ARC_RUN * u, y: REST.y - HOP - ARC_RISE * (2 * u - u * u) }
}

export function poseAt(ms: number): RoadsterPose {
  const flip = -360 * easeInOut(progress(ms, FLIP_START, FLIP_END))
  const lean = LEAN * easeInOut(progress(ms, FLIP_END, FLIP_END + LEAN_MS))
  const opacity = Math.min(progress(ms, 0, FADE_IN_MS), 1 - progress(ms, FLIGHT_MS - FADE_OUT_MS, FLIGHT_MS))

  return { ...placeAt(ms), angle: flip + lean, jets: jetsAt(ms), opacity }
}
