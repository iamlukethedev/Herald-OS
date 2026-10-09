import { CODE_FONT, type DocJSON, type DocNode, imageSize, parseDataUrl, textOf } from '../../../../shared/office/document.ts'
import type { CellRange } from '../../../../shared/office/xlsx/address.ts'
import type { Box, Deck, LayoutId, ListKind, NumberStyle, Paragraph, RunStyle, ShapeElement, Slide, SlideElement, SlideSize, TextAlign, TextElement, TextRun, Theme } from './deck.ts'
import { coverCrop, imageElement, textElement } from './elements.ts'
import { contentArea, type GridCell, insertSlides, LINE, lineCount, tablesFor, withPlaceholderText } from './from-sheet.ts'
import { isEmptyPlaceholder, newSlide, placeholderFor } from './layouts.ts'
import { type DeckChange, newDeck } from './model.ts'
import { imageSource } from './normalize.ts'
import { MAX_COLUMNS, MAX_ROWS } from './tables.ts'
import { DEFAULT_INSET, LIST_INDENT, MAX_LEVEL, textBody, tidyRuns } from './text.ts'

/*
 * Decks from Herald Docs documents, laid out by rule: the document's title makes a title slide, its
 * headings make section headers and slides of bullets, and its pictures, tables, quotes and code
 * get slides in the layouts made for them. How much text a slide holds is estimated from its
 * placeholder's width and text size, so a long section goes on over further slides rather than
 * running off one. The same document always makes the same slides.
 */

type Place = Pick<Deck, 'size' | 'master'>

/** A paragraph or list item of a section, as a bullet. */
interface Bullet {
  runs: TextRun[]
  level: number
  list: ListKind
  /** A to-do item's box, ticked or not. */
  glyph?: string
  /** An item of a numbered list: which list it is in, its number there and the list's numbering. */
  order?: { list: number; n: number; numbering?: NumberStyle }
  /** A paragraph of its own rather than a list item: a picture's caption may be one. */
  plain?: boolean
}

interface Picture {
  src: string
  natural: { width: number; height: number }
  alt: string
}

/** What a section holds, in the order the document has it. */
type Item =
  | { kind: 'bullet'; bullet: Bullet }
  | { kind: 'picture'; picture: Picture }
  | { kind: 'table'; cells: GridCell[][]; merges: CellRange[]; header: boolean }
  | { kind: 'quote'; lines: string[]; by: string }
  | { kind: 'code'; lines: string[] }

type TableItem = Extract<Item, { kind: 'table' }>
type QuoteItem = Extract<Item, { kind: 'quote' }>
type CodeItem = Extract<Item, { kind: 'code' }>

interface Section {
  title: string
  level: number
  blocks: DocNode[]
}

/** The room a text placeholder gives its paragraphs, in points. */
interface Fit {
  width: number
  height: number
  size: number
  spaceAfter: number
}

/** A slide's worth of bullets, and whether one of them was shortened to fit. */
interface Chunk {
  bullets: Bullet[]
  shortened: boolean
}

/** A paragraph this long or shorter may be a subtitle or a picture's caption. */
const SHORT = 120
const QUOTE_SIZES = [40, 36, 32, 28, 24]
const CODE_SIZES = [20, 18, 16, 14, 12]
/** How wide a character of code is, as a share of its size (a monospace face). */
const CODE_CHARACTER = 0.6
const CODE_INSET: [number, number, number, number] = [14, 10, 14, 10]
const LISTS = new Set(['bulletList', 'orderedList', 'taskList'])
/** Ordered lists' `type`, as numbering styles. */
const NUMBERINGS: Record<string, NumberStyle | undefined> = { a: 'alphaLcPeriod', A: 'alphaUcPeriod', i: 'romanLcPeriod', I: 'romanUcPeriod' }
const MARKS: Record<string, RunStyle | undefined> = { bold: { bold: true }, italic: { italic: true }, underline: { underline: true }, strike: { strike: true }, code: { font: CODE_FONT } }
/** A table cell's text that reads as a number (an amount, a percentage), right-aligned. */
const NUMERIC = /^[-+−(]?[$€£¥]?\s?\d[\d,.\s]*%?\)?$/

const runsText = (runs: readonly TextRun[]): string => runs.map((run) => run.text).join('')

const isText = (element: SlideElement | undefined): element is TextElement | ShapeElement => element?.kind === 'text' || element?.kind === 'shape'

const continued = (title: string): string => `${title} (continued)`.trim()

