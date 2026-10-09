import { baseName, extensionOf } from '../../../../shared/office/files.ts'
import type { OfficeAdapter, OfficeDocument } from '../types.ts'
import type { Deck } from './deck.ts'
import type { SlidesDocument } from './document.ts'
import type { DeckChange } from './model.ts'

/*
 * Where a change from outside the editor lands (Hermes's slides commands): in the deck open in a
 * window, as one step to undo that the window saves by its own rules, or in a file on disk, read,
 * changed and written back (main backs the original up first). A file whose reading approximated
 * or left something out is not written over without being told to, so nothing is lost silently.
 */

export interface SlidesTarget {
  /** The deck as it is now. */
  deck: Deck
  /** The live deck in a window, when it is open in one. */
  doc: SlidesDocument | null
  /** The open document (its editor may not be mounted). */
  open: OfficeDocument<Deck> | null
  path: string | null
  /** What reading the file approximated or left out. */
  notes: string[]
}

/** What targets need from the window: its open decks and files, injected so they can be tested. */
export interface TargetIO {
  documents: () => OfficeDocument<Deck>[]
  active: () => OfficeDocument<Deck> | null
  live: (key: string) => SlidesDocument | undefined
  changed: (doc: OfficeDocument<Deck>) => void
  read: (file: string) => Promise<{ path: string; bytes: Uint8Array }>
  write: (file: string, bytes: Uint8Array) => Promise<unknown>
  adapter: Pick<OfficeAdapter<Deck>, 'read' | 'write'>
  /** Fold typing in progress into a live deck first. */
  flush?: (doc: SlidesDocument) => void
}

export function makeTargets(io: TargetIO) {
  const fromOpen = (open: OfficeDocument<Deck>): SlidesTarget => {
    const doc = io.live(open.key) ?? null

    if (doc) {
      io.flush?.(doc)
    }

    return { deck: doc?.presentation ?? open.initial, doc, open, path: open.path, notes: open.notes }
  }

  /** The deck a command works on: the file named (open or on disk), or the deck in front. */
  async function target(file?: string | null): Promise<SlidesTarget> {
    if (file) {
      const open = io.documents().find((doc) => doc.path === file)

      if (open) {
        return fromOpen(open)
      }

      const data = await io.read(file)
      const result = await io.adapter.read(data.bytes, extensionOf(file), baseName(file))

      return { deck: result.model, doc: null, open: null, path: data.path, notes: result.notes }
    }

    const active = io.active()

    if (!active) {
      throw new Error('No presentation is open in Herald Slides: open one or start one')
    }

    return fromOpen(active)
  }

  /**
   * Make a change, worked out from the deck as it is when the change lands: one step in a live
   * deck, or the file rewritten. `accept` agrees to lose what the file's reading left out.
   */
  async function apply(on: SlidesTarget, make: (deck: Deck) => DeckChange, options: { accept?: boolean } = {}): Promise<DeckChange> {
    if (on.doc) {
      io.flush?.(on.doc)
      const change = make(on.doc.presentation)
      on.doc.commit(change)

      return change
    }

    const change = make(on.deck)

    if (on.open) {
      on.open.initial = change.deck
      io.changed(on.open)

      return change
    }

    if (!on.path) {
      throw new Error('This presentation has nowhere to be saved')
    }

    if (on.notes.length && !options.accept) {
      throw new Error(`Writing ${baseName(on.path)} back would lose what Herald could not keep of it (${on.notes[0]}); open it in Herald Slides to decide`)
    }

    const { bytes } = await io.adapter.write(change.deck, extensionOf(on.path), undefined)
    await io.write(on.path, bytes)

    return change
  }

  return { target, apply }
}

/** The window's own targets, wired to its Herald Slides session. */
export async function slidesTargets(): Promise<ReturnType<typeof makeTargets>> {
  const [{ slidesSession, decks }, { slidesAdapter }, { flushTyping }] = await Promise.all([import('./store.ts'), import('./adapter.ts'), import('./editor/active.ts')])

  return makeTargets({
    documents: () => slidesSession.$documents.get(),
    active: () => slidesSession.active(),
    live: (key) => decks.get(key),
    changed: (doc) => slidesSession.changed(doc),
    read: (file) => window.heraldOS.office.read(file),
    write: (file, bytes) => window.heraldOS.office.write(file, bytes),
    adapter: slidesAdapter,
    flush: (doc) => flushTyping(doc)
  })
}
