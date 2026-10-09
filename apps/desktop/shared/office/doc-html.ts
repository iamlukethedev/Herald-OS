import { type CalloutKind, cssLineHeight, DEFAULT_HEADER_DISTANCE, type DocJSON, type DocMark, type DocNode, headersOf, type HeaderKind, looksOf, noteLabel, type NoteKind, notesOf, pageOf, pagePart, type PageSettings, round, type StyleLook, type StyleName, tocEntries, walk } from './document.ts'
import { fieldText } from './fields.ts'

/*
 * A Herald Docs document as HTML and CSS: the print view main turns into a PDF, and the styles the
 * editor's page uses, so that what prints is what the page shows. Pages are paper whatever the
 * theme: black text on white. The print view lays each page out as the page view measured it
 * (its header, its part of the text, its footnotes and its footer), or, without those
 * measurements, lets the text flow over pages as Chromium breaks them.
 */

export const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const SERIF = /times|georgia|garamond|cambria|caladea|book|palatino|baskerville|serif|minion|charter|didot|bodoni|merriweather|lora|playfair|tinos/i
const MONO = /mono|consol|courier|menlo|monaco|code|cousine|inconsolata/i

/** Faces that measure like Word's, for a machine without Word's fonts (Linux, mostly). */
const LOOKALIKES: Record<string, string[]> = {
  calibri: ['Carlito'],
  cambria: ['Caladea'],
  arial: ['Liberation Sans', 'Arimo'],
  helvetica: ['Liberation Sans', 'Arimo'],
  'times new roman': ['Liberation Serif', 'Tinos'],
  'courier new': ['Liberation Mono', 'Cousine'],
  aptos: ['Calibri', 'Carlito']
}

const quoted = (name: string): string => (/^[\w-]+$/.test(name) && !/^\d/.test(name) ? name : `"${name.replace(/["\\]/g, '')}"`)

/** A font name with what to fall back on: faces that measure alike, then faces of the same kind. */
export function fontStack(name: string | null | undefined): string {
  const font = (name ?? '').trim()
  const fallback = MONO.test(font) ? ['Menlo', 'Consolas', 'DejaVu Sans Mono', 'monospace'] : SERIF.test(font) ? ['Georgia', 'Times New Roman', 'Liberation Serif', 'serif'] : ['Helvetica Neue', 'Arial', 'Liberation Sans', 'sans-serif']
  const names = [...(font ? [font] : []), ...(LOOKALIKES[font.toLowerCase()] ?? []), ...fallback]

  return [...new Set(names)].map((entry) => (['serif', 'sans-serif', 'monospace'].includes(entry) ? entry : quoted(entry))).join(', ')
}

function lookRules(look: StyleLook, inherited?: StyleLook): string {
  const rules: string[] = []

  if (look.font && look.font !== inherited?.font) {
    rules.push(`font-family: ${fontStack(look.font)}`)
  }

  if (look.size) {
    rules.push(`font-size: ${look.size}pt`)
  }

  if (look.color) {
    rules.push(`color: ${look.color}`)
  }

  if (look.bold !== undefined) {
    rules.push(`font-weight: ${look.bold ? 700 : 400}`)
  }

  if (look.italic !== undefined) {
    rules.push(`font-style: ${look.italic ? 'italic' : 'normal'}`)
  }

  if (look.lineHeight) {
    rules.push(`line-height: ${cssLineHeight(look.lineHeight)}`)
  }

  if (look.spaceBefore !== undefined || look.spaceAfter !== undefined) {
    rules.push(`margin: ${round(look.spaceBefore ?? 0)}pt 0 ${round(look.spaceAfter ?? 0)}pt`)
  }

  return rules.join('; ')
}

const HEADING_SELECTORS: [StyleName, string][] = [1, 2, 3, 4, 5, 6].map((level) => [`heading${level}` as StyleName, `h${level}`])

