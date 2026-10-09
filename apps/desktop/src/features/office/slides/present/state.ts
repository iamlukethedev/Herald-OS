import type { Deck, SlideTransition } from '../deck.ts'
import { transitionOf } from '../transitions.ts'

/*
 * A presentation as every view of it sees it: the slides it shows, where it is, a blanked screen,
 * the move that brought the slide in front (which its transition plays) and the presenter's timer.
 * Moves are pure functions from one state to the next; null is a presentation that has ended.
 */

export type Blank = 'black' | 'white'

/**
 * How the slides show: alone over Herald's window, beside the presenter view in it, or in a window
 * of their own on another display while the presenter view fills Herald's.
 */
export type PresentMode = 'slides' | 'split' | 'displays'

/** A move between two places by slide id (null: the end screen), numbered so that each plays its transition once. */
export interface Move {
  from: string | null
  to: string | null
  /** On through the slides, rather than back. */
  forward: boolean
  serial: number
}

/** The presenter's timer: the time counted before it last started, and when that was (null while paused). */
export interface Timer {
  banked: number
  since: number | null
}

export interface Presentation {
  /** The deck's document key. */
  key: string
  /** The ids of the slides shown, in order: the deck's not hidden, or all of them when every one is. */
  shown: string[]
  /** Where in `shown`; its length is the end screen. */
  at: number
  blank: Blank | null
  /** The last move, for its transition. */
  move: Move | null
  /** Digits typed toward a jump, until Enter. */
  typed: string
  timer: Timer
  mode: PresentMode
  /** When it began, by the clock: a presentation begun anew is another one. */
  started: number
}

/** What every view shows of a presentation. */
export interface Frame {
  /** The slide in front; null is the end screen. */
  current: string | null
  next: string | null
  /** The slide in front's place among those shown, 1 for the first. */
  number: number
  count: number
  ended: boolean
  blank: Blank | null
}

/** The ids of the slides a deck shows: those not hidden, or every one when all are. */
export function shownSlides(deck: Pick<Deck, 'slides'>): string[] {
  const visible = deck.slides.filter((slide) => !slide.hidden)

  return (visible.length ? visible : deck.slides).map((slide) => slide.id)
}

/** A presentation of a deck from its slide at `index`, or the next one shown when that one is hidden; the timer starts at `now`. */
export function begin(deck: Pick<Deck, 'slides'>, key: string, index: number, now: number, mode: PresentMode = 'slides'): Presentation {
  const shown = shownSlides(deck)
  const wanted = deck.slides.slice(Math.max(0, index)).find((slide) => shown.includes(slide.id))
  const at = wanted ? shown.indexOf(wanted.id) : shown.length - 1

  return { key, shown, at: Math.max(0, at), blank: null, move: null, typed: '', timer: { banked: 0, since: now }, mode, started: now }
}

const idAt = (state: Presentation, at: number): string | null => state.shown[at] ?? null

/** Go to a place among the slides shown (their count is the end screen); going on from the end screen ends the presentation. */
export function goTo(state: Presentation, target: number): Presentation | null {
  if (state.at >= state.shown.length && target > state.at) {
    return null
  }

  const to = Math.max(0, Math.min(state.shown.length, Math.round(target)))

  if (to === state.at) {
    return state.blank || state.typed ? { ...state, blank: null, typed: '' } : state
  }

  const move = { from: idAt(state, state.at), to: idAt(state, to), forward: to > state.at, serial: (state.move?.serial ?? 0) + 1 }

  return { ...state, at: to, blank: null, typed: '', move }
}

const unblank = (state: Presentation): Presentation => ({ ...state, blank: null, typed: '' })

/** On to the next slide, the end screen after the last, the end after that; a blanked screen shows its slide again first. */
export const next = (state: Presentation): Presentation | null => (state.blank ? unblank(state) : goTo(state, state.at + 1))

/** Back a slide; a blanked screen shows its slide again first. */
export const previous = (state: Presentation): Presentation | null => (state.blank ? unblank(state) : goTo(state, state.at - 1))

/** The first slide shown. */
export const first = (state: Presentation): Presentation | null => goTo(state, 0)

/** The last slide shown. */
export const last = (state: Presentation): Presentation | null => goTo(state, state.shown.length - 1)

