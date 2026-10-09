import type { SlideTransition, TransitionDirection } from '../deck.ts'
import { DIRECTIONS } from '../transitions.ts'
import { find, xml, type XmlElement } from './xml.ts'

/*
 * A slide's transition as PowerPoint writes it: with its duration (PowerPoint 2010's `p14:dur`)
 * for apps that read it, and with the speed nearest that duration for apps that do not.
 */

const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'

const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'

const SIDES: Partial<Record<TransitionDirection, string>> = { left: 'l', right: 'r', up: 'u', down: 'd' }

/** The speed PowerPoint 2007 knows nearest a duration in milliseconds. */
const speedOf = (duration: number): string => (duration <= 500 ? 'fast' : duration <= 750 ? 'med' : 'slow')

function effectXml(transition: SlideTransition): XmlElement | null {
  const ways = DIRECTIONS[transition.kind]
  const direction = transition.direction && ways.includes(transition.direction) ? transition.direction : ways[0]
  const side = direction ? SIDES[direction] : undefined

  switch (transition.kind) {
    case 'fade':
      return xml('p:fade')
    case 'push':
      return xml('p:push', { dir: side })
    case 'wipe':
      return xml('p:wipe', { dir: side })
    case 'cover':
      return xml('p:cover', { dir: side })
    case 'uncover':
      return xml('p:pull', { dir: side })
    case 'split':
      return xml('p:split', { orient: transition.orientation === 'vertical' ? 'vert' : 'horz', dir: direction === 'in' ? 'in' : 'out' })
    case 'zoom':
      return xml('p:zoom', { dir: direction === 'out' ? 'out' : 'in' })
    default:
      return null
  }
}

const isTransition = (node: XmlElement): boolean => node.name === 'p:transition' || (node.name === 'mc:AlternateContent' && Boolean(find(node, 'mc:Fallback/p:transition') ?? find(node, 'mc:Choice/p:transition')))

/**
 * A slide's transition in place of any it had, where the schema has it (after the colour map, before
 * the timing and extensions); none writes nothing. The slide declares the markup compatibility
 * namespace with PowerPoint 2010's as ignorable, and the choice declares the namespace it requires.
 */
export function writeTransition(root: XmlElement, transition: SlideTransition): void {
  root.children = root.children.filter((node) => typeof node === 'string' || !isTransition(node))
  const effect = effectXml(transition)
  const fallback = effectXml(transition)

  if (!effect || !fallback) {
    return
  }

  const speed = speedOf(transition.duration)
  const alternatives = xml('mc:AlternateContent', {}, [
    xml('mc:Choice', { 'xmlns:p14': P14, Requires: 'p14' }, [xml('p:transition', { spd: speed, 'p14:dur': Math.max(0, Math.round(transition.duration)) }, [effect])]),
    xml('mc:Fallback', {}, [xml('p:transition', { spd: speed }, [fallback])])
  ])
  const at = root.children.findIndex((node) => typeof node !== 'string' && (node.name === 'p:timing' || node.name === 'p:extLst'))

  root.attrs['xmlns:mc'] = MC
  root.attrs['xmlns:p14'] = P14
  root.attrs['mc:Ignorable'] = 'p14'
  root.children.splice(at < 0 ? root.children.length : at, 0, alternatives)
}
