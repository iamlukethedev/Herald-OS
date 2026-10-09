/*
 * A Herald Docs document as plain data: the JSON of its TipTap (ProseMirror) document. The editor,
 * the converters (Word, Markdown, plain text, the print view) and Hermes's commands all read and
 * write this one shape. The document node carries the page (its size and margins, in points) and
 * the looks of its styles, the way a Word file keeps them in its section and its styles part.
 */

export type NodeName =
  | 'doc'
  | 'paragraph'
  | 'heading'
  | 'blockquote'
  | 'codeBlock'
  | 'bulletList'
  | 'orderedList'
  | 'listItem'
  | 'taskList'
  | 'taskItem'
  | 'table'
  | 'tableRow'
  | 'tableCell'
  | 'tableHeader'
  | 'horizontalRule'
  | 'pageBreak'
  | 'callout'
  | 'image'
  | 'hardBreak'
  | 'field'
  | 'note'
  | 'tableOfContents'
  | 'sectionBreak'
  | 'textBox'
  | 'text'

export type MarkName = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'subscript' | 'superscript' | 'link' | 'textStyle' | 'highlight' | 'comment'

export interface DocMark {
  type: MarkName | string
  attrs?: Record<string, unknown>
}

export interface DocNode {
  type: NodeName | string
  attrs?: Record<string, unknown>
  content?: DocNode[]
  marks?: DocMark[]
  text?: string
}

export interface PageMargins {
  top: number
  right: number
  bottom: number
  left: number
  /** From the top edge to the header and from the bottom edge to the footer; Word's 0.5 inch when missing. */
  header?: number
  footer?: number
}

/** A page in points (1/72 inch), as Word's section keeps it in twentieths of a point. */
export interface PageSettings {
  width: number
  height: number
  margins: PageMargins
}

export type StyleName = 'normal' | 'title' | 'subtitle' | 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'heading5' | 'heading6' | 'quote' | 'code'

export const STYLE_NAMES: readonly StyleName[] = ['normal', 'title', 'subtitle', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'quote', 'code']

/**
 * How text in one of the document's styles looks: sizes and spacing in points, and line spacing as
 * Word gives it, a multiple of single spacing (a paragraph's own `lineHeight` is the same).
 */
export interface StyleLook {
  font?: string
  size?: number
  color?: string
  bold?: boolean
  italic?: boolean
  spaceBefore?: number
  spaceAfter?: number
  lineHeight?: number
}

export type StyleLooks = Partial<Record<StyleName, StyleLook>>

export interface DocAttrs {
  page: PageSettings | null
  /** Looks that differ from Herald's own (a Word file's styles); null keeps Herald's. */
  styles: StyleLooks | null
  headers: PageHeaders | null
  /** Review comments; the text each one is on carries a `comment` mark with its id. */
  comments: CommentThread[] | null
  /** Parts of a Word file Herald keeps without showing them, to write back; only the Word converters read it. */
  kept: unknown
}

export interface DocJSON extends DocNode {
  type: 'doc'
  attrs?: Partial<DocAttrs>
  content: DocNode[]
}

/** Panels in the text: a coloured box with a kind, as in Confluence. */
export type CalloutKind = 'info' | 'note' | 'success' | 'warning' | 'error'

export const CALLOUT_KINDS: readonly CalloutKind[] = ['info', 'note', 'success', 'warning', 'error']

/** Paragraph styles beyond headings, kept as the paragraph's `docStyle`. */
export type ParagraphStyle = 'title' | 'subtitle'

export const PAGE_SIZES = {
  a4: { width: 595.3, height: 841.9, label: 'A4' },
  letter: { width: 612, height: 792, label: 'Letter' },
  legal: { width: 612, height: 1008, label: 'Legal' },
  a5: { width: 419.5, height: 595.3, label: 'A5' }
} as const

export type PageSizeName = keyof typeof PAGE_SIZES

export const DEFAULT_MARGIN = 72

export const DEFAULT_HEADER_DISTANCE = 36

/** The monospace face Herald gives code in Word documents. */
export const CODE_FONT = 'Consolas'

