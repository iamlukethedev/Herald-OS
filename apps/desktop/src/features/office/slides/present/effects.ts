import type { SlideTransition, TransitionDirection } from '../deck.ts'
import { DIRECTIONS } from '../transitions.ts'

/*
 * What each transition does to the two slides, as Web Animations keyframes: the slide it brings in,
 * the one before, and which of them is drawn on top. Going back plays the same keyframes
 * backwards, so the slide being left goes out the way it came in.
 */

/** A transition's keyframes for the slide it brings in and the one before; null keeps that slide still. */
export interface Effect {
  incoming: Keyframe[] | null
  outgoing: Keyframe[] | null
  /** The slide before is drawn over the one coming in (uncover, split in, zoom out). */
  outgoingOnTop: boolean
  easing: string
}

/** A slide's animation, ready for `Element.animate`. */
export interface LayerAnimation {
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
}

/** How a move animates the slide arriving and the one being left. */
export interface Choreography {
  arriving: LayerAnimation | null
  leaving: LayerAnimation | null
  /** The slide drawn over the other while it plays. */
  top: 'arriving' | 'leaving'
  duration: number
}

/** The longest the fade standing in for every transition takes when motion is reduced. */
export const REDUCED_MOTION_MS = 180

const MOVE_EASING = 'cubic-bezier(0.65, 0, 0.35, 1)'
const REVEAL_EASING = 'ease-in-out'
const SHOWN = 'inset(0% 0% 0% 0%)'

type Side = 'left' | 'right' | 'up' | 'down'

/** Where a slide travelling one way starts, in percent of its size: PowerPoint's `left` comes in from the right. */
const STARTS: Record<Side, readonly [number, number]> = { left: [100, 0], right: [-100, 0], up: [0, 100], down: [0, -100] }

/** A wiped slide before it shows: clipped away up to the edge it opens from. */
const WIPES: Record<Side, string> = { left: 'inset(0% 0% 0% 100%)', right: 'inset(0% 100% 0% 0%)', up: 'inset(100% 0% 0% 0%)', down: 'inset(0% 0% 100% 0%)' }

/** A split shut along the middle: a horizontal line across the slide, or a vertical one up and down it. */
const SPLITS = { horizontal: 'inset(50% 0% 50% 0%)', vertical: 'inset(0% 50% 0% 50%)' } as const

const translate = ([x, y]: readonly [number, number]): string => `translate(${x}%, ${y}%)`

const isSide = (direction: TransitionDirection | undefined): direction is Side => direction === 'left' || direction === 'right' || direction === 'up' || direction === 'down'

/** The way a transition goes: its own when its kind takes it, else the kind's default. */
function directionOf(transition: SlideTransition): TransitionDirection | undefined {
  const allowed = DIRECTIONS[transition.kind]

  return transition.direction && allowed.includes(transition.direction) ? transition.direction : allowed[0]
}

const fade = (): Effect => ({ incoming: [{ opacity: 0 }, { opacity: 1 }], outgoing: null, outgoingOnTop: false, easing: REVEAL_EASING })

/** A transition's keyframes, played forwards; null for none. */
export function effectOf(transition: SlideTransition): Effect | null {
  const direction = directionOf(transition)
  const side: Side = isSide(direction) ? direction : 'left'
  const start = STARTS[side]
  const still = translate([0, 0])
  const away = translate([-start[0], -start[1]])

  switch (transition.kind) {
    case 'fade':
      return fade()
    case 'push':
      return { incoming: [{ transform: translate(start) }, { transform: still }], outgoing: [{ transform: still }, { transform: away }], outgoingOnTop: false, easing: MOVE_EASING }
    case 'cover':
      return { incoming: [{ transform: translate(start) }, { transform: still }], outgoing: null, outgoingOnTop: false, easing: MOVE_EASING }
    case 'uncover':
      return { incoming: null, outgoing: [{ transform: still }, { transform: away }], outgoingOnTop: true, easing: MOVE_EASING }
    case 'wipe':
      return { incoming: [{ clipPath: WIPES[side] }, { clipPath: SHOWN }], outgoing: null, outgoingOnTop: false, easing: REVEAL_EASING }
    case 'split': {
      const shut = SPLITS[transition.orientation ?? 'horizontal']

      return direction === 'in'
        ? { incoming: null, outgoing: [{ clipPath: SHOWN }, { clipPath: shut }], outgoingOnTop: true, easing: REVEAL_EASING }
        : { incoming: [{ clipPath: shut }, { clipPath: SHOWN }], outgoing: null, outgoingOnTop: false, easing: REVEAL_EASING }
    }
    case 'zoom':
      return direction === 'out'
        ? { incoming: null, outgoing: [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.3)', opacity: 0 }], outgoingOnTop: true, easing: MOVE_EASING }
        : { incoming: [{ transform: 'scale(0.3)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], outgoing: null, outgoingOnTop: false, easing: MOVE_EASING }
    default:
      return null
  }
}

/**
 * How a move plays a transition: going on, the slide arriving comes in by it; going back, the slide
 * being left goes out by it backwards. With motion reduced every transition is a quick fade. Null
 * when nothing moves.
 */
export function choreograph(transition: SlideTransition, reverse: boolean, reducedMotion = false): Choreography | null {
  const effect = transition.kind === 'none' ? null : reducedMotion ? fade() : effectOf(transition)
  const duration = reducedMotion ? Math.min(REDUCED_MOTION_MS, transition.duration) : transition.duration

  if (!effect || !(duration > 0)) {
    return null
  }

  const layer = (keyframes: Keyframe[] | null): LayerAnimation | null => (keyframes ? { keyframes, options: { duration, easing: effect.easing, fill: 'both', direction: reverse ? 'reverse' : 'normal' } } : null)

  return reverse
    ? { arriving: layer(effect.outgoing), leaving: layer(effect.incoming), top: effect.outgoingOnTop ? 'arriving' : 'leaving', duration }
    : { arriving: layer(effect.incoming), leaving: layer(effect.outgoing), top: effect.outgoingOnTop ? 'leaving' : 'arriving', duration }
}
