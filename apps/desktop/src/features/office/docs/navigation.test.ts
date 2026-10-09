import { describe, expect, it } from 'vitest'
import type { DocJSON, DocNode } from '../../../../shared/office/document.ts'
import { findText, stateOf } from './model.ts'
import { currentEntry, filterMarks, mapPositions, type NavEntry, navigationEntries, navigationKey, navigationRows, navigationTree, rowOf } from './navigation.ts'

const text = (value: string): DocNode[] => (value ? [{ type: 'text', text: value }] : [])
const heading = (level: number, value: string): DocNode => ({ type: 'heading', attrs: { level }, content: text(value) })
const paragraph = (value: string, docStyle?: string): DocNode => ({ type: 'paragraph', ...(docStyle ? { attrs: { docStyle } } : {}), content: text(value) })
const stateWith = (...content: DocNode[]) => stateOf({ type: 'doc', content } as DocJSON)

/** Entries of the given levels, ten positions apart. */
const entries = (...levels: number[]): NavEntry[] => levels.map((level, index) => ({ level, text: `Entry ${index}`, from: index * 10 }))

const shape = (levels: number[]) => navigationTree(entries(...levels)).map(({ depth, parent, end }) => [depth, parent, end])

const TREE = navigationTree([
  { level: 1, text: 'Introduction', from: 0 },
  { level: 2, text: 'Background', from: 10 },
  { level: 3, text: 'Earlier work', from: 20 },
  { level: 2, text: 'Aims', from: 30 },
  { level: 1, text: 'Method', from: 40 },
  { level: 2, text: 'Planning the work', from: 50 }
])

describe('navigationEntries', () => {
  it('lists the headings with text and the titles, in document order, where their blocks start', () => {
    const { doc } = stateWith(
      paragraph('Annual report', 'title'),
      paragraph('For Ann Example', 'subtitle'),
      heading(1, 'Introduction'),
      paragraph('Body text.'),
      heading(2, '  Scope \t and   aims '),
      heading(2, ''),
      { type: 'blockquote', content: [heading(3, 'Quoted heading')] },
      heading(1, 'Results')
    )
    const found = navigationEntries(doc)

    expect(found.map(({ level, text }) => [level, text])).toEqual([
      [0, 'Annual report'],
      [1, 'Introduction'],
      [2, 'Scope and aims'],
      [3, 'Quoted heading'],
      [1, 'Results']
    ])
    expect(found.map((entry) => doc.nodeAt(entry.from)?.type.name)).toEqual(['paragraph', 'heading', 'heading', 'heading', 'heading'])
  })

  it('has nothing for a document without headings or a title', () => {
    expect(navigationEntries(stateWith(paragraph('Just text.'), heading(1, ' ')).doc)).toEqual([])
  })
})

describe('navigationTree', () => {
  it('puts each heading under the last heading of a higher level before it', () => {
    expect(shape([1, 2, 3, 2, 1])).toEqual([
      [0, -1, 4],
      [1, 0, 3],
      [2, 1, 3],
      [1, 0, 4],
      [0, -1, 5]
    ])
  })

  it('nests one step in where levels are skipped, and keeps a lower heading before the first higher one at the top', () => {
    expect(shape([2, 1, 3, 3, 2])).toEqual([
      [0, -1, 1],
      [0, -1, 5],
      [1, 1, 3],
      [1, 1, 4],
      [1, 1, 5]
    ])
  })

  it('starts again at the top at a title, with nothing under it', () => {
    expect(shape([1, 2, 0, 2, 1])).toEqual([
      [0, -1, 2],
      [1, 0, 2],
      [0, -1, 3],
      [0, -1, 4],
      [0, -1, 5]
    ])
  })
})

describe('currentEntry', () => {
  it('finds the last entry that starts before the caret', () => {
    const list = entries(1, 2, 1)

    expect([0, 1, 10, 11, 15, 20, 21, 99].map((pos) => currentEntry(list, pos))).toEqual([-1, 0, 0, 1, 1, 1, 2, 2])
    expect(currentEntry([], 5)).toBe(-1)
  })

  it('finds the heading the caret is under in a document', () => {
    const { doc } = stateWith(paragraph('Before any.'), heading(1, 'First'), paragraph('Under the first.'), heading(2, 'Second'))
    const list = navigationEntries(doc)
    const caret = (search: string) => findText(doc, search)[0].from

    expect(['Before', 'First', 'Under', 'Second'].map((search) => currentEntry(list, caret(search)))).toEqual([-1, 0, 0, 1])
  })
})