const total = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0)

// Reading the document.

/** Inline content as runs: bold, italic, underline, strike and code's monospace face kept, line breaks as new lines, pictures left out. */
function runsOf(nodes: readonly DocNode[] = []): TextRun[] {
  return tidyRuns(
    nodes.flatMap((node): TextRun[] => {
      if (node.type === 'hardBreak') {
        return [{ text: '\n' }]
      }

      return node.type === 'text' && node.text ? [{ ...(node.marks ?? []).reduce<RunStyle>((style, mark) => ({ ...style, ...MARKS[mark.type] }), {}), text: node.text }] : []
    })
  )
}

/** Runs without the spaces at their ends. */
function trimmed(runs: readonly TextRun[]): TextRun[] {
  const out = runs.map((run) => ({ ...run }))

  if (out.length) {
    out[0].text = out[0].text.trimStart()
    out[out.length - 1].text = out[out.length - 1].text.trimEnd()
  }

  return tidyRuns(out)
}

const emptyParagraph = (block: DocNode): boolean => block.type === 'paragraph' && !textOf(block).trim() && !block.content?.some((child) => child.type === 'image')

const isHeading = (block: DocNode): boolean => block.type === 'heading' && textOf(block).trim() !== ''

const levelOf = (block: DocNode): number => Math.min(6, Math.max(1, Math.round(Number(block.attrs?.level ?? 1)) || 1))

const styled = (block: DocNode, style: 'title' | 'subtitle'): boolean => block.type === 'paragraph' && block.attrs?.docStyle === style && textOf(block).trim() !== ''

/** A plain paragraph's text when it is short enough for a subtitle or a caption, else null. */
function shortText(block: DocNode | undefined): string | null {
  if (block?.type !== 'paragraph' || block.content?.some((child) => child.type === 'image')) {
    return null
  }

  const text = textOf(block).trim()

  return text && text.length <= SHORT && !text.includes('\n') ? text : null
}

/** A picture the deck can hold (a data URL of an image), at its own size. */
function pictureOf(node: DocNode): Picture | null {
  const src = imageSource(node.attrs?.src)

  if (!src) {
    return null
  }

  const bytes = parseDataUrl(src)?.bytes
  const own = bytes ? imageSize(bytes) : null
  const width = Number(node.attrs?.width)
  const height = Number(node.attrs?.height)
  const natural = own && own.width > 0 && own.height > 0 ? own : width > 0 && height > 0 ? { width: Math.round(width), height: Math.round(height) } : { width: 0, height: 0 }

  return { src, natural, alt: typeof node.attrs?.alt === 'string' ? node.attrs.alt.trim() : '' }
}

/** A paragraph's text as a bullet, and its pictures, in the order they come. */
function paragraphItems(node: DocNode): Item[] {
  const items: Item[] = []
  let inline: DocNode[] = []
  const flush = () => {
    const runs = trimmed(runsOf(inline))

    if (runsText(runs).trim()) {
      items.push({ kind: 'bullet', bullet: { runs, level: 0, list: 'bullet', plain: true } })
    }

    inline = []
  }

  for (const child of node.content ?? []) {
    const picture = child.type === 'image' ? pictureOf(child) : null

    if (picture) {
      flush()
      items.push({ kind: 'picture', picture })
    } else {
      inline.push(child)
    }
  }

  flush()

  return items
}

/** The text of some blocks a line each: a paragraph (its line breaks kept), and what lists, quotes and tables hold, block by block. */
function blockLines(nodes: readonly DocNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock') {
      const text = textOf(node).trim()

      return text ? [text] : []
    }

    return blockLines(node.content ?? [])
  })
}

/** A list's items as bullets, a level deeper for each list they are in; an item's paragraphs are lines of its bullet. */
function listItems(list: DocNode, level: number, lists: { count: number }): Item[] {
  const ordered = list.type === 'orderedList'
  const id = lists.count++
  const start = Math.round(Number(list.attrs?.start ?? 1)) || 1
  const numbering = NUMBERINGS[String(list.attrs?.type ?? '')]

  return (list.content ?? []).flatMap((item, index) => {
    const blocks = item.content ?? []
    const lines = blocks
      .filter((block) => !LISTS.has(block.type))
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? runsOf(block.content) : [{ text: blockLines([block]).join('\n') }]))
      .filter((line) => runsText(line).trim())
    const runs = trimmed(lines.flatMap((line, k) => (k ? [{ text: '\n' }, ...line] : line)))
    const bullet: Bullet = {
      runs,
      level: Math.min(MAX_LEVEL, level),
      list: ordered ? 'number' : 'bullet',
      ...(list.type === 'taskList' ? { glyph: item.attrs?.checked ? '☑' : '☐' } : {}),
      ...(ordered ? { order: { list: id, n: start + index, ...(numbering ? { numbering } : {}) } } : {})
    }
    const own: Item[] = runsText(runs).trim() ? [{ kind: 'bullet', bullet }] : []

    return [...own, ...blocks.filter((block) => LISTS.has(block.type)).flatMap((block) => listItems(block, level + 1, lists))]
  })
}