/** The slide `number` among those shown (1 is the first), or the nearest there is. */
export const jump = (state: Presentation, number: number): Presentation | null => goTo(state, Math.max(1, Math.min(state.shown.length, number)) - 1)

/** Blank the screen to a colour, or show the slide again when it is blanked to that colour already. */
export const blank = (state: Presentation, color: Blank): Presentation => ({ ...state, blank: state.blank === color ? null : color, typed: '' })

/** The end of the presentation, in every view. */
export const end = (): null => null

/** Show the slides another way (alone, or with the presenter view). */
export const withMode = (state: Presentation, mode: PresentMode): Presentation => (state.mode === mode ? state : { ...state, mode })

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'N'])
const PREVIOUS_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P'])

/**
 * What a key does, whichever view it is pressed in: the presentation after it (null when that ends
 * it), or undefined for a key that means nothing here. Digits and then Enter go to that slide.
 */
export function press(state: Presentation, key: string): Presentation | null | undefined {
  if (/^\d$/.test(key)) {
    return { ...state, typed: (state.typed + key).slice(-4) }
  }

  if (key === 'Enter' && state.typed) {
    return jump(state, Number(state.typed))
  }

  if (key === 'Escape') {
    return end()
  }

  if (NEXT_KEYS.has(key)) {
    return next(state)
  }

  if (PREVIOUS_KEYS.has(key)) {
    return previous(state)
  }

  if (key === 'Home') {
    return first(state)
  }

  if (key === 'End') {
    return last(state)
  }

  if (key === 'b' || key === 'B' || key === '.') {
    return blank(state, 'black')
  }

  if (key === 'w' || key === 'W' || key === ',') {
    return blank(state, 'white')
  }

  return undefined
}

/** What a presentation shows, the same in every view of it. */
export function frameOf(state: Presentation): Frame {
  const ended = state.at >= state.shown.length

  return { current: ended ? null : idAt(state, state.at), next: idAt(state, state.at + 1), number: Math.min(state.at + 1, state.shown.length), count: state.shown.length, ended, blank: state.blank }
}

/** The slide counter: '3 of 12', or 'End' on the end screen. */
export const counterText = (frame: Frame): string => (frame.ended ? 'End' : `${frame.number} of ${frame.count}`)

/**
 * The transition a move plays: going on, the one of the slide coming in; going back, the one of
 * the slide being left, backwards. The end screen comes in as the deck's slides do.
 */
export function moveTransition(deck: Pick<Deck, 'transition' | 'slides'>, move: Move): { transition: SlideTransition; reverse: boolean } {
  const id = move.forward ? move.to : move.from
  const slide = id === null ? undefined : deck.slides.find((entry) => entry.id === id)

  return { transition: transitionOf(deck, slide ?? {}), reverse: !move.forward }
}

/** The presentation after its deck changed: the slides shown again, staying on the slide in front where it can. */
export function follow(state: Presentation, deck: Pick<Deck, 'slides'>): Presentation {
  const shown = shownSlides(deck)

  if (shown.length === state.shown.length && shown.every((id, index) => id === state.shown[index])) {
    return state
  }

  const current = state.shown[state.at]
  const kept = current === undefined ? -1 : shown.indexOf(current)
  const at = state.at >= state.shown.length ? shown.length : kept >= 0 ? kept : Math.min(state.at, shown.length)

  return { ...state, shown, at }
}

/** Milliseconds the timer has counted by `now`. */
export const elapsed = (timer: Timer, now: number): number => timer.banked + (timer.since === null ? 0 : Math.max(0, now - timer.since))

export const pauseTimer = (timer: Timer, now: number): Timer => (timer.since === null ? timer : { banked: elapsed(timer, now), since: null })

export const resumeTimer = (timer: Timer, now: number): Timer => (timer.since === null ? { ...timer, since: now } : timer)

export const toggleTimer = (timer: Timer, now: number): Timer => (timer.since === null ? resumeTimer(timer, now) : pauseTimer(timer, now))

/** Back to nothing counted, still running if it was. */
export const resetTimer = (timer: Timer, now: number): Timer => ({ banked: 0, since: timer.since === null ? null : now })

/** A time counted, as minutes and seconds ('4:05'), with hours once there are any ('1:02:03'). */
export function durationText(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  const rest = String(seconds % 60).padStart(2, '0')

  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}