/** The document's own typography, under `scope`: its styles' fonts, sizes, colours and spacing. */
export function looksCss(doc: DocNode, scope: string): string {
  const looks = looksOf(doc)
  const normal = looks.normal
  const rule = (selector: string, body: string) => (body ? `${selector.split(',').map((part) => `${scope} ${part.trim()}`).join(', ')} { ${body} }` : '')

  return [
    `${scope} { ${lookRules({ ...normal, font: normal.font ?? 'Arial', spaceBefore: undefined, spaceAfter: undefined })} }`,
    rule('p', lookRules({ spaceBefore: normal.spaceBefore ?? 0, spaceAfter: normal.spaceAfter ?? 0 })),
    rule('p[data-style="title"]', lookRules(looks.title, normal)),
    rule('p[data-style="subtitle"]', lookRules(looks.subtitle, normal)),
    ...HEADING_SELECTORS.map(([name, selector]) => rule(selector, lookRules(looks[name], normal))),
    rule('blockquote', lookRules({ ...looks.quote, spaceBefore: undefined, spaceAfter: undefined }, normal)),
    rule('pre', lookRules({ ...looks.code, bold: undefined, italic: undefined, spaceBefore: undefined, spaceAfter: undefined }, normal)),
    rule('code', `font-family: ${fontStack(looks.code.font)}`)
  ]
    .filter(Boolean)
    .join('\n')
}

const CALLOUT_COLORS: Record<CalloutKind, [string, string]> = {
  info: ['#2f7dff', '#eaf2ff'],
  note: ['#7c5cff', '#f1edff'],
  success: ['#1f9d55', '#e8f6ee'],
  warning: ['#d99a00', '#fff5dc'],
  error: ['#e5484d', '#fdeceb']
}

