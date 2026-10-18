import { isEditable } from '../store/edit-target.ts'

/**
 * Focus for a request card that has just appeared. A field being typed in keeps the focus, so a key
 * meant for it cannot answer the card; otherwise the card itself takes it, never one of its answers.
 * The returned function, for when the card goes, gives the focus back to where it was, unless the
 * person has since put it somewhere else.
 */
export function takeRequestFocus(card: HTMLElement): () => void {
  const before = document.activeElement

  if (!isEditable(before) && !card.contains(before)) {
    card.focus({ preventScroll: true })
  }

  return () => {
    const now = document.activeElement
    const lost = now === null || now === document.body || card.contains(now)

    if (lost && before instanceof HTMLElement && before !== document.body && before.isConnected && !card.contains(before)) {
      before.focus({ preventScroll: true })
    }
  }
}