/** Single line spacing as a CSS line height: what Word's "single" and Google Docs' 1.0 look like on screen. */
export const SINGLE_LINE = 1.2

export const cssLineHeight = (multiple: number): number => round(multiple * SINGLE_LINE, 3)

/** Herald's own look for each style: what a new document has, and what a style missing from a file falls back on. */
export const HERALD_LOOKS: Readonly<Record<StyleName, StyleLook>> = {
  normal: { font: 'Arial', size: 11, lineHeight: 1.15, spaceBefore: 0, spaceAfter: 6 },
  title: { size: 26, spaceBefore: 0, spaceAfter: 3 },
  subtitle: { size: 15, color: '#666666', spaceBefore: 0, spaceAfter: 16 },
  heading1: { size: 20, bold: true, spaceBefore: 20, spaceAfter: 6 },
  heading2: { size: 16, bold: true, spaceBefore: 18, spaceAfter: 6 },
  heading3: { size: 14, bold: true, spaceBefore: 16, spaceAfter: 4 },
  heading4: { size: 12, bold: true, spaceBefore: 14, spaceAfter: 4 },
  heading5: { size: 11, bold: true, spaceBefore: 12, spaceAfter: 4 },
  heading6: { size: 11, bold: true, italic: true, spaceBefore: 12, spaceAfter: 4 },
  quote: { italic: true, color: '#555555' },
  code: { font: CODE_FONT, size: 10, lineHeight: 1, spaceBefore: 0, spaceAfter: 0 }
}

/** The page a new document gets: Letter where people use it, A4 elsewhere. */
export function defaultPage(locale = typeof navigator === 'undefined' ? 'en-GB' : navigator.language): PageSettings {
  const size = /^(en-US|en-CA|es-MX|es-US|fr-CA)$/i.test(locale) ? PAGE_SIZES.letter : PAGE_SIZES.a4

  return { width: size.width, height: size.height, margins: { top: DEFAULT_MARGIN, right: DEFAULT_MARGIN, bottom: DEFAULT_MARGIN, left: DEFAULT_MARGIN } }
}

/** The named size a page has (either way round), if it has one. */
export function pageSizeName(page: PageSettings): PageSizeName | null {
  const [short, long] = [Math.min(page.width, page.height), Math.max(page.width, page.height)]

  for (const [name, size] of Object.entries(PAGE_SIZES) as [PageSizeName, (typeof PAGE_SIZES)[PageSizeName]][]) {
    if (Math.abs(size.width - short) < 2 && Math.abs(size.height - long) < 2) {
      return name
    }
  }

  return null
}

export function blankDocument(page: PageSettings | null = defaultPage()): DocJSON {
  return { type: 'doc', attrs: { page, styles: null }, content: [{ type: 'paragraph' }] }
}

// Headers and footers, fields, notes, tables of contents, sections, text boxes and comments.

/** Which header or footer a page shows: the usual one, the first page's, or even pages'. */
export type HeaderKind = 'default' | 'first' | 'even'

export const HEADER_KINDS: readonly HeaderKind[] = ['default', 'first', 'even']

/** A document's headers and footers, each a list of blocks that can hold fields. */
export interface PageHeaders {
  header: Partial<Record<HeaderKind, DocNode[]>>
  footer: Partial<Record<HeaderKind, DocNode[]>>
  /** The first page has a header and footer of its own (Word's "different first page"). */
  differentFirst?: boolean
  /** Even pages have their own, and the usual ones are for odd pages. */
  differentOddEven?: boolean
}

export const headersOf = (doc: DocNode): PageHeaders | null => (doc.attrs?.headers as PageHeaders | null | undefined) ?? null

/** The kind of header and footer page `number` (from 1) shows. */
export function headerKindFor(headers: PageHeaders | null, number: number): HeaderKind {
  if (headers?.differentFirst && number === 1) {
    return 'first'
  }

  return headers?.differentOddEven && number % 2 === 0 ? 'even' : 'default'
}