/** A quote's paragraphs, and who said it when its last paragraph starts with a dash. */
function quoteItems(node: DocNode): Item[] {
  const lines = blockLines(node.content ?? [])
  const by = lines.length > 1 ? /^(?:—|–|-{1,2}|~)\s*(\S.*)$/.exec(lines[lines.length - 1]) : null

  return lines.length ? [{ kind: 'quote', lines: by ? lines.slice(0, -1) : lines, by: by ? by[1] : '' }] : []
}

function codeItems(node: DocNode): Item[] {
  const lines = textOf(node).replace(/\t/g, '    ').split('\n')

  while (lines.length && !lines[lines.length - 1].trim()) {
    lines.pop()
  }

  return lines.length ? [{ kind: 'code', lines }] : []
}

const span = (value: unknown, most: number): number => Math.max(1, Math.min(most, Math.round(Number(value)) || 1))

function alignOf(block: DocNode | undefined): TextAlign | undefined {
  const align = block?.attrs?.textAlign

  return align === 'center' || align === 'right' || align === 'justify' ? align : undefined
}

/** A table's cells on a grid (as many as a slide's table holds), merged cells spanning theirs; its first row is the header when it is header cells. */
function tableItems(node: DocNode): Item[] {
  const rows = (node.content ?? []).filter((row) => row.type === 'tableRow').slice(0, MAX_ROWS)
  const grid: GridCell[][] = rows.map(() => [])
  const merges: CellRange[] = []

  rows.forEach((row, r) => {
    let column = 0

    for (const cell of row.content ?? []) {
      while (grid[r][column]) {
        column++
      }

      const across = span(cell.attrs?.colspan, MAX_COLUMNS - column)
      const down = span(cell.attrs?.rowspan, rows.length - r)
      const text = blockLines(cell.content ?? []).join('\n')
      const align = alignOf(cell.content?.[0]) ?? (NUMERIC.test(text) ? 'right' : undefined)

      for (let y = r; y < r + down; y++) {
        for (let x = column; x < column + across; x++) {
          grid[y][x] = y === r && x === column ? { text, ...(align ? { align } : {}) } : { text: '' }
        }
      }

      if (across > 1 || down > 1) {
        merges.push({ startRow: r, startColumn: column, endRow: r + down - 1, endColumn: column + across - 1 })
      }

      column += across
    }
  })

  const columns = Math.min(MAX_COLUMNS, Math.max(0, ...grid.map((row) => row.length)))
  const cells = grid.map((row) => Array.from({ length: columns }, (_, column) => row[column] ?? { text: '' }))
  const head = rows[0]?.content ?? []
  const header = head.length > 0 && head.every((cell) => cell.type === 'tableHeader')
  const kept = merges.filter((merge) => merge.startColumn < columns).map((merge) => ({ ...merge, endColumn: Math.min(columns - 1, merge.endColumn) }))

  return columns ? [{ kind: 'table', cells, merges: kept, header }] : []
}

/** A section's blocks as what its slides show, in order. */
function itemsOf(blocks: readonly DocNode[], lists: { count: number }): Item[] {
  return blocks.flatMap((block): Item[] => {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        return paragraphItems(block)
      case 'image': {
        const picture = pictureOf(block)

        return picture ? [{ kind: 'picture', picture }] : []
      }
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        return listItems(block, 0, lists)
      case 'blockquote':
        return quoteItems(block)
      case 'codeBlock':
        return codeItems(block)
      case 'table':
        return tableItems(block)
      case 'callout':
        return itemsOf(block.content ?? [], lists)
      default:
        return []
    }
  })
}

/**
 * The document's title and subtitle, and which blocks they were: a Title paragraph before the
 * first heading, else the first heading when it heads the document (no other heading is at its
 * level or above), else `fallback`, else the first heading. The subtitle is a Subtitle paragraph
 * before the first section, else a short paragraph straight after the title.
 */
