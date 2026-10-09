import type { Editor } from '@tiptap/core'
import { atom } from 'nanostores'
import type { HeaderKind, NoteKind } from '../../../../shared/office/document.ts'
import { createSession } from '../session.ts'
import { docsAdapter } from './adapter.ts'
import type { PageMap } from './pages/map.ts'

/** Herald Docs' open documents in this window. */
export const docsSession = createSession(docsAdapter)

/** The live editor of each open document, by its key, while its view is mounted. */
export const $editors = atom<Readonly<Record<string, Editor>>>({})

export const editorOf = (key: string | null | undefined): Editor | null => (key ? ($editors.get()[key] ?? null) : null)

export const activeEditor = (): Editor | null => editorOf(docsSession.$activeKey.get())

/** Each document's page zoom (1 is actual size). */
export const $zoom = atom<Readonly<Record<string, number>>>({})

/** The find bar: the document it is open on, and whether it shows replace. */
export const $find = atom<{ key: string; replace: boolean; at: number } | null>(null)

/** A request to edit the link at the selection (⌘K), for one document. */
export const $linkEdit = atom<{ key: string; at: number } | null>(null)

/** Each document's pages as the page view last laid them out, by its key: the status bar, a table of contents and Hermes read them. */
export const $pages = atom<Readonly<Record<string, PageMap>>>({})

/** Where something is on screen, in window pixels. */
export interface ScreenRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * A request to edit a header or footer in place, made by a double click on one: the document, the
 * part, which of its kinds the page shows, the page, and where the area is on screen. The area is
 * `[data-docs-page="<docKey>"] .docs-page-area[data-page-part="<part>"][data-page="<page>"]`.
 */
export const $partEdit = atom<{ docKey: string; part: 'header' | 'footer'; kind: HeaderKind; page: number; rect: ScreenRect } | null>(null)

/** A request to edit a footnote or endnote, made by a double click on its reference or its text: the document, the note, where its reference is in the document, and where it was on screen. */
export const $noteEdit = atom<{ docKey: string; kind: NoteKind; number: number; pos: number; rect: ScreenRect } | null>(null)
