import { type Deck, DEFAULT_TRANSITION_MS, type Slide, type SlideTransition, type Transition, type TransitionDirection } from './deck.ts'

/*
 * Slide transitions: each slide's own, or the deck's for slides without one, and what each kind
 * can be told (which way it moves, how it opens), with the names the menus show.
 */

export const TRANSITION_NAMES: Record<Transition, string> = { none: 'None', fade: 'Fade', push: 'Push', wipe: 'Wipe', cover: 'Cover', uncover: 'Uncover', split: 'Split', zoom: 'Zoom' }

/** The directions each kind takes, the first its default; kinds without any move no way in particular. */
export const DIRECTIONS: Record<Transition, readonly TransitionDirection[]> = {
  none: [],
  fade: [],
  push: ['up', 'left', 'down', 'right'],
  wipe: ['left', 'up', 'right', 'down'],
  cover: ['left', 'up', 'right', 'down'],
  uncover: ['left', 'up', 'right', 'down'],
  split: ['out', 'in'],
  zoom: ['in', 'out']
}

/** What PowerPoint's effect options call each direction (a slide travelling left comes in from the right). */
export const DIRECTION_NAMES: Record<TransitionDirection, string> = { left: 'From Right', right: 'From Left', up: 'From Bottom', down: 'From Top', in: 'In', out: 'Out' }

/** A transition of a kind with its defaults. */
export function transitionFor(kind: Transition, duration = DEFAULT_TRANSITION_MS): SlideTransition {
  const direction = DIRECTIONS[kind][0]

  return { kind, duration, ...(direction ? { direction } : {}), ...(kind === 'split' ? { orientation: 'horizontal' as const } : {}) }
}

/** How a slide comes in: its own transition, or the deck's kind with its defaults. */
export const transitionOf = (deck: Pick<Deck, 'transition'>, slide: Pick<Slide, 'transition'>): SlideTransition => slide.transition ?? transitionFor(deck.transition)

/** Whether two transitions come in alike. */
export const sameTransition = (a: SlideTransition | undefined, b: SlideTransition | undefined): boolean =>
  a && b ? a.kind === b.kind && a.duration === b.duration && a.direction === b.direction && a.orientation === b.orientation : a === b