/** The blocks of the header or footer page `number` shows, or null when it has none. */
export function pagePart(headers: PageHeaders | null, part: 'header' | 'footer', number: number): DocNode[] | null {
  const blocks = headers?.[part][headerKindFor(headers, number)]

  return blocks?.length ? blocks : null
}

/**
 * A field's attrs. Page, page count, date and time are worked out where they are shown; `other` is a
 * Word field Herald does not work out, kept with its instruction and shown as its last result.
 */
export type FieldKind = 'page' | 'pages' | 'date' | 'time' | 'other'

export interface FieldAttrs {
  kind: FieldKind
  /** A date or time picture in Word's terms (`d MMMM yyyy`, `HH:mm`); null for the locale's own. */
  format: string | null
  /** Word's field instruction, for `other`. */
  instruction: string | null
  /** The last result shown. */
  text: string | null
}

export type NoteKind = 'footnote' | 'endnote'

/** A note's attrs: the reference in the text holds the note's blocks. */
export interface NoteAttrs {
  kind: NoteKind
  content: DocNode[]
}

/** The notes of a document in the order their references come, numbered by kind from 1. */
export function notesOf(doc: DocNode): { kind: NoteKind; number: number; content: DocNode[] }[] {
  const out: { kind: NoteKind; number: number; content: DocNode[] }[] = []
  const counts: Record<NoteKind, number> = { footnote: 0, endnote: 0 }

  walk(doc, (node) => {
    if (node.type === 'note') {
      const kind: NoteKind = node.attrs?.kind === 'endnote' ? 'endnote' : 'footnote'
      out.push({ kind, number: ++counts[kind], content: (node.attrs?.content as DocNode[] | undefined) ?? [] })
    }
  })

  return out
}

const ROMAN: [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i']
]

/** How a note's number is shown: footnotes 1, 2, 3 and endnotes i, ii, iii, as Word numbers them. */
export function noteLabel(kind: NoteKind, number: number): string {
  if (kind === 'footnote') {
    return String(number)
  }

  let rest = number
  let out = ''

  for (const [value, letters] of ROMAN) {
    while (rest >= value) {
      out += letters
      rest -= value
    }
  }

  return out
}

/** A table of contents' attrs: the heading levels it lists, its title, and the page each entry was last on. */
export interface TocAttrs {
  levels: number
  title: string | null
  pages: (number | null)[] | null
}

export interface TocEntry {
  level: number
  text: string
  /** Which heading of the document it is, counting every heading from 0. */
  heading: number
}

/** The entries a table of contents listing `levels` levels has: the document's headings down to that level. */
export function tocEntries(doc: DocNode, levels: number): TocEntry[] {
  const out: TocEntry[] = []
  let heading = 0

  walk(doc, (node) => {
    if (node.type === 'heading') {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)))
      const text = textOf(node).replace(/\s+/g, ' ').trim()

      if (level <= levels && text) {
        out.push({ level, text, heading })
      }

      heading++

      return false
    }

    return node.type === 'note' || node.type === 'tableOfContents' ? false : undefined
  })

  return out
}

/** How a section starts: on a new page, on the same page, or on the next even or odd page. */
export type SectionKind = 'nextPage' | 'continuous' | 'evenPage' | 'oddPage'

/** A section break's attrs: how the section after it starts, and its page (null keeps the page before it). */
export interface SectionBreakAttrs {
  kind: SectionKind
  page: PageSettings | null
}

/** Each section's page and the index of the top-level block it starts at; the document's page is the first section's. */
export function sectionsOf(doc: DocJSON): { page: PageSettings; start: number }[] {
  const out = [{ page: pageOf(doc), start: 0 }]

  doc.content.forEach((node, index) => {
    if (node.type === 'sectionBreak') {
      out.push({ page: (node.attrs?.page as PageSettings | null | undefined) ?? out[out.length - 1].page, start: index + 1 })
    }
  })

  return out
}

/** A text box's attrs: its size in points (null fits its text), where it sits, and its border and fill colours. */
export interface TextBoxAttrs {
  width: number | null
  height: number | null
  align: 'left' | 'center' | 'right' | null
  border: string | null
  fill: string | null
}

