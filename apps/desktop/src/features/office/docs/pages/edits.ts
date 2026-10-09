import type { Node as PMNode } from '@tiptap/pm/model'

/*
 * Edits the page view need not lay the whole document out again for. Typing changes the text of
 * one top-level block and nothing else: when the block keeps its kind and settings, holds no note
 * (whose text the foot of a page shows) and keeps its height, every page still starts where it
 * did, at document positions moved by the change.
 */

export interface ChangedBlock {
  index: number
  /** Where the block starts, the same in both versions. */
  start: number
  before: PMNode
  after: PMNode
}

/** The one top-level block whose content alone changed between two versions of a document; null when anything else changed. */
export function changedBlock(before: PMNode, after: PMNode, hasNotes: (block: PMNode) => boolean): ChangedBlock | null {
  if (before.attrs !== after.attrs || before.childCount !== after.childCount) {
    return null
  }

  let found = -1

  for (let index = 0; index < after.childCount; index++) {
    if (after.child(index) !== before.child(index)) {
      if (found >= 0) {
        return null
      }

      found = index
    }
  }

  if (found < 0) {
    return null
  }

  const was = before.child(found)
  const now = after.child(found)

  if (!was.sameMarkup(now) || hasNotes(was) || hasNotes(now)) {
    return null
  }

  let start = 0

  for (let index = 0; index < found; index++) {
    start += after.child(index).nodeSize
  }

  return { index: found, start, before: was, after: now }
}

/** Pages after a block that ended at `end` grew by `delta`: what starts or ends from there on moves with it. */
export function shiftedPages<Page extends { from: number; to: number }>(pages: readonly Page[], end: number, delta: number): Page[] {
  const shift = (pos: number) => (pos >= end ? pos + delta : pos)

  return pages.map((page) => ({ ...page, from: shift(page.from), to: shift(page.to) }))
}