/** How content looks under `scope` on the page and on paper: lists, tables, callouts, pictures, code. */
export function contentCss(scope: string, medium: 'screen' | 'print'): string {
  const s = (selector: string) =>
    selector
      .split(',')
      .map((part) => `${scope} ${part.trim()}`)
      .join(', ')

  return [
    `${s('p:empty::before')} { content: ''; display: inline-block }`,
    `${s('h1, h2, h3, h4, h5, h6')} { page-break-after: avoid; break-after: avoid }`,
    `${s('ul, ol')} { margin: 0 0 6pt; padding-left: 24pt }`,
    `${s('ul')} { list-style: disc }`,
    `${s('ul ul')} { list-style: circle }`,
    `${s('ul ul ul')} { list-style: square }`,
    `${s('ol')} { list-style: decimal }`,
    `${s('ol[type="a"]')} { list-style-type: lower-alpha }`,
    `${s('ol[type="A"]')} { list-style-type: upper-alpha }`,
    `${s('ol[type="i"]')} { list-style-type: lower-roman }`,
    `${s('ol[type="I"]')} { list-style-type: upper-roman }`,
    `${s('li > p')} { margin-top: 0; margin-bottom: 0 }`,
    `${s('li + li')} { margin-top: 2pt }`,
    `${s('li > ul, li > ol')} { margin-bottom: 0 }`,
    `${s('ul[data-type="taskList"]')} { list-style: none; padding-left: 4pt }`,
    `${s('ul[data-type="taskList"] > li')} { display: flex; gap: 6pt; align-items: flex-start }`,
    `${s('ul[data-type="taskList"] > li > label')} { flex: none; user-select: none; line-height: inherit }`,
    `${s('ul[data-type="taskList"] > li > div')} { flex: 1; min-width: 0 }`,
    `${s('ul[data-type="taskList"] > li[data-checked="true"] > div')} { color: #6b7280; text-decoration: line-through }`,
    `${s('blockquote')} { margin: 6pt 0; padding: 2pt 0 2pt 12pt; border-left: 3pt solid #c8ced8 }`,
    `${s('pre')} { margin: 6pt 0; background: #f4f5f7; border-radius: 4pt; padding: 6pt 8pt; white-space: pre-wrap; overflow-wrap: anywhere }`,
    `${s('pre code')} { font-size: inherit; background: none; padding: 0 }`,
    `${s(':not(pre) > code')} { background: #f1f2f4; border-radius: 3pt; padding: 0 2pt; font-size: 0.92em }`,
    `${s('a')} { color: #1155cc; text-decoration: underline }`,
    `${s('mark')} { background-color: #fff27a; color: inherit }`,
    `${s('hr')} { border: 0; border-top: 1pt solid #c8ced8; margin: 10pt 0 }`,
    `${s('img')} { max-width: 100%; height: auto; vertical-align: bottom }`,
    `${s('table')} { border-collapse: collapse; margin: 6pt 0; max-width: 100% }`,
    `${s('.tableWrapper')} { display: flow-root }`,
    `${s('td, th')} { border: 0.75pt solid #9aa3b2; padding: 3pt 6pt; vertical-align: top; text-align: left; min-width: 1em; position: relative }`,
    `${s('th')} { background: #f2f4f7; font-weight: 700 }`,
    `${s('td > :first-child, th > :first-child')} { margin-top: 0 }`,
    `${s('td > :last-child, th > :last-child')} { margin-bottom: 0 }`,
    // Guides on screen take the room the missing borders would, so the page and the paper lay out alike.
    `${s('table[data-borders="none"] td, table[data-borders="none"] th')} { border: 0.75pt ${medium === 'screen' ? 'dashed #d5dae2' : 'solid transparent'} }`,
    `${s('table[data-borders="none"] th')} { background: none }`,
    `${s('.doc-callout')} { margin: 8pt 0; padding: 6pt 10pt; border-left: 4pt solid; border-radius: 4pt }`,
    ...Object.entries(CALLOUT_COLORS).map(([kind, [line, fill]]) => `${s(`.doc-callout[data-callout="${kind}"]`)} { border-color: ${line}; background: ${fill} }`),
    `${s('.doc-callout > :first-child')} { margin-top: 0 }`,
    `${s('.doc-callout > :last-child')} { margin-bottom: 0 }`,
    `${s('.doc-text-box')} { display: flow-root; box-sizing: border-box; margin: 6pt 0; padding: 4pt 6pt }`,
    `${s('.doc-text-box[data-align="left"]')} { float: left; margin: 2pt 9pt 6pt 0 }`,
    `${s('.doc-text-box[data-align="right"]')} { float: right; margin: 2pt 0 6pt 9pt }`,
    `${s('.doc-text-box[data-align="center"]')} { margin-left: auto; margin-right: auto }`,
    `${s('.doc-text-box > :first-child')} { margin-top: 0 }`,
    `${s('.doc-text-box > :last-child')} { margin-bottom: 0 }`,
    ...(medium === 'screen' ? [`${s('.doc-text-box:not([data-border])')} { outline: 0.75pt dashed #c8ced8; outline-offset: -0.75pt }`] : []),
    `${s('.doc-note-ref, .doc-note-label')} { font-size: 0.7em; line-height: 0; vertical-align: super }`,
    `${s('.doc-note')} { font-size: 10pt; line-height: ${cssLineHeight(1)} }`,
    `${s('.doc-note p, .doc-note h1, .doc-note h2, .doc-note h3, .doc-note h4, .doc-note h5, .doc-note h6')} { margin: 0; font-size: inherit }`,
    `${s('.doc-note-label')} { margin-right: 2pt }`,
    `${s('.doc-notes-rule')} { width: 144pt; max-width: 40%; height: 0; border-top: 0.75pt solid #000; margin: 0 0 4pt }`,
    `${s('.doc-endnotes')} { margin-top: 18pt }`,
    // Breaks and tables of contents never let margins collapse through them, so pages line up after them alike on screen and on paper.
    `${s('.doc-page-break, .doc-section-break, .doc-toc')} { display: flow-root }`,
    `${s('.doc-toc')} { margin: 6pt 0 }`,
    `${s('.doc-toc-title')} { margin: 0 0 6pt; font-weight: 700; font-size: 1.15em }`,
    `${s('.doc-toc-entry')} { margin: 0 0 3pt }`,
    ...[2, 3, 4, 5, 6].map((level) => `${s(`.doc-toc-entry[data-level="${level}"]`)} { padding-left: ${(level - 1) * 12}pt }`),
    `${s('.doc-toc-entry a')} { display: flex; align-items: baseline; gap: 4pt; color: inherit; text-decoration: none }`,
    `${s('.doc-toc-dots')} { flex: 1; min-width: 12pt; border-bottom: 1pt dotted currentColor }`,
    `${s('.doc-toc-page')} { flex: none; min-width: 1.5em; text-align: right }`,
    medium === 'print'
      ? `${s('.doc-page-break')} { break-after: page; page-break-after: always; height: 0; margin: 0; border: 0 }`
      : `${s('.doc-page-break, .doc-section-break')} { position: relative; height: 0; margin: 0; border: 0 }`,
    medium === 'print'
      ? `${s('.doc-section-break:not([data-section-break="continuous"])')} { break-after: page; page-break-after: always; height: 0; margin: 0 }`
      : `${s('.ProseMirror-selectednode.doc-page-break::after, .ProseMirror-selectednode.doc-section-break::after')} { content: 'Page break'; position: absolute; left: 0; right: 0; top: 2pt; padding: 1px 0; border-top: 1px dashed var(--color-accent, #2f7dff); color: var(--color-accent, #2f7dff); font: 500 10px/1.4 system-ui, sans-serif; letter-spacing: 0.04em; text-align: center; text-transform: uppercase }`,
    ...(medium === 'screen' ? [`${s('.ProseMirror-selectednode.doc-section-break::after')} { content: 'Section break' }`] : []),
    ...(medium === 'print' ? [`${s('tr, img, li, .doc-callout, pre')} { break-inside: avoid }`] : [])
  ].join('\n')
}