/** A reply to a comment, or a comment itself; dates are ISO strings. */
export interface CommentReply {
  id: string
  author: string
  initials?: string | null
  date: string | null
  /** Plain text, its paragraphs on lines of their own. */
  text: string
}

export interface CommentThread extends CommentReply {
  resolved?: boolean
  replies?: CommentReply[]
}

export const commentsOf = (doc: DocNode): CommentThread[] => (doc.attrs?.comments as CommentThread[] | null | undefined) ?? []

export const pageOf = (doc: DocNode): PageSettings => ((doc.attrs?.page as PageSettings | null | undefined) ?? defaultPage())

/** Each style's look in this document: its own over Herald's. */
export function looksOf(doc: DocNode): Record<StyleName, StyleLook> {
  const own = (doc.attrs?.styles as StyleLooks | null | undefined) ?? {}

  return Object.fromEntries(STYLE_NAMES.map((name) => [name, { ...HERALD_LOOKS[name], ...own[name] }])) as Record<StyleName, StyleLook>
}

/** The style a block shows in: a heading's level, a paragraph's `docStyle`, or what it is. */
export function styleOfBlock(node: DocNode): StyleName {
  if (node.type === 'heading') {
    return `heading${Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)))}` as StyleName
  }

  if (node.type === 'codeBlock') {
    return 'code'
  }

  const style = node.attrs?.docStyle

  return style === 'title' || style === 'subtitle' ? style : 'normal'
}

// Walking and text.

/** Every node under `node`, depth first, with its parent. */
export function walk(node: DocNode, visit: (node: DocNode, parent: DocNode | null) => void | false, parent: DocNode | null = null): void {
  if (visit(node, parent) === false) {
    return
  }

  for (const child of node.content ?? []) {
    walk(child, visit, node)
  }
}

const BLOCK_TEXT = new Set(['paragraph', 'heading', 'codeBlock'])

/** The text of a node: its blocks on lines of their own and line breaks as new lines. */
export function textOf(node: DocNode): string {
  if (node.type === 'text') {
    return node.text ?? ''
  }

  if (node.type === 'hardBreak') {
    return '\n'
  }

  const parts = (node.content ?? []).map(textOf)

  return parts.join(BLOCK_TEXT.has(node.type) ? '' : '\n')
}

export const countWords = (text: string): number => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? []).length

export const countCharacters = (text: string): number => [...text.replace(/\n/g, '')].length

// Building.

export const textNode = (text: string, marks?: DocMark[]): DocNode => (marks?.length ? { type: 'text', text, marks } : { type: 'text', text })

export function paragraphNode(content: DocNode[] = [], attrs?: Record<string, unknown>): DocNode {
  const node: DocNode = { type: 'paragraph' }

  if (attrs && Object.keys(attrs).length) {
    node.attrs = attrs
  }

  if (content.length) {
    node.content = content
  }

  return node
}

/** Text runs next to each other with the same marks joined, and empty ones dropped, as ProseMirror keeps them. */
export function joinText(nodes: DocNode[]): DocNode[] {
  const out: DocNode[] = []

  for (const node of nodes) {
    if (node.type === 'text' && !node.text) {
      continue
    }

    const last = out[out.length - 1]

    if (last?.type === 'text' && node.type === 'text' && sameMarks(last.marks, node.marks)) {
      last.text = `${last.text ?? ''}${node.text ?? ''}`
    } else {
      out.push(node.type === 'text' ? { ...node } : node)
    }
  }

  return out
}

const markKey = (mark: DocMark): string => `${mark.type}${mark.attrs ? JSON.stringify(Object.entries(mark.attrs).filter(([, value]) => value !== null && value !== undefined).sort()) : ''}`

export function sameMarks(a: DocMark[] | undefined, b: DocMark[] | undefined): boolean {
  const left = (a ?? []).map(markKey).sort()
  const right = (b ?? []).map(markKey).sort()

  return left.length === right.length && left.every((key, index) => key === right[index])
}

export const markOf = (node: DocNode, type: MarkName): DocMark | undefined => node.marks?.find((mark) => mark.type === type)

// Units and colours.

