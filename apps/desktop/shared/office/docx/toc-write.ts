import { InternalHyperlink, LeaderType, type IParagraphStyleOptions, Paragraph, TabStopType, TextRun } from 'docx'
import type { DocNode, TocEntry } from '../document.ts'
import { Element, fieldEnd, fieldRuns, fieldStart, textRun } from './elements.ts'

/*
 * Tables of contents written into Word files, apart from toc.ts's reading so that opening a Word
 * file does not load the docx package.
 */

/** The paragraph styles of tables of contents: an entry style for each level, indented, with a tab at the end of the text for the page number, and the title's. */
export function tocStyles(textWidth: number): IParagraphStyleOptions[] {
  const entries = [1, 2, 3, 4, 5, 6].map(
    (level): IParagraphStyleOptions => ({
      id: `TOC${level}`,
      name: `toc ${level}`,
      basedOn: 'Normal',
      next: 'Normal',
      paragraph: { indent: level > 1 ? { left: (level - 1) * 220 } : undefined, spacing: { after: 100 }, rightTabStop: textWidth }
    })
  )

  return [...entries, { id: 'TOCHeading', name: 'TOC Heading', basedOn: 'Heading1', next: 'Normal', paragraph: { outlineLevel: 9 } }]
}

/**
 * A table of contents as Word writes one: its title, then the TOC field with an entry per heading,
 * each linked to the bookmark on its heading and with a dotted tab to its page number. The page
 * numbers are written when there is one for each entry; otherwise the field is left for Word to
 * update when it opens the file.
 */
export function tocParagraphs(node: DocNode, entries: readonly TocEntry[], bookmarks: ReadonlyMap<number, string>, textWidth: number): Paragraph[] {
  const levels = Math.min(6, Math.max(1, Math.round(Number(node.attrs?.levels ?? 3)) || 3))
  const title = typeof node.attrs?.title === 'string' && node.attrs.title.trim() ? node.attrs.title.trim() : null
  const given = node.attrs?.pages
  const pages = Array.isArray(given) && given.length === entries.length ? (given as unknown[]) : null
  const pageAt = (index: number): number | null => (pages && typeof pages[index] === 'number' && Number.isFinite(pages[index]) ? (pages[index] as number) : null)
  const whole = pages !== null && entries.every((_, index) => pageAt(index) !== null)
  const start = fieldStart(`TOC \\o "1-${levels}" \\h \\z \\u`, {}, !whole)
  const out = title ? [new Paragraph({ style: 'TOCHeading', children: [textRun(title)] })] : []

  if (!entries.length) {
    return [...out, new Paragraph({ children: [...start, fieldEnd()] })]
  }

  entries.forEach((entry, index) => {
    const bookmark = bookmarks.get(entry.heading)
    const page = bookmark === undefined ? null : pageAt(index)
    const children = [textRun(entry.text), ...(page === null ? [] : [new TextRun({ children: [new Element('w:tab')] }), ...fieldRuns(`PAGEREF ${bookmark} \\h`, String(page))])]
    out.push(
      new Paragraph({
        style: `TOC${entry.level}`,
        tabStops: [{ type: TabStopType.RIGHT, position: textWidth, leader: LeaderType.DOT }],
        children: [...(index ? [] : start), ...(bookmark === undefined ? children : [new InternalHyperlink({ anchor: bookmark, children })])]
      })
    )
  })
  out.push(new Paragraph({ children: [fieldEnd()] }))

  return out
}

/** The content control Word keeps a table of contents in, as a building block. */
export const tocControl = (paragraphs: readonly Paragraph[]): Element =>
  new Element('w:sdt', {}, [
    new Element('w:sdtPr', {}, [new Element('w:docPartObj', {}, [new Element('w:docPartGallery', { 'w:val': 'Table of Contents' }), new Element('w:docPartUnique')])]),
    new Element('w:sdtContent', {}, paragraphs)
  ])
