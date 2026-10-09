import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { type EditorState, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { atom, map } from 'nanostores'
import { commentsOf } from '../../../../shared/office/document.ts'
import { addComment, applyLive, commentRange, comments, commentSpans, deleteComment, newCommentId, type Op, type Range, setCommentResolved } from './model.ts'
import { revealInDesk } from './overlay.ts'

/*
 * Comments in the editor: their text highlighted (more strongly for the thread in front, not at
 * all once resolved), which thread is in front (the one whose card was picked, or the one whose
 * text the caret is in), and a new comment while it is written, on the text it will be on. What
 * the panel and the menus do to comments goes through the document API, one step to undo each.
 */

export interface CommentsState {
  /** The thread in front: its card picked, or its text where the caret is. */
  active: string | null
  /** A new comment being written: the text it will be on, followed through changes. */
  draft: Range | null
  decorations: DecorationSet
}

interface CommentsMeta {
  active?: string | null
  draft?: Range | null
}

export const commentsKey = new PluginKey<CommentsState>('comments')

export const commentsState = (state: EditorState): CommentsState | null => commentsKey.getState(state) ?? null

/** Whether each document's comments show beside its pages, by its key, once the person chose; until then they show when it has some. */
export const $commentsShown = map<Record<string, boolean>>({})

/** Asks for the box of the comment being written to take the focus, each time New Comment is chosen. */
export const $composeRequest = atom(0)

const openThreads = (doc: PMNode): Set<string> => new Set(commentsOf({ type: 'doc', attrs: doc.attrs }).flatMap((thread) => (thread && typeof thread.id === 'string' && !thread.resolved ? [thread.id] : [])))

/** The open thread whose text the caret is in or beside: `current` when it is one of them, or the one on the least text. */
function threadAtCaret(state: EditorState, current: string | null): string | null {
  const { $head } = state.selection
  const open = openThreads(state.doc)
  const ids = new Set<string>()

  for (const mark of [...($head.nodeBefore?.marks ?? []), ...($head.nodeAfter?.marks ?? [])]) {
    if (mark.type.name === 'comment' && open.has(mark.attrs.id)) {
      ids.add(mark.attrs.id)
    }
  }

  if (current && ids.has(current)) {
    return current
  }

  const spans = commentSpans(state.doc)
  let best: string | null = null
  let least = Number.POSITIVE_INFINITY

  for (const id of ids) {
    const span = spans.get(id)
    const size = span ? span.to - span.from : Number.POSITIVE_INFINITY

    if (best === null || size < least) {
      best = id
      least = size
    }
  }

  return best
}

function decorate(doc: PMNode, active: string | null, draft: Range | null): DecorationSet {
  const open = openThreads(doc)
  const found: Decoration[] = []

  if (open.size) {
    doc.descendants((node, pos) => {
      if (!node.isInline) {
        return true
      }

      for (const mark of node.marks) {
        if (mark.type.name === 'comment' && open.has(mark.attrs.id)) {
          found.push(Decoration.inline(pos, pos + node.nodeSize, { class: mark.attrs.id === active ? 'docs-comment is-active' : 'docs-comment' }, { comment: mark.attrs.id }))
        }
      }

      return false
    })
  }

  if (draft) {
    found.push(Decoration.inline(draft.from, draft.to, { class: 'docs-comment is-active' }, { comment: null }))
  }

  return found.length ? DecorationSet.create(doc, found) : DecorationSet.empty
}

export function commentsPlugin(): Plugin<CommentsState> {
  return new Plugin<CommentsState>({
    key: commentsKey,
    state: {
      init: (_, state) => ({ active: null, draft: null, decorations: decorate(state.doc, null, null) }),
      apply: (tr, value, _old, state) => {
        const meta = tr.getMeta(commentsKey) as CommentsMeta | undefined
        let { active, draft } = value

        if (meta && 'draft' in meta) {
          draft = meta.draft ?? null
        } else if (draft && tr.docChanged) {
          const from = tr.mapping.map(draft.from, 1)
          const to = tr.mapping.map(draft.to, -1)
          draft = from < to ? { from, to } : null
        }

        if (meta && 'active' in meta) {
          active = meta.active ?? null
        } else if (tr.selectionSet) {
          active = threadAtCaret(state, active)
        }

        if (active && !openThreads(state.doc).has(active)) {
          active = null
        }

        if (!tr.docChanged && active === value.active && draft === value.draft) {
          return value
        }

        return { active, draft, decorations: decorate(state.doc, active, draft) }
      }
    },
    props: {
      decorations: (state) => commentsKey.getState(state)?.decorations ?? null
    }
  })
}

export const Comments = Extension.create({
  name: 'comments',
  addProseMirrorPlugins: () => [commentsPlugin()]
})

// What the panel and the menus do.

/** Start a new comment on the selection, or the word at the caret, and show the comments; false when there is no text there. */
export function startComment(view: EditorView, docKey: string): boolean {
  const range = commentRange(view.state)

  if (!range || range.from === range.to) {
    return false
  }

  $commentsShown.setKey(docKey, true)
  view.dispatch(view.state.tr.setMeta(commentsKey, { draft: range, active: null }))
  $composeRequest.set($composeRequest.get() + 1)

  return true
}

/** Give the text the focus back from the comment being written, the caret after the text it is on, so typing does not replace that text. */
export function leaveComment(view: EditorView): void {
  const draft = commentsState(view.state)?.draft

  if (draft) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, draft.to)))
  }

  view.focus()
}