function titleOf(blocks: readonly DocNode[], fallback?: string): { title: string; subtitle: string; used: Set<number> } {
  const headings = blocks.flatMap((block, index) => (isHeading(block) ? [index] : []))
  const titled = blocks.findIndex((block, index) => index < (headings[0] ?? blocks.length) && styled(block, 'title'))
  const heads = headings.length > 0 && headings.every((index) => index === headings[0] || levelOf(blocks[index]) > levelOf(blocks[headings[0]]))
  const source = titled >= 0 ? titled : headings.length && (heads || fallback === undefined) ? headings[0] : -1
  const used = new Set(source >= 0 ? [source] : [])
  const sections = headings.find((index) => !used.has(index)) ?? blocks.length
  const subtitled = blocks.findIndex((block, index) => index < sections && !used.has(index) && styled(block, 'subtitle'))
  let next = source + 1

  while (source >= 0 && next < sections && emptyParagraph(blocks[next])) {
    next++
  }

  const short = subtitled < 0 && source >= 0 && next < sections ? shortText(blocks[next]) : null
  const subtitle = subtitled >= 0 ? textOf(blocks[subtitled]).trim() : (short ?? '')

  if (subtitled >= 0 || short !== null) {
    used.add(subtitled >= 0 ? subtitled : next)
  }

  return { title: source >= 0 ? textOf(blocks[source]).trim() : (fallback ?? ''), subtitle, used }
}

// Laying out text.

/** About how tall a paragraph is in a placeholder: its lines at the placeholder's text size, and the space after it. */
const paragraphHeight = (text: string, width: number, fit: Fit): number => lineCount(text, width, fit.size) * fit.size * LINE + fit.spaceAfter

/** The room a text element gives its paragraphs: its box less its insets, at its text size. */
function fitOf(element: TextElement | ShapeElement): Fit {
  const [left, top, right, bottom] = element.body.inset

  return { width: Math.max(1, element.width - left - right), height: Math.max(1, element.height - top - bottom), size: element.body.style.size, spaceAfter: element.body.paragraphs[0]?.spaceAfter ?? 0 }
}

/** The runs' first `end` characters, then `tail`. */
function sliceRuns(runs: readonly TextRun[], end: number, tail: string): TextRun[] {
  const out: TextRun[] = []
  let at = 0

  for (const run of runs) {
    if (at < end) {
      out.push({ ...run, text: run.text.slice(0, end - at) })
    }

    at += run.text.length
  }

  const last = out[out.length - 1]

  if (last) {
    last.text = `${last.text.trimEnd()}${tail}`
  }

  return tidyRuns(out)
}

/** The largest of ascending `candidates` that `fits` (which holds up to some candidate and for none after it); 0 when none does. */
function largest(candidates: readonly number[], fits: (candidate: number) => boolean): number {
  let low = 0
  let high = candidates.length - 1
  let found = 0

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)

    if (fits(candidates[middle])) {
      found = candidates[middle]
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  return found
}

