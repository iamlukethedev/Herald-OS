import { describe, expect, it } from 'vitest'
import type { SlideTransition } from './deck.ts'
import * as model from './model.ts'
import { sameTransition, transitionFor, transitionOf } from './transitions.ts'

const push: SlideTransition = { kind: 'push', duration: 700, direction: 'up' }

/** A deck of three slides, each named by id. */
function three() {
  const deck = model.addSlide(model.addSlide(model.newDeck('Pitch')).deck).deck
  const [a, b, c] = deck.slides.map((slide) => slide.id)

  return { deck, a, b, c }
}

describe('slide transitions', () => {
  it('gives some slides a transition of their own, and the deck’s back with null', () => {
    const { deck, a, b, c } = three()
    const change = model.setSlideTransition(deck, [a, c], push)

    expect(change.label).toBe('Transition')
    expect(change.deck.slides.map((slide) => slide.transition?.kind)).toEqual(['push', undefined, 'push'])
    expect(change.deck.slides[1]).toBe(deck.slides[1])
    expect(transitionOf(change.deck, change.deck.slides[1])).toEqual(transitionFor('fade'))
    expect(model.setSlideTransition(change.deck, [a], { ...push }).deck).toBe(change.deck)

    const back = model.setSlideTransition(change.deck, [a, b], null).deck
    expect(back.slides.map((slide) => slide.transition?.kind)).toEqual([undefined, undefined, 'push'])
    expect('transition' in back.slides[0]).toBe(false)

    const all = model.setSlideTransition(back, 'all', transitionFor('zoom')).deck
    expect(all.slides.every((slide) => slide.transition?.kind === 'zoom')).toBe(true)
    expect(all.transition).toBe('fade')
  })

  it('applies a transition to every slide and makes its kind the deck’s', () => {
    const { deck, a } = three()
    const mixed = model.setSlideTransition(deck, [a], transitionFor('wipe')).deck
    const change = model.applyTransitionToAll(mixed, push)

    expect(change.label).toBe('Transition')
    expect(change.deck.transition).toBe('push')
    expect(change.deck.slides.every((slide) => sameTransition(slide.transition, push))).toBe(true)
    expect(model.applyTransitionToAll(change.deck, { ...push }).deck).toBe(change.deck)
  })

  it('sets the deck’s kind for every slide, as it always has, clearing slides’ own', () => {
    const { deck, b } = three()
    const own = model.setSlideTransition(deck, [b], push).deck
    const change = model.setTransition(own, 'cover')

    expect(change.label).toBe('Transition')
    expect(change.deck.transition).toBe('cover')
    expect(change.deck.slides.every((slide) => slide.transition === undefined)).toBe(true)
    expect(change.deck.slides.map((slide) => transitionOf(change.deck, slide).kind)).toEqual(['cover', 'cover', 'cover'])
    expect(model.setTransition(deck, 'cover').deck.slides).toBe(deck.slides)
  })

  it('tells transitions that come in alike', () => {
    expect(sameTransition(push, { ...push })).toBe(true)
    expect(sameTransition(push, { ...push, duration: 500 })).toBe(false)
    expect(sameTransition(undefined, undefined)).toBe(true)
    expect(sameTransition(push, undefined)).toBe(false)
  })
})
