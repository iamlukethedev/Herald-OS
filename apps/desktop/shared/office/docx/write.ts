import {
  AlignmentType,
  AnnotationReference,
  Bookmark,
  BorderStyle,
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  commentIdToParaId,
  Document,
  ExternalHyperlink,
  type FileChild,
  Footer,
  Header,
  type ICommentOptions,
  type ILevelsOptions,
  ImageRun,
  type IParagraphOptions,
  type IParagraphStyleOptions,
  type IParagraphStylePropertiesOptions,
  type IRunOptions,
  type IRunStylePropertiesOptions,
  type ISectionOptions,
  type ISectionPropertiesOptions,
  type IStylesOptions,
  LevelFormat,
  LineRuleType,
  Packer,
  PageBreak,
  PageOrientation,
  Paragraph,
  type ParagraphChild,
  SectionType,
  ShadingType,
  Table,
  TableBorders,
  TableCell,
  TableLayoutType,
  TableRow,
  TabStopType,
  TextRun,
  UnderlineType,
  WidthType
} from 'docx'
import {
  CALLOUT_KINDS,
  type CalloutKind,
  CODE_FONT,
  type CommentReply,
  commentsOf,
  DEFAULT_HEADER_DISTANCE,
  type DocJSON,
  type DocMark,
  type DocNode,
  HEADER_KINDS,
  type HeaderKind,
  headersOf,
  hexColor,
  HIGHLIGHT_COLORS,
  imageSize,
  looksOf,
  type NoteKind,
  type PageHeaders,
  type PageSettings,
  paragraphNode,
  parseDataUrl,
  points,
  type SectionKind,
  sectionsOf,
  type StyleLook,
  type StyleName,
  tocEntries,
  walk
} from '../document.ts'
import { fieldAttrs, fieldText } from '../fields.ts'
import { commentSpans } from './comments.ts'
import { Element, fieldRuns, noteReference, textRun } from './elements.ts'
import { instructionOf } from './field-codes.ts'
import { keptOf, writeKept } from './kept.ts'
import { Repack } from './repack.ts'
import { tocControl, tocParagraphs, tocStyles } from './toc.ts'
import { pixelsToTwips, pointsToTwips, TWIPS_PER_PIXEL } from './units.ts'

/*
 * Herald Docs documents as Word documents (.docx), written with the docx package. Herald's styles
 * become Word's built-in ones (Normal, Title, Subtitle, Heading 1 to 6, Quote) with the document's
 * looks, plus Source Code, Verbatim Char and a style for each kind of callout; lists get real
 * numbering, tables their spans, header rows and shading, and pictures are embedded. Headers and
 * footers, fields, footnotes and endnotes, tables of contents, sections, text boxes and comments
 * are written as Word writes them, and what Herald kept of the file it opened goes back in. What a
 * Word document cannot hold is left out or written another way, and said in the losses.
 */

type LossKey =
  | 'checklists'
  | 'codeLanguages'
  | 'svgWebp'
  | 'otherPictures'
  | 'webPictures'
  | 'internalLinks'
  | 'otherLinks'
  | 'headerCells'
  | 'nestedInLists'
  | 'nestedInContainers'
  | 'notesOutside'
  | 'deletedComments'

/** The sentence for each loss, in the order losses are given. */
const LOSSES: Readonly<Record<LossKey, string>> = {
  checklists: 'Checklists are saved as boxes typed before each item.',
  codeLanguages: 'Code block languages are not saved in Word documents.',
  svgWebp: 'SVG and WebP pictures are left out of Word documents.',
  otherPictures: 'Pictures in formats other than PNG, JPEG, GIF and BMP are left out of Word documents.',
  webPictures: 'Pictures from the web are left out of Word documents.',
  internalLinks: 'Links to places inside the document are saved as plain text.',
  otherLinks: 'Links that are not web or email addresses are saved as plain text.',
  headerCells: 'Header cells outside the top rows of a table are saved as ordinary cells.',
  nestedInLists: 'Headings, tables, quotes and callouts inside list items are saved as ordinary blocks.',
  nestedInContainers: 'Headings, code blocks, tables, quotes and callouts inside a quote or callout are saved as ordinary blocks.',
  notesOutside: 'Footnotes and endnotes in headers, footers and other notes are left out, as Word has notes in the text only.',
  deletedComments: 'Comments whose text was deleted are left out.'
}

type Block = Paragraph | Table

/** Where the comments on the text being written start and end, by the node each starts before and ends after. */
interface Ranges {
  starts: Map<DocNode, string[]>
  ends: Map<DocNode, string[]>
}

interface Writer {
  doc: DocJSON
  looks: Record<StyleName, StyleLook>
  /** The width text runs across the page (or the text box), in twips. */
  textWidth: number
  losses: Set<LossKey>
  numbering: { reference: string; levels: ILevelsOptions[] }[]
  bulletLists: number
  pictures: number
  /** What is being written: only the body's headings are counted, and only the body has notes and comments. */
  story: 'body' | 'header' | 'note'
  /** The bookmark on each heading a table of contents lists, by the heading's number among all the headings. */
  bookmarks: Map<number, string>
  /** The body's headings written so far. */
  headings: number
  notes: Record<NoteKind, Record<string, { children: Paragraph[] }>>
  noteCount: Record<NoteKind, number>
  ranges: Ranges
  /** The numbers of each thread's comments in the file (its own first, then its replies'), by the thread's id. */
  comments: Map<string, number[]>
  /** The threads whose text has been placed, in the body or in a note. */
  placed: Set<string>
  boxes: number
}