/** How headers, footers and the notes at a page's foot look on the page and on paper, under `prefix` (the page's scope). */
export function partCss(prefix: string): string {
  const p = prefix ? `${prefix} ` : ''

  return [
    `${p}.doc-part { overflow-wrap: break-word; white-space: pre-wrap; tab-size: 36pt }`,
    ...['header', 'footer'].map((part) => `${p}.doc-part.doc-${part} p, ${p}.doc-part.doc-${part} h1, ${p}.doc-part.doc-${part} h2, ${p}.doc-part.doc-${part} h3 { margin-top: 0; margin-bottom: 0 }`),
    `${p}.doc-part.doc-footnotes { padding-top: 6pt }`
  ].join('\n')
}

// The print view.

/** What a part of a document is shown with: its page and the page count for fields, the notes and headings before it, and what a table of contents lists. */
export interface HtmlContext {
  page?: number
  pages?: number
  now?: Date
  locale?: string
  /** The footnotes and endnotes before it, so that references go on numbering. */
  notes?: { footnote: number; endnote: number }
  /** The headings before it, and whether headings carry anchors for a table of contents' links. */
  headings?: number
  anchors?: boolean
  /** The whole document, for a table of contents, and the page each of its headings is on. */
  doc?: DocJSON
  headingPages?: readonly number[]
}

interface Render {
  context: HtmlContext
  footnote: number
  endnote: number
  heading: number
}

const render = (context: HtmlContext = {}): Render => ({ context, footnote: context.notes?.footnote ?? 0, endnote: context.notes?.endnote ?? 0, heading: context.headings ?? 0 })