describe('filterMarks', () => {
  it('finds every word in any case, with or without accents, merging marks that touch', () => {
    expect(filterMarks('Résumé of the résumé', 'RESUME')).toEqual([
      [0, 6],
      [14, 20]
    ])
    expect(filterMarks('Project plan and planning', 'plan proj')).toEqual([
      [0, 4],
      [8, 12],
      [17, 21]
    ])
    expect(filterMarks('Overview', 'view over')).toEqual([[0, 8]])
  })

  it('needs every word, and marks nothing for an empty filter', () => {
    expect(filterMarks('Project plan', 'plan budget')).toBeNull()
    expect(filterMarks('Project plan', '   ')).toEqual([])
  })

  it('marks decomposed accents and characters outside the basic plane where they are', () => {
    expect(filterMarks('Cafe\u0301 menu', 'café')).toEqual([[0, 5]])
    expect(filterMarks('😀 Émoji', 'emoji')).toEqual([[3, 8]])
  })
})

describe('navigationRows', () => {
  it('shows every entry, leaving out what is under a folded one', () => {
    const rows = (collapsed: number[]) => navigationRows(TREE, new Set(collapsed)).map((row) => [row.index, row.expanded])

    expect(rows([])).toEqual([
      [0, true],
      [1, true],
      [2, null],
      [3, null],
      [4, true],
      [5, null]
    ])
    expect(rows([10, 40])).toEqual([
      [0, true],
      [1, false],
      [3, null],
      [4, false]
    ])
    // An entry with nothing under it has nothing to fold.
    expect(rows([20]).map(([index]) => index)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('shows what a filter matches and the entries they come under, unfolded', () => {
    expect(navigationRows(TREE, new Set([0, 40]), 'WORK')).toEqual([
      { index: 0, expanded: null, marks: [], context: true },
      { index: 1, expanded: null, marks: [], context: true },
      { index: 2, expanded: null, marks: [[8, 12]], context: false },
      { index: 4, expanded: null, marks: [], context: true },
      { index: 5, expanded: null, marks: [[13, 17]], context: false }
    ])
    expect(navigationRows(TREE, new Set(), 'nothing like this')).toEqual([])
  })
})

describe('rowOf', () => {
  it('finds the row an entry shows on, or the row of the nearest entry above it that shows', () => {
    const folded = navigationRows(TREE, new Set([10]))
    const filtered = navigationRows(TREE, new Set(), 'aims')

    expect([3, 2, -1].map((index) => rowOf(folded, TREE, index))).toEqual([2, 1, -1])
    expect([3, 2, 5].map((index) => rowOf(filtered, TREE, index))).toEqual([1, 0, -1])
  })
})

describe('navigationKey', () => {
  const rows = navigationRows(TREE, new Set([40]))

  it('moves between rows and goes to an entry', () => {
    expect(navigationKey(rows, TREE, 0, 'ArrowDown')).toEqual({ focus: 1 })
    expect(navigationKey(rows, TREE, 4, 'ArrowDown')).toEqual({ focus: 4 })
    expect(navigationKey(rows, TREE, 0, 'ArrowUp')).toEqual({ focus: 0 })
    expect(navigationKey(rows, TREE, 2, 'Home')).toEqual({ focus: 0 })
    expect(navigationKey(rows, TREE, 2, 'End')).toEqual({ focus: 4 })
    expect(navigationKey(rows, TREE, 3, 'Enter')).toEqual({ go: 3 })
    expect(navigationKey(rows, TREE, 0, 'a')).toBeNull()
    expect(navigationKey([], TREE, 0, 'ArrowDown')).toBeNull()
  })

  it('unfolds then goes in with Right, and folds then goes up with Left', () => {
    expect(navigationKey(rows, TREE, 4, 'ArrowRight')).toEqual({ toggle: 4 })
    expect(navigationKey(rows, TREE, 1, 'ArrowRight')).toEqual({ focus: 2 })
    expect(navigationKey(rows, TREE, 2, 'ArrowRight')).toBeNull()
    expect(navigationKey(rows, TREE, 1, 'ArrowLeft')).toEqual({ toggle: 1 })
    expect(navigationKey(rows, TREE, 2, 'ArrowLeft')).toEqual({ focus: 1 })
    expect(navigationKey(rows, TREE, 4, 'ArrowLeft')).toBeNull()
  })
})

describe('mapPositions', () => {
  it('carries positions through changes, and drops those whose block was deleted or replaced', () => {
    const state = stateWith(paragraph('Intro.'), heading(1, 'First'), heading(1, 'Second'))
    const [first, second] = navigationEntries(state.doc).map((entry) => entry.from)
    const both = new Set([first, second])

    expect([...mapPositions(both, state.tr.insertText('More ', 1).mapping)]).toEqual([first + 5, second + 5])
    expect([...mapPositions(both, state.tr.insertText('!', first + 2).mapping)]).toEqual([first, second + 1])
    expect([...mapPositions(both, state.tr.delete(first, second).mapping)]).toEqual([first])
    expect([...mapPositions(both, state.tr.setBlockType(second + 1, second + 1, state.schema.nodes.paragraph).mapping)]).toEqual([first])
  })
})