/** Where blocks are written: in a quote or callout (its paragraph style), and in a list item (its depth, or -1). */
interface Place {
  container?: string
  depth: number
  /** A table cell's alignment, for its paragraphs without one of their own. */
  align?: unknown
  /** The style of plain paragraphs: a header's, a footer's or a note's, or Normal. */
  base?: string
}

const LIST_INDENT = 720
const HANGING = 360

/** Where a list item's text starts at each depth, as the numbering and the paragraphs after an item's first share it. */
const levelIndent = (depth: number): number => LIST_INDENT * (depth + 1)

const append = <T>(out: T[], items: readonly T[]): void => {
  for (const item of items) {
    out.push(item)
  }
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const hex = (color: string): string => color.slice(1).toUpperCase()

const capitalised = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1)

const calloutKind = (kind: unknown): CalloutKind => (CALLOUT_KINDS.includes(kind as CalloutKind) ? (kind as CalloutKind) : 'info')

const calloutStyle = (kind: unknown): string => `HeraldCallout${capitalised(calloutKind(kind))}`

// Numbering.

const BULLETS = ['\u25cf', '\u25cb', '\u25a0']

const DEPTH_FORMATS = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN]

const TYPE_FORMATS: Record<string, (typeof LevelFormat)[keyof typeof LevelFormat]> = {
  '1': LevelFormat.DECIMAL,
  a: LevelFormat.LOWER_LETTER,
  A: LevelFormat.UPPER_LETTER,
  i: LevelFormat.LOWER_ROMAN,
  I: LevelFormat.UPPER_ROMAN
}

const levelStyle = (level: number): ILevelsOptions['style'] => ({ paragraph: { indent: { left: levelIndent(level), hanging: HANGING } } })

const bulletLevels = (): ILevelsOptions[] =>
  Array.from({ length: 9 }, (_, level) => ({ level, format: LevelFormat.BULLET, text: BULLETS[level % BULLETS.length], alignment: AlignmentType.LEFT, style: levelStyle(level) }))

/**
 * An ordered list's numbering: at the list's own depth its type (plain numbers without one, as the
 * editor shows it) and start; deeper levels, for lists indented further in Word, 1, a, i by depth.
 */