/** Drop the comment being written; `focus` gives the text the focus back, the caret after the text it was on. */
export function cancelComment(view: EditorView, focus = false): void {
  const draft = commentsState(view.state)?.draft

  if (!draft) {
    return
  }

  const tr = view.state.tr.setMeta(commentsKey, { draft: null })

  if (focus) {
    tr.setSelection(TextSelection.create(view.state.doc, draft.to))
  }

  view.dispatch(tr)

  if (focus) {
    view.focus()
  }
}

/** Post the comment being written, as one step; the text gets the focus back with the caret after the comment's text. The new thread's id, or null. */
export function postComment(view: EditorView, text: string, author: string): string | null {
  const draft = commentsState(view.state)?.draft

  if (!draft) {
    return null
  }

  const id = newCommentId(view.state.doc)
  const op: Op = (state) => {
    const tr = addComment(draft, text, { author, id })(state)

    return tr && tr.setSelection(TextSelection.create(tr.doc, draft.to)).setMeta(commentsKey, { draft: null, active: id })
  }

  if (!applyLive(view, op)) {
    cancelComment(view)

    return null
  }

  view.focus()

  return id
}

/** Bring a thread to the front, its text selected and scrolled into view; the focus stays where it is unless `focus`. */
export function showThread(view: EditorView, id: string, focus = false): void {
  const span = commentSpans(view.state.doc).get(id)
  const tr = view.state.tr.setMeta(commentsKey, { active: id })

  if (span) {
    tr.setSelection(TextSelection.create(view.state.doc, span.to, span.from))
  }

  view.dispatch(tr)

  if (span) {
    revealInDesk(view, span.from)
  }

  if (focus) {
    view.focus()
  }
}

/** Go to the next open comment after the caret (or the one in front), or the one before it, round to the first or last; false when there is none. */
export function moveToThread(view: EditorView, direction: 1 | -1): boolean {
  const open = comments(view.state.doc).filter((thread) => !thread.resolved && thread.from !== null)

  if (!open.length) {
    return false
  }

  const current = open.findIndex((thread) => thread.id === commentsState(view.state)?.active)
  const at = view.state.selection.from
  const next =
    current >= 0
      ? open[(current + direction + open.length) % open.length]
      : direction > 0
        ? (open.find((thread) => thread.from! > at) ?? open[0])
        : (open.findLast((thread) => thread.from! < at) ?? open[open.length - 1])
  showThread(view, next.id, true)

  return true
}

/** The thread in front, for the menus. */
export const activeThread = (view: EditorView | null | undefined): string | null => (view ? (commentsState(view.state)?.active ?? null) : null)

export function resolveThread(view: EditorView, id: string, resolved = true): boolean {
  return applyLive(view, setCommentResolved(id, resolved))
}

/** Delete a thread (or a reply), or the comment being written when it is the one in front. */
export function removeThread(view: EditorView, id: string | null): boolean {
  if (!id) {
    const writing = Boolean(commentsState(view.state)?.draft)
    cancelComment(view, writing)

    return writing
  }

  return applyLive(view, deleteComment(id))
}
