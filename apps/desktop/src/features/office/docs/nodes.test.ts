import { describe, expect, it } from 'vitest'
import type { DocJSON, DocNode } from '../../../../shared/office/document.ts'
import { docsSchema } from './schema.ts'

const roundTrip = (json: DocJSON): DocJSON => docsSchema().nodeFromJSON(json).toJSON() as DocJSON

describe('the nodes beyond text', () => {
  it('keeps fields, notes, tables of contents, section breaks and text boxes with their attrs', () => {
    const field: DocNode = { type: 'field', attrs: { kind: 'page', format: null, instruction: null, text: '1' } }
    const note: DocNode = { type: 'note', attrs: { kind: 'endnote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A note.' }] }] } }
    const toc: DocNode = { type: 'tableOfContents', attrs: { levels: 2, title: 'Contents', pages: [1, 2] } }
    const section: DocNode = { type: 'sectionBreak', attrs: { kind: 'oddPage', page: { width: 842, height: 595, margins: { top: 36, right: 36, bottom: 36, left: 36 } } } }
    const box: DocNode = { type: 'textBox', attrs: { width: 144, height: null, align: 'right', border: '#000000', fill: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Boxed' }] }] }
    const attrs = { page: null, styles: null, headers: { header: { default: [{ type: 'paragraph' }] }, footer: {}, differentFirst: true }, comments: [{ id: 'c1', author: 'Ann', date: null, text: 'Why?' }], kept: { parts: [] } }
    const out = roundTrip({ type: 'doc', attrs, content: [toc, { type: 'paragraph', content: [{ type: 'text', text: 'Page ' }, field, note] }, section, box] })

    expect(out.attrs).toEqual(attrs)
    expect(out.content[0]).toEqual(toc)
    expect(out.content[1].content?.slice(1)).toEqual([field, note])
    expect(out.content[2]).toEqual(section)
    expect(out.content[3].attrs).toEqual(box.attrs)
  })

  it('lets comments overlap', () => {
    const marks = [
      { type: 'comment', attrs: { id: 'a' } },
      { type: 'comment', attrs: { id: 'b' } }
    ]
    const out = roundTrip({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'both', marks }] }] })

    expect(out.content[0].content?.[0].marks).toEqual(marks)
  })
})
