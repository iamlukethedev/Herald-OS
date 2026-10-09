import { Mark, mergeAttributes, Node } from '@tiptap/core'
import type { SectionKind } from '../../../../shared/office/document.ts'
import { fieldText } from '../../../../shared/office/fields.ts'

/*
 * The nodes and the mark that go beyond plain text: fields (page number, page count, date and time,
 * and Word fields kept as their last result), footnote and endnote references that hold their
 * notes, tables of contents, section breaks with the next section's page, text boxes, and comments
 * on text. Each keeps its attrs in the HTML it renders, so copying and pasting in a document keeps
 * them. Note numbers and a table's entries depend on the whole document, so the page view shows them.
 */

const SECTION_KINDS: readonly SectionKind[] = ['nextPage', 'continuous', 'evenPage', 'oddPage']

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function parsedJson(element: HTMLElement, name: string, fallback: unknown): unknown {
  const raw = element.getAttribute(`data-${name}`)

  try {
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

/** An attr of any JSON value, kept in a data attribute. */
const jsonAttribute = (name: string, fallback: unknown) => ({
  default: fallback,
  parseHTML: (element: HTMLElement) => parsedJson(element, name, fallback),
  renderHTML: (attrs: Record<string, unknown>) => (attrs[name] === null || attrs[name] === undefined ? {} : { [`data-${name}`]: JSON.stringify(attrs[name]) })
})

/** An attr of text, kept in a data attribute. */
const textAttribute = (name: string, fallback: string | null = null) => ({
  default: fallback,
  parseHTML: (element: HTMLElement) => element.getAttribute(`data-${name}`) ?? fallback,
  renderHTML: (attrs: Record<string, unknown>) => (typeof attrs[name] === 'string' ? { [`data-${name}`]: attrs[name] } : {})
})

/** An attr of points, kept in a data attribute. */
const pointsAttribute = (name: string) => ({
  default: null,
  parseHTML: (element: HTMLElement) => finite(Number(element.getAttribute(`data-${name}`) ?? Number.NaN)),
  renderHTML: (attrs: Record<string, unknown>) => (finite(attrs[name]) === null ? {} : { [`data-${name}`]: String(attrs[name]) })
})

export const Field = Node.create({
  name: 'field',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      kind: { default: 'page', parseHTML: (element) => element.dataset.field || 'other', renderHTML: (attrs) => ({ 'data-field': attrs.kind }) },
      format: textAttribute('format'),
      instruction: textAttribute('instruction'),
      text: textAttribute('text')
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-field]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'doc-field' }, HTMLAttributes), fieldText(node.attrs)]
  },
  renderText({ node }) {
    return fieldText(node.attrs)
  }
})

export const Note = Node.create({
  name: 'note',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      kind: { default: 'footnote', parseHTML: (element) => (element.dataset.note === 'endnote' ? 'endnote' : 'footnote'), renderHTML: (attrs) => ({ 'data-note': attrs.kind }) },
      content: jsonAttribute('content', [{ type: 'paragraph' }])
    }
  },
  parseHTML() {
    return [{ tag: 'sup[data-note]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['sup', mergeAttributes({ class: 'doc-note-ref' }, HTMLAttributes)]
  },
  renderText() {
    return ''
  }
})

export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      levels: {
        default: 3,
        parseHTML: (element) => Math.min(6, Math.max(1, Math.round(Number(element.dataset.toc)) || 3)),
        renderHTML: (attrs) => ({ 'data-toc': String(attrs.levels) })
      },
      title: textAttribute('title', 'Contents'),
      pages: { default: null, rendered: false }
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-toc]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ class: 'doc-toc' }, HTMLAttributes)]
  }
})

export const SectionBreak = Node.create({
  name: 'sectionBreak',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      kind: {
        default: 'nextPage',
        parseHTML: (element) => (SECTION_KINDS.includes(element.dataset.sectionBreak as SectionKind) ? element.dataset.sectionBreak : 'nextPage'),
        renderHTML: (attrs) => ({ 'data-section-break': attrs.kind })
      },
      page: jsonAttribute('page', null)
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-section-break]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ class: 'doc-section-break' }, HTMLAttributes)]
  }
})

export const TextBox = Node.create({
  name: 'textBox',
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      width: pointsAttribute('width'),
      height: pointsAttribute('height'),
      align: textAttribute('align'),
      border: textAttribute('border'),
      fill: textAttribute('fill')
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-text-box]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    const { width, height, border, fill } = node.attrs
    const style = [
      finite(width) !== null && `width: ${width}pt`,
      finite(height) !== null && `min-height: ${height}pt`,
      typeof border === 'string' && `border: 0.75pt solid ${border}`,
      typeof fill === 'string' && `background: ${fill}`
    ]
      .filter(Boolean)
      .join('; ')

    return ['div', mergeAttributes({ class: 'doc-text-box', 'data-text-box': '' }, HTMLAttributes, style ? { style } : {}), 0]
  }
})

/** A comment on text: any number can overlap, and typing at the end of one does not extend it. */
export const CommentMark = Mark.create({
  name: 'comment',
  excludes: '',
  inclusive: false,
  spanning: true,
  addAttributes() {
    return { id: { default: null, parseHTML: (element) => element.dataset.comment ?? null, renderHTML: (attrs) => ({ 'data-comment': attrs.id }) } }
  },
  parseHTML() {
    return [{ tag: 'span[data-comment]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'doc-comment' }, HTMLAttributes), 0]
  }
})