const style = (rules: (string | false | null | undefined)[]): string => {
  const kept = rules.filter(Boolean)

  return kept.length ? ` style="${escapeHtml(kept.join('; '))}"` : ''
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** A block a page starts or ends inside is marked, so its continuation shows no second indent, marker or edge. */
const cut = (node: DocNode): string[] => [node.attrs?.continued === true ? 'doc-continued' : '', node.attrs?.continues === true ? 'doc-continues' : ''].filter(Boolean)

const classes = (names: readonly string[]): string => (names.length ? ` class="${names.join(' ')}"` : '')

function blockStyle(node: DocNode): string {
  const attrs = node.attrs ?? {}
  const align = typeof attrs.textAlign === 'string' && attrs.textAlign !== 'left' ? attrs.textAlign : null

  return style([
    align && `text-align: ${align}`,
    num(attrs.lineHeight) !== null && `line-height: ${cssLineHeight(num(attrs.lineHeight)!)}`,
    num(attrs.spaceBefore) !== null && `margin-top: ${attrs.spaceBefore}pt`,
    num(attrs.spaceAfter) !== null && `margin-bottom: ${attrs.spaceAfter}pt`,
    num(attrs.indent) !== null && `margin-left: ${attrs.indent}pt`,
    num(attrs.firstLine) !== null && `text-indent: ${attrs.firstLine}pt`
  ])
}

const SAFE_LINK = /^(https?:|mailto:|tel:|#)/i

function wrapMark(mark: DocMark, html: string): string {
  const attrs = mark.attrs ?? {}

  switch (mark.type) {
    case 'bold':
      return `<strong>${html}</strong>`
    case 'italic':
      return `<em>${html}</em>`
    case 'underline':
      return `<u>${html}</u>`
    case 'strike':
      return `<s>${html}</s>`
    case 'superscript':
      return `<sup>${html}</sup>`
    case 'subscript':
      return `<sub>${html}</sub>`
    case 'code':
      return `<code>${html}</code>`
    case 'highlight':
      return `<mark${style([typeof attrs.color === 'string' && `background-color: ${attrs.color}`])}>${html}</mark>`
    case 'link': {
      const href = String(attrs.href ?? '')

      return SAFE_LINK.test(href) ? `<a href="${escapeHtml(href)}">${html}</a>` : html
    }
    case 'textStyle': {
      const rules = style([
        typeof attrs.color === 'string' && `color: ${attrs.color}`,
        typeof attrs.fontFamily === 'string' && `font-family: ${fontStack(attrs.fontFamily)}`,
        typeof attrs.fontSize === 'string' && `font-size: ${attrs.fontSize}`
      ])

      return rules ? `<span${rules}>${html}</span>` : html
    }
    default:
      return html
  }
}

/** Marks from the outside in, so a link holds the formatting inside it. */
const MARK_ORDER = ['link', 'textStyle', 'highlight', 'bold', 'italic', 'underline', 'strike', 'superscript', 'subscript', 'code']

const marked = (node: DocNode, html: string): string => [...(node.marks ?? [])].sort((a, b) => MARK_ORDER.indexOf(b.type) - MARK_ORDER.indexOf(a.type)).reduce((out, mark) => wrapMark(mark, out), html)

function inlineHtml(node: DocNode, state: Render): string {
  const attrs = node.attrs ?? {}

  switch (node.type) {
    case 'hardBreak':
      return '<br>'
    case 'image': {
      const src = String(attrs.src ?? '')

      if (!/^(data:image\/|https?:)/i.test(src)) {
        return ''
      }

      const width = num(attrs.width)
      const height = num(attrs.height)

      // Sized as the editor sizes it, so that its line is as tall on paper.
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(String(attrs.alt ?? ''))}"${style([width !== null && `width: ${width}px`, width !== null && height !== null && `height: ${height}px`])}>`
    }
    case 'field': {
      const { page, pages, now, locale } = state.context

      return marked(node, `<span class="doc-field">${escapeHtml(fieldText(attrs, { page, pages, now, locale }))}</span>`)
    }
    case 'note': {
      const kind: NoteKind = attrs.kind === 'endnote' ? 'endnote' : 'footnote'
      const number = kind === 'endnote' ? ++state.endnote : ++state.footnote

      return marked(node, `<sup class="doc-note-ref" data-note="${kind}">${noteLabel(kind, number)}</sup>`)
    }
    default:
      return marked(node, escapeHtml(node.text ?? ''))
  }
}

const inline = (node: DocNode, state: Render, lead = ''): string => lead + (node.content ?? []).map((child) => inlineHtml(child, state)).join('') || '<br>'

function cellHtml(cell: DocNode, state: Render): string {
  const attrs = cell.attrs ?? {}
  const tag = cell.type === 'tableHeader' ? 'th' : 'td'
  const colspan = Number(attrs.colspan ?? 1)
  const rowspan = Number(attrs.rowspan ?? 1)

  return `<${tag}${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}${style([typeof attrs.background === 'string' && `background-color: ${attrs.background}`, typeof attrs.align === 'string' && `text-align: ${attrs.align}`])}>${blocksHtml(cell.content, state)}</${tag}>`
}

/** The narrowest an editor's table column is drawn. */
const CELL_MIN_WIDTH = 36

/** A table sized as the editor sizes it: columns set at least the narrowest width, others growing from it. */
function tableHtml(table: DocNode, state: Render): string {
  const first = table.content?.[0]?.content ?? []
  const widths = first.flatMap((cell) => {
    const spans = Math.max(1, Number(cell.attrs?.colspan ?? 1))
    const given = Array.isArray(cell.attrs?.colwidth) ? (cell.attrs.colwidth as unknown[]) : []

    return Array.from({ length: spans }, (_, index) => num(given[index]))
  })
  const fixed = widths.every((width) => width)
  const total = widths.reduce<number>((sum, width) => sum + (width || CELL_MIN_WIDTH), 0)
  const columns = widths.map((width) => `<col style="${width ? `width: ${Math.max(width, CELL_MIN_WIDTH)}px` : `min-width: ${CELL_MIN_WIDTH}px`}">`).join('')
  const rows = (table.content ?? []).map((row) => `<tr>${(row.content ?? []).map((cell) => cellHtml(cell, state)).join('')}</tr>`).join('')

  return `<div${classes(['tableWrapper', ...cut(table)])}><table${table.attrs?.borders === false ? ' data-borders="none"' : ''} style="${fixed ? 'width' : 'min-width'}: ${round(total)}px"><colgroup>${columns}</colgroup><tbody>${rows}</tbody></table></div>`
}

/** A table of contents: its title, then an entry for each heading it lists with a dotted leader to its page, linked to the heading. */
function tocHtml(node: DocNode, state: Render): string {
  const attrs = node.attrs ?? {}
  const levels = Math.min(6, Math.max(1, Math.round(Number(attrs.levels)) || 3))
  const title = typeof attrs.title === 'string' && attrs.title ? attrs.title : null
  const known = Array.isArray(attrs.pages) ? (attrs.pages as unknown[]) : []
  const { doc, headingPages } = state.context
  const entries = (doc ? tocEntries(doc, levels) : []).map((entry, index) => {
    const page = headingPages?.[entry.heading] ?? num(known[index])

    return `<p class="doc-toc-entry" data-level="${entry.level}"><a href="#doc-heading-${entry.heading}"><span class="doc-toc-text">${escapeHtml(entry.text)}</span><span class="doc-toc-dots"></span><span class="doc-toc-page">${page ?? ''}</span></a></p>`
  })

  return `<div class="doc-toc" data-toc="${levels}">${title ? `<p class="doc-toc-title">${escapeHtml(title)}</p>` : ''}${entries.join('')}</div>`
}

function blockHtml(node: DocNode, state: Render, lead = ''): string {
  const attrs = node.attrs ?? {}
  const own = cut(node)

  switch (node.type) {
    case 'paragraph': {
      const docStyle = attrs.docStyle === 'title' || attrs.docStyle === 'subtitle' ? ` data-style="${attrs.docStyle}"` : ''

      return `<p${classes(own)}${docStyle}${blockStyle(node)}>${inline(node, state, lead)}</p>`
    }
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(attrs.level ?? 1)))
      const id = state.context.anchors ? ` id="doc-heading-${state.heading}"` : ''
      state.heading++

      return `<h${level}${id}${classes(own)}${blockStyle(node)}>${inline(node, state, lead)}</h${level}>`
    }
    case 'blockquote':
      return `<blockquote${classes(own)}>${blocksHtml(node.content, state)}</blockquote>`
    case 'callout':
      return `<div${classes(['doc-callout', ...own])} data-callout="${escapeHtml(String(attrs.kind ?? 'info'))}">${blocksHtml(node.content, state)}</div>`
    case 'codeBlock':
      return `<pre${classes(own)}><code>${escapeHtml((node.content ?? []).map((child) => child.text ?? '').join(''))}</code></pre>`
    case 'bulletList':
      return `<ul${classes(own)}>${blocksHtml(node.content, state)}</ul>`
    case 'orderedList': {
      const start = Number(attrs.start ?? 1)
      const type = typeof attrs.type === 'string' && /^[1aAiI]$/.test(attrs.type) ? ` type="${attrs.type}"` : ''

      return `<ol${classes(own)}${start !== 1 ? ` start="${start}"` : ''}${type}>${blocksHtml(node.content, state)}</ol>`
    }
    case 'listItem':
      return `<li${classes(own)}>${blocksHtml(node.content, state)}</li>`
    case 'taskList':
      return `<ul${classes(own)} data-type="taskList">${blocksHtml(node.content, state)}</ul>`
    case 'taskItem': {
      const checked = attrs.checked === true

      return `<li${classes(own)} data-type="taskItem" data-checked="${checked}"><label>${checked ? '☑' : '☐'}</label><div>${blocksHtml(node.content, state)}</div></li>`
    }
    case 'table':
      return tableHtml(node, state)
    case 'horizontalRule':
      return '<hr>'
    case 'pageBreak':
      return '<div class="doc-page-break"></div>'
    case 'sectionBreak':
      return `<div class="doc-section-break" data-section-break="${escapeHtml(String(attrs.kind ?? 'nextPage'))}"></div>`
    case 'tableOfContents':
      return tocHtml(node, state)
    case 'textBox': {
      const width = num(attrs.width)
      const height = num(attrs.height)
      const align = attrs.align === 'left' || attrs.align === 'center' || attrs.align === 'right' ? ` data-align="${attrs.align}"` : ''
      const border = typeof attrs.border === 'string' ? attrs.border : null
      const fill = typeof attrs.fill === 'string' ? attrs.fill : null
      const look = style([width !== null && `width: ${width}pt`, height !== null && `min-height: ${height}pt`, border && `border: 0.75pt solid ${border}`, fill && `background: ${fill}`])

      return `<div${classes(['doc-text-box', ...own])} data-text-box=""${align}${border ? ` data-border="${escapeHtml(border)}"` : ''}${look}>${blocksHtml(node.content, state)}</div>`
    }
    default:
      return blocksHtml(node.content, state)
  }
}

