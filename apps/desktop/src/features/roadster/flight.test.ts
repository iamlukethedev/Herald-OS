import { afterEach, describe, expect, it } from 'vitest'
import { $roadsterFlight, flyoversOn, isRoadsterWord, landRoadster, launchRoadster, ROADSTER_WORDS } from './flight.ts'

afterEach(() => {
  $roadsterFlight.set(0)
})

describe('the roadster’s trigger words', () => {
  it('take "fly" and "roadster" on their own, in any case and with spaces around them', () => {
    expect(ROADSTER_WORDS).toEqual(['fly', 'roadster'])

    for (const text of ['fly', 'roadster', 'FLY', 'Roadster', '  fly  ', '\troadster\n']) {
      expect(isRoadsterWord(text)).toBe(true)
    }
  })

  it('leave everything else to Hermes: longer words, sentences, slash commands and nothing at all', () => {
    for (const text of ['', ' ', 'fl', 'flying', 'flyer', 'roadsters', 'fly me to the moon', 'book a flight', 'a roadster', '/fly', 'fly roadster']) {
      expect(isRoadsterWord(text)).toBe(false)
    }
  })
})

describe('the flight store', () => {
  it('numbers each flight, and a new one takes the place of the one up', () => {
    const first = launchRoadster()
    expect($roadsterFlight.get()).toBe(first)

    const second = launchRoadster()
    expect(second).toBeGreaterThan(first)
    expect($roadsterFlight.get()).toBe(second)
  })

  it('lands only the flight that ended, so a stale end does not cut a later flight short', () => {
    const first = launchRoadster()
    const second = launchRoadster()

    landRoadster(first)
    expect($roadsterFlight.get()).toBe(second)

    landRoadster(second)
    expect($roadsterFlight.get()).toBe(0)
  })
})

describe('the Flyover animations setting', () => {
  it('is on until the person turns it off', () => {
    expect(flyoversOn({})).toBe(true)
    expect(flyoversOn({ flyovers: true })).toBe(true)
    expect(flyoversOn({ flyovers: false })).toBe(false)
  })
})
