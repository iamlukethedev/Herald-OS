import type { Editor } from '@tiptap/core'
import { atom } from 'nanostores'

/*
 * What is being edited in place on a document's pages: a header, a footer or a note, each in an
 * editor of its own. While one is open, the menus and the toolbar work on its editor.
 */

export interface OpenPart {
  what: 'header' | 'footer' | 'note'
  editor: Editor
  /** The page whose header or footer it is. */
  page: number | null
  /** Put what was typed into the document now. */
  flush: () => void
}

/** The part open in each document, by its key. */
export const $openParts = atom<Readonly<Record<string, OpenPart>>>({})

export const openPartOf = (key: string | null | undefined): OpenPart | null => (key ? ($openParts.get()[key] ?? null) : null)

/** Say what is open in a document, or that nothing is (only for the editor that was open, when one is given). */
export function setOpenPart(key: string, part: OpenPart | null, closing?: Editor): void {
  const { [key]: current, ...rest } = $openParts.get()

  if (!part && closing && current?.editor !== closing) {
    return
  }

  $openParts.set(part ? { ...rest, [key]: part } : rest)
}

/** The document whose Page Setup dialog is open. */
export const $pageSetup = atom<string | null>(null)