const blocksHtml = (nodes: readonly DocNode[] = [], state: Render = render()): string => nodes.map((node) => blockHtml(node, state)).join('')

/** The document's content as HTML (no page around it). */
export const htmlFromDocument = (doc: DocJSON, context: HtmlContext = {}): string => blocksHtml(doc.content, render(context))

/** The blocks of a header or a footer as HTML, their fields showing `context`'s page. */
export const partHtml = (blocks: readonly DocNode[], context: HtmlContext = {}): string => blocksHtml(blocks, render(context))

/** A table of contents as the print view draws it, listing `context.doc`'s headings with the pages in `context.headingPages`. */
export const tocBlockHtml = (node: DocNode, context: HtmlContext = {}): string => tocHtml(node, render(context))

/** A footnote or endnote as listed under its rule: its number at the start of its first paragraph, as Word puts it, then its text. */
export function noteHtml(kind: NoteKind, number: number, content: readonly DocNode[], context: HtmlContext = {}): string {
  const state = render(context)
  const label = `<sup class="doc-note-label">${noteLabel(kind, number)}</sup>`
  const [first, ...rest] = content.length ? content : [{ type: 'paragraph' }]
  const lead = first.type === 'paragraph' || first.type === 'heading' ? blockHtml(first, state, label) : `<p>${label}</p>${blockHtml(first, state)}`

  return `<div class="doc-note" data-note="${kind}" data-number="${number}">${lead}${blocksHtml(rest, state)}</div>`
}

