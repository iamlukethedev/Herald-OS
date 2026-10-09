import type { HeaderKind } from '../../../../../shared/office/document.ts'

/*
 * A document's pages as the page view laid them out, for the status bar, a table of contents and
 * Hermes: each page's number, the document positions its text runs between, which header it
 * shows, and the page each heading and footnote is on.
 */

export interface PageEntry {
  /** From 1. */
  number: number
  /** The document positions its text runs from and to. */
  from: number
  to: number
  kind: HeaderKind
  section: number
  /** Left blank so that a section starts on an even or odd page. */
  blank: boolean
}

export interface PageMap {
  pages: PageEntry[]
  /** The page each heading is on, by its place among the document's headings (a TOC entry's `heading`). */
  headings: number[]
  /** The page each footnote is on, by its number less one. */
  footnotes: number[]
}

/** The page a document position is on: the last page that starts at or before it. */
export function pageAt(map: PageMap | null | undefined, pos: number): PageEntry | null {
  const pages = map?.pages

  if (!pages?.length) {
    return null
  }

  let low = 0
  let high = pages.length - 1

  while (low < high) {
    const middle = (low + high + 1) >> 1

    if (pages[middle].from <= pos) {
      low = middle
    } else {
      high = middle - 1
    }
  }

  return pages[low]
}

/** The page numbers of positions in document order (headings, notes), in one pass. */
export function pagesOf(map: PageMap, positions: readonly number[]): number[] {
  const pages = map.pages
  let at = 0

  return positions.map((pos) => {
    while (at + 1 < pages.length && pages[at + 1].from <= pos) {
      at++
    }

    return pages[at]?.number ?? 1
  })
}
