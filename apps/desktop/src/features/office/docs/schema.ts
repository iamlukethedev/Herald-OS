import { type AnyExtension, Extension, getSchema, mergeAttributes, Node, type NodeViewRenderer } from '@tiptap/core'
import Code from '@tiptap/extension-code'
import HardBreak from '@tiptap/extension-hard-break'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import Strike from '@tiptap/extension-strike'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import { Table, TableCell, TableHeader, type TableOptions, TableRow } from '@tiptap/extension-table'
import TextAlign from '@tiptap/extension-text-align'
import { Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import type { Schema } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import { CALLOUT_KINDS, type CalloutKind, cssLineHeight, hexColor, points, round, SINGLE_LINE } from '../../../../shared/office/document.ts'
import { CommentMark, Field, Note, SectionBreak, TableOfContents, TextBox } from './nodes.ts'

/*
 * Herald Docs' document schema: TipTap's own nodes and marks, with a document that keeps its page
 * and styles, paragraphs with spacing, indents and a Title or Subtitle style, callouts, page
 * breaks, tables with borders on or off and shaded cells, pictures in the line of text, and the
 * fields, notes, tables of contents, section breaks, text boxes and comments of nodes.ts. The
 * editor and the headless model build their schema from this one list. Shortcuts follow Word:
 * Strike, Code and line breaks move off the keys Word uses for other things.
 */

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const cssPoints = (value: string): number | null => {
  const amount = value ? points(value) : null

  return amount === null ? null : round(amount)
}

/** Line spacing as a multiple of single spacing, from a unitless CSS line height. */
const lineHeightOf = (value: string): number | null => {
  const amount = Number(value)

  return value && Number.isFinite(amount) && amount > 0 ? round(amount / SINGLE_LINE, 3) : null
}

const pointsAttribute = (name: string, css: 'margin-top' | 'margin-bottom' | 'margin-left' | 'text-indent') => ({
  default: null,
  parseHTML: (element: HTMLElement) => cssPoints(element.style.getPropertyValue(css)),
  renderHTML: (attrs: Record<string, unknown>) => {
    const value = finite(attrs[name])

    return value === null ? {} : { style: `${css}: ${value}pt` }
  }
})

/** Spacing, line height and indents of paragraphs and headings, in points. */
const ParagraphLayout = Extension.create({
  name: 'paragraphLayout',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (element) => lineHeightOf(element.style.lineHeight),
            renderHTML: (attrs) => {
              const multiple = finite(attrs.lineHeight)

              return multiple ? { style: `line-height: ${cssLineHeight(multiple)}` } : {}
            }
          },
          spaceBefore: pointsAttribute('spaceBefore', 'margin-top'),
          spaceAfter: pointsAttribute('spaceAfter', 'margin-bottom'),
          indent: pointsAttribute('indent', 'margin-left'),
          firstLine: pointsAttribute('firstLine', 'text-indent')
        }
      },
      {
        types: ['paragraph'],
        attributes: {
          docStyle: {
            default: null,
            parseHTML: (element) => (['title', 'subtitle'].includes(element.dataset.style ?? '') ? element.dataset.style : null),
            renderHTML: (attrs) => (attrs.docStyle ? { 'data-style': attrs.docStyle } : {})
          }
        }
      }
    ]
  }
})

/** The document, with its page size and margins, its styles' looks, headers and footers, comments, and what it keeps of a Word file. */
const DocsDocument = Node.create({
  name: 'doc',
  topNode: true,
  content: 'block+',
  addAttributes() {
    return {
      page: { default: null, rendered: false },
      styles: { default: null, rendered: false },
      headers: { default: null, rendered: false },
      comments: { default: null, rendered: false },
      kept: { default: null, rendered: false }
    }
  }
})

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      kind: {
        default: 'info' satisfies CalloutKind,
        parseHTML: (element) => (CALLOUT_KINDS.includes(element.dataset.callout as CalloutKind) ? element.dataset.callout : 'info'),
        renderHTML: (attrs) => ({ 'data-callout': attrs.kind })
      }
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-callout]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ class: 'doc-callout' }, HTMLAttributes), 0]
  }
})

export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML() {
    return [{ tag: 'div[data-page-break]' }]
  },
  renderHTML() {
    return ['div', { 'data-page-break': '', class: 'doc-page-break' }]
  }
})

const DocsTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      borders: {
        default: true,
        parseHTML: (element) => element.dataset.borders !== 'none',
        renderHTML: (attrs) => (attrs.borders === false ? { 'data-borders': 'none' } : {})
      }
    }
  }
})

const cellBackground = {
  background: {
    default: null,
    parseHTML: (element: HTMLElement) => hexColor(element.dataset.background ?? element.style.backgroundColor),
    renderHTML: (attrs: Record<string, unknown>) => (attrs.background ? { 'data-background': attrs.background, style: `background-color: ${attrs.background}` } : {})
  }
}

const DocsTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellBackground }
  }
})

const DocsTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellBackground }
  }
})

const pixels = (value: string | null): number | null => {
  const amount = value ? Number.parseFloat(value) : Number.NaN

  return Number.isFinite(amount) && amount > 0 ? amount : null
}

/** Pictures in the line of text, sized in CSS pixels (96 an inch), as a paragraph's alignment places them. */
const DocsImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: { default: null, parseHTML: (element) => pixels(element.getAttribute('width') ?? element.style.width), renderHTML: (attrs) => (finite(attrs.width) ? { width: Math.round(attrs.width) } : {}) },
      height: { default: null, parseHTML: (element) => pixels(element.getAttribute('height') ?? element.style.height), renderHTML: (attrs) => (finite(attrs.height) ? { height: Math.round(attrs.height) } : {}) }
    }
  }
})

const WordStrike = Strike.extend({
  addKeyboardShortcuts() {
    return { 'Mod-Shift-x': () => this.editor.commands.toggleStrike() }
  }
})

/** Code takes no other formatting, but a link can hold it, as in Markdown. */
const WordCode = Code.extend({
  excludes: 'bold italic underline strike subscript superscript textStyle highlight',
  addKeyboardShortcuts() {
    return { 'Mod-Shift-m': () => this.editor.commands.toggleCode() }
  }
})

const WordHardBreak = HardBreak.extend({
  addKeyboardShortcuts() {
    return { 'Shift-Enter': () => this.editor.commands.setHardBreak() }
  }
})

const WordTextAlign = TextAlign.extend({
  addKeyboardShortcuts() {
    return {
      'Mod-l': () => this.editor.commands.setTextAlign('left'),
      'Mod-e': () => this.editor.commands.setTextAlign('center'),
      'Mod-r': () => this.editor.commands.setTextAlign('right'),
      'Mod-j': () => this.editor.commands.setTextAlign('justify')
    }
  }
}).configure({ types: ['heading', 'paragraph'] })

const QuietHighlight = Highlight.extend({
  addKeyboardShortcuts() {
    return {}
  }
}).configure({ multicolor: true })

export interface SchemaOptions {
  /** Undo and redo (the editor wants them; a document changed without a window does not). */
  history?: boolean
  /** The editor's own drawing of pictures (resize handles) and tables (borders on or off). */
  views?: { image?: NodeViewRenderer; table?: TableOptions['View'] }
}

/** The extensions that make up a Herald Docs document. */
export function docsExtensions(options: SchemaOptions = {}): AnyExtension[] {
  const { image, table } = options.views ?? {}

  return [
    StarterKit.configure({
      document: false,
      strike: false,
      code: false,
      hardBreak: false,
      // A document is not changed by being clicked in: the gap cursor reaches the end instead.
      trailingNode: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https' },
      undoRedo: options.history === false ? false : { depth: 200 },
      dropcursor: { color: 'var(--color-accent)', width: 2 }
    }),
    DocsDocument,
    WordStrike,
    WordCode,
    WordHardBreak,
    ParagraphLayout,
    WordTextAlign,
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    QuietHighlight,
    Subscript,
    Superscript,
    TaskList,
    TaskItem.configure({ nested: true }),
    DocsTable.configure({ resizable: true, cellMinWidth: 36, lastColumnResizable: true, ...(table ? { View: table } : {}) }),
    TableRow,
    DocsTableHeader,
    DocsTableCell,
    (image ? DocsImage.extend({ addNodeView: () => image }) : DocsImage).configure({ inline: true, allowBase64: true }),
    Callout,
    PageBreak,
    Field,
    Note,
    TableOfContents,
    SectionBreak,
    TextBox,
    CommentMark
  ]
}

let cached: Schema | null = null

/** The schema of a Herald Docs document, for working on one without an editor. */
export function docsSchema(): Schema {
  cached ??= getSchema(docsExtensions({ history: false }))

  return cached
}