/** A document's endnotes (or, without pages to put them at the foot of, its footnotes) after its text, under a rule; nothing when it has none. */
export function endnotesHtml(doc: DocJSON, context: HtmlContext = {}, kind: NoteKind = 'endnote'): string {
  const notes = notesOf(doc).filter((note) => note.kind === kind)

  return notes.length ? `<div class="doc-endnotes"><div class="doc-notes-rule"></div>${notes.map((note) => noteHtml(kind, note.number, note.content, context)).join('')}</div>` : ''
}

/** A page of the print view as the page view laid it out. */
export interface PrintPage {
  number: number
  kind: HeaderKind
  page: PageSettings
  /** Its part of the document, cut where the page starts and ends, and the notes and headings before that part. */
  blocks: DocNode[]
  notes: { footnote: number; endnote: number }
  headings: number
  footnotes: { number: number; content: DocNode[] }[]
  /** The endnotes that fall on it, and whether their rule does. */
  endnotes: { number: number; content: DocNode[] }[]
  endnoteRule: boolean
  /** From the top edge to its text, and from the end of its text to the bottom edge, in CSS pixels (a tall header or footer pushes these in). */
  bodyTop: number
  bodyBottom: number
}

const PX = 96 / 72

const px = (value: number): string => `${round(value, 2)}px`

function pageHtml(doc: DocJSON, entry: PrintPage, count: number, size: number, headingPages: readonly number[]): string {
  const { page } = entry
  const { margins } = page
  const across = `left: ${px(margins.left * PX)}; width: ${px(Math.max(24, (page.width - margins.left - margins.right) * PX))}`
  const fields: HtmlContext = { page: entry.number, pages: count }
  const headers = headersOf(doc)
  const part = (name: 'header' | 'footer', place: string) => {
    const blocks = pagePart(headers, name, entry.number)

    return blocks ? `<div class="doc-part doc-${name}" data-page-part="${name}" style="${place}; ${across}">${partHtml(blocks, fields)}</div>` : ''
  }
  const notes = (kind: NoteKind, list: PrintPage['footnotes']) => list.map((note) => noteHtml(kind, note.number, note.content, fields)).join('')
  const body = htmlFromDocument({ type: 'doc', content: entry.blocks }, { ...fields, notes: entry.notes, headings: entry.headings, anchors: true, doc, headingPages })
  const endnotes = entry.endnotes.length ? `<div class="doc-endnotes${entry.endnoteRule ? '' : ' doc-continued'}">${entry.endnoteRule ? '<div class="doc-notes-rule"></div>' : ''}${notes('endnote', entry.endnotes)}</div>` : ''
  const footnotes = entry.footnotes.length ? `<div class="doc-part doc-footnotes" style="bottom: ${px(entry.bodyBottom)}; ${across}"><div class="doc-notes-rule"></div>${notes('footnote', entry.footnotes)}</div>` : ''
  const header = part('header', `top: ${px((margins.header ?? DEFAULT_HEADER_DISTANCE) * PX)}`)
  const footer = part('footer', `bottom: ${px((margins.footer ?? DEFAULT_HEADER_DISTANCE) * PX)}`)

  return `<section class="doc-page"${size ? ` data-size="${size}"` : ''} style="width: ${page.width}pt; height: ${page.height}pt">${header}<div class="doc doc-page-body" style="top: ${px(entry.bodyTop)}; ${across}">${body}${endnotes}</div>${footnotes}${footer}</section>`
}

