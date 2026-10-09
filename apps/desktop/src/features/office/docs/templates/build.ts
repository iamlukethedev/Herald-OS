import { type CalloutKind, DEFAULT_HEADER_DISTANCE, type DocJSON, type DocMark, type DocNode, type FieldKind, type PageHeaders, type PageMargins, type PageSettings, paragraphNode, type StyleLooks, textNode } from '../../../../../shared/office/document.ts'

/*
 * What the built-in templates are made of: blocks and runs as the document keeps them (TipTap's
 * JSON), so a template is plain data that the editor, the converters and Hermes all take as it is.
 */

/** What a template is built for: the paper, the date order and the size of a card. */
export interface TemplateContext {
  /** The paper's size in points, portrait. */
  paper: { width: number; height: number }
  /** A small page for notes and cards: A5, or half of a Letter sheet where people use Letter. */
  card: { width: number; height: number }
  /** Word's picture for a long date in the locale's order: `d MMMM yyyy`, or `MMMM d, yyyy` in the US. */
  dateFormat: string
}

/** Text, or an inline node (a field, a line break, a run with formatting). */
export type Inline = string | DocNode

/** Paragraph and heading attrs a template sets: spacing and indents in points, line spacing as a multiple. */
export interface BlockAttrs {
  textAlign?: 'center' | 'right' | 'justify'
  lineHeight?: number
  spaceBefore?: number
  spaceAfter?: number
  indent?: number
  firstLine?: number
}

/** How a run of text looks: sizes in points. */
export interface RunLook {
  bold?: boolean
  italic?: boolean
  color?: string
  size?: number
}

const runs = (content: Inline | Inline[]): DocNode[] => (Array.isArray(content) ? content : [content]).filter((part) => part !== '').map((part) => (typeof part === 'string' ? textNode(part) : part))

function marksOf(look: RunLook): DocMark[] {
  const marks: DocMark[] = []

  if (look.bold) {
    marks.push({ type: 'bold' })
  }

  if (look.italic) {
    marks.push({ type: 'italic' })
  }

  if (look.color || look.size) {
    marks.push({ type: 'textStyle', attrs: { ...(look.color ? { color: look.color } : {}), ...(look.size ? { fontSize: `${look.size}pt` } : {}) } })
  }

  return marks
}

export const run = (text: string, look: RunLook): DocNode => textNode(text, marksOf(look))

export const bold = (text: string): DocNode => run(text, { bold: true })

export const italic = (text: string): DocNode => run(text, { italic: true })

/** A field (page number, page count, date), formatted like the text around it. */
export function field(kind: FieldKind, format: string | null = null, look: RunLook = {}): DocNode {
  const node: DocNode = { type: 'field', attrs: { kind, format, instruction: null, text: null } }
  const marks = marksOf(look)

  return marks.length ? { ...node, marks } : node
}

export const lineBreak = (): DocNode => ({ type: 'hardBreak' })

/** Lines of one paragraph, with line breaks between them (an address, a signature). */
export const lines = (...parts: (Inline | Inline[])[]): DocNode[] => parts.flatMap((part, index) => (index ? [lineBreak(), ...runs(part)] : runs(part)))

export const para = (content: Inline | Inline[] = [], attrs: BlockAttrs = {}): DocNode => paragraphNode(runs(content), { ...attrs })

export const title = (content: Inline | Inline[], attrs: BlockAttrs = {}): DocNode => paragraphNode(runs(content), { docStyle: 'title', ...attrs })

export const subtitle = (content: Inline | Inline[], attrs: BlockAttrs = {}): DocNode => paragraphNode(runs(content), { docStyle: 'subtitle', ...attrs })

export const heading = (level: 1 | 2 | 3, content: Inline | Inline[], attrs: BlockAttrs = {}): DocNode => ({ type: 'heading', attrs: { level, ...attrs }, content: runs(content) })

const items = (type: string, entries: (Inline | Inline[])[]): DocNode[] => entries.map((entry) => (type === 'taskItem' ? { type, attrs: { checked: false }, content: [para(entry)] } : { type, content: [para(entry)] }))