/** Runs cut to fit `fit`: after the last sentence that fits (then " …") when that keeps most of what fits, else after the last word (then "…"). */
function shortenRuns(runs: readonly TextRun[], width: number, fit: Fit): TextRun[] {
  const text = runsText(runs)
  const room = Math.max(1, Math.floor(fit.height / (fit.size * LINE)))
  const fits = (end: number) => lineCount(`${text.slice(0, end).trimEnd()} …`, width, fit.size) <= room
  const breaks = [...text.matchAll(/\s+/g)].map((match) => match.index ?? 0).filter((index) => index > 0)
  // A first word too long for the room is cut where the lines run out.
  const end = largest(breaks, fits) || Math.max(1, largest(Array.from({ length: text.length }, (_, index) => index + 1), fits))
  const sentence = Math.max(0, ...[...text.slice(0, end).matchAll(/[.!?…]["”’)]?(?=\s|$)/g)].map((match) => (match.index ?? 0) + match[0].length))

  return sentence > end / 2 ? sliceRuns(runs, sentence, ' …') : sliceRuns(runs, end, '…')
}

/** Bullets in slides' worth, as many as each slide's placeholder holds: a paragraph never splits between slides, and one too long for a slide of its own is shortened. */
function chunked(bullets: readonly Bullet[], fit: Fit): Chunk[] {
  const chunks: Chunk[] = []
  let used = 0

  for (const bullet of bullets) {
    const width = fit.width - LIST_INDENT * (bullet.level + 1)
    const cut = paragraphHeight(runsText(bullet.runs), width, fit) - fit.spaceAfter > fit.height
    const shown = cut ? { ...bullet, runs: shortenRuns(bullet.runs, width, fit) } : bullet
    const height = paragraphHeight(runsText(shown.runs), width, fit)
    const last = chunks[chunks.length - 1]

    if (last && used + height - fit.spaceAfter <= fit.height) {
      last.bullets.push(shown)
      last.shortened ||= cut
      used += height
    } else {
      chunks.push({ bullets: [shown], shortened: cut })
      used = height
    }
  }

  return chunks
}

/** A text element's paragraph settings (spacing, alignment), without runs or list markers. */
function settingsOf(element: TextElement | ShapeElement): Omit<Paragraph, 'runs'> {
  const first: Paragraph = element.body.paragraphs[0] ?? { runs: [] }
  const { runs: _runs, bullet: _bullet, numbering: _numbering, startAt: _start, ...settings } = first

  return settings
}

/** A text element holding bullets; a numbered list counts on from the number its first item here has. */
function withBullets<T extends TextElement | ShapeElement>(element: T, bullets: readonly Bullet[]): T {
  const settings = settingsOf(element)
  const starts = new Map<number, number>()
  const paragraphs = bullets.map((bullet): Paragraph => {
    const order = bullet.order

    if (order && !starts.has(order.list)) {
      starts.set(order.list, order.n)
    }

    const start = order ? (starts.get(order.list) ?? 1) : 1

    return {
      ...settings,
      list: bullet.list,
      level: bullet.level,
      ...(bullet.glyph ? { bullet: bullet.glyph } : {}),
      ...(order?.numbering ? { numbering: order.numbering } : {}),
      ...(start !== 1 ? { startAt: start } : {}),
      runs: bullet.runs
    }
  })

  return { ...element, body: { ...element.body, paragraphs } }
}

/** A text element holding one paragraph of runs, in its first paragraph's settings without a list. */
function withRuns<T extends TextElement | ShapeElement>(element: T, runs: readonly TextRun[]): T {
  const { list: _list, level: _level, ...settings } = settingsOf(element)

  return { ...element, body: { ...element.body, paragraphs: [{ ...settings, runs: [...runs] }] } }
}

/** The largest box of a picture's proportions inside `box`, in its middle. */
function inside(natural: { width: number; height: number }, box: Box): Box {
  const ratio = natural.width > 0 && natural.height > 0 ? natural.width / natural.height : 4 / 3
  const width = Math.min(box.width, box.height * ratio)
  const height = width / ratio

  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height }
}

/** Lines in quotation marks, unless they open with one already. */
function quoted(lines: readonly string[]): string[] {
  if (!lines.length || /^["“'‘«]/.test(lines[0])) {
    return [...lines]
  }

  return lines.map((line, index) => `${index === 0 ? '“' : ''}${line}${index === lines.length - 1 ? '”' : ''}`)
}

// Making the slides.

const slideOf = (place: Place, layout: LayoutId, title: string): Slide => withPlaceholderText(newSlide(layout, place.size, place.master), 'title', title)

const altRuns = (picture: Picture): TextRun[] => (picture.alt ? [{ text: picture.alt }] : [])

/** A slide's text placeholder, or a text box in its content area when its layout has none. */
function bodyOf(place: Place, slide: Slide): { slide: Slide; body: TextElement | ShapeElement } {
  const found = placeholderFor(slide, 'body')

  if (isText(found)) {
    return { slide, body: found }
  }

  const body = textElement(contentArea(place, slide).box, textBody({ font: '+body', size: 24, color: 'tx1' }, { fit: 'shrink', paragraph: { list: 'bullet', spaceAfter: 6 } }))

  return { slide: { ...slide, elements: [...slide.elements, body] }, body }
}

/** Bullets on Title and Content slides, as many as fit each; a slide with a bullet shortened to fit has the section's text as its notes. */
function textSlides(place: Place, title: string, bullets: readonly Bullet[], notes: string, goesOn: boolean): Slide[] {
  if (!bullets.length) {
    return []
  }

  const slideFor = (index: number) => bodyOf(place, slideOf(place, 'title-content', index || goesOn ? continued(title) : title))
  const first = slideFor(0)

  return chunked(bullets, fitOf(first.body)).map((chunk, index) => {
    const { slide, body } = index ? slideFor(index) : first

    return { ...slide, elements: slide.elements.map((element) => (element.id === body.id ? withBullets(body, chunk.bullets) : element)), notes: chunk.shortened ? notes : '' }
  })
}

/** One picture beside text on a Two Content slide (text left, the picture fitted into the right); null when the text does not fit its column. */
function twoContentSlide(place: Place, title: string, bullets: readonly Bullet[], picture: Picture): Slide | null {
  const slide = slideOf(place, 'two-content', title)
  const left = placeholderFor(slide, 'body', 0)
  const right = placeholderFor(slide, 'body', 1)

  if (!bullets.length || !isText(left) || !right) {
    return null
  }

  const chunks = chunked(bullets, fitOf(left))

  if (chunks.length > 1 || chunks[0].shortened) {
    return null
  }

  const image = imageElement(picture.src, picture.natural, inside(picture.natural, right), picture.alt ? { alt: picture.alt } : {})

  return { ...slide, elements: [...slide.elements.flatMap((element) => (element.id === right.id ? [] : [element.id === left.id ? withBullets(left, chunks[0].bullets) : element])), image] }
}

/** A Picture with Caption slide: the picture cut to fill its frame, its caption beside it (shortened, with the section's text as notes, when too long). */
function pictureSlide(place: Place, title: string, picture: Picture, caption: readonly TextRun[], notes: string): Slide {
  const slide = slideOf(place, 'picture-caption', title)
  const frame = placeholderFor(slide, 'picture')
  const text = placeholderFor(slide, 'caption')
  const fit = isText(text) ? fitOf(text) : null
  const shortened = fit !== null && caption.length > 0 && paragraphHeight(runsText(caption), fit.width, fit) - fit.spaceAfter > fit.height
  const runs = fit && shortened ? shortenRuns(caption, fit.width, fit) : [...caption]
  const alt = picture.alt ? { alt: picture.alt } : {}
  const elements = slide.elements.map((element): SlideElement => {
    if (element.id === frame?.id && element.kind === 'image') {
      const crop = coverCrop(picture.natural, element)

      return { ...element, src: picture.src, natural: picture.natural, ...(crop ? { crop } : {}), ...alt }
    }

    return element.id === text?.id && isText(element) && runs.length ? withRuns(element, runs) : element
  })
  const placed = frame?.kind === 'image' ? elements : [...elements, imageElement(picture.src, picture.natural, inside(picture.natural, contentArea(place, slide).box), alt)]

  return { ...slide, elements: placed, notes: shortened ? notes : '' }
}

/** Pictures with nothing between them but a short paragraph after each, as the pictures and their captions (that paragraph, else the alt text); null when there is other text. */
function captionedPictures(items: readonly Item[]): { picture: Picture; caption: TextRun[] }[] | null {
  const out: { picture: Picture; caption: TextRun[] }[] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const next = items[i + 1]

    if (item.kind !== 'picture') {
      return null
    }

    const caption = next?.kind === 'bullet' && next.bullet.plain && runsText(next.bullet.runs).length <= SHORT ? next.bullet.runs : null
    out.push({ picture: item.picture, caption: caption ?? altRuns(item.picture) })
    i += caption ? 1 : 0
  }

  return out.length ? out : null
}

/**
 * Text and pictures: pictures alone on Picture with Caption slides; one picture with text that
 * fits beside it on a Two Content slide; else the text on slides of bullets, then each picture on
 * a slide of its own captioned with its alt text.
 */
function flowSlides(place: Place, title: string, items: readonly Item[], notes: string, goesOn: boolean): { slides: Slide[]; text: boolean } {
  const bullets = items.flatMap((item) => (item.kind === 'bullet' ? [item.bullet] : []))
  const pictures = items.flatMap((item) => (item.kind === 'picture' ? [item.picture] : []))
  const captioned = captionedPictures(items)

  if (captioned) {
    return { slides: captioned.map(({ picture, caption }) => pictureSlide(place, title, picture, caption, notes)), text: false }
  }

  const beside = pictures.length === 1 ? twoContentSlide(place, goesOn ? continued(title) : title, bullets, pictures[0]) : null

  if (beside) {
    return { slides: [beside], text: true }
  }

  return { slides: [...textSlides(place, title, bullets, notes, goesOn), ...pictures.map((picture) => pictureSlide(place, title, picture, altRuns(picture), notes))], text: bullets.length > 0 }
}

/** A table under the title of Title Only slides, its rows going on over further slides under the header row when there are too many for one. */
function tableSlides(place: Place, title: string, table: TableItem): Slide[] {
  const first = slideOf(place, 'title-only', title)

  return tablesFor(table.cells, table.merges, contentArea(place, first).box, { header: table.header, split: true }).map((element, index) => {
    const slide = index ? slideOf(place, 'title-only', continued(title)) : first

    return { ...slide, elements: [...slide.elements, element] }
  })
}

/** A quote large on a Title Only slide, in quotation marks at the largest size from 40 points down to 24 that it fits, who said it under it. */
function quoteSlide(place: Place, title: string, quote: QuoteItem, notes: string): Slide {
  const slide = slideOf(place, 'title-only', title)
  const { box } = contentArea(place, slide)
  const [left, top, right, bottom] = DEFAULT_INSET
  const width = box.width - left - right
  const by = quote.by ? `— ${quote.by}` : ''
  const bySize = (size: number) => Math.max(16, Math.round(size * 0.55))
  const room = (size: number) => box.height - top - bottom - (by ? lineCount(by, width, bySize(size)) * bySize(size) * LINE + size / 2 : 0)
  const needs = (size: number, lines: readonly string[]) => total(lines.map((line) => lineCount(line, width, size))) * size * LINE
  const size = QUOTE_SIZES.find((candidate) => needs(candidate, quoted(quote.lines)) <= room(candidate)) ?? QUOTE_SIZES[QUOTE_SIZES.length - 1]
  const shortened = needs(size, quoted(quote.lines)) > room(size)
  const lines = quoted(shortened ? runsText(shortenRuns([{ text: quote.lines.join('\n') }], width, { width, height: room(size), size, spaceAfter: 0 })).split('\n') : quote.lines)
  const attribution: Paragraph[] = by ? [{ align: 'center', spaceBefore: size / 2, runs: [{ text: by, size: bySize(size), italic: false, color: 'tx2' }] }] : []
  const body = textBody({ font: '+body', size, color: 'tx1', italic: true }, { anchor: 'middle', fit: 'shrink' })
  const paragraphs = [...lines.map((line): Paragraph => ({ align: 'center', runs: [{ text: line }] })), ...attribution]

  return { ...slide, elements: [...slide.elements, textElement(box, { ...body, paragraphs })], notes: shortened ? notes : '' }
}

/** Code in a monospace box on Title Only slides, a paragraph a line, at the largest size from 20 points down to 12 that it fits; code too long for a slide at 12 points goes on over further ones. */
function codeSlides(place: Place, title: string, code: CodeItem): Slide[] {
  const first = slideOf(place, 'title-only', title)
  const { box } = contentArea(place, first)
  const [left, top, right, bottom] = CODE_INSET
  const width = box.width - left - right
  const height = box.height - top - bottom
  const longest = Math.max(1, ...code.lines.map((line) => [...line].length))
  const across = (size: number) => Math.max(1, Math.floor(width / (size * CODE_CHARACTER)))
  const rows = (line: string, size: number) => Math.max(1, Math.ceil([...line].length / across(size)))
  const tall = (lines: readonly string[], size: number) => total(lines.map((line) => rows(line, size))) * size * LINE
  const size = CODE_SIZES.find((candidate) => longest <= across(candidate) && tall(code.lines, candidate) <= height) ?? CODE_SIZES[CODE_SIZES.length - 1]
  const chunks: string[][] = [[]]
  let used = 0

  for (const line of code.lines) {
    const chunk = chunks[chunks.length - 1]
    const lines = rows(line, size)

    if (chunk.length && (used + lines) * size * LINE > height) {
      chunks.push([line])
      used = lines
    } else {
      chunk.push(line)
      used += lines
    }
  }

  return chunks.map((lines, index) => {
    const slide = index ? slideOf(place, 'title-only', continued(title)) : first
    const body = textBody({ font: CODE_FONT, size, color: 'tx1' }, { inset: CODE_INSET, fit: 'shrink' })
    const element = textElement({ ...box, height: Math.min(box.height, tall(lines, size) + top + bottom) }, { ...body, paragraphs: lines.map((line): Paragraph => ({ align: 'left', runs: [{ text: line }] })) }, { fill: { color: 'bg2' } })

    return { ...slide, elements: [...slide.elements, element] }
  })
}

/**
 * A section's slides: its text as bullets, with its pictures beside it or on slides of their own,
 * then each table, quote and code block on a slide of its own, in the order the document has them.
 * Slides that go on with the section's text, a table or code are titled "… (continued)".
 */
function contentSlides(place: Place, title: string, blocks: readonly DocNode[]): Slide[] {
  const items = itemsOf(blocks, { count: 0 })
  const notes = blocks
    .map(textOf)
    .filter((text) => text.trim())
    .join('\n')
  const slides: Slide[] = []
  let flow: Item[] = []
  let goesOn = false
  const flush = () => {
    if (flow.length) {
      const made = flowSlides(place, title, flow, notes, goesOn)
      slides.push(...made.slides)
      goesOn ||= made.text
    }

    flow = []
  }

  for (const item of items) {
    if (item.kind === 'bullet' || item.kind === 'picture') {
      flow.push(item)
      continue
    }

    flush()

    if (item.kind === 'table') {
      slides.push(...tableSlides(place, title, item))
    } else if (item.kind === 'quote') {
      slides.push(quoteSlide(place, title, item, notes))
    } else {
      slides.push(...codeSlides(place, title, item))
    }
  }

  flush()

  return slides
}

/** The slides a document makes on a deck of `place`'s size and master, its title slide first, and the title it gives the deck. */
function documentSlides(doc: DocJSON, place: Place, fallback?: string): { title: string; slides: Slide[] } {
  const blocks = doc.content ?? []
  const { title, subtitle, used } = titleOf(blocks, fallback)
  const intro: DocNode[] = []
  const sections: Section[] = []

  blocks.forEach((block, index) => {
    if (used.has(index)) {
      return
    }

    if (isHeading(block)) {
      sections.push({ title: textOf(block).trim(), level: levelOf(block), blocks: [] })
    } else {
      ;(sections.length ? sections[sections.length - 1].blocks : intro).push(block)
    }
  })

  const top = Math.min(...sections.map((section) => section.level))
  const slides = [withPlaceholderText(slideOf(place, 'title', title), 'subtitle', subtitle), ...contentSlides(place, title, intro)]

  sections.forEach((section, index) => {
    const deeper = (sections[index + 1]?.level ?? 0) > section.level
    const content = section.blocks.filter((block) => !emptyParagraph(block))

    if ((section.level === top && deeper) || (!itemsOf(content, { count: 0 }).length && !deeper)) {
      // A section header's subtitle is its heading's one short paragraph.
      const lead = content.length === 1 ? shortText(content[0]) : null
      slides.push(withPlaceholderText(slideOf(place, 'section', section.title), 'subtitle', lead ?? ''), ...(lead === null ? contentSlides(place, section.title, section.blocks) : []))
    } else {
      slides.push(...contentSlides(place, section.title, section.blocks))
    }
  })

  return { title, slides }
}

/**
 * A deck made from a document by rule. A title slide comes first, from the document's title (a
 * Title paragraph, else the heading that heads the document, else `title`, else its first
 * heading) and subtitle (a Subtitle paragraph, else a short paragraph straight after the title);
 * what comes before the first heading goes on the slides after it. A top-level heading with
 * headings under it, or a heading with nothing under it, makes a Section Header; a heading's text
 * makes Title and Content slides of bullets (list levels kept), going on over "… (continued)"
 * slides as it needs. A picture alone goes on a Picture with Caption slide, one with text beside it
 * on a Two Content slide; tables, quotes and code get Title Only slides of their own.
 */
export function deckFromDocument(doc: DocJSON, options: { title?: string; theme?: Theme; size?: SlideSize } = {}): Deck {
  const deck = newDeck(options.title ?? '', { size: options.size, theme: options.theme })
  const { title, slides } = documentSlides(doc, deck, options.title)

  return { ...deck, title, slides }
}

/** A document's slides, as `deckFromDocument` makes them, in a deck after `after` (at the end without one) as one step; without a title of its own, the document has no title slide. */
export function slidesFromDocument(deck: Deck, doc: DocJSON, options: { after?: string | null } = {}): DeckChange & { slideIds: string[] } {
  const [opening, ...rest] = documentSlides(doc, deck).slides
  const slides = opening.elements.every(isEmptyPlaceholder) ? rest : [opening, ...rest]
  const label = 'Slides from Document'

  if (!slides.length) {
    return { deck, label, slideIds: [] }
  }

  return { deck: insertSlides(deck, slides, options.after), label, slideIds: slides.map((slide) => slide.id), focus: { slideId: slides[0].id, selected: [] } }
}