/** What a page that starts or ends inside a block leaves out of it: the second first-line indent, list marker, space or edge. */
const CUT_CSS = [
  '.doc-continued { margin-top: 0 !important; padding-top: 0 !important; border-top-width: 0 !important; border-top-left-radius: 0 !important; border-top-right-radius: 0 !important; text-indent: 0 !important }',
  '.doc-continues { margin-bottom: 0 !important; padding-bottom: 0 !important; border-bottom-width: 0 !important; border-bottom-left-radius: 0 !important; border-bottom-right-radius: 0 !important }',
  'li.doc-continued { list-style-type: none }',
  'li.doc-continued > label { visibility: hidden }',
  '.tableWrapper.doc-continued > table { margin-top: 0 }',
  '.tableWrapper.doc-continues > table { margin-bottom: 0 }'
]

/** A self-contained page main prints to PDF. With the page view's pages, each is a page of its own, as on screen; without them the text flows over pages of the document's size. */
export function printView(doc: DocJSON, title: string, pages?: readonly PrintPage[]): string {
  if (!pages?.length) {
    return flowView(doc, title)
  }

  const sizes: string[] = []
  const sizeOf = (page: PageSettings): number => {
    const key = `${page.width}pt ${page.height}pt`

    if (!sizes.includes(key)) {
      sizes.push(key)
    }

    return sizes.indexOf(key)
  }
  let headingCount = 0
  walk(doc, (node) => {
    if (node.type === 'heading') {
      headingCount++
    }
  })
  const headingPages: number[] = []
  pages.forEach((entry, index) => {
    for (let heading = entry.headings; heading < (pages[index + 1]?.headings ?? headingCount); heading++) {
      headingPages[heading] = entry.number
    }
  })
  const body = pages.map((entry) => pageHtml(doc, entry, pages.length, sizeOf(entry.page), headingPages)).join('')
  const scope = ':is(.doc, .doc-part)'
  const css = [
    `@page { size: ${sizes[0]}; margin: 0 }`,
    ...sizes.slice(1).map((size, index) => `@page size${index + 1} { size: ${size}; margin: 0 } .doc-page[data-size="${index + 1}"] { page: size${index + 1} }`),
    'html, body { margin: 0; padding: 0; background: #fff; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact }',
    // Each page box is exactly a page, never split, so the PDF has the page view's pages.
    '.doc-page { position: relative; overflow: hidden; contain: size layout paint; break-after: page; page-break-after: always }',
    '.doc-page:last-child { break-after: auto; page-break-after: auto }',
    '.doc-page > div { position: absolute; box-sizing: border-box }',
    '.doc { overflow-wrap: break-word; white-space: pre-wrap; tab-size: 36pt }',
    '.doc-page + .doc-page .doc-page-body > :first-child { margin-top: 0 }',
    '.doc-page .doc-page-break, .doc-page .doc-section-break { break-after: auto !important; page-break-after: auto !important }',
    ...CUT_CSS,
    looksCss(doc, scope),
    contentCss(scope, 'print'),
    partCss('')
  ].join('\n')

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${css}</style></head><body>${body}</body></html>`
}

/** The print view without the page view's pages: the document's page size and margins, its text flowing over pages as Chromium breaks them. */
function flowView(doc: DocJSON, title: string): string {
  const page = pageOf(doc)
  const { margins } = page
  let anchors = false
  walk(doc, (node) => {
    anchors ||= node.type === 'tableOfContents'
  })
  const css = [
    `@page { size: ${page.width}pt ${page.height}pt; margin: ${margins.top}pt ${margins.right}pt ${margins.bottom}pt ${margins.left}pt }`,
    'html, body { margin: 0; padding: 0; background: #fff; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact }',
    '.doc { overflow-wrap: break-word; white-space: pre-wrap; tab-size: 36pt }',
    looksCss(doc, '.doc'),
    contentCss('.doc', 'print')
  ].join('\n')

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${css}</style></head><body><div class="doc">${htmlFromDocument(doc, { anchors, doc })}${endnotesHtml(doc, {}, 'footnote')}${endnotesHtml(doc)}</div></body></html>`
}
