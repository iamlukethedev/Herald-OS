import { InternalHyperlink, LeaderType, type IParagraphStyleOptions, Paragraph, TabStopType, TextRun } from 'docx'
import type { DocNode, TocAttrs, TocEntry } from '../document.ts'
import { alternative } from './drawing.ts'
import { Element, fieldEnd, fieldRuns, fieldStart, textRun } from './elements.ts'
import { hasSwitch, keywordOf, switchOf } from './field-codes.ts'
import { attr, child, children, textOf, type XmlElement } from './xml.ts'

/*
 * Tables of contents in Word files. Word writes one as a TOC field whose result is an entry per
 * heading, each linked to a bookmark on its heading and ending with its page number, usually in a
 * content control (a building block) with a "TOC Heading" title. Herald reads the field as one
 * table of contents: the heading levels it lists, its title, and the page each entry was on; the
 * entries themselves are worked out from the headings. A table of figures (captions) is not one.
 */

/** Where a comment's text starts or ends. */
export interface CommentMark {
  start: boolean
  id: string
}

type Token = { kind: 'begin' } | { kind: 'separate' } | { kind: 'end' } | { kind: 'instruction'; text: string } | { kind: 'text'; text: string } | ({ kind: 'comment' } & CommentMark)

const CONTAINERS = new Set(['w:hyperlink', 'w:smartTag', 'w:customXml', 'w:ins', 'w:moveTo', 'w:dir', 'w:bdo'])

/** Markers between paragraphs, which a table of contents can have among its own. */
const RANGE_MARKS = new Set(['w:bookmarkStart', 'w:bookmarkEnd', 'w:commentRangeStart', 'w:commentRangeEnd', 'w:proofErr', 'w:permStart', 'w:permEnd'])

const commentMark = (element: XmlElement): CommentMark => ({ start: element.name === 'w:commentRangeStart', id: attr(element, 'w:id') ?? '' })

/** A paragraph's field characters, field instructions, text and comment markers, in order. */
function tokensOf(element: XmlElement | undefined, out: Token[] = []): Token[] {
  for (const node of children(element)) {
    if (node.name === 'w:r') {
      for (const item of children(node)) {
        const type = attr(item, 'w:fldCharType')

        if (item.name === 'w:fldChar' && (type === 'begin' || type === 'separate' || type === 'end')) {
          out.push({ kind: type })
        } else if (item.name === 'w:instrText') {
          out.push({ kind: 'instruction', text: textOf(item) })
        } else if (item.name === 'w:t') {
          out.push({ kind: 'text', text: textOf(item) })
        } else if (item.name === 'w:tab' || item.name === 'w:ptab') {
          out.push({ kind: 'text', text: '\t' })
        }
      }
    } else if (node.name === 'w:fldSimple') {
      out.push({ kind: 'begin' }, { kind: 'instruction', text: attr(node, 'w:instr') ?? '' }, { kind: 'separate' })
      tokensOf(node, out)
      out.push({ kind: 'end' })
    } else if (node.name === 'w:sdt') {
      tokensOf(child(node, 'w:sdtContent'), out)
    } else if (node.name === 'mc:AlternateContent') {
      tokensOf(alternative(node), out)
    } else if (node.name === 'w:commentRangeStart' || node.name === 'w:commentRangeEnd') {
      out.push({ kind: 'comment', ...commentMark(node) })
    } else if (CONTAINERS.has(node.name)) {
      tokensOf(node, out)
    }
  }

  return out
}

/** The comment markers in a paragraph, in order. */
export const commentMarks = (paragraph: XmlElement): CommentMark[] => tokensOf(paragraph).flatMap((token) => (token.kind === 'comment' ? [{ start: token.start, id: token.id }] : []))

/** Whether an instruction is a table of contents of headings, not of captions (a table of figures) or only of entries marked by hand. */
function isContents(instruction: string): boolean {
  const has = (name: string): boolean => hasSwitch(instruction, name)

  return keywordOf(instruction) === 'TOC' && !has('c') && !has('a') && (has('o') || has('t') || has('u') || !(has('f') || has('l')))
}

