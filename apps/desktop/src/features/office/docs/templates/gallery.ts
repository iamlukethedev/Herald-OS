/*
 * The template gallery's logic apart from React: moving the selection with the keys through
 * sections of cards laid out in rows, and naming a new document after its template.
 */

export type Direction = 'left' | 'right' | 'up' | 'down' | 'home' | 'end'

/**
 * Where the selection goes from `index` among sections of `sizes` cards, `columns` to a row, each
 * section starting a row of its own. Up and down keep the column, or take a shorter row's last card.
 */
export function moveSelection(sizes: readonly number[], columns: number, index: number, direction: Direction): number {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  const width = Math.max(1, Math.floor(columns))

  if (!total) {
    return 0
  }

  const current = Math.min(Math.max(index, 0), total - 1)

  switch (direction) {
    case 'left':
      return Math.max(0, current - 1)
    case 'right':
      return Math.min(total - 1, current + 1)
    case 'home':
      return 0
    case 'end':
      return total - 1
  }

  const rows: number[][] = []
  let start = 0

  for (const size of sizes) {
    for (let at = 0; at < size; at += width) {
      rows.push(Array.from({ length: Math.min(width, size - at) }, (_, offset) => start + at + offset))
    }

    start += size
  }

  const row = rows.findIndex((cards) => cards.includes(current))
  const next = rows[row + (direction === 'down' ? 1 : -1)]

  return next ? next[Math.min(rows[row].indexOf(current), next.length - 1)] : current
}

/** How many cards a row holds, from the tops of a section's cards in order: those level with the first. */
export const rowLength = (tops: readonly number[]): number => Math.max(1, tops.filter((top) => top === tops[0]).length)

/** `name`, or "name 2", "name 3" and so on when it is taken. */
export function freshName(name: string, taken: Iterable<string>): string {
  const names = new Set(taken)

  if (!names.has(name)) {
    return name
  }

  let n = 2

  while (names.has(`${name} ${n}`)) {
    n++
  }

  return `${name} ${n}`
}
