import { atom, computed } from 'nanostores'
import { createSession } from '../session.ts'
import { slidesAdapter } from './adapter.ts'
import type { SlidesDocument } from './document.ts'
import type { Presentation } from './present/state.ts'

/** Herald Slides' open decks in this window. */
export const slidesSession = createSession(slidesAdapter)

/** The live deck of each open document, by its key, while its editor is mounted. */
export const decks = new Map<string, SlidesDocument>()

/** The presentation under way, the one state every view of it (presenter and audience) draws and moves. */
export const $presentation = atom<Presentation | null>(null)

/** The deck being presented, and the slide in front (its place in the deck; the last one shown on the end screen). */
export const $presenting = computed($presentation, (state): { key: string; index: number } | null => {
  if (!state) {
    return null
  }

  const id = state.shown[Math.min(state.at, state.shown.length - 1)]
  const index = decks.get(state.key)?.history.present.slides.findIndex((slide) => slide.id === id) ?? -1

  return { key: state.key, index: Math.max(0, index) }
})
