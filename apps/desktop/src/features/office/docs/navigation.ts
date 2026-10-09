import type { Node as PMNode } from '@tiptap/pm/model'
import type { Mappable } from '@tiptap/pm/transform'
import { outline } from './model.ts'

/*
 * The navigation pane's outline: the document's headings, and its title, as a tree; the one the
 * caret is under; what a filter leaves of them; and what the pane's keys do. An entry is known by
 * where its block starts, so a folded heading stays folded while the text around it changes.
 */

/** A heading, or a paragraph in the Title style (level 0). */
export interface NavEntry {
  level: number
  text: string
  /** Where its block starts in the document. */
  from: number
}

export interface NavNode extends NavEntry {
  depth: number
  /** The index of the entry it comes under, or -1 at the top. */
  parent: number
  /** The index after the last entry under it: there are some when this is more than its own index plus one. */
  end: number
}

/** A line of the pane. */
export interface NavRow {
  /** The entry's index in the tree. */
  index: number
  /** Whether the entries under it show; null when none are, and while filtering. */
  expanded: boolean | null
  /** Where in its text the filter matched, from and to; empty without a filter. */
  marks: [number, number][]
  /** Shown only because an entry under it matched the filter. */
  context: boolean
}

/** What a key does in the pane: move to a row, fold or unfold an entry, or go to it. */
export type NavStep = { focus: number } | { toggle: number } | { go: number }

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The headings (as the outline reads them) and the titles at the top level, in document order; those without text are left out. */
export function navigationEntries(doc: PMNode): NavEntry[] {
  const entries: NavEntry[] = outline(doc).map((entry) => ({ level: entry.level, text: clean(entry.text), from: entry.from }))
  doc.forEach((node, offset) => {
    if (node.type.name === 'paragraph' && node.attrs.docStyle === 'title') {
      entries.push({ level: 0, text: clean(node.textContent), from: offset })
    }
  })

  return entries.filter((entry) => entry.text).sort((a, b) => a.from - b.from)
}

/** The entries as a tree: a heading comes under the last heading of a higher level before it; a title starts again at the top, with nothing under it. */
export function navigationTree(entries: readonly NavEntry[]): NavNode[] {
  const nodes: NavNode[] = []
  const open: number[] = []
  const close = (to: number, level: number) => {
    while (open.length && nodes[open[open.length - 1]].level >= level) {
      nodes[open.pop()!].end = to
    }
  }

  entries.forEach((entry, index) => {
    close(index, entry.level)
    nodes.push({ ...entry, depth: open.length, parent: open.length ? open[open.length - 1] : -1, end: index + 1 })

    if (entry.level > 0) {
      open.push(index)
    }
  })
  close(entries.length, 0)

  return nodes
}

/** The entry the caret at `pos` is under: the last one that starts before it, or -1 before the first. */
export function currentEntry(entries: readonly NavEntry[], pos: number): number {
  let low = 0
  let high = entries.length - 1
  let found = -1

  while (low <= high) {
    const middle = (low + high) >> 1

    if (entries[middle].from < pos) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  return found
}

/** Text in lower case without accents, with where in the text each of its UTF-16 units came from, and the text's length last. */
function fold(text: string): { text: string; at: number[] } {
  let folded = ''
  const at: number[] = []
  let index = 0

  for (const char of text) {
    const plain = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    folded += plain
    at.push(...Array.from({ length: plain.length }, () => index))
    index += char.length
  }

  at.push(index)

  return { text: folded, at }
}

/** Where each word of a filter is in `text`, in any case and with or without accents, merged in order; null when a word is missing. */
export function filterMarks(text: string, query: string): [number, number][] | null {
  const words = fold(query).text.split(/\s+/).filter(Boolean)
  const folded = fold(text)
  const found: [number, number][] = []

  for (const word of words) {
    let at = folded.text.indexOf(word)

    if (at < 0) {
      return null
    }

    while (at >= 0) {
      found.push([folded.at[at], folded.at[at + word.length]])
      at = folded.text.indexOf(word, at + word.length)
    }
  }

  found.sort((a, b) => a[0] - b[0])

  return found.reduce<[number, number][]>((merged, [from, to]) => {
    const last = merged[merged.length - 1]

    if (last && from <= last[1]) {
      last[1] = Math.max(last[1], to)
    } else {
      merged.push([from, to])
    }

    return merged
  }, [])
}

/** The pane's lines: every entry not folded away; with a filter, the entries that match and those they come under, unfolded. */
export function navigationRows(tree: readonly NavNode[], collapsed: ReadonlySet<number>, query = ''): NavRow[] {
  if (!query.trim()) {
    const rows: NavRow[] = []

    for (let index = 0; index < tree.length; ) {
      const node = tree[index]
      const folded = node.end > index + 1 && collapsed.has(node.from)
      rows.push({ index, expanded: node.end > index + 1 ? !folded : null, marks: [], context: false })
      index = folded ? node.end : index + 1
    }

    return rows
  }

  const marks = tree.map((node) => filterMarks(node.text, query))
  const shown = new Set<number>()
  marks.forEach((found, index) => {
    for (let at = found ? index : -1; at >= 0 && !shown.has(at); at = tree[at].parent) {
      shown.add(at)
    }
  })

  return tree.flatMap((_, index) => (shown.has(index) ? [{ index, expanded: null, marks: marks[index] ?? [], context: !marks[index] }] : []))
}

/** The row an entry shows on: its own, or that of the nearest entry it comes under that shows; -1 when none does. */
export function rowOf(rows: readonly NavRow[], tree: readonly NavNode[], index: number): number {
  for (let entry = index; entry >= 0; entry = tree[entry].parent) {
    let low = 0
    let high = rows.length - 1

    while (low <= high) {
      const middle = (low + high) >> 1

      if (rows[middle].index === entry) {
        return middle
      }

      if (rows[middle].index < entry) {
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
  }

  return -1
}

/** What a key does on the row at `at`: arrows move, Right unfolds then goes in, Left folds then goes up, Enter goes to the entry. */
export function navigationKey(rows: readonly NavRow[], tree: readonly NavNode[], at: number, key: string): NavStep | null {
  const row = rows[at]

  if (!row) {
    return null
  }

  switch (key) {
    case 'ArrowDown':
      return { focus: Math.min(at + 1, rows.length - 1) }
    case 'ArrowUp':
      return { focus: Math.max(at - 1, 0) }
    case 'Home':
      return { focus: 0 }
    case 'End':
      return { focus: rows.length - 1 }
    case 'Enter':
      return { go: row.index }
    case 'ArrowRight':
      if (row.expanded === false) {
        return { toggle: row.index }
      }

      return row.expanded && rows[at + 1] ? { focus: at + 1 } : null
    case 'ArrowLeft': {
      if (row.expanded) {
        return { toggle: row.index }
      }

      const parent = tree[row.index].parent
      const up = parent < 0 ? -1 : rows.findIndex((other) => other.index === parent)

      return up < 0 ? null : { focus: up }
    }
    default:
      return null
  }
}

/** Positions carried through changes to the document; those whose block was deleted or replaced are dropped. */
export function mapPositions(positions: ReadonlySet<number>, mapping: Mappable): Set<number> {
  const out = new Set<number>()

  for (const pos of positions) {
    const result = mapping.mapResult(pos, 1)

    if (!result.deleted) {
      out.add(result.pos)
    }
  }

  return out
}