export const bullets = (entries: (Inline | Inline[])[]): DocNode => ({ type: 'bulletList', content: items('listItem', entries) })

export const numbered = (entries: (Inline | Inline[])[]): DocNode => ({ type: 'orderedList', content: items('listItem', entries) })

/** A checklist, nothing ticked yet. */
export const checklist = (entries: (Inline | Inline[])[]): DocNode => ({ type: 'taskList', content: items('taskItem', entries) })

export const rule = (): DocNode => ({ type: 'horizontalRule' })

export const pageBreak = (): DocNode => ({ type: 'pageBreak' })

export const callout = (kind: CalloutKind, blocks: DocNode[]): DocNode => ({ type: 'callout', attrs: { kind }, content: blocks })

export const quote = (blocks: DocNode[]): DocNode => ({ type: 'blockquote', content: blocks })

export const contents = (levels = 3, label = 'Contents'): DocNode => ({ type: 'tableOfContents', attrs: { levels, title: label, pages: null } })

/** A table cell of blocks, across `span` columns, with a fill colour. */
export interface CellSpec {
  blocks: DocNode[]
  span?: number
  fill?: string
}

export const cell = (blocks: DocNode[], options: Omit<CellSpec, 'blocks'> = {}): CellSpec => ({ blocks, ...options })

export interface TableOptions {
  /** Each column's share of the width: [3, 1, 1] makes the first three times the others. */
  columns: number[]
  /** The width the table fills, in points: usually the page's text width. */
  width: number
  /** The first row is a header row. */
  header?: boolean
  borders?: boolean
  /** The fill of the header row's cells. */
  headerFill?: string
  /** Each column's alignment. */
  align?: (BlockAttrs['textAlign'] | null)[]
}

const isCell = (value: Inline | Inline[] | CellSpec): value is CellSpec => typeof value === 'object' && !Array.isArray(value) && 'blocks' in value

/** A table with columns shared out over `width`, in CSS pixels as the editor sizes them. */
export function table(rows: (Inline | Inline[] | CellSpec)[][], options: TableOptions): DocNode {
  const total = options.columns.reduce((sum, share) => sum + share, 0)
  const widths = options.columns.map((share) => Math.floor((options.width * share * 96) / 72 / total))

  return {
    type: 'table',
    ...(options.borders === false ? { attrs: { borders: false } } : {}),
    content: rows.map((row, index) => {
      const header = Boolean(options.header) && index === 0
      let column = 0

      return {
        type: 'tableRow',
        content: row.map((entry) => {
          const spec = isCell(entry) ? entry : null
          const span = spec?.span ?? 1
          const align = options.align?.[column]
          const blocks = spec ? spec.blocks : [para(entry as Inline | Inline[], align ? { textAlign: align } : {})]
          const fill = spec?.fill ?? (header ? options.headerFill : undefined)
          const attrs = { colspan: span, rowspan: 1, colwidth: widths.slice(column, column + span), ...(fill ? { background: fill } : {}) }
          column += span

          return { type: header ? 'tableHeader' : 'tableCell', attrs, content: blocks }
        })
      }
    })
  }
}

/** A page of `size` with these margins in points; headers and footers sit `edge` from the paper's edge. */
export function paper(size: { width: number; height: number }, margins: number | PageMargins, edge = DEFAULT_HEADER_DISTANCE): PageSettings {
  const sides = typeof margins === 'number' ? { top: margins, right: margins, bottom: margins, left: margins } : margins

  return { width: size.width, height: size.height, margins: { ...sides, header: edge, footer: edge } }
}

/** The width a page gives its text, in points. */
export const textWidth = (page: PageSettings): number => page.width - page.margins.left - page.margins.right

export function templateDocument(page: PageSettings, styles: StyleLooks, content: DocNode[], headers: PageHeaders | null = null): DocJSON {
  return { type: 'doc', attrs: { page, styles, headers }, content }
}
