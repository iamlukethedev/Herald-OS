import { TextSelection } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import { blankDocument, paragraphNode, textNode } from '../../../../../shared/office/document.ts'
import { stateOf } from '../model.ts'
import { changedBlock, shiftedPages } from './edits.ts'

const noNotes = () => false

function threeParagraphs() {
  const json = blankDocument()
  json.content = [paragraphNode([textNode('First paragraph.')]), paragraphNode([textNode('Second paragraph.')]), paragraphNode([textNode('Third paragraph.')])]

  return stateOf(json)
}

/** Where the text of the top-level block at `index` starts. */
function textStart(state: ReturnType<typeof stateOf>, index: number): number {
  let pos = 0

  for (let at = 0; at < index; at++) {
    pos += state.doc.child(at).nodeSize
  }

  return pos + 1
}

describe('edits the pages stand through', () => {
  it('finds the one block typing changed, where it starts', () => {
    const state = threeParagraphs()
    const typed = state.apply(state.tr.insertText('x', textStart(state, 1) + 3))
    const change = changedBlock(state.doc, typed.doc, noNotes)

    expect(change?.index).toBe(1)
    expect(change?.start).toBe(state.doc.child(0).nodeSize)
    expect(change?.after.textContent).toBe('Secxond paragraph.')
  })

  it('lays out again when more than one block’s text changed', () => {
    const state = threeParagraphs()
    const both = state.apply(state.tr.insertText('x', textStart(state, 2)).insertText('y', textStart(state, 0)))

    expect(changedBlock(state.doc, both.doc, noNotes)).toBeNull()
  })

  it('lays out again when blocks come or go, change kind or settings, or the document’s own settings change', () => {
    const state = threeParagraphs()
    const at = textStart(state, 1) + 3
    const split = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)).split(at))
    const heading = state.apply(state.tr.setBlockType(at, at, state.schema.nodes.heading, { level: 1 }))
    const spaced = state.apply(state.tr.setNodeMarkup(textStart(state, 1) - 1, undefined, { ...state.doc.child(1).attrs, spaceBefore: 12 }))
    const page = state.apply(state.tr.setDocAttribute('page', { size: 'a4' }).insertText('x', at))

    expect(changedBlock(state.doc, split.doc, noNotes)).toBeNull()
    expect(changedBlock(state.doc, heading.doc, noNotes)).toBeNull()
    expect(changedBlock(state.doc, spaced.doc, noNotes)).toBeNull()
    expect(changedBlock(state.doc, page.doc, noNotes)).toBeNull()
  })

  it('lays out again when the block holds a note', () => {
    const state = threeParagraphs()
    const typed = state.apply(state.tr.insertText('x', textStart(state, 1)))

    expect(changedBlock(state.doc, typed.doc, (block) => block.textContent.includes('Second'))).toBeNull()
  })

  it('moves the pages after the block by what it grew or shrank', () => {
    const pages = [
      { number: 1, from: 0, to: 20 },
      { number: 2, from: 20, to: 40 }
    ]

    expect(shiftedPages(pages, 8, 1)).toEqual([
      { number: 1, from: 0, to: 21 },
      { number: 2, from: 21, to: 41 }
    ])
    expect(shiftedPages(pages, 20, -2)).toEqual([
      { number: 1, from: 0, to: 18 },
      { number: 2, from: 18, to: 38 }
    ])
    expect(pages[1].from).toBe(20)
  })
})