/** A CSS length ("12pt", "16px", "1.5em" against 12pt) in points, or null. */
export function points(value: unknown, base = 12): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  const match = /^\s*(-?\d*\.?\d+)\s*(pt|px|em|rem|in|cm|mm|pc)?\s*$/i.exec(String(value ?? ''))

  if (!match) {
    return null
  }

  const amount = Number(match[1])
  const factors: Record<string, number> = { pt: 1, px: 0.75, em: base, rem: base, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12 }

  return amount * (factors[(match[2] ?? 'pt').toLowerCase()] ?? 1)
}

export const round = (value: number, places = 2): number => Math.round(value * 10 ** places) / 10 ** places

const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  orange: '#ffa500',
  purple: '#800080'
}

/** A colour as "#rrggbb" (from #rgb, #rrggbb, rgb(), or a few names), or null. */
export function hexColor(value: unknown): string | null {
  const text = String(value ?? '').trim().toLowerCase()

  if (NAMED_COLORS[text]) {
    return NAMED_COLORS[text]
  }

  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text)

  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  }

  const long = /^#?([0-9a-f]{6})$/.exec(text)

  if (long) {
    return `#${long[1]}`
  }

  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(text)

  if (rgb) {
    return `#${rgb
      .slice(1, 4)
      .map((part) => Math.min(255, Number(part)).toString(16).padStart(2, '0'))
      .join('')}`
  }

  return null
}

/** Word's sixteen highlight colours, by the names its files use. */
export const HIGHLIGHT_COLORS: Readonly<Record<string, string>> = {
  yellow: '#ffff00',
  green: '#00ff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  blue: '#0000ff',
  red: '#ff0000',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#c0c0c0',
  black: '#000000',
  white: '#ffffff'
}

// Pictures.

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  let i = 0

  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += BASE64[n >> 18] + BASE64[(n >> 12) & 63] + BASE64[(n >> 6) & 63] + BASE64[n & 63]
  }

  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8)
    out += BASE64[n >> 18] + BASE64[(n >> 12) & 63] + (i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : '=') + '='
  }

  return out
}

const BASE64_INDEX = new Map([...BASE64].map((char, index) => [char, index]))

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let length = 0

  for (let i = 0; i < clean.length; i += 4) {
    const [a, b, c, d] = [0, 1, 2, 3].map((k) => BASE64_INDEX.get(clean[i + k]) ?? -1)
    out[length++] = (a << 2) | (b >> 4)

    if (c >= 0) {
      out[length++] = ((b & 15) << 4) | (c >> 2)
    }

    if (d >= 0) {
      out[length++] = ((c & 3) << 6) | d
    }
  }

  return out.slice(0, length)
}

export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf'
}

export const dataUrl = (bytes: Uint8Array, mime: string): string => `data:${mime};base64,${bytesToBase64(bytes)}`

export function parseDataUrl(url: unknown): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(url ?? ''))

  if (!match) {
    return null
  }

  return { mime: match[1].toLowerCase(), bytes: match[2] ? base64ToBytes(match[3]) : new TextEncoder().encode(decodeURIComponent(match[3])) }
}

/** A picture's pixel size from its bytes (PNG, JPEG, GIF, BMP, WebP), for one inserted without a size. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (from: number, length: number) => String.fromCharCode(...bytes.slice(from, from + length))

  if (bytes.length > 24 && ascii(1, 3) === 'PNG') {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }

  if (bytes.length > 10 && ascii(0, 3) === 'GIF') {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }

  if (bytes.length > 26 && ascii(0, 2) === 'BM') {
    return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) }
  }

  if (bytes.length > 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4)

    if (kind === 'VP8 ') {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    }

    if (kind === 'VP8L') {
      const bits = view.getUint32(21, true)

      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }

    if (kind === 'VP8X') {
      return { width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) }
    }
  }

  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2

    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++
        continue
      }

      const marker = bytes[offset + 1]
      const length = view.getUint16(offset + 2)

      // Start-of-frame markers, not DHT, JPG or DAC.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
      }

      offset += 2 + length
    }
  }

  return null
}
