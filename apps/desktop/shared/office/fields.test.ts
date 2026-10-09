import { describe, expect, it } from 'vitest'
import { type DocJSON, headerKindFor, noteLabel, notesOf, type PageHeaders, pagePart, paragraphNode, sectionsOf, textNode, tocEntries } from './document.ts'
import { fieldAttrs, fieldText, formatDate } from './fields.ts'

const at = new Date(2026, 2, 7, 14, 5, 9)

describe('fields', () => {
  it('formats dates and times in Word pictures', () => {
    expect(formatDate(at, 'd MMMM yyyy')).toBe('7 March 2026')
    expect(formatDate(at, 'dd/MM/yy')).toBe('07/03/26')
    expect(formatDate(at, 'dddd, MMM d')).toBe('Saturday, Mar 7')
    expect(formatDate(at, 'HH:mm:ss')).toBe('14:05:09')
    expect(formatDate(at, "h:mm am/pm 'today'")).toBe('2:05 pm today')
  })

  it('shows page fields on a page and their last result off one', () => {
    expect(fieldText({ kind: 'page' }, { page: 4, pages: 9 })).toBe('4')
    expect(fieldText({ kind: 'pages' }, { page: 4, pages: 9 })).toBe('9')
    expect(fieldText({ kind: 'page', text: '2' })).toBe('2')
    expect(fieldText({ kind: 'page' })).toBe('#')
    expect(fieldText({ kind: 'date', format: 'yyyy' }, { now: at })).toBe('2026')
    expect(fieldText({ kind: 'other', instruction: 'SEQ Figure', text: '3' })).toBe('3')
  })

  it('makes unknown attrs safe', () => {
    expect(fieldAttrs({ kind: 'nonsense', format: 3 })).toEqual({ kind: 'other', format: null, instruction: null, text: null })
  })
})

describe('headers, notes, tables of contents and sections', () => {
  const headers: PageHeaders = {
    header: { default: [paragraphNode([textNode('Odd')])], first: [paragraphNode([textNode('First')])], even: [paragraphNode([textNode('Even')])] },
    footer: {},
    differentFirst: true,
    differentOddEven: true
  }

  it('picks the header each page shows', () => {
    expect([1, 2, 3, 4].map((page) => headerKindFor(headers, page))).toEqual(['first', 'even', 'default', 'even'])
    expect(headerKindFor({ ...headers, differentFirst: false, differentOddEven: false }, 1)).toBe('default')
    expect(pagePart(headers, 'header', 2)?.[0].content?.[0].text).toBe('Even')
    expect(pagePart(headers, 'footer', 2)).toBeNull()
    expect(pagePart(null, 'header', 1)).toBeNull()
  })

  it('numbers notes by kind in the order of their references', () => {
    const note = (kind: string, text: string) => ({ type: 'note', attrs: { kind, content: [paragraphNode([textNode(text)])] } })
    const doc: DocJSON = { type: 'doc', content: [paragraphNode([textNode('A'), note('footnote', 'one'), note('endnote', 'e1'), note('footnote', 'two'), note('endnote', 'e2')])] }

    expect(notesOf(doc).map((item) => `${item.kind} ${noteLabel(item.kind, item.number)}`)).toEqual(['footnote 1', 'endnote i', 'footnote 2', 'endnote ii'])
    expect(noteLabel('endnote', 14)).toBe('xiv')
  })

  it('lists the headings a table of contents shows', () => {
    const heading = (level: number, text: string) => ({ type: 'heading', attrs: { level }, content: text ? [textNode(text)] : [] })
    const doc: DocJSON = { type: 'doc', content: [{ type: 'tableOfContents', attrs: { levels: 2 } }, heading(1, 'Intro'), heading(3, 'Deep'), heading(2, ''), heading(2, 'Method  one')] }

    expect(tocEntries(doc, 2)).toEqual([
      { level: 1, text: 'Intro', heading: 0 },
      { level: 2, text: 'Method one', heading: 3 }
    ])
  })

  it('gives each section its page', () => {
    const landscape = { width: 842, height: 595, margins: { top: 36, right: 36, bottom: 36, left: 36 } }
    const doc: DocJSON = {
      type: 'doc',
      attrs: { page: { width: 595, height: 842, margins: { top: 72, right: 72, bottom: 72, left: 72 } } },
      content: [paragraphNode(), { type: 'sectionBreak', attrs: { kind: 'nextPage', page: landscape } }, paragraphNode(), { type: 'sectionBreak', attrs: { kind: 'continuous', page: null } }, paragraphNode()]
    }

    expect(sectionsOf(doc).map((section) => [section.start, section.page.width])).toEqual([
      [0, 595],
      [2, 842],
      [4, 842]
    ])
  })
})
