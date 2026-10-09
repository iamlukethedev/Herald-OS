import { $reviewProvider, type ReviewProvider } from '../docs/review-provider.ts'
import { docsSession, editorOf } from '../docs/store.ts'
import { actionName, free } from './actions.ts'
import { askHermes } from './ask.ts'
import type { DocsAction } from './prompts.ts'

/*
 * Review > Review with Hermes in Herald Docs: Hermes reads the document in front and leaves its
 * clarity, grammar and tone comments on exact passages in one add_comments call, so the review is
 * one step to undo. It goes through the document's Ask Hermes bar like the inline actions: the
 * same session, progress, cancel, undo and way to the Hermes window.
 */

const REVIEW: DocsAction = { id: 'review' }

export const hermesReview: ReviewProvider = {
  label: 'Review with Hermes',
  enabled: free,
  run: async (docKey) => {
    if (!free(docKey)) {
      return
    }

    const editor = editorOf(docKey)

    if (editor && !editor.state.doc.textContent.trim()) {
      docsSession.notify('There is nothing to review in this document yet')

      return
    }

    await askHermes({ app: 'docs', docKey, words: actionName(REVIEW), action: REVIEW })
  }
}

/** Offer the review in Herald Docs' Review menu; the function returned takes it away again. */
export function offerHermesReview(): () => void {
  $reviewProvider.set(hermesReview)

  return () => {
    if ($reviewProvider.get() === hermesReview) {
      $reviewProvider.set(null)
    }
  }
}
