import { atom, type WritableAtom } from 'nanostores'
import { describe, expect, it } from 'vitest'
import type { Deck, Slide, SlideTransition } from '../deck.ts'
import { newDeck } from '../model.ts'
import { transitionFor } from '../transitions.ts'
import { begin, blank, counterText, durationText, elapsed, first, follow, frameOf, goTo, jump, moveTransition, next, pauseTimer, type Presentation, press, previous, resetTimer, resumeTimer, shownSlides, toggleTimer } from './state.ts'

const slide = (id: string, extra: Partial<Slide> = {}): Slide => ({ id, layout: 'blank', background: null, elements: [], notes: '', hidden: false, ...extra })

const deckOf = (slides: Slide[], transition: Deck['transition'] = 'fade'): Deck => ({ ...newDeck('Talk'), slides, transition })

/** What a presentation shows: a slide's id, the end screen, or nothing once it is over. */
function showing(state: Presentation | null): string {
  return state ? (frameOf(state).current ?? 'end screen') : 'over'
}

/** Keys pressed one after another; keys that mean nothing change nothing. */
function keys(state: Presentation, ...pressed: string[]): Presentation | null {
  let now: Presentation | null = state

  for (const key of pressed) {
    now = now && (press(now, key) ?? now)
  }

  return now
}

const talk = deckOf([slide('a'), slide('b', { hidden: true }), slide('c'), slide('d')])

describe('presentation navigation', () => {
  it('shows the slides not hidden, and every slide when all are', () => {
    expect(shownSlides(talk)).toEqual(['a', 'c', 'd'])
    expect(shownSlides(deckOf([slide('a', { hidden: true }), slide('b', { hidden: true })]))).toEqual(['a', 'b'])
  })

  it('starts on the slide asked for, or the next one shown when that one is hidden', () => {
    expect(showing(begin(talk, 'k', 0, 0))).toBe('a')
    expect(showing(begin(talk, 'k', 1, 0))).toBe('c')
    expect(showing(begin(deckOf([slide('a'), slide('b'), slide('c', { hidden: true })]), 'k', 2, 0))).toBe('b')
  })

  it('moves on past hidden slides to the end screen, and ends after it', () => {
    const seen: string[] = []

    for (let state: Presentation | null = begin(talk, 'k', 0, 0); state; state = next(state)) {
      seen.push(showing(state))
    }

    expect(seen).toEqual(['a', 'c', 'd', 'end screen'])
  })

  it('goes back from the end screen to the last slide, and no further back than the first', () => {
    const ended = keys(begin(talk, 'k', 0, 0), 'End', 'ArrowRight') as Presentation
    expect(showing(ended)).toBe('end screen')
    expect(counterText(frameOf(ended))).toBe('End')

    const back = previous(ended) as Presentation
    expect(showing(back)).toBe('d')

    const start = first(back) as Presentation
    expect(showing(start)).toBe('a')
    expect(previous(start)).toBe(start)
  })

  it('jumps to the slide typed by number and Enter, or the nearest there is', () => {
    const start = begin(talk, 'k', 0, 0)

    expect(showing(keys(start, '3', 'Enter'))).toBe('d')
    expect(showing(keys(start, '2', 'Enter'))).toBe('c')
    expect(showing(keys(start, '9', '9', 'Enter'))).toBe('d')
    expect(showing(jump(start, 0))).toBe('a')
    expect(keys(start, '2')?.typed).toBe('2')
    expect(keys(start, '2', 'Enter')?.typed).toBe('')
  })

  it('goes to the first and last slides with Home and End', () => {
    const start = begin(talk, 'k', 2, 0)

    expect(showing(keys(start, 'Home'))).toBe('a')
    expect(showing(keys(start, 'Home', 'End'))).toBe('d')
  })

  it('blanks the screen to black or white, and a move shows the slide again before going on', () => {
    const start = begin(talk, 'k', 0, 0)
    const black = press(start, 'b') as Presentation

    expect(black.blank).toBe('black')
    expect(press(black, 'B')?.blank).toBe(null)
    expect(press(black, 'w')?.blank).toBe('white')

    const shown = next(black) as Presentation
    expect([showing(shown), shown.blank]).toEqual(['a', null])
    expect(showing(next(shown))).toBe('c')
    expect(showing(previous(blank(begin(talk, 'k', 2, 0), 'white')))).toBe('c')

    const jumped = keys(black, '3', 'Enter') as Presentation
    expect([showing(jumped), jumped.blank]).toEqual(['d', null])
  })

  it('ends with Escape, and leaves keys that mean nothing here alone', () => {
    const start = begin(talk, 'k', 0, 0)

    expect(press(start, 'Escape')).toBe(null)
    expect(press(start, 'x')).toBe(undefined)
  })

  it('records each move: the slide left, the slide shown, which way and its number', () => {
    const on = next(begin(talk, 'k', 0, 0)) as Presentation

    expect(on.move).toEqual({ from: 'a', to: 'c', forward: true, serial: 1 })
    expect(previous(on)?.move).toEqual({ from: 'c', to: 'a', forward: false, serial: 2 })
    expect(goTo(on, 9)?.move).toEqual({ from: 'c', to: null, forward: true, serial: 2 })
  })

  it('follows the deck as it changes, staying on the slide in front', () => {
    const state = begin(talk, 'k', 2, 0)
    const inserted = follow(state, deckOf([slide('z'), ...talk.slides]))

    expect([inserted.at, showing(inserted)]).toEqual([2, 'c'])
    expect(showing(follow(state, deckOf([slide('a'), slide('d')])))).toBe('d')
    expect(follow(state, deckOf([...talk.slides]))).toBe(state)
  })
})

