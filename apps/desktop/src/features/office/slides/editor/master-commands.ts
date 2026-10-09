import { atom } from 'nanostores'
import { messageOf } from '../../../canvas/errors.ts'
import type { Background, Deck, HeaderFooter, LayoutId, SlideTransition, Theme, Transition } from '../deck.ts'
import { DEFAULT_TRANSITION_MS } from '../deck.ts'
import type { SlidesDocument } from '../document.ts'
import { layoutOf, masterOf } from '../layouts.ts'
import {
  addLogo,
  applyTheme,
  applyTransitionToAll,
  type DeckChange,
  layoutSlideId,
  type LogoCorner,
  MASTER_SLIDE_ID,
  renameLayout,
  resetMaster,
  setHeaderFooter,
  setLayoutBackground,
  setMasterBackground,
  setShowMaster,
  setShowMasterOnSlides,
  setSlideTransition,
  slideLayoutId
} from '../model.ts'
import { $customThemes, loadCustomThemes } from '../theme-store.ts'
import { themeOf } from '../themes.ts'
import { DIRECTIONS, transitionFor, transitionOf } from '../transitions.ts'
import { flushTyping } from './active.ts'
import * as commands from './commands.ts'

/*
 * What the master view, the theme and transition panels and their menu items do to the deck in
 * front: changes to the deck itself (its master, theme, footers and transitions), worked out from the
 * deck as it stands whichever view is in front, each one step; and the dialogs they open, one at a
 * time for the window.
 */

/** A change to the deck itself as one step, whichever view is in front; nothing when it changes nothing. */
export function changeDeck(make: (deck: Deck, doc: SlidesDocument) => DeckChange | null | undefined, doc = commands.live()): DeckChange | null {
  if (!doc) {
    return null
  }

  flushTyping(doc)
  const next = make(doc.presentation, doc)

  if (next && next.deck !== doc.presentation) {
    doc.commit(next)
  }

  return next ?? null
}

/** The layout in front in the master view; null for the master's own slide, and in the slides view. */
export const layoutInFront = (doc = commands.live()): LayoutId | null => (doc?.mode === 'master' ? slideLayoutId(doc.slideId) : null)

/** Open or close the master view, keeping what is being typed first. */
export function showMasterView(shown: boolean, doc = commands.live()): void {
  if (!doc || (doc.mode === 'master') === shown) {
    return
  }

  flushTyping(doc)

  if (shown) {
    doc.enterMaster()
  } else {
    doc.exitMaster()
  }
}

/** Where the master view goes after a change to the master or a layout: its slide there, with `selected` picked. */
const masterFocus = (doc: SlidesDocument, where: 'master' | LayoutId, selected: string[]): DeckChange['focus'] =>
  doc.mode === 'master' ? { slideId: where === 'master' ? MASTER_SLIDE_ID : layoutSlideId(where), selected } : undefined

/** A picture as a logo in a corner of every slide (or of one layout's slides), selected in the master view. */
export async function insertLogo(file: Blob, where: { corner: LogoCorner; layoutId?: LayoutId }, doc = commands.live()): Promise<void> {
  const picture = await commands.readPicture(file)

  changeDeck((deck, on) => {
    const added = addLogo(deck, { src: picture.src, natural: picture.natural, corner: where.corner, ...(where.layoutId ? { layoutId: where.layoutId } : {}) })

    return { ...added, focus: masterFocus(on, where.layoutId ?? 'master', [added.elementId]) }
  }, doc)
}

/** In the master view, the background of the master, or of the layout in front (null: the master's, or the theme's). */
export function setMasterViewBackground(background: Background | null, doc = commands.live()): void {
  changeDeck((deck, on) => {
    if (on.mode !== 'master') {
      return null
    }

    const layout = layoutInFront(on)

    return layout ? setLayoutBackground(deck, layout, background) : setMasterBackground(deck, background)
  }, doc)
}

/** Whether the picked slides hide the master's drawings, or in the master view the layout in front does. */
export function backgroundGraphicsHidden(doc = commands.live()): boolean {
  if (!doc) {
    return false
  }

  const deck = doc.presentation

  if (doc.mode === 'master') {
    const layout = layoutInFront(doc)

    return layout !== null && !layoutOf(masterOf(deck), layout).showMaster
  }

  const picked = new Set(doc.pickedSlides)
  const slides = deck.slides.filter((slide) => picked.has(slide.id))

  return slides.length > 0 && slides.every((slide) => slide.showMaster === false)
}

