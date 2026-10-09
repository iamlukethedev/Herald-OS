import { describe, expect, it } from 'vitest'
import { type DocNode, paragraphNode, textNode } from '../../../../../shared/office/document.ts'
import { stateOf } from '../model.ts'
import type { LaidPage, PageLayout } from './paginator.ts'
import { printPagesOf, sliceOf } from './print.ts'

const item = (text: string): DocNode => ({ type: 'listItem', content: [paragraphNode([textNode(text)])] })

const docOf = (content: DocNode[]) => stateOf({ type: 'doc', attrs: { page: null, styles: null }, content }).doc

describe('cutting a document at page starts', () => {
  const doc = docOf([paragraphNode([textNode('Intro')], { firstLine: 18 }), { type: 'orderedList', attrs: { start: 3 }, content: [item('three'), item('four long'), item('five')] }])
  // Inside "four long", after "four ".
  let inside = 0
  doc.descendants((node, pos) => {
    if (node.text === 'four long') {
      inside = pos + 5
    }
  })

  it('ends a page inside a list item, its block marked as going on', () => {
    const [intro, list] = sliceOf(doc, 0, inside)

    expect(doc.textBetween(inside, inside + 4)).toBe('long')
    expect(intro).toMatchObject({ type: 'paragraph', attrs: { firstLine: 18 }, content: [textNode('Intro')] })
    expect(intro.attrs?.continues).toBeUndefined()
    expect(list.attrs).toMatchObject({ start: 3, continues: true })
    expect(list.content).toHaveLength(2)
    expect(list.content?.[0].attrs).toBeUndefined()
    expect(list.content?.[1]).toMatchObject({ attrs: { continues: true }, content: [{ attrs: { continues: true }, content: [textNode('four ')] }] })
  })

  it('starts the next inside the same item: the list numbered on, the item and its paragraph marked as continued', () => {
    const [list] = sliceOf(doc, inside, doc.content.size)

    expect(list.attrs).toMatchObject({ start: 4, continued: true })
    expect(list.content?.[0].attrs).toEqual({ continued: true })
    expect(list.content?.[0].content?.[0]).toMatchObject({ attrs: { continued: true }, content: [textNode('long')] })
    expect(list.content?.[1].attrs).toBeUndefined()
  })

  it('cuts nothing out of a block a page starts at', () => {
    const at = 7
    const [list] = sliceOf(doc, at, doc.content.size)

    expect(list.attrs).toMatchObject({ start: 3 })
    expect(list.attrs?.continued).toBeUndefined()
    expect(sliceOf(doc, 5, 5)).toEqual([])
  })
})

describe('the print view’s pages', () => {
  it('counts the notes and headings before each page, and gives each page its footnotes and endnotes', () => {
    const note = (kind: string, text: string): DocNode => ({ type: 'note', attrs: { kind, content: [paragraphNode([textNode(text)])] } })
    const doc = docOf([
      { type: 'heading', attrs: { level: 1 }, content: [textNode('One')] },
      paragraphNode([textNode('a'), note('footnote', 'first'), note('endnote', 'end')]),
      { type: 'heading', attrs: { level: 1 }, content: [textNode('Two')] },
      paragraphNode([textNode('b'), note('footnote', 'second')])
    ])
    const second = doc.child(0).nodeSize + doc.child(1).nodeSize
    const page = (number: number, from: number, to: number, extra: Partial<LaidPage> = {}): LaidPage =>
      ({ number, from, to, kind: 'default', section: 0, blank: false, frame: {}, top: 0, left: 0, bodyTop: 96, bodyBottom: 110, footnotes: [], notesHeight: 0, endnotes: [], endnoteRule: false, overflow: 0, ...extra }) as LaidPage
    const layout: PageLayout = { pages: [page(1, 0, second, { footnotes: [1] }), page(2, second, doc.content.size, { footnotes: [2], endnotes: [1], endnoteRule: true })], map: { pages: [], headings: [], footnotes: [] }, time: 0, zoom: 1 }
    const [first, next] = printPagesOf(doc, layout)

    expect(first).toMatchObject({ number: 1, notes: { footnote: 0, endnote: 0 }, headings: 0, bodyTop: 96, bodyBottom: 110 })
    expect(first.footnotes).toEqual([{ number: 1, content: [paragraphNode([textNode('first')])] }])
    expect(next).toMatchObject({ notes: { footnote: 1, endnote: 1 }, headings: 1, endnoteRule: true })
    expect(next.footnotes[0].content).toEqual([paragraphNode([textNode('second')])])
    expect(next.endnotes).toEqual([{ number: 1, content: [paragraphNode([textNode('end')])] }])
    expect(next.blocks.map((block) => block.type)).toEqual(['heading', 'paragraph'])
  })
})