const orderedLevels = (depth: number, type: unknown, start: number): ILevelsOptions[] =>
  Array.from({ length: 9 }, (_, level) => ({
    level,
    format: level === depth ? (TYPE_FORMATS[String(type)] ?? LevelFormat.DECIMAL) : DEPTH_FORMATS[level % DEPTH_FORMATS.length],
    text: `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    start: level === depth ? start : 1,
    style: levelStyle(level)
  }))

/** The numbering a list's items use; each list gets numbering of its own, so each counts from its start. */
function numberingFor(writer: Writer, list: DocNode, depth: number): { reference: string; instance: number } {
  if (list.type === 'bulletList') {
    if (!writer.numbering.some((config) => config.reference === 'bullets')) {
      writer.numbering.push({ reference: 'bullets', levels: bulletLevels() })
    }

    return { reference: 'bullets', instance: ++writer.bulletLists }
  }

  const start = finite(list.attrs?.start)
  const reference = `numbers${writer.numbering.length}`
  writer.numbering.push({ reference, levels: orderedLevels(depth, list.attrs?.type, Math.max(0, Math.floor(start ?? 1))) })

  return { reference, instance: 0 }
}

// Inline content.

const HIGHLIGHT_NAMES = new Map(Object.entries(HIGHLIGHT_COLORS).map(([name, color]) => [color, name as NonNullable<IRunOptions['highlight']>]))

const PICTURE_TYPES: Record<string, 'png' | 'jpg' | 'gif' | 'bmp'> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp' }

/** The first family of a CSS font list, without its quotes. */
const fontName = (value: unknown): string | null =>
  String(value ?? '')
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '') || null

function runOptions(marks: readonly DocMark[], linked: boolean): IRunOptions {
  const has = (type: string): boolean => marks.some((mark) => mark.type === type)

  if (has('code')) {
    return { style: 'VerbatimChar' }
  }

  const style = marks.find((mark) => mark.type === 'textStyle')?.attrs ?? {}
  const color = hexColor(style.color)
  const font = fontName(style.fontFamily)
  const size = style.fontSize ? points(style.fontSize) : null
  const highlight = hexColor(marks.find((mark) => mark.type === 'highlight')?.attrs?.color)
  const named = highlight ? HIGHLIGHT_NAMES.get(highlight) : undefined

  return {
    ...(linked ? { style: 'Hyperlink' } : {}),
    ...(has('bold') ? { bold: true } : {}),
    ...(has('italic') ? { italics: true } : {}),
    ...(has('underline') ? { underline: { type: UnderlineType.SINGLE } } : {}),
    ...(has('strike') ? { strike: true } : {}),
    ...(has('superscript') ? { superScript: true } : has('subscript') ? { subScript: true } : {}),
    ...(color ? { color: hex(color) } : {}),
    ...(font ? { font } : {}),
    ...(size && size > 0 ? { size: Math.round(size * 2) } : {}),
    ...(named ? { highlight: named } : highlight ? { shading: { type: ShadingType.CLEAR, fill: hex(highlight), color: 'auto' } } : {})
  }
}

/** Text with its tabs as Word's tabs. */
const withTabs = (value: string): Element[] => value.split('\t').flatMap((part, index) => [...(index ? [new Element('w:tab')] : []), ...(part ? [new Element('w:t', { 'xml:space': 'preserve' }, [part])] : [])])

function pictureSize(attrs: Record<string, unknown>, bytes: Uint8Array, maxWidth: number): { width: number; height: number } {
  const natural = imageSize(bytes) ?? { width: 96, height: 96 }
  const ratio = natural.height / natural.width || 1
  const givenHeight = finite(attrs.height)
  let width = finite(attrs.width) ?? (givenHeight ? givenHeight / ratio : natural.width)
  let height = givenHeight ?? width * ratio

  // A picture wider than the page's text is shown at the text's width in the editor.
  if (width > maxWidth) {
    height *= maxWidth / width
    width = maxWidth
  }

  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
}

function imageRun(writer: Writer, node: DocNode): ImageRun | null {
  const attrs = node.attrs ?? {}
  const parsed = parseDataUrl(attrs.src)

  if (!parsed) {
    writer.losses.add('webPictures')

    return null
  }

  const type = PICTURE_TYPES[parsed.mime]

  if (!type) {
    writer.losses.add(parsed.mime === 'image/svg+xml' || parsed.mime === 'image/webp' ? 'svgWebp' : 'otherPictures')

    return null
  }

  const alt = typeof attrs.alt === 'string' && attrs.alt ? attrs.alt : undefined
  const title = typeof attrs.title === 'string' && attrs.title ? attrs.title : undefined
  writer.pictures++

  return new ImageRun({
    type,
    data: parsed.bytes,
    transformation: pictureSize(attrs, parsed.bytes, writer.textWidth / TWIPS_PER_PIXEL),
    altText: { name: `Picture ${writer.pictures}`, ...(alt ? { description: alt } : {}), ...(title ? { title } : {}) }
  })
}

/** A field as Word writes it, with the result Herald shows as its last; a field Herald has no instruction for is its text. */
function field(node: DocNode, options: IRunOptions): ParagraphChild[] {
  const attrs = fieldAttrs(node.attrs)
  const instruction = instructionOf(attrs)
  const shown = attrs.kind === 'page' || attrs.kind === 'pages' ? attrs.text : fieldText(attrs)

  if (!instruction) {
    return shown ? [textRun(shown, options)] : []
  }

  return fieldRuns(instruction, shown || null, options)
}

/** A footnote or endnote: its mark here, and its blocks in the notes. */
function note(writer: Writer, node: DocNode): ParagraphChild[] {
  if (writer.story !== 'body') {
    writer.losses.add('notesOutside')

    return []
  }

  const kind: NoteKind = node.attrs?.kind === 'endnote' ? 'endnote' : 'footnote'
  const id = ++writer.noteCount[kind]
  const given = Array.isArray(node.attrs?.content) ? (node.attrs.content as DocNode[]) : []
  const content = given.length ? given : [paragraphNode()]
  const style = kind === 'footnote' ? 'FootnoteText' : 'EndnoteText'
  const children = within(writer, 'note', content, () => blocks(writer, content, { depth: -1, base: style }))

  if (!(children[0] instanceof Paragraph)) {
    children.unshift(new Paragraph({ style }))
  }

  // Word puts a space between a note's number and its text.
  ;(children[0] as Paragraph).addRunToFront(textRun(' '))
  // The docx package types a note's blocks as paragraphs; a table among them is written as Word reads it.
  writer.notes[kind][id] = { children: children as Paragraph[] }

  return [noteReference(kind, id)]
}

function inline(writer: Writer, node: DocNode, linked: boolean): ParagraphChild[] {
  if (node.type === 'text') {
    const options = runOptions(node.marks ?? [], linked)

    return (node.text ?? '').split('\n').map((line, index) => new TextRun({ ...options, ...(index ? { break: 1 } : {}), children: withTabs(line) }))
  }

  if (node.type === 'hardBreak') {
    return [new TextRun({ break: 1 })]
  }

  if (node.type === 'field') {
    return field(node, runOptions(node.marks ?? [], linked))
  }

  if (node.type === 'note') {
    return note(writer, node)
  }

  const image = node.type === 'image' ? imageRun(writer, node) : null

  return image ? [image] : []
}

/** The numbers of a thread's comments, its own first, then its replies'. */
const numbersOf = (writer: Writer, id: string): number[] => writer.comments.get(id) ?? []

/** Comments that start before a node, each with its replies, which Word marks the same text for. */
const commentStarts = (writer: Writer, node: DocNode): ParagraphChild[] => (writer.ranges.starts.get(node) ?? []).flatMap((id) => numbersOf(writer, id).map((number) => new CommentRangeStart(number)))

/** Comments that end after a node, each followed by its mark in the text. */
const commentEnds = (writer: Writer, node: DocNode): ParagraphChild[] =>
  (writer.ranges.ends.get(node) ?? []).flatMap((id) => numbersOf(writer, id).flatMap((number) => [new CommentRangeEnd(number), new TextRun({ style: 'CommentReference', children: [new CommentReference(number)] })]))

const linkOf = (node: DocNode): string | null => {
  const href = node.marks?.find((mark) => mark.type === 'link')?.attrs?.href

  return typeof href === 'string' && href ? href : null
}

/** A link Word documents can hold (a web or email address), or null with the loss said. */
function webLink(writer: Writer, href: string): string | null {
  if (/^(https?:|mailto:)/i.test(href.trim())) {
    return href.trim()
  }

  writer.losses.add(href.startsWith('#') ? 'internalLinks' : 'otherLinks')

  return null
}

function inlines(writer: Writer, nodes: readonly DocNode[]): ParagraphChild[] {
  const out: ParagraphChild[] = []
  let start = 0

  while (start < nodes.length) {
    const href = linkOf(nodes[start])
    let end = start + 1

    while (end < nodes.length && linkOf(nodes[end]) === href) {
      end++
    }

    const link = href === null ? null : webLink(writer, href)
    const runs = nodes.slice(start, end).flatMap((node) => [...commentStarts(writer, node), ...inline(writer, node, link !== null), ...commentEnds(writer, node)])

    if (link) {
      out.push(new ExternalHyperlink({ link, children: runs }))
    } else {
      append(out, runs)
    }

    start = end
  }

  return out
}

// Blocks.

const ALIGNMENTS: Record<string, IParagraphOptions['alignment']> = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED }

function spacingOf(before: number | null, after: number | null, lineHeight: number | null): IParagraphOptions['spacing'] {
  if (before === null && after === null && !lineHeight) {
    return undefined
  }

  return {
    ...(before !== null ? { before: pointsToTwips(before) } : {}),
    ...(after !== null ? { after: pointsToTwips(after) } : {}),
    ...(lineHeight ? { line: Math.round(240 * lineHeight), lineRule: LineRuleType.AUTO } : {})
  }
}

function indentOf(attrs: Record<string, unknown>): IParagraphOptions['indent'] {
  const left = finite(attrs.indent)
  const firstLine = finite(attrs.firstLine)

  if (!left && !firstLine) {
    return undefined
  }

  return {
    ...(left ? { left: pointsToTwips(left) } : {}),
    ...(firstLine && firstLine > 0 ? { firstLine: pointsToTwips(firstLine) } : {}),
    ...(firstLine && firstLine < 0 ? { hanging: pointsToTwips(-firstLine) } : {})
  }
}

/** A paragraph's own layout: alignment, spacing, line height and, outside list items, its indents. */
function layoutOf(node: DocNode, place: Place): Pick<IParagraphOptions, 'alignment' | 'spacing' | 'indent'> {
  const attrs = node.attrs ?? {}

  return {
    alignment: ALIGNMENTS[String(attrs.textAlign ?? place.align ?? '')],
    spacing: spacingOf(finite(attrs.spaceBefore), finite(attrs.spaceAfter), finite(attrs.lineHeight)),
    indent: place.depth >= 0 ? { left: levelIndent(place.depth) } : indentOf(attrs)
  }
}

function paragraph(writer: Writer, node: DocNode, place: Place, options: { style?: string; prefix?: string; numbering?: IParagraphOptions['numbering'] } = {}): Paragraph {
  const docStyle = node.attrs?.docStyle === 'title' ? 'Title' : node.attrs?.docStyle === 'subtitle' ? 'Subtitle' : undefined
  const layout = layoutOf(node, place)

  return new Paragraph({
    ...layout,
    ...(options.numbering ? { numbering: options.numbering, indent: undefined } : {}),
    ...(place.base === 'Header' || place.base === 'Footer' ? { tabStops: partTabs(writer.textWidth) } : {}),
    style: options.style ?? place.container ?? docStyle ?? place.base,
    children: [...(options.prefix ? [textRun(options.prefix)] : []), ...inlines(writer, node.content ?? [])]
  })
}

/** A block Herald Docs nests that Word can only write after the list item, quote or callout it is in. */
function flattened(writer: Writer, place: Place): void {
  if (place.depth >= 0) {
    writer.losses.add('nestedInLists')
  }

  if (place.container) {
    writer.losses.add('nestedInContainers')
  }
}

/** A heading, with the bookmark a table of contents links to when one lists it. */
function heading(writer: Writer, node: DocNode, place: Place): Paragraph {
  const level = Math.min(6, Math.max(1, Math.round(Number(node.attrs?.level ?? 1)) || 1))
  const bookmark = writer.story === 'body' ? writer.bookmarks.get(writer.headings++) : undefined
  const children = inlines(writer, node.content ?? [])
  flattened(writer, place)

  return new Paragraph({ ...layoutOf(node, { depth: -1, align: place.align }), style: `Heading${level}`, children: bookmark ? [new Bookmark({ id: bookmark, children })] : children })
}

function code(writer: Writer, node: DocNode, place: Place): Paragraph[] {
  const text = (node.content ?? []).map((child) => child.text ?? '').join('')

  if (node.attrs?.language) {
    writer.losses.add('codeLanguages')
  }

  if (place.container) {
    writer.losses.add('nestedInContainers')
  }

  return text.split('\n').map(
    (line) =>
      new Paragraph({
        style: 'SourceCode',
        ...(place.depth >= 0 ? { indent: { left: levelIndent(place.depth) } } : {}),
        children: line ? [new TextRun({ children: withTabs(line) })] : []
      })
  )
}

function list(writer: Writer, node: DocNode, place: Place): Block[] {
  const depth = place.depth + 1
  const inner: Place = { ...place, depth }
  const task = node.type === 'taskList'
  const numbering = task ? null : numberingFor(writer, node, depth)
  const out: Block[] = []

  if (task) {
    writer.losses.add('checklists')
  }

  for (const item of node.content ?? []) {
    const [first, ...rest] = item.content ?? []

    if (first?.type === 'paragraph') {
      out.push(
        numbering
          ? paragraph(writer, first, inner, { style: place.container, numbering: { reference: numbering.reference, instance: numbering.instance, level: depth } })
          : paragraph(writer, first, inner, { style: place.container ?? 'ListParagraph', prefix: item.attrs?.checked ? '\u2612 ' : '\u2610 ' })
      )
    } else if (first) {
      rest.unshift(first)
    }

    for (const child of rest) {
      append(out, block(writer, child, inner))
    }
  }

  return out
}

/** Columns' widths in twips: their cells' widths where they have them, the rest of the page's text width shared out. */
function columnWidths(rows: readonly DocNode[], textWidth: number): number[] {
  const widths: (number | null)[] = []
  const taken = new Set<string>()

  rows.forEach((row, rowIndex) => {
    let column = 0

    for (const cell of row.content ?? []) {
      while (taken.has(`${rowIndex}:${column}`)) {
        column++
      }

      const span = Math.max(1, Number(cell.attrs?.colspan ?? 1) || 1)
      const rowspan = Math.max(1, Number(cell.attrs?.rowspan ?? 1) || 1)
      const colwidth = Array.isArray(cell.attrs?.colwidth) ? (cell.attrs.colwidth as unknown[]) : []

      for (let offset = 0; offset < span; offset++) {
        const width = finite(colwidth[offset])
        widths[column + offset] ??= width && width > 0 ? pixelsToTwips(width) : null

        for (let below = 0; below < rowspan; below++) {
          taken.add(`${rowIndex + below}:${column + offset}`)
        }
      }

      column += span
    }
  })

  const known = widths.reduce<number>((sum, width) => sum + (width ?? 0), 0)
  const missing = widths.filter((width) => width === null).length
  const share = missing ? Math.max(720, Math.round((textWidth - known) / missing)) : 0

  return widths.length ? Array.from(widths, (width) => width ?? share) : [textWidth]
}

function tableCell(writer: Writer, cell: DocNode): TableCell {
  const attrs = cell.attrs ?? {}
  const children = blocks(writer, cell.content ?? [], { depth: -1, align: attrs.align })
  const background = hexColor(attrs.background)
  const colspan = Number(attrs.colspan ?? 1)
  const rowspan = Number(attrs.rowspan ?? 1)

  // Word wants every cell to end with a paragraph.
  if (!children.length || children[children.length - 1] instanceof Table) {
    children.push(new Paragraph({}))
  }

  return new TableCell({
    children,
    ...(colspan > 1 ? { columnSpan: colspan } : {}),
    ...(rowspan > 1 ? { rowSpan: rowspan } : {}),
    ...(background ? { shading: { type: ShadingType.CLEAR, fill: hex(background), color: 'auto' } } : {})
  })
}

function table(writer: Writer, node: DocNode, place: Place): Table {
  const rows = node.content ?? []
  const widths = columnWidths(rows, writer.textWidth)
  const isHeader = (row: DocNode): boolean => Boolean(row.content?.length) && (row.content ?? []).every((cell) => cell.type === 'tableHeader')
  const headerRows = rows.findIndex((row) => !isHeader(row))
  const repeated = headerRows === -1 ? rows.length : headerRows
  flattened(writer, place)

  if (rows.some((row, index) => index >= repeated && row.content?.some((cell) => cell.type === 'tableHeader'))) {
    writer.losses.add('headerCells')
  }

  return new Table({
    rows: rows.map((row, index) => new TableRow({ ...(index < repeated ? { tableHeader: true } : {}), children: (row.content ?? []).map((cell) => tableCell(writer, cell)) })),
    columnWidths: widths,
    width: { size: widths.reduce((sum, width) => sum + width, 0), type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    ...(node.attrs?.borders === false ? { borders: TableBorders.NONE } : {}),
    ...(place.depth >= 0 ? { indent: { size: levelIndent(place.depth), type: WidthType.DXA } } : {})
  })
}

function container(writer: Writer, node: DocNode, style: string, place: Place): Block[] {
  flattened(writer, place)

  return blocks(writer, node.content ?? [], { container: style, depth: -1, align: place.align })
}

const RULE = { style: BorderStyle.SINGLE, size: 6, color: 'auto', space: 1 }

/** The VML shape type of text boxes, which Word writes with each one. */
const textBoxType = (): Element =>
  new Element('v:shapetype', { id: '_x0000_t202', coordsize: '21600,21600', 'o:spt': '202', path: 'm,l,21600r21600,l21600,xe' }, [
    new Element('v:stroke', { joinstyle: 'miter' }),
    new Element('v:path', { gradientshapeok: 't', 'o:connecttype': 'rect' })
  ])

/**
 * A text box as a VML text box in the line of a paragraph of its own, which its alignment places:
 * the markup the docx package's Textbox writes, with the box's border and fill as well.
 */
function textBox(writer: Writer, node: DocNode, place: Place): Paragraph {
  const attrs = node.attrs ?? {}
  const width = finite(attrs.width) ?? writer.textWidth / 20
  const height = finite(attrs.height)
  const border = hexColor(attrs.border)
  const fill = hexColor(attrs.fill)
  const outer = writer.textWidth
  writer.textWidth = Math.max(720, pointsToTwips(width) - 288)
  const content = blocks(writer, node.content ?? [], { depth: -1 })
  writer.textWidth = outer

  if (!content.length || content[content.length - 1] instanceof Table) {
    content.push(new Paragraph({}))
  }

  const shape = new Element(
    'v:shape',
    {
      id: `_x0000_s${1025 + writer.boxes++}`,
      type: '#_x0000_t202',
      style: `width:${width}pt${height ? `;height:${height}pt` : ''}`,
      stroked: border ? 't' : 'f',
      strokecolor: border ?? undefined,
      strokeweight: border ? '0.75pt' : undefined,
      filled: fill ? 't' : 'f',
      fillcolor: fill ?? undefined
    },
    [new Element('v:textbox', { style: height ? undefined : 'mso-fit-shape-to-text:t' }, [new Element('w:txbxContent', {}, content)])]
  )

  return new Paragraph({
    style: place.container,
    alignment: ALIGNMENTS[String(attrs.align ?? '')],
    ...(place.depth >= 0 ? { indent: { left: levelIndent(place.depth) } } : {}),
    children: [new TextRun({ children: [new Element('w:pict', {}, [textBoxType(), shape])] })]
  })
}

/** A table of contents' paragraphs, its entries the document's headings now. */
function tableOfContents(writer: Writer, node: DocNode): Paragraph[] {
  return tocParagraphs(node, tocEntries(writer.doc, Number(node.attrs?.levels ?? 3) || 3), writer.bookmarks, writer.textWidth)
}

/** Writes the blocks of a note or a header with what is theirs: the comments on their text, and what they may hold. */
function within(writer: Writer, story: Writer['story'], nodes: readonly DocNode[], write: () => Block[]): Block[] {
  const { story: outer, ranges } = writer
  writer.story = story
  writer.ranges = story === 'note' ? rangesOf(writer, nodes) : { starts: new Map(), ends: new Map() }

  try {
    return write()
  } finally {
    writer.story = outer
    writer.ranges = ranges
  }
}

/** Where the comments on some blocks' text start and end; a thread's text is placed once, where it is first found. */
function rangesOf(writer: Writer, nodes: readonly DocNode[]): Ranges {
  const ranges: Ranges = { starts: new Map(), ends: new Map() }

  for (const [id, span] of commentSpans(nodes)) {
    if (writer.comments.has(id) && !writer.placed.has(id)) {
      writer.placed.add(id)
      ranges.starts.set(span.first, [...(ranges.starts.get(span.first) ?? []), id])
      ranges.ends.set(span.last, [...(ranges.ends.get(span.last) ?? []), id])
    }
  }

  return ranges
}

function block(writer: Writer, node: DocNode, place: Place): Block[] {
  switch (node.type) {
    case 'paragraph':
      // A paragraph in a list item after its first is indented as the item's text, without a number.
      return [paragraph(writer, node, place, place.depth >= 0 ? { style: place.container ?? 'ListParagraph' } : {})]
    case 'heading':
      return [heading(writer, node, place)]
    case 'blockquote':
      return container(writer, node, 'Quote', place)
    case 'callout':
      return container(writer, node, calloutStyle(node.attrs?.kind), place)
    case 'codeBlock':
      return code(writer, node, place)
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return list(writer, node, place)
    case 'table':
      return [table(writer, node, place)]
    case 'horizontalRule':
      return [new Paragraph({ style: place.container, ...(place.depth >= 0 ? { indent: { left: levelIndent(place.depth) } } : {}), border: { bottom: RULE } })]
    case 'pageBreak':
      return [new Paragraph({ style: place.container, children: [new PageBreak()] })]
    case 'textBox':
      return [textBox(writer, node, place)]
    case 'tableOfContents':
      return tableOfContents(writer, node)
    case 'sectionBreak':
      return []
    default:
      return node.content ? blocks(writer, node.content, place) : []
  }
}

function blocks(writer: Writer, nodes: readonly DocNode[], place: Place): Block[] {
  const out: Block[] = []

  for (const node of nodes) {
    append(out, block(writer, node, place))
  }

  return out
}

// Styles and the page.

const CALLOUT_COLORS: Readonly<Record<CalloutKind, { border: string; fill: string }>> = {
  info: { border: '3B82F6', fill: 'EFF6FF' },
  note: { border: '8B5CF6', fill: 'F5F3FF' },
  success: { border: '22C55E', fill: 'F0FDF4' },
  warning: { border: 'F59E0B', fill: 'FFFBEB' },
  error: { border: 'EF4444', fill: 'FEF2F2' }
}

function runOfLook(look: StyleLook, normal: StyleLook | null): IRunStylePropertiesOptions {
  const color = hexColor(look.color)

  return {
    ...(look.font ? { font: look.font } : {}),
    ...(look.size ? { size: Math.round(look.size * 2) } : {}),
    ...(color ? { color: hex(color) } : {}),
    // Bold and italic are written off only where Normal would give them.
    ...(look.bold || (look.bold === false && normal?.bold) ? { bold: Boolean(look.bold) } : {}),
    ...(look.italic || (look.italic === false && normal?.italic) ? { italics: Boolean(look.italic) } : {})
  }
}

const spacingOfLook = (look: StyleLook): IParagraphOptions['spacing'] => spacingOf(look.spaceBefore ?? null, look.spaceAfter ?? null, look.lineHeight ?? null)

/** Word's Header and Footer styles, which a header's or footer's paragraphs are in. */
const partStyle = (id: string): IParagraphStyleOptions => ({ id, name: id.toLowerCase(), basedOn: 'Normal' })

/** A header's or footer's centre and right tabs across the text, as Word's Header and Footer styles have them. */
const partTabs = (textWidth: number): IParagraphOptions['tabStops'] => [
  { type: TabStopType.CENTER, position: Math.round(textWidth / 2) },
  { type: TabStopType.RIGHT, position: textWidth }
]

function stylesFor(looks: Record<StyleName, StyleLook>, textWidth: number): IStylesOptions {
  const normal = looks.normal

  const style = (id: string, name: string, look: StyleLook, paragraph: IParagraphStylePropertiesOptions = {}): IParagraphStyleOptions => {
    const spacing = spacingOfLook(look)

    return { id, name, basedOn: 'Normal', next: 'Normal', quickFormat: true, run: runOfLook(look, normal), paragraph: { ...paragraph, ...(spacing ? { spacing } : {}) } }
  }

  const headings = [1, 2, 3, 4, 5, 6].map((level) =>
    style(`Heading${level}`, `heading ${level}`, looks[`heading${level}` as StyleName], { outlineLevel: level - 1, keepNext: true, keepLines: true })
  )
  const callouts = CALLOUT_KINDS.map((kind) =>
    style(calloutStyle(kind), `Callout ${capitalised(kind)}`, {}, {
      border: { left: { style: BorderStyle.SINGLE, size: 24, color: CALLOUT_COLORS[kind].border, space: 8 } },
      shading: { type: ShadingType.CLEAR, fill: CALLOUT_COLORS[kind].fill, color: 'auto' }
    })
  )

  return {
    default: { document: { run: runOfLook({ font: normal.font, size: normal.size }, null), paragraph: { spacing: spacingOfLook(normal) } } },
    paragraphStyles: [
      { id: 'Normal', name: 'Normal', quickFormat: true, run: runOfLook(normal, null), paragraph: { spacing: spacingOfLook(normal) } },
      style('Title', 'Title', looks.title),
      style('Subtitle', 'Subtitle', looks.subtitle),
      ...headings,
      // List items sit close together, as the editor shows them.
      { id: 'ListParagraph', name: 'List Paragraph', basedOn: 'Normal', quickFormat: true, paragraph: { contextualSpacing: true } },
      style('Quote', 'Quote', looks.quote, { indent: { left: LIST_INDENT }, border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'BFBFBF', space: 12 } } }),
      { ...style('SourceCode', 'Source Code', looks.code, { shading: { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' } }), next: 'SourceCode' },
      ...callouts,
      partStyle('Header'),
      partStyle('Footer'),
      ...tocStyles(textWidth),
      { id: 'CommentText', name: 'annotation text', basedOn: 'Normal', run: { size: 20 } }
    ],
    characterStyles: [
      { id: 'VerbatimChar', name: 'Verbatim Char', run: { font: looks.code.font ?? CODE_FONT } },
      { id: 'Hyperlink', name: 'Hyperlink', run: { color: '0563C1', underline: { type: UnderlineType.SINGLE } } },
      { id: 'CommentReference', name: 'annotation reference', run: { size: 16 } }
    ]
  }
}

const SECTION_TYPES: Readonly<Record<SectionKind, (typeof SectionType)[keyof typeof SectionType]>> = {
  nextPage: SectionType.NEXT_PAGE,
  continuous: SectionType.CONTINUOUS,
  evenPage: SectionType.EVEN_PAGE,
  oddPage: SectionType.ODD_PAGE
}

function sectionFor(page: PageSettings): ISectionPropertiesOptions {
  const landscape = page.width > page.height
  // The docx package swaps the two sides of a landscape page itself.
  const size = landscape
    ? { width: pointsToTwips(page.height), height: pointsToTwips(page.width), orientation: PageOrientation.LANDSCAPE }
    : { width: pointsToTwips(page.width), height: pointsToTwips(page.height), orientation: PageOrientation.PORTRAIT }
  const { top, right, bottom, left, header, footer } = page.margins
  const margin = {
    top: pointsToTwips(top),
    right: pointsToTwips(right),
    bottom: pointsToTwips(bottom),
    left: pointsToTwips(left),
    header: pointsToTwips(header ?? DEFAULT_HEADER_DISTANCE),
    footer: pointsToTwips(footer ?? DEFAULT_HEADER_DISTANCE)
  }

  return { page: { size, margin } }
}

const textWidthOf = (page: PageSettings): number => Math.max(1440, pointsToTwips(page.width - page.margins.left - page.margins.right))

/** The first section's headers and footers; a first page's or even pages' own is written, empty if need be, when the document has them. */
function headerParts(writer: Writer, headers: PageHeaders | null): Pick<ISectionOptions, 'headers' | 'footers'> {
  if (!headers) {
    return {}
  }

  const make = (part: 'header' | 'footer', kind: HeaderKind): Header | Footer | undefined => {
    const given = headers[part]?.[kind] ?? []
    const wanted = given.length > 0 || (kind === 'first' && headers.differentFirst) || (kind === 'even' && headers.differentOddEven)
    const base = part === 'header' ? 'Header' : 'Footer'

    if (!wanted) {
      return undefined
    }

    const children = within(writer, 'header', given, () => blocks(writer, given, { depth: -1, base }))

    if (!children.length || children[children.length - 1] instanceof Table) {
      children.push(new Paragraph({ style: base }))
    }

    return part === 'header' ? new Header({ children }) : new Footer({ children })
  }

  return {
    headers: Object.fromEntries(HEADER_KINDS.map((kind) => [kind, make('header', kind)]).filter(([, part]) => part)),
    footers: Object.fromEntries(HEADER_KINDS.map((kind) => [kind, make('footer', kind)]).filter(([, part]) => part))
  }
}

/** The bookmarks on the headings the document's tables of contents list, by the heading's number. */
function headingBookmarks(doc: DocJSON): Map<number, string> {
  const bookmarks = new Map<number, string>()

  walk(doc, (node) => {
    if (node.type === 'tableOfContents') {
      for (const entry of tocEntries(doc, Number(node.attrs?.levels ?? 3) || 3)) {
        bookmarks.set(entry.heading, `_Toc${String(entry.heading + 1).padStart(9, '0')}`)
      }
    }
  })

  return bookmarks
}

/** Each thread's comment numbers in the file: its own, then its replies'. */
function commentNumbers(doc: DocJSON): Map<string, number[]> {
  const numbers = new Map<string, number[]>()
  let next = 0

  for (const thread of commentsOf(doc)) {
    if (typeof thread?.id === 'string' && !numbers.has(thread.id)) {
      numbers.set(thread.id, [thread, ...(thread.replies ?? [])].map(() => next++))
    }
  }

  return numbers
}

const commentDate = (value: string | null | undefined): Date | undefined => {
  const time = value ? Date.parse(value) : Number.NaN

  return Number.isNaN(time) ? undefined : new Date(time)
}

/** A comment as the docx package writes it: its paragraphs, the first with Word's mark of the comment. */
function commentOptions(comment: CommentReply, id: number, extra: Partial<ICommentOptions>): ICommentOptions {
  const lines = String(comment.text ?? '').split('\n')
  const children = lines.map(
    (line, index) =>
      new Paragraph({
        style: 'CommentText',
        children: [...(index ? [] : [new TextRun({ style: 'CommentReference', children: [new AnnotationReference()] })]), ...(line ? [new TextRun({ children: withTabs(line) })] : [])]
      })
  )
  const date = commentDate(comment.date)

  return { id, author: comment.author ?? '', ...(comment.initials ? { initials: comment.initials } : {}), ...(date ? { date } : {}), children, ...extra }
}

/** The comments of the threads whose text was written; threads whose text was deleted are left out. */
function commentsFor(writer: Writer): ICommentOptions[] {
  const out: ICommentOptions[] = []

  for (const thread of commentsOf(writer.doc)) {
    const [own, ...replies] = writer.comments.get(thread?.id) ?? []

    if (own === undefined) {
      continue
    }

    if (!writer.placed.has(thread.id)) {
      writer.losses.add('deletedComments')
      continue
    }

    const resolved = thread.resolved ? { resolved: true } : {}
    out.push(commentOptions(thread, own, resolved))
    ;(thread.replies ?? []).forEach((reply, index) => out.push(commentOptions(reply, replies[index], { parentId: own, ...resolved })))
  }

  // Word keeps whether a thread is resolved by its comments' paragraph ids, which the docx package only writes for threads with replies or with ids.
  return out.some((comment) => comment.resolved) && !out.some((comment) => comment.parentId !== undefined) ? out.map((comment) => ({ ...comment, durableId: commentIdToParaId(comment.id) })) : out
}

/** What the docx package cannot write: resolved threads without replies, notes' separators without note marks, and the parts Herald kept. */
async function repacked(bytes: Uint8Array, comments: readonly ICommentOptions[], doc: DocJSON): Promise<Uint8Array> {
  const repack = await Repack.open(bytes)
  const main = 'word/document.xml'

  for (const path of ['word/footnotes.xml', 'word/endnotes.xml']) {
    const xml = await repack.text(path)

    if (xml) {
      repack.setText(path, xml.replace(/<w:r><w:rPr><w:rStyle w:val="(?:Footnote|Endnote)Reference"\/><\/w:rPr><w:(?:footnote|endnote)Ref\/><\/w:r>(?=<w:r><w:(?:separator|continuationSeparator)\/><\/w:r>)/g, ''))
    }
  }

  if (comments.some((comment) => comment.resolved) && !repack.has('word/commentsExtended.xml')) {
    const entries = comments.map((comment) => `<w15:commentEx w15:paraId="${commentIdToParaId(comment.id)}" w15:done="${comment.resolved ? 1 : 0}"/>`).join('')
    repack.setText('word/commentsExtended.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">${entries}</w15:commentsEx>`)
    await repack.setContentType('word/commentsExtended.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml')
    await repack.relate(main, 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended', 'word/commentsExtended.xml')
  }

  const kept = keptOf(doc.attrs?.kept)

  if (kept) {
    await writeKept(repack, kept, main)
  }

  return repack.bytes()
}

/** A Word file of a Herald Docs document, with what the file cannot keep of it. */
export async function docxFromDocument(doc: DocJSON): Promise<{ bytes: Uint8Array; losses: string[] }> {
  const content = doc.content ?? []
  const parts = sectionsOf({ ...doc, content })
  const writer: Writer = {
    doc: { ...doc, content },
    looks: looksOf(doc),
    textWidth: textWidthOf(parts[0].page),
    losses: new Set(),
    numbering: [],
    bulletLists: 0,
    pictures: 0,
    story: 'body',
    bookmarks: headingBookmarks({ ...doc, content }),
    headings: 0,
    notes: { footnote: {}, endnote: {} },
    noteCount: { footnote: 0, endnote: 0 },
    ranges: { starts: new Map(), ends: new Map() },
    comments: commentNumbers(doc),
    placed: new Set(),
    boxes: 0
  }
  writer.ranges = rangesOf(writer, content)
  const headers = headersOf(doc)

  const sections = parts.map(({ page, start }, index): ISectionOptions => {
    const end = index + 1 < parts.length ? parts[index + 1].start - 1 : content.length
    writer.textWidth = textWidthOf(page)
    const children: FileChild[] = content.slice(start, end).flatMap((node) => (node.type === 'tableOfContents' ? [tocControl(tableOfContents(writer, node))] : block(writer, node, { depth: -1 })))
    const kind = index ? (content[start - 1].attrs?.kind as SectionKind | undefined) : undefined

    // Word keeps a paragraph after a table that ends a document.
    if (index === parts.length - 1 && (!children.length || children[children.length - 1] instanceof Table)) {
      children.push(new Paragraph({}))
    }

    return { properties: { ...sectionFor(page), ...(kind ? { type: SECTION_TYPES[kind] ?? SectionType.NEXT_PAGE } : {}), ...(index === 0 && headers?.differentFirst ? { titlePage: true } : {}) }, children }
  })
  writer.textWidth = textWidthOf(parts[0].page)
  sections[0] = { ...sections[0], ...headerParts(writer, headers) }
  const comments = commentsFor(writer)
  const properties = keptOf(doc.attrs?.kept)?.properties ?? {}

  const file = new Document({
    ...properties,
    creator: properties.creator ?? '',
    lastModifiedBy: '',
    styles: stylesFor(writer.looks, textWidthOf(parts[0].page)),
    numbering: { config: writer.numbering },
    comments: { children: comments },
    footnotes: writer.notes.footnote,
    endnotes: writer.notes.endnote,
    evenAndOddHeaderAndFooters: Boolean(headers?.differentOddEven),
    sections
  })
  const bytes = await repacked(await Packer.pack(file, 'uint8array'), comments, doc)

  return { bytes, losses: (Object.keys(LOSSES) as LossKey[]).filter((key) => writer.losses.has(key)).map((key) => LOSSES[key]) }
}
