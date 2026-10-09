import { Extension } from '@tiptap/core'
import { undo, undoDepth } from '@tiptap/pm/history'
import { type EditorState, Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { applyLive, type LiveView, type Op } from './model.ts'

/*
 * The text a request to Hermes is about: what was selected when the person asked, kept through
 * every edit made meanwhile (theirs or Hermes's) and tinted in the page while Hermes works on it.
 * Hermes's commands write to it with `at: "marked"`, so the answer lands where it was asked for even
 * after the person has clicked elsewhere.
 */

export interface MarkedRange {
  from: number
  to: number
}

interface MarkedState {
  range: MarkedRange | null
  /** The undo depth right after Hermes last wrote into the range: a rewrite then replaces that write instead of adding a step. */
  landed: number | null
  decorations: DecorationSet
}

export const markedKey = new PluginKey<MarkedState>('docsHermesMarked')

const EMPTY: MarkedState = { range: null, landed: null, decorations: DecorationSet.empty }

function stateFor(state: { doc: EditorState['doc'] }, range: MarkedRange | null, landed: number | null = null): MarkedState {
  if (!range || range.to < range.from) {
    return EMPTY
  }

  const decorations = range.to > range.from ? DecorationSet.create(state.doc, [Decoration.inline(range.from, range.to, { class: 'docs-hermes-marked' })]) : DecorationSet.empty

  return { range, landed, decorations }
}

export function markedPlugin(): Plugin<MarkedState> {
  return new Plugin<MarkedState>({
    key: markedKey,
    state: {
      init: () => EMPTY,
      apply(tr, value) {
        const meta = tr.getMeta(markedKey) as { range: MarkedRange | null } | { landed: number } | undefined

        if (meta && 'landed' in meta) {
          return value.range ? { ...value, landed: meta.landed } : value
        }

        if (meta) {
          return stateFor(tr, meta.range)
        }

        if (!value.range || !tr.docChanged) {
          return value
        }

        // Text typed at either edge joins neither side: the range stays what was asked about.
        const range = { from: tr.mapping.map(value.range.from, 1), to: tr.mapping.map(value.range.to, -1) }

        return stateFor(tr, range.to >= range.from ? range : { from: range.from, to: range.from }, value.landed)
      }
    },
    props: {
      decorations: (state) => markedKey.getState(state)?.decorations
    }
  })
}

export const HermesMarked = Extension.create({
  name: 'hermesMarked',
  addProseMirrorPlugins() {
    return [markedPlugin()]
  }
})

export const markedRangeOf = (state: EditorState): MarkedRange | null => markedKey.getState(state)?.range ?? null

/** The undo depth right after Hermes last wrote into the marked range, or null. */
export const markedLandedOf = (state: EditorState): number | null => markedKey.getState(state)?.landed ?? null

/**
 * Hermes writes into the marked range. When it writes there again with nothing else changed since
 * (it refines its wording), its last write is taken back first, so the request stays one step to undo.
 */
export function writeMarked(view: LiveView, build: (state: EditorState) => Op): boolean {
  if (markedLandedOf(view.state) === undoDepth(view.state)) {
    undo(view.state, view.dispatch)
  }

  const changed = applyLive(view, build(view.state))

  if (changed) {
    view.dispatch(view.state.tr.setMeta(markedKey, { landed: undoDepth(view.state) }).setMeta('addToHistory', false))
  }

  return changed
}

/** Mark a range (the selection, by default) for Hermes, or clear the mark with null. */
export function setMarked(view: EditorView, range: MarkedRange | null | 'selection' = 'selection'): MarkedRange | null {
  const chosen = range === 'selection' ? { from: view.state.selection.from, to: view.state.selection.to } : range
  view.dispatch(view.state.tr.setMeta(markedKey, { range: chosen }).setMeta('addToHistory', false))

  return chosen
}
