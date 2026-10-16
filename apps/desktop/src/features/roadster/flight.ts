import { atom } from 'nanostores'

/*
 * The roadster flyover: a short night scene in which a white roadster lifts off on cold vapor,
 * flips backwards over a box truck and leaves through the top right. Three things start it: the
 * command bar's easter egg (`roadster.fly`), a helper in the Pet Room handing back finished work,
 * and now and then the screensaver.
 */

/** What the command bar takes as the easter egg, typed on its own. */
export const ROADSTER_WORDS = ['fly', 'roadster'] as const

/** The query is one of the easter egg's words and nothing else, in any case. */
export function isRoadsterWord(text: string): boolean {
  const word = text.trim().toLowerCase()

  return (ROADSTER_WORDS as readonly string[]).includes(word)
}

/** The flight on screen in this window, by number; 0 when none is. */
export const $roadsterFlight = atom(0)

let flights = 0

/** Start a flight over the whole window, in place of one already up. */
export function launchRoadster(): number {
  flights += 1
  $roadsterFlight.set(flights)

  return flights
}

/** The flight ended or was dismissed; a later flight that replaced it stays. */
export function landRoadster(flight: number): void {
  if ($roadsterFlight.get() === flight) {
    $roadsterFlight.set(0)
  }
}
