import { atom } from 'nanostores'
import { $commentsShown } from './comments.ts'
import { addComments, applyLive, type CommentSpec, comments } from './model.ts'
import { editorOf } from './store.ts'

/**
 * A review of a document by an AI, which another part of Herald offers by setting this: while it
 * is set, the Review menu has an item named `label` that runs `run` with the key of the document in
 * front. The review adds its comments with `addReviewComments` (or the document API's
 * `addComments(list, 'Hermes')`), all of them one step to undo. Null takes the item away.
 */
export interface ReviewProvider {
  label: string
  run: (docKey: string) => void | Promise<void>
  /** Whether it can review the document now (its reviewer is reachable and free); left out, it always can. */
  enabled?: (docKey: string) => boolean
}

export const $reviewProvider = atom<ReviewProvider | null>(null)

/** Add a review's comments to an open document as one step, by `author`, and show them; how many it added. */
export function addReviewComments(docKey: string, list: readonly CommentSpec[], author = 'Hermes'): number {
  const editor = editorOf(docKey)

  if (!editor) {
    return 0
  }

  const before = comments(editor.state.doc).length

  if (!applyLive(editor.view, addComments(list, author))) {
    return 0
  }

  $commentsShown.setKey(docKey, true)

  return comments(editor.state.doc).length - before
}
