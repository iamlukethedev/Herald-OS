import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { type EditorState, Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { noteHtml, partHtml } from '../../../../../shared/office/doc-html.ts'
import { type DocNode, HEADER_KINDS, type HeaderKind, headerKindFor, type NoteKind, type PageHeaders, pagePart, round } from '../../../../../shared/office/document.ts'
import { type ChromePage, type NoteTarget, PageChrome, type PartTarget } from './chrome.ts'
import { fieldViewsOf, showField } from './fields.ts'
import { bodyOf, type Frame, type Section, sectionAt, sectionsOfDoc, textWidthOf } from './geometry.ts'
import { type Page, paginate } from './layout.ts'
import { type PageEntry, type PageMap, pageAt, pagesOf } from './map.ts'
import { lineStart, measureFlow, type Ref } from './measure.ts'

/*
 * Herald Docs' pages on screen, in the one editor: the text runs down a single column, and a
 * spacer where each page starts (before a block, in a paragraph before a line, or before a table
 * row) moves what follows down to the next page's text area. A run measures the column with the
 * spacers hidden, works out the pages, then sets the spacers (in place when only their heights
 * change), the paper behind with each page's header, footer and footnotes, and a clip that shows
 * the text only where pages have text. It runs once in the frame after a change, and again when
 * fonts or pictures load or the zoom changes.
 */

export interface PagesHost {
  /** The zoomed sheet the pages are drawn on, the layer behind the text, and the column the editor is in. */
  sheet: HTMLElement
  layer: HTMLElement
  mount: HTMLElement
}

export interface NoteEdit {
  kind: NoteKind
  number: number
  /** Where its reference is in the document. */
  pos: number
  rect: DOMRect
}

export interface PagesOptions {
  host: PagesHost | null
  zoom: () => number
  onLayout: ((layout: PageLayout) => void) | null
  onPartEdit: ((edit: PartTarget) => void) | null
  onNoteEdit: ((edit: NoteEdit) => void) | null
}

export interface LaidPage extends PageEntry {
  frame: Frame
  /** In the sheet, in CSS pixels. */
  top: number
  left: number
  /** From the top edge to the text, and from the end of the text to the bottom edge. */
  bodyTop: number
  bodyBottom: number
  /** Its footnotes by number and the height they take at its foot, and the endnotes on it. */
  footnotes: number[]
  notesHeight: number
  endnotes: number[]
  endnoteRule: boolean
  overflow: number
}

export interface PageLayout {
  pages: LaidPage[]
  map: PageMap
  /** How long the run took in milliseconds, and the zoom it measured at. */
  time: number
  zoom: number
}

interface Widget {
  key: string
  kind: 'block' | 'line' | 'row'
  pos: number
  columns: number
  size: number
}

interface Scan {
  notes: { offset: number; kind: NoteKind; content: DocNode[] }[]
  headings: number[]
}

interface Inventory {
  footnotes: { pos: number; content: DocNode[] }[]
  endnotes: { pos: number; content: DocNode[] }[]
  headings: number[]
}

const pagesKey = new PluginKey<DecorationSet>('docsPages')

const paginators = new WeakMap<EditorView, Paginator>()

export const paginatorOf = (view: EditorView): Paginator | null => paginators.get(view) ?? null

/** The desk between pages, in CSS pixels. */
const GAP = 20

/** Glyphs reach a little past their lines: text shows this far beyond a page's text area. */
const BLEED = 3

/** Runs in a row that may follow fields changing what they show. */
const SETTLE_RUNS = 3

const px = (value: number): string => `${round(value)}px`

const scans = new WeakMap<PMNode, Scan>()

/** The notes and headings in a top-level block, kept for as long as the block is unchanged. */
function scanOf(node: PMNode): Scan {
  const known = scans.get(node)

  if (known) {
    return known
  }

  const scan: Scan = { notes: [], headings: node.type.name === 'heading' ? [0] : [] }
  node.descendants((child, offset) => {
    if (child.type.name === 'note') {
      scan.notes.push({ offset: offset + 1, kind: child.attrs.kind === 'endnote' ? 'endnote' : 'footnote', content: (child.attrs.content as DocNode[] | null) ?? [] })
    } else if (child.type.name === 'heading') {
      scan.headings.push(offset + 1)
    }
  })
  scans.set(node, scan)

  return scan
}

function inventoryOf(doc: PMNode): Inventory {
  const out: Inventory = { footnotes: [], endnotes: [], headings: [] }
  doc.forEach((node, offset) => {
    const scan = scanOf(node)

    for (const note of scan.notes) {
      const list = note.kind === 'endnote' ? out.endnotes : out.footnotes
      list.push({ pos: offset + note.offset, content: note.content })
    }

    for (const heading of scan.headings) {
      out.headings.push(offset + heading)
    }
  })

  return out
}

function hash(text: string): string {
  let value = 5381

  for (let index = 0; index < text.length; index++) {
    value = ((value << 5) + value + text.charCodeAt(index)) | 0
  }

  return (value >>> 0).toString(36)
}

function sizeSpacer(element: HTMLElement, kind: Widget['kind'], size: number): void {
  if (kind === 'block') {
    element.style.marginTop = px(size)
  } else if (kind === 'row') {
    const cell = element.firstElementChild as HTMLElement | null
    cell?.style.setProperty('height', px(size))
  } else {
    element.style.height = px(size)
  }
}

/** A clip of the column to each page's text area, the pages joined down their left edges by lines of no width. */
function clipOf(bands: readonly { left: number; right: number; top: number; bottom: number }[]): string {
  if (!bands.length) {
    return 'none'
  }

  const points: string[] = []
  const at = (x: number, y: number) => points.push(`${px(x)} ${px(y)}`)

  for (const band of bands) {
    at(band.left, band.top)
    at(band.right, band.top)
    at(band.right, band.bottom)
    at(band.left, band.bottom)
  }

  for (let index = bands.length - 1; index >= 0; index--) {
    at(bands[index].left, bands[index].top)

    if (index) {
      at(bands[index - 1].left, bands[index - 1].bottom)
    }
  }

  return `polygon(${points.join(', ')})`
}

export class Paginator {
  layout: PageLayout | null = null
  private frameId = 0
  private skipped = false
  private destroyed = false
  private width = 0
  private readonly chrome: PageChrome | null
  private readonly spacers = new Map<string, HTMLElement>()
  private readonly sizes = new Map<string, number>()
  private endnoteSpacers: HTMLElement[] = []
  private endnotes: HTMLElement | null = null
  private readonly heights = new Map<string, number>()
  private shape = ''
  private clip = ''
  private padTop = 0
  private settling = 0
  private inventory: Inventory = { footnotes: [], endnotes: [], headings: [] }
  private parts = new Map<string, string>()
  private partsOf: PageHeaders | null = null
  private readonly observer: ResizeObserver | null

  constructor(
    private readonly view: EditorView,
    private readonly options: PagesOptions
  ) {
    const { host } = options
    this.chrome = host ? new PageChrome(host.layer, { part: (target) => options.onPartEdit?.(target), note: (target) => this.editNote(target) }) : null
    this.firstPaint()
    document.fonts?.addEventListener('loadingdone', this.onFonts)
    void document.fonts?.ready.then(this.schedule)
    view.dom.addEventListener('load', this.schedule, true)
    view.dom.addEventListener('compositionend', this.onCompositionEnd)
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(this.onResize)
    this.observer?.observe(view.dom)
    this.schedule()
  }

  /** Lay the pages out in the next frame (once, however many changes come before it). */
  readonly schedule = (): void => {
    if (this.destroyed || this.frameId) {
      return
    }

    this.frameId = requestAnimationFrame(() => {
      this.frameId = 0
      this.run()
    })
  }

  private readonly onFonts = () => {
    this.heights.clear()
    this.schedule()
  }

  private readonly onCompositionEnd = () => {
    if (this.skipped) {
      this.schedule()
    }
  }

  private readonly onResize = (entries: ResizeObserverEntry[]) => {
    const width = entries[entries.length - 1]?.contentRect.width ?? 0

    if (this.skipped || Math.abs(width - this.width) > 0.5) {
      this.width = width
      this.schedule()
    }
  }

  update(prev: EditorState): void {
    if (this.view.state.doc !== prev.doc) {
      this.schedule()
    }
  }

  /** One page of the document's size before the first run, so the first frame shows paper. */
  private firstPaint(): void {
    const host = this.options.host

    if (!host) {
      return
    }

    const [section] = sectionsOfDoc(this.view.state.doc)
    const { frame } = section
    this.padTop = frame.top
    Object.assign(host.sheet.style, { width: px(frame.width), height: px(frame.height) })
    Object.assign(host.mount.style, { marginLeft: px(frame.left), width: px(textWidthOf(frame)), paddingTop: px(frame.top) })
    this.chrome?.draw([this.chromePage({ number: 1, kind: 'default', frame, top: 0, left: 0, bodyTop: frame.top, bodyBottom: frame.bottom }, null, 1, '')])
  }

  /** Measure the column and lay the pages out now; null when it cannot be measured (hidden, or in the middle of composing). */
  run(): PageLayout | null {
    const { view, options } = this
    const host = options.host

    if (this.destroyed || view.isDestroyed || !host) {
      return null
    }

    if (view.composing) {
      this.skipped = true

      return null
    }

    const started = performance.now()
    const zoom = options.zoom() || 1
    const { doc } = view.state
    const sections = sectionsOfDoc(doc)
    const headers = (doc.attrs.headers as PageHeaders | null) ?? null
    const inventory = inventoryOf(doc)
    const sheetWidth = Math.max(...sections.map((section) => section.frame.width))
    this.inventory = inventory
    this.shapeColumn(doc, sections, sheetWidth, inventory)
    const partHeight = this.partHeights(sections, headers, zoom)
    const sectionOfPos = (pos: number) => (sections.length > 1 ? sectionAt(sections, doc.resolve(Math.min(pos, doc.content.size)).index(0)) : 0)
    const notes = this.noteHeights(inventory, sections, sectionOfPos, zoom)
    host.mount.classList.add('docs-measuring')
    let pages: Page<Ref>[]
    let starts: (number | null)[]

    try {
      const rect = host.mount.getBoundingClientRect()

      if (!rect.width || !rect.height) {
        this.skipped = true

        return null
      }

      const origin = rect.top + this.padTop * zoom
      const refs = this.footnoteRefs(inventory)
      const marks = refs.map((element, index) => {
        const box = element?.getBoundingClientRect()

        return { y: box ? ((box.top + box.bottom) / 2 - origin) / zoom : Number.NEGATIVE_INFINITY, note: index + 1 }
      })
      const boxes = measureFlow({ view, origin, zoom, notes: marks }, sections)
      pages = paginate(boxes, {
        room: (number, section) => {
          const { frame } = sections[section]
          const kind = headerKindFor(headers, number)
          const body = bodyOf(frame, partHeight(section, 'header', kind), partHeight(section, 'footer', kind))

          return frame.height - body.top - body.bottom
        },
        noteHeight: (note) => notes.heights[note - 1] ?? 0,
        noteRule: notes.rule
      })
      starts = pages.map((page) => {
        const ref = page.ref

        if (!ref) {
          return page.kind === 'first' ? 0 : null
        }

        switch (ref.kind) {
          case 'line':
            return lineStart(view, ref.element, ref.boundary) ?? ref.pos + 1
          case 'endnote':
            return doc.content.size
          default:
            return ref.pos
        }
      })
    } finally {
      host.mount.classList.remove('docs-measuring')
    }

    this.skipped = false
    const count = pages.length
    const base = sections[0].frame
    const columnLeft = (sheetWidth - base.width) / 2 + base.left
    const laid: LaidPage[] = []
    const widgets: Widget[] = []
    const endnoteSpacers: { element: HTMLElement; size: number }[] = []
    let shift = 0
    let origin = 0

    pages.forEach((page, index) => {
      const { frame } = sections[page.section]
      const number = index + 1
      const kind = headerKindFor(headers, number)
      const body = bodyOf(frame, partHeight(page.section, 'header', kind), partHeight(page.section, 'footer', kind))
      const notesHeight = page.notes.length ? notes.rule + page.notes.reduce((sum, note) => sum + (notes.heights[note - 1] ?? 0), 0) : 0
      const previous = laid[index - 1]
      let top = previous ? previous.top + previous.frame.height + GAP : 0
      const ref = page.ref

      if (!previous) {
        origin = body.top
      } else if (ref && ref.kind !== 'end') {
        const blockLike = ref.kind === 'block' || ref.kind === 'endnote'
        let size = top + body.top - (origin + (blockLike ? page.before : page.top) + shift)

        // What runs past the page before pushes this one down.
        if (size < 0) {
          top -= size
          size = 0
        }

        if (ref.kind === 'endnote') {
          endnoteSpacers.push({ element: ref.element, size })
        } else {
          const columns = ref.kind === 'row' ? ref.columns : 0
          widgets.push({ key: `p${index}:${ref.kind}:${columns}`, kind: ref.kind === 'block' ? 'block' : ref.kind, pos: starts[index] ?? 0, columns, size })
        }

        shift += blockLike ? size - (page.top - page.before) : size
      }

      laid.push({ number, kind, section: page.section, blank: page.kind === 'blank', frame, top, left: (sheetWidth - frame.width) / 2, bodyTop: body.top, bodyBottom: body.bottom, footnotes: page.notes, notesHeight, endnotes: [], endnoteRule: false, overflow: page.overflow, from: 0, to: 0 })
    })

    let next = doc.content.size

    for (let index = laid.length - 1; index >= 0; index--) {
      laid[index].to = next
      laid[index].from = index ? Math.min(next, starts[index] ?? next) : 0
      next = laid[index].from
    }

    this.placeEndnotes(laid, pages.map((page) => (page.ref?.kind === 'endnote' ? page.ref.element : null)))
    const entries = laid.map(({ number, from, to, kind, section, blank }) => ({ number, from, to, kind, section, blank }))
    const footnotes: number[] = []
    laid.forEach((page) => page.footnotes.forEach((note) => (footnotes[note - 1] = page.number)))
    const map: PageMap = { pages: entries, headings: pagesOf({ pages: entries, headings: [], footnotes: [] }, inventory.headings), footnotes }

    this.setSpacers(widgets, endnoteSpacers)
    this.padTop = origin
    const last = laid[laid.length - 1]
    Object.assign(host.sheet.style, { width: px(sheetWidth), height: px(last.top + last.frame.height) })
    Object.assign(host.mount.style, { marginLeft: px(columnLeft), width: px(textWidthOf(base)), paddingTop: px(origin) })
    const clip = clipOf(
      laid
        .filter((page) => !page.blank)
        .map((page) => ({
          left: page.left - columnLeft,
          right: page.left - columnLeft + page.frame.width,
          top: page.top + page.bodyTop - BLEED,
          bottom: page.top + page.frame.height - page.bodyBottom - page.notesHeight + Math.max(0, page.overflow) + BLEED
        }))
    )

    if (clip !== this.clip) {
      this.clip = clip
      host.mount.style.clipPath = clip
    }

    this.chrome?.draw(laid.map((page) => this.chromePage(page, headers, count, this.footnotesHtml(page, count))))
    let changed = false

    for (const field of fieldViewsOf(view)) {
      const pos = field.pos()
      changed = showField(field, pos === undefined ? undefined : pageAt(map, pos)?.number, count) || changed
    }

    this.settling = changed && this.settling < SETTLE_RUNS ? this.settling + 1 : 0

    if (this.settling) {
      this.schedule()
    }

    this.layout = { pages: laid, map, time: performance.now() - started, zoom }
    options.onLayout?.(this.layout)

    return this.layout
  }

  /** The decorations that shape the column before it is measured: other sections' text widths, and the endnotes after the text. */
  private shapeColumn(doc: PMNode, sections: readonly Section[], sheetWidth: number, inventory: Inventory): void {
    const decorations: Decoration[] = []
    const base = sections[0].frame
    const baseLeft = (sheetWidth - base.width) / 2 + base.left
    const baseWidth = textWidthOf(base)
    let shape = ''

    sections.forEach((section, index) => {
      const left = (sheetWidth - section.frame.width) / 2 + section.frame.left - baseLeft
      const width = textWidthOf(section.frame)

      if (Math.abs(left) < 0.5 && Math.abs(width - baseWidth) < 0.5) {
        return
      }

      const end = sections[index + 1]?.start ?? doc.childCount
      const style = `margin-right: ${px(baseWidth - width)}; position: relative; left: ${px(left)}`
      let pos = 0

      for (let child = 0; child < end; child++) {
        const size = doc.child(child).nodeSize

        if (child >= section.start) {
          decorations.push(Decoration.node(pos, pos + size, { style }, { section: true }))
          shape += `${pos}:${size}:${style};`
        }

        pos += size
      }
    })

    if (inventory.endnotes.length) {
      const html = `<div class="doc-notes-rule"></div>${inventory.endnotes.map((note, index) => noteHtml('endnote', index + 1, note.content)).join('')}`
      const key = `endnotes:${hash(html)}`
      decorations.push(Decoration.widget(doc.content.size, () => this.endnotesDom(html), { key, side: 1, ignoreSelection: true, stopEvent: (event: Event) => event.type.startsWith('mouse') || event.type === 'dblclick' }))
      shape += key
    }

    // A new state (a version loaded from disk) starts without them, and blocks added to a section lack theirs.
    const current = pagesKey.getState(this.view.state)
    const stale = (current?.find(undefined, undefined, (spec) => spec.spacer !== true).length ?? 0) !== decorations.length

    if (shape === this.shape && !stale) {
      return
    }

    this.shape = shape
    const spacers = current?.find(undefined, undefined, (spec) => spec.spacer === true) ?? []
    this.view.dispatch(this.view.state.tr.setMeta(pagesKey, DecorationSet.create(this.view.state.doc, [...decorations, ...spacers])).setMeta('addToHistory', false))
  }

  private endnotesDom(html: string): HTMLElement {
    const element = document.createElement('div')
    element.className = 'doc-endnotes'
    element.innerHTML = html
    element.addEventListener('dblclick', (event) => {
      const note = event.target instanceof Element ? event.target.closest<HTMLElement>('.doc-note') : null

      if (note) {
        this.editNote({ kind: 'endnote', number: Number(note.dataset.number) || 1, rect: note.getBoundingClientRect() })
      }
    })
    this.endnotes = element
    this.endnoteSpacers = []

    return element
  }

  /** Heights of the headers and footers each section's pages show, measured at its text width. */
  private partHeights(sections: readonly Section[], headers: PageHeaders | null, zoom: number): (section: number, part: 'header' | 'footer', kind: HeaderKind) => number {
    const keys = new Map<string, string>()
    const wanted: { key: string; html: string; width: number; className: string }[] = []

    sections.forEach((section, index) => {
      const width = textWidthOf(section.frame)

      for (const part of ['header', 'footer'] as const) {
        for (const kind of HEADER_KINDS) {
          const blocks = headers?.[part]?.[kind]

          if (!blocks?.length) {
            continue
          }

          const html = partHtml(blocks, { page: 1, pages: 1 })
          const key = `${part}|${round(width)}|${html}`
          keys.set(`${index}|${part}|${kind}`, key)

          if (!this.heights.has(key) && !wanted.some((entry) => entry.key === key)) {
            wanted.push({ key, html, width, className: `doc-${part}` })
          }
        }
      }
    })

    this.remember(wanted, zoom)

    return (section, part, kind) => this.heights.get(keys.get(`${section}|${part}|${kind}`) ?? '') ?? 0
  }

  /** Each footnote's height, and that of the rule above a page's footnotes, measured at its section's text width. */
  private noteHeights(inventory: Inventory, sections: readonly Section[], sectionOfPos: (pos: number) => number, zoom: number): { heights: number[]; rule: number } {
    if (!inventory.footnotes.length) {
      return { heights: [], rule: 0 }
    }

    const ruleWidth = textWidthOf(sections[0].frame)
    const ruleKey = `rule|${round(ruleWidth)}`
    const keys = inventory.footnotes.map((note, index) => {
      const width = textWidthOf(sections[sectionOfPos(note.pos)].frame)
      const html = noteHtml('footnote', index + 1, note.content)

      return { key: `note|${round(width)}|${html}`, html, width, className: '' }
    })
    this.remember([{ key: ruleKey, html: '<div class="doc-notes-rule"></div>', width: ruleWidth, className: 'doc-footnotes' }, ...keys].filter((entry) => !this.heights.has(entry.key)), zoom)

    return { heights: keys.map((entry) => this.heights.get(entry.key) ?? 0), rule: this.heights.get(ruleKey) ?? 0 }
  }

  private remember(wanted: readonly { key: string; html: string; width: number; className: string }[], zoom: number): void {
    if (!wanted.length || !this.chrome) {
      return
    }

    this.chrome.measure(wanted, zoom).forEach((height, index) => this.heights.set(wanted[index].key, height))
  }

  /** The footnote references in the text, in order. */
  private footnoteRefs(inventory: Inventory): (HTMLElement | null)[] {
    if (!inventory.footnotes.length) {
      return []
    }

    const found = [...this.view.dom.querySelectorAll<HTMLElement>('.doc-note-ref[data-note="footnote"]')].filter((element) => !element.closest('.doc-endnotes'))

    if (found.length === inventory.footnotes.length) {
      return found
    }

    return inventory.footnotes.map((note) => {
      const dom = this.view.nodeDOM(note.pos)

      return dom instanceof HTMLElement ? dom : null
    })
  }

  /** Which pages the endnotes fall on: from the page the text ends on, each page after starting at one of them. */
  private placeEndnotes(laid: LaidPage[], startsAt: readonly (HTMLElement | null)[]): void {
    const items = this.endnotes ? [...this.endnotes.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.classList.contains('docs-page-spacer')) : []

    if (!items.length || !this.inventory.endnotes.length) {
      return
    }

    const firstStart = startsAt.findIndex((element) => element !== null)
    const first = firstStart >= 0 && startsAt[firstStart] === items[0] ? firstStart : (firstStart >= 0 ? firstStart : laid.length) - 1

    for (let index = Math.max(0, first); index < laid.length; index++) {
      const from = index === first ? 0 : Math.max(0, items.indexOf(startsAt[index] as HTMLElement))
      const nextAt = startsAt[index + 1]
      const to = nextAt ? items.indexOf(nextAt) : items.length
      laid[index].endnoteRule = from === 0
      laid[index].endnotes = items
        .slice(from, to < 0 ? items.length : to)
        .filter((item) => item.classList.contains('doc-note'))
        .map((item) => Number(item.dataset.number) || 0)
    }
  }

  /** Put the spacers where pages start: the same widgets resized in place when only heights changed. */
  private setSpacers(widgets: readonly Widget[], endnotes: readonly { element: HTMLElement; size: number }[]): void {
    const { view } = this

    for (const widget of widgets) {
      this.sizes.set(widget.key, widget.size)
    }

    const set = pagesKey.getState(view.state)
    const current = set?.find(undefined, undefined, (spec) => spec.spacer === true) ?? []
    const same = current.length === widgets.length && current.every((decoration, index) => decoration.spec.key === widgets[index].key && decoration.from === widgets[index].pos)

    if (!same) {
      const shapes = set?.find(undefined, undefined, (spec) => spec.spacer !== true) ?? []
      const decorations = widgets.map((widget) =>
        Decoration.widget(widget.pos, () => this.spacerDom(widget), {
          key: widget.key,
          side: -1,
          spacer: true,
          ignoreSelection: true,
          destroy: (dom: Node) => {
            if (this.spacers.get(widget.key) === dom) {
              this.spacers.delete(widget.key)
            }
          }
        })
      )
      view.dispatch(view.state.tr.setMeta(pagesKey, DecorationSet.create(view.state.doc, [...shapes, ...decorations])).setMeta('addToHistory', false))
    }

    for (const widget of widgets) {
      const element = this.spacers.get(widget.key)

      if (element) {
        sizeSpacer(element, widget.kind, widget.size)
      }
    }

    for (const element of this.endnoteSpacers) {
      element.remove()
    }

    this.endnoteSpacers = endnotes.map(({ element, size }) => {
      const spacer = document.createElement('div')
      spacer.className = 'docs-page-spacer'
      sizeSpacer(spacer, 'block', size)
      element.before(spacer)

      return spacer
    })
  }

  private spacerDom(widget: Widget): HTMLElement {
    let element: HTMLElement

    if (widget.kind === 'row') {
      element = document.createElement('tr')
      const cell = document.createElement('td')
      cell.colSpan = Math.max(1, widget.columns)
      element.append(cell)
    } else {
      element = document.createElement(widget.kind === 'line' ? 'span' : 'div')
    }

    element.className = 'docs-page-spacer'
    element.dataset.spacer = widget.kind
    sizeSpacer(element, widget.kind, this.sizes.get(widget.key) ?? widget.size)
    this.spacers.set(widget.key, element)

    return element
  }

  private chromePage(page: Pick<LaidPage, 'number' | 'kind' | 'frame' | 'top' | 'left' | 'bodyTop' | 'bodyBottom'>, headers: PageHeaders | null, count: number, notes: string): ChromePage {
    const { frame } = page

    return {
      number: page.number,
      kind: page.kind,
      top: page.top,
      left: page.left,
      width: frame.width,
      height: frame.height,
      textLeft: frame.left,
      textWidth: textWidthOf(frame),
      headerTop: frame.header,
      bodyTop: page.bodyTop,
      footerBottom: frame.footer,
      bodyBottom: page.bodyBottom,
      header: this.partOf(headers, 'header', page.number, count),
      footer: this.partOf(headers, 'footer', page.number, count),
      notes
    }
  }

  /** A page's header or footer as HTML, its fields showing that page. */
  private partOf(headers: PageHeaders | null, part: 'header' | 'footer', number: number, count: number): string {
    if (headers !== this.partsOf) {
      this.partsOf = headers
      this.parts = new Map()
    }

    const key = `${part}|${number}|${count}`
    let html = this.parts.get(key)

    if (html === undefined) {
      const blocks = pagePart(headers, part, number)
      html = blocks ? partHtml(blocks, { page: number, pages: count }) : ''
      this.parts.set(key, html)
    }

    return html
  }

  private footnotesHtml(page: LaidPage, count: number): string {
    if (!page.footnotes.length) {
      return ''
    }

    return `<div class="doc-notes-rule"></div>${page.footnotes.map((note) => noteHtml('footnote', note, this.inventory.footnotes[note - 1]?.content ?? [], { page: page.number, pages: count })).join('')}`
  }

  private editNote(target: NoteTarget): void {
    const note = (target.kind === 'endnote' ? this.inventory.endnotes : this.inventory.footnotes)[target.number - 1]

    if (note) {
      this.options.onNoteEdit?.({ kind: target.kind, number: target.number, pos: note.pos, rect: target.rect })
    }
  }

  /** Ask to edit the note whose reference is at `pos`. */
  editNoteAt(pos: number): boolean {
    for (const kind of ['footnote', 'endnote'] as const) {
      const index = (kind === 'endnote' ? this.inventory.endnotes : this.inventory.footnotes).findIndex((note) => note.pos === pos)
      const dom = this.view.nodeDOM(pos)

      if (index >= 0 && dom instanceof HTMLElement) {
        this.editNote({ kind, number: index + 1, rect: dom.getBoundingClientRect() })

        return true
      }
    }

    return false
  }

  /** The area a page's header or footer is drawn in. */
  areaOf(part: 'header' | 'footer', page: number): HTMLElement | null {
    return this.chrome?.areaOf(part, page) ?? null
  }

  destroy(): void {
    this.destroyed = true
    cancelAnimationFrame(this.frameId)
    document.fonts?.removeEventListener('loadingdone', this.onFonts)
    this.view.dom.removeEventListener('load', this.schedule, true)
    this.view.dom.removeEventListener('compositionend', this.onCompositionEnd)
    this.observer?.disconnect()
    this.chrome?.destroy()
  }
}

/** Pages for a Herald Docs editor: where they end, their paper, headers, footers and notes, and their map. */
export const Pages = Extension.create<PagesOptions>({
  name: 'pages',
  addOptions() {
    return { host: null, zoom: () => 1, onLayout: null, onPartEdit: null, onNoteEdit: null }
  },
  addProseMirrorPlugins() {
    const options = this.options

    return [
      new Plugin<DecorationSet>({
        key: pagesKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, set) => (tr.getMeta(pagesKey) as DecorationSet | undefined) ?? set.map(tr.mapping, tr.doc)
        },
        props: {
          decorations: (state) => pagesKey.getState(state),
          handleDoubleClickOn: (view, _pos, node, nodePos) => node.type.name === 'note' && (paginatorOf(view)?.editNoteAt(nodePos) ?? false)
        },
        view: (view) => {
          const paginator = new Paginator(view, options)
          paginators.set(view, paginator)

          return {
            update: (_view, prev) => paginator.update(prev),
            destroy: () => {
              paginators.delete(view)
              paginator.destroy()
            }
          }
        }
      })
    ]
  }
})
