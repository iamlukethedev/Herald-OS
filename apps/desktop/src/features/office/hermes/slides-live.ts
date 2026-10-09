import { readDeck } from '../slides/agent-model.ts'
import type { SlidesDocument } from '../slides/document.ts'
import { slideTitle } from '../slides/model.ts'
import { decks, slidesSession } from '../slides/store.ts'
import type { LiveDoc } from './ask.ts'
import type { SlideSelection } from './prompts.ts'

function slideOf(live: SlidesDocument): SlideSelection {
  const { deck, slide } = live
  const read = readDeck(deck, slide.id).slides[0]
  const selected = new Set(live.selected)

  return {
    kind: 'slide',
    number: live.index + 1,
    count: deck.slides.length,
    id: slide.id,
    layout: slide.layout,
    title: read?.title ?? '',
    bodies: [read?.body ?? '', read?.body2 ?? ''].filter(Boolean),
    notes: slide.notes,
    selected: (read?.elements ?? []).filter((element) => selected.has(element.id)).map((element) => (element.text ? `${element.kind.toLowerCase()} “${element.text}”` : element.kind.toLowerCase())),
    titles: deck.slides.map(slideTitle)
  }
}

/** A Herald Slides deck open in this window, for a request to Hermes: the slide in front, the deck's titles and its history. */
export function slidesLive(docKey: string): LiveDoc | null {
  const doc = slidesSession.find(docKey)
  const live = decks.get(docKey)

  if (!doc) {
    return null
  }

  if (!live) {
    return { name: doc.name, path: doc.path, selection: null, detail: doc.editor?.detail?.(), depth: () => null, watch: () => () => {}, undo: () => {}, unmark: () => {} }
  }

  // The history keeps whole decks: every step makes a new one, and undoing comes back to the very deck it left.
  const start = live.history.present
  let seen = start
  let steps = 0

  return {
    name: doc.name,
    path: doc.path,
    selection: slideOf(live),
    depth: () => {
      if (live.history.present !== seen) {
        seen = live.history.present
        steps++
      }

      return steps
    },
    watch: (listener) => live.subscribe(listener),
    undo: (count) => {
      for (let n = 0; n < count && live.history.present !== start; n++) {
        if (!live.undo()) {
          break
        }
      }
    },
    unmark: () => {}
  }
}
