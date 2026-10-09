import { describe, expect, it } from 'vitest'
import type { SlideTransition, TransitionDirection } from '../deck.ts'
import { choreograph, effectOf, REDUCED_MOTION_MS } from './effects.ts'

const transition = (kind: SlideTransition['kind'], extra: Partial<SlideTransition> = {}): SlideTransition => ({ kind, duration: 500, ...extra })

const STILL = 'translate(0%, 0%)'
const SHOWN = 'inset(0% 0% 0% 0%)'

/** Each way a slide travels: where it starts coming in, and where the slide before it goes. */
const SIDES: [TransitionDirection, string, string][] = [
  ['left', 'translate(100%, 0%)', 'translate(-100%, 0%)'],
  ['right', 'translate(-100%, 0%)', 'translate(100%, 0%)'],
  ['up', 'translate(0%, 100%)', 'translate(0%, -100%)'],
  ['down', 'translate(0%, -100%)', 'translate(0%, 100%)']
]

describe('transition effects', () => {
  it('none moves nothing, and nor does a transition that takes no time', () => {
    expect(effectOf(transition('none'))).toBe(null)
    expect(choreograph(transition('none'), false)).toBe(null)
    expect(choreograph(transition('fade', { duration: 0 }), false)).toBe(null)
  })

  it('fades the slide coming in over the one before', () => {
    expect(effectOf(transition('fade'))).toMatchObject({ incoming: [{ opacity: 0 }, { opacity: 1 }], outgoing: null, outgoingOnTop: false })
  })

  it.each(SIDES)('pushes travelling %s: in from %s, the slide before out to %s', (direction, from, to) => {
    expect(effectOf(transition('push', { direction }))).toMatchObject({ incoming: [{ transform: from }, { transform: STILL }], outgoing: [{ transform: STILL }, { transform: to }] })
  })

  it.each(SIDES)('covers travelling %s: the slide coming in from %s, over the one before', (direction, from) => {
    expect(effectOf(transition('cover', { direction }))).toMatchObject({ incoming: [{ transform: from }, { transform: STILL }], outgoing: null, outgoingOnTop: false })
  })

  it.each(SIDES)('uncovers travelling %s: the slide before, on top, goes out to %s', (direction, _from, to) => {
    expect(effectOf(transition('uncover', { direction }))).toMatchObject({ incoming: null, outgoing: [{ transform: STILL }, { transform: to }], outgoingOnTop: true })
  })

  it.each([
    ['left', 'inset(0% 0% 0% 100%)'],
    ['right', 'inset(0% 100% 0% 0%)'],
    ['up', 'inset(100% 0% 0% 0%)'],
    ['down', 'inset(0% 0% 100% 0%)']
  ] as const)('wipes travelling %s, opening from the edge it starts at', (direction, from) => {
    expect(effectOf(transition('wipe', { direction }))).toMatchObject({ incoming: [{ clipPath: from }, { clipPath: SHOWN }], outgoing: null, outgoingOnTop: false })
  })

  it('splits open from the middle outwards, or shuts the slide before into the middle inwards', () => {
    expect(effectOf(transition('split', { direction: 'out', orientation: 'horizontal' }))).toMatchObject({ incoming: [{ clipPath: 'inset(50% 0% 50% 0%)' }, { clipPath: SHOWN }], outgoing: null, outgoingOnTop: false })
    expect(effectOf(transition('split', { direction: 'out', orientation: 'vertical' }))).toMatchObject({ incoming: [{ clipPath: 'inset(0% 50% 0% 50%)' }, { clipPath: SHOWN }], outgoing: null })
    expect(effectOf(transition('split', { direction: 'in', orientation: 'horizontal' }))).toMatchObject({ incoming: null, outgoing: [{ clipPath: SHOWN }, { clipPath: 'inset(50% 0% 50% 0%)' }], outgoingOnTop: true })
    expect(effectOf(transition('split', { direction: 'in', orientation: 'vertical' }))).toMatchObject({ incoming: null, outgoing: [{ clipPath: SHOWN }, { clipPath: 'inset(0% 50% 0% 50%)' }], outgoingOnTop: true })
  })

  it('zooms the slide coming in up from the middle, or the slide before down into it', () => {
    expect(effectOf(transition('zoom', { direction: 'in' }))).toMatchObject({ incoming: [{ transform: 'scale(0.3)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], outgoing: null, outgoingOnTop: false })
    expect(effectOf(transition('zoom', { direction: 'out' }))).toMatchObject({ incoming: null, outgoing: [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.3)', opacity: 0 }], outgoingOnTop: true })
  })

  it('goes the way its kind goes first when it says no way, or one its kind does not take', () => {
    expect(effectOf(transition('push'))?.incoming?.[0]).toEqual({ transform: 'translate(0%, 100%)' })
    expect(effectOf(transition('push', { direction: 'in' }))?.incoming?.[0]).toEqual({ transform: 'translate(0%, 100%)' })
    expect(effectOf(transition('wipe'))?.incoming?.[0]).toEqual({ clipPath: 'inset(0% 0% 0% 100%)' })
    expect(effectOf(transition('split'))?.incoming?.[0]).toEqual({ clipPath: 'inset(50% 0% 50% 0%)' })
    expect(effectOf(transition('zoom', { direction: 'left' }))?.incoming?.[0]).toEqual({ transform: 'scale(0.3)', opacity: 0 })
  })
})

describe('playing a transition', () => {
  it('going on, brings the slide arriving in by it for its duration, over the one being left', () => {
    const plan = choreograph(transition('push', { direction: 'left', duration: 650 }), false)

    expect(plan).toMatchObject({ duration: 650, top: 'arriving' })
    expect(plan?.arriving).toMatchObject({ keyframes: [{ transform: 'translate(100%, 0%)' }, { transform: STILL }], options: { duration: 650, fill: 'both', direction: 'normal' } })
    expect(plan?.leaving).toMatchObject({ keyframes: [{ transform: STILL }, { transform: 'translate(-100%, 0%)' }], options: { direction: 'normal' } })
  })

  it('going back, plays it backwards: the slide being left goes out the way it came in', () => {
    const plan = choreograph(transition('cover', { direction: 'left' }), true)

    expect(plan).toMatchObject({ arriving: null, top: 'leaving' })
    expect(plan?.leaving).toMatchObject({ keyframes: [{ transform: 'translate(100%, 0%)' }, { transform: STILL }], options: { direction: 'reverse' } })
  })

  it('going back over an uncover, the slide arriving comes back on top', () => {
    const plan = choreograph(transition('uncover', { direction: 'right' }), true)

    expect(plan).toMatchObject({ leaving: null, top: 'arriving' })
    expect(plan?.arriving).toMatchObject({ keyframes: [{ transform: STILL }, { transform: 'translate(100%, 0%)' }], options: { direction: 'reverse' } })
  })

  it('with motion reduced, is a quick fade whatever the kind', () => {
    for (const kind of ['fade', 'push', 'wipe', 'cover', 'uncover', 'split', 'zoom'] as const) {
      expect(choreograph(transition(kind, { duration: 900 }), false, true)).toMatchObject({ duration: REDUCED_MOTION_MS, top: 'arriving', leaving: null, arriving: { keyframes: [{ opacity: 0 }, { opacity: 1 }] } })
    }

    expect(choreograph(transition('none'), false, true)).toBe(null)
  })
})