export interface TocField {
  /** The index of the last element the field takes. */
  end: number
  attrs: TocAttrs
  /** Whether it has options Herald does not keep, such as entries from other styles. */
  approximate: boolean
  /** The comment markers in the elements it takes, in order. */
  comments: CommentMark[]
}

/** The levels a TOC field lists: up to the last of `\o "1-3"`, or 3. */
function levelsOf(instruction: string): number {
  const range = /(\d+)\s*(?:-\s*(\d+))?/.exec(switchOf(instruction, 'o') ?? '')
  const levels = range ? Number(range[2] ?? range[1]) : 3

  return Math.min(6, Math.max(1, levels || 3))
}

/** An entry's page number: what follows its last tab, when that is a number. */
function pageOf(entry: string): number | null {
  const tab = entry.lastIndexOf('\t')
  const match = tab < 0 ? null : /^\s*(\d+)\s*$/.exec(entry.slice(tab + 1))

  return match ? Number(match[1]) : null
}

/**
 * A table of contents field that begins in element `from` of `elements` (with nothing before it
 * in its paragraph), read to its end; null when there is none, or it never ends, or text follows it.
 */
export function tocField(elements: readonly XmlElement[], from: number): TocField | null {
  if (elements[from]?.name !== 'w:p') {
    return null
  }

  const stack: { instruction: string; result: boolean }[] = []
  const entries: string[] = []
  const comments: CommentMark[] = []
  let instruction: string | null = null

  for (let index = from; index < elements.length; index++) {
    const element = elements[index]

    if (element.name !== 'w:p') {
      if (instruction === null || !RANGE_MARKS.has(element.name)) {
        return null
      }

      if (element.name === 'w:commentRangeStart' || element.name === 'w:commentRangeEnd') {
        comments.push(commentMark(element))
      }

      continue
    }

    let entry = ''
    let ended = false

    for (const token of tokensOf(element)) {
      const top = stack[stack.length - 1]

      if (token.kind === 'comment') {
        comments.push({ start: token.start, id: token.id })
      } else if (ended) {
        if (token.kind !== 'text' || token.text.trim()) {
          return null
        }
      } else if (token.kind === 'begin') {
        stack.push({ instruction: '', result: false })
      } else if (token.kind === 'instruction') {
        if (top && !top.result) {
          top.instruction += token.text
        }
      } else if (token.kind === 'separate') {
        if (top) {
          top.result = true
        }

        if (instruction === null && stack.length === 1 && top) {
          if (!isContents(top.instruction)) {
            return null
          }

          instruction = top.instruction
        }
      } else if (token.kind === 'end') {
        const field = stack.pop()

        if (instruction === null && !stack.length && field && isContents(field.instruction)) {
          instruction = field.instruction
        }

        ended = instruction !== null && !stack.length
      } else if (instruction === null && !stack.length) {
        if (token.text.trim()) {
          return null
        }
      } else if (stack.every((field) => field.result)) {
        entry += token.text
      }
    }

    if (instruction === null) {
      return null
    }

    if (entry.trim()) {
      entries.push(entry)
    }

    if (ended) {
      const pages = entries.map(pageOf)
      const approximate = ['t', 'b', 'n', 'l'].some((name) => hasSwitch(instruction as string, name))

      return { end: index, attrs: { levels: levelsOf(instruction), title: null, pages: pages.some((page) => page !== null) ? pages : null }, approximate, comments }
    }
  }

  return null
}

const TITLE_STYLE = /^(toc|contents) heading$/i

/** A paragraph's text, without field instructions. */
export const paragraphText = (paragraph: XmlElement): string =>
  tokensOf(paragraph)
    .map((token) => (token.kind === 'text' ? token.text : ''))
    .join('')
    .trim()

/** Whether a paragraph is a table of contents' title, by the name of its style. */
export const isTitle = (styleName: string): boolean => TITLE_STYLE.test(styleName.trim())

// Writing.

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