/** A view of the one presentation: what it drew each time the state changed, and its keys. */
function view($state: WritableAtom<Presentation | null>) {
  const drawn: string[] = []
  $state.subscribe((state) => {
    const frame = state && frameOf(state)
    drawn.push(frame ? `${frame.current ?? 'end'} ${frame.blank ?? 'shown'} ${counterText(frame)}` : 'over')
  })

  const key = (pressed: string) => {
    const state = $state.get()
    const after = state && press(state, pressed)

    if (after !== undefined) {
      $state.set(after)
    }
  }

  return { drawn, key }
}

describe('presenter and audience', () => {
  it('show the same slide and screen from the one state, whichever view has the keys', () => {
    const $state = atom<Presentation | null>(begin(talk, 'k', 0, 0, 'displays'))
    const presenter = view($state)
    const audience = view($state)

    presenter.key('ArrowRight')
    audience.key('b')
    presenter.key(' ')
    audience.key('3')
    presenter.key('Enter')
    audience.key('ArrowRight')
    presenter.key('Escape')

    expect(presenter.drawn).toEqual(['a shown 1 of 3', 'c shown 2 of 3', 'c black 2 of 3', 'c shown 2 of 3', 'c shown 2 of 3', 'd shown 3 of 3', 'end shown End', 'over'])
    expect(audience.drawn).toEqual(presenter.drawn)
  })
})

describe('the presenter timer', () => {
  it('counts from the start of the presentation, by the clock it is given', () => {
    expect(elapsed(begin(talk, 'k', 0, 1_000).timer, 4_500)).toBe(3_500)
  })

  it('pauses and resumes, leaving the pause out', () => {
    const paused = pauseTimer({ banked: 0, since: 1_000 }, 5_000)
    expect(paused).toEqual({ banked: 4_000, since: null })
    expect(elapsed(paused, 60_000)).toBe(4_000)
    expect(pauseTimer(paused, 70_000)).toBe(paused)

    const resumed = resumeTimer(paused, 10_000)
    expect(elapsed(resumed, 12_500)).toBe(6_500)
    expect(resumeTimer(resumed, 11_000)).toBe(resumed)
    expect(toggleTimer(toggleTimer(resumed, 13_000), 20_000)).toEqual({ banked: 7_000, since: 20_000 })
  })

  it('resets to nothing counted, running on when it was running', () => {
    expect(resetTimer({ banked: 9_000, since: 1_000 }, 30_000)).toEqual({ banked: 0, since: 30_000 })
    expect(resetTimer({ banked: 9_000, since: null }, 30_000)).toEqual({ banked: 0, since: null })
  })

  it('writes the time taken as minutes and seconds, with hours once there are any', () => {
    expect(durationText(0)).toBe('0:00')
    expect(durationText(65_400)).toBe('1:05')
    expect(durationText(3_723_000)).toBe('1:02:03')
  })
})

describe('the transition a move plays', () => {
  const push: SlideTransition = { kind: 'push', duration: 700, direction: 'left' }
  const wipe: SlideTransition = { kind: 'wipe', duration: 300, direction: 'up' }
  const deck = deckOf([slide('a'), slide('b', { transition: push }), slide('c'), slide('d', { transition: wipe })])
  const start = begin(deck, 'k', 0, 0)
  const played = (state: Presentation | null) => (state?.move ? moveTransition(deck, state.move) : null)

  it('going on, is the one of the slide coming in', () => {
    expect(played(next(start))).toEqual({ transition: push, reverse: false })
  })

  it('is the deck one for a slide without its own', () => {
    expect(played(keys(start, 'ArrowRight', 'ArrowRight'))).toEqual({ transition: transitionFor('fade'), reverse: false })
  })

  it('going back, is the one of the slide being left, played backwards', () => {
    expect(played(keys(start, 'ArrowRight', 'ArrowLeft'))).toEqual({ transition: push, reverse: true })
    expect(played(keys(start, 'End', 'ArrowLeft'))).toEqual({ transition: wipe, reverse: true })
  })

  it('jumping, is the one of the slide jumped to, or going back of the one jumped from', () => {
    expect(played(keys(start, '4', 'Enter'))).toEqual({ transition: wipe, reverse: false })
    expect(played(keys(start, 'End', 'Home'))).toEqual({ transition: wipe, reverse: true })
  })

  it('to the end screen and back from it, is the deck one', () => {
    expect(played(keys(start, 'End', 'ArrowRight'))).toEqual({ transition: transitionFor('fade'), reverse: false })
    expect(played(keys(start, 'End', 'ArrowRight', 'ArrowLeft'))).toEqual({ transition: transitionFor('fade'), reverse: true })
  })
})
