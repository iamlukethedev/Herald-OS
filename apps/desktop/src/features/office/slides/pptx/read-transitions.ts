import type { SlideTransition, Transition, TransitionDirection } from '../deck.ts'
import { DEFAULT_TRANSITION_MS } from '../deck.ts'
import { DIRECTIONS, transitionFor } from '../transitions.ts'
import { attr, child, childrenNamed, elements, flagAttr, numberAttr, type XmlElement } from './xml.ts'

/*
 * A slide's transition as Herald plays it: the effects Herald has as themselves, with the way they
 * travel and how long they take, and PowerPoint's others as the nearest effect Herald has.
 */

/** How long each of PowerPoint's speeds takes, in milliseconds (a transition says `fast` by default). */
const SPEEDS: Record<string, number> = { slow: 1000, med: 750, fast: 500 }

const SIDES: Record<string, TransitionDirection> = { l: 'left', r: 'right', u: 'up', d: 'down' }

const each = (kind: Transition, names: string): Record<string, Transition> => Object.fromEntries(names.split(' ').map((name) => [name, kind]))

/** Effects Herald does not play, by the one it plays that looks most like each (anything else fades). */
const NEAREST: Record<string, Transition> = {
  ...each('wipe', 'randomBar blinds checker comb strips wedge wheel wheelReverse circle diamond plus'),
  ...each('push', 'pan conveyor ferris gallery switch flip vortex prism'),
  ...each('split', 'doors window'),
  ...each('zoom', 'newsflash warp flythrough')
}

export interface TransitionRead {
  /** Null for a slide that just appears. */
  transition: SlideTransition | null
  /** Whether Herald plays the very effect the slide has. */
  exact: boolean
  /** Whether the slide moves on by itself after a time. */
  timed: boolean
  /** Whether a sound plays as the slide comes in. */
  sound: boolean
}

/** A slide's transition: a markup choice's, which says how long it takes in milliseconds, over a plain one, over a fallback's stand-in. */
function transitionElement(root: XmlElement): XmlElement | undefined {
  const alternatives = childrenNamed(root, 'mc:AlternateContent')
  const among = (name: string) =>
    alternatives
      .flatMap((node) => childrenNamed(node, name))
      .map((node) => child(node, 'p:transition'))
      .find((entry) => entry !== undefined)

  return among('mc:Choice') ?? child(root, 'p:transition') ?? among('mc:Fallback')
}

/** An effect Herald plays itself, as it plays it; null for one it does not. */
function ownEffect(name: string, effect: XmlElement, duration: number): { transition: SlideTransition; exact: boolean } | null {
  const dir = attr(effect, 'dir')
  const through = flagAttr(effect, 'thruBlk') === true

  if (name === 'fade' || name === 'cut') {
    return { transition: { kind: name === 'fade' ? 'fade' : 'none', duration }, exact: !through }
  }

  if (name === 'push' || name === 'wipe' || name === 'cover' || name === 'pull') {
    // Cover and pull may also go corner to corner (`lu`, `rd`…): the side they start from is the nearest.
    const side = SIDES[dir ?? 'l'] ?? SIDES[(dir ?? 'l')[0]] ?? 'left'

    return { transition: { kind: name === 'pull' ? 'uncover' : name, duration, direction: side }, exact: dir === undefined || SIDES[dir] !== undefined }
  }

  if (name === 'split') {
    return { transition: { kind: 'split', duration, direction: dir === 'in' ? 'in' : 'out', orientation: attr(effect, 'orient') === 'vert' ? 'vertical' : 'horizontal' }, exact: true }
  }

  return name === 'zoom' ? { transition: { kind: 'zoom', duration, direction: dir === 'in' ? 'in' : 'out' }, exact: true } : null
}

/** A slide's transition as Herald plays it, with what it cannot keep of it. */
export function readTransition(root: XmlElement): TransitionRead {
  const element = transitionElement(root)
  const effect = elements(element).find((node) => node.name !== 'p:sndAc' && node.name !== 'p:extLst')
  const timed = attr(element, 'advTm') !== undefined
  const sound = child(child(element, 'p:sndAc'), 'p:stSnd') !== undefined

  if (!effect) {
    return { transition: null, exact: true, timed, sound }
  }

  const duration = Math.max(0, Math.round(numberAttr(element, 'p14:dur') ?? SPEEDS[attr(element, 'spd') ?? 'fast'] ?? DEFAULT_TRANSITION_MS))
  const name = effect.name.slice(effect.name.indexOf(':') + 1)
  const own = ownEffect(name, effect, duration)

  if (own) {
    return { ...own, timed, sound }
  }

  const kind = NEAREST[name] ?? 'fade'
  const dir = attr(effect, 'dir') ?? ''
  const way = SIDES[dir] ?? (dir === 'in' || dir === 'out' ? dir : undefined)
  const across = attr(effect, 'orient') ?? (dir === 'horz' || dir === 'vert' ? dir : undefined)
  const transition: SlideTransition = {
    ...transitionFor(kind, duration),
    ...(way && DIRECTIONS[kind].includes(way) ? { direction: way } : {}),
    ...(kind === 'split' && across ? { orientation: across === 'vert' ? 'vertical' : 'horizontal' } : {})
  }

  return { transition, exact: false, timed, sound }
}