/** Hide the master's drawings on the picked slides, or on the layout in front in the master view; or show them again. */
export function toggleBackgroundGraphics(doc = commands.live()): void {
  changeDeck((deck, on) => {
    const hidden = backgroundGraphicsHidden(on)

    if (on.mode === 'slides') {
      return setShowMasterOnSlides(deck, on.pickedSlides, hidden)
    }

    const layout = layoutInFront(on)

    return layout ? setShowMaster(deck, layout, hidden) : null
  }, doc)
}

export function renameLayoutInFront(name: string, doc = commands.live()): void {
  changeDeck((deck, on) => {
    const layout = layoutInFront(on)

    return layout ? renameLayout(deck, layout, name) : null
  }, doc)
}

export const resetDeckMaster = (doc = commands.live()) => changeDeck((deck) => resetMaster(deck), doc)

export const applyHeaderFooter = (patch: Partial<HeaderFooter>, doc = commands.live()) => changeDeck((deck) => setHeaderFooter(deck, patch), doc)

/** A theme for every slide, or for the picked slides only (the master view has none to pick). */
export type ThemeScope = 'all' | 'selected'

export function applyThemeTo(theme: Theme, scope: ThemeScope = 'all', doc = commands.live()): void {
  changeDeck((deck, on) => applyTheme(deck, theme, scope === 'selected' && on.mode === 'slides' ? on.pickedSlides : 'all'), doc)
}

/** The theme a scope has now: the deck's, or the slide in front's. */
export function themeInUse(scope: ThemeScope, doc = commands.live()): Theme | null {
  if (!doc) {
    return null
  }

  const deck = doc.presentation

  return scope === 'selected' && doc.mode === 'slides' ? themeOf(deck, doc.slide) : deck.theme
}

export const isCustomTheme = (theme: Theme | undefined): boolean => Boolean(theme && $customThemes.get().some((entry) => entry.id === theme.id))

let customThemesRead: Promise<unknown> | null = null

/** Read the custom themes from disk once for the panels and menus; after a failure (told when `report`), the next call tries again. */
export function readCustomThemes(report = true): void {
  customThemesRead ??= loadCustomThemes().catch((error: unknown) => {
    customThemesRead = null

    if (report) {
      commands.notify(`Herald Slides could not read the custom themes: ${messageOf(error)}`)
    }
  })
}

/** The transition the slide in front comes in with (its own, or the deck's); none in the master view. */
export function transitionInFront(doc = commands.live()): SlideTransition | null {
  return doc?.mode === 'slides' ? transitionOf(doc.presentation, doc.slide) : null
}

/** A transition of another kind, keeping the duration, and the direction or opening where the kind takes them. */
export function ofKind(kind: Transition, from: SlideTransition | null): SlideTransition {
  const next = transitionFor(kind, from?.duration ?? DEFAULT_TRANSITION_MS)

  if (from?.direction && DIRECTIONS[kind].includes(from.direction)) {
    next.direction = from.direction
  }

  if (kind === 'split' && from?.orientation) {
    next.orientation = from.orientation
  }

  return next
}

/** A transition for the picked slides; `join` makes quick changes of one thing (the duration being typed) one step. */
export function setPickedTransition(transition: SlideTransition, doc = commands.live(), join?: string): void {
  changeDeck((deck, on) => (on.mode === 'slides' ? { ...setSlideTransition(deck, on.pickedSlides, transition), ...(join ? { join } : {}) } : null), doc)
}

export const transitionToAll = (transition: SlideTransition, doc = commands.live()) => changeDeck((deck, on) => (on.mode === 'slides' ? applyTransitionToAll(deck, transition) : null), doc)

export type SlidesDialog =
  /** A new theme made from `theme`, or a custom theme edited in place; saved, it goes on the deck (or the picked slides). */
  | { kind: 'theme'; doc: SlidesDocument; theme: Theme; fresh: boolean; scope: ThemeScope }
  | { kind: 'header-footer'; doc: SlidesDocument }

/** The dialog open over the window. */
export const $slidesDialog = atom<SlidesDialog | null>(null)

/** The theme editor, for a new theme from `theme` (the deck's when none is given) or a custom theme. */
export function openThemeEditor(options: { theme?: Theme; fresh: boolean; scope?: ThemeScope }, doc = commands.live()): void {
  if (doc) {
    $slidesDialog.set({ kind: 'theme', doc, theme: options.theme ?? doc.presentation.theme, fresh: options.fresh, scope: options.scope ?? 'all' })
  }
}

export function openHeaderFooter(doc = commands.live()): void {
  if (doc) {
    $slidesDialog.set({ kind: 'header-footer', doc })
  }
}

export const closeSlidesDialog = (): void => $slidesDialog.set(null)
