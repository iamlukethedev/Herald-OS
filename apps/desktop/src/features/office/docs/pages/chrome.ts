import type { HeaderKind, NoteKind } from '../../../../../shared/office/document.ts'

/*
 * What the page view draws behind the text: paper for each page and, in its margins, the header
 * and footer that page shows and its footnotes, as static HTML from the print view's renderer
 * with fields filled in. Each header and footer area says which part, kind and page it is, and a
 * double click on one, or on a note, asks to edit it in place.
 */

export interface ChromePage {
  number: number
  kind: HeaderKind
  /** In the sheet, in CSS pixels. */
  top: number
  left: number
  width: number
  height: number
  /** The text column, from the page's left edge. */
  textLeft: number
  textWidth: number
  /** From the top edge to the header, and to the text below it; from the bottom edge to the footer, and to the text above it. */
  headerTop: number
  bodyTop: number
  footerBottom: number
  bodyBottom: number
  header: string
  footer: string
  /** The footnotes at its foot under their rule, or nothing. */
  notes: string
}

export interface PartTarget {
  part: 'header' | 'footer'
  kind: HeaderKind
  page: number
  rect: DOMRect
}

export interface NoteTarget {
  kind: NoteKind
  number: number
  rect: DOMRect
}

interface Drawn {
  element: HTMLElement
  header: HTMLElement
  headerPart: HTMLElement
  footer: HTMLElement
  footerPart: HTMLElement
  notes: HTMLElement
  page: ChromePage | null
}

const px = (value: number): string => `${Math.round(value * 100) / 100}px`

function area(part: 'header' | 'footer'): { element: HTMLElement; inner: HTMLElement } {
  const element = document.createElement('div')
  element.className = 'docs-page-area'
  element.dataset.pagePart = part
  const inner = document.createElement('div')
  inner.className = `doc-part doc-${part}`
  element.append(inner)

  return { element, inner }
}

export class PageChrome {
  private readonly measureBox: HTMLElement
  private readonly drawn: Drawn[] = []

  constructor(
    private readonly layer: HTMLElement,
    private readonly events: { part: (target: PartTarget) => void; note: (target: NoteTarget) => void }
  ) {
    this.measureBox = document.createElement('div')
    this.measureBox.className = 'docs-page-measure'
    this.measureBox.setAttribute('aria-hidden', 'true')
    layer.append(this.measureBox)
    layer.addEventListener('dblclick', this.onDoubleClick)
  }

  private readonly onDoubleClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null
    const note = target?.closest<HTMLElement>('.doc-note')

    if (note) {
      this.events.note({ kind: note.dataset.note === 'endnote' ? 'endnote' : 'footnote', number: Number(note.dataset.number) || 1, rect: note.getBoundingClientRect() })

      return
    }

    const part = target?.closest<HTMLElement>('.docs-page-area')

    if (part) {
      event.preventDefault()
      this.events.part({ part: part.dataset.pagePart === 'footer' ? 'footer' : 'header', kind: (part.dataset.headerKind as HeaderKind) ?? 'default', page: Number(part.dataset.page) || 1, rect: part.getBoundingClientRect() })
    }
  }

  /** The heights of pieces of HTML drawn as headers, footers or notes at a width, in CSS pixels, read in one go. */
  measure(pieces: readonly { html: string; width: number; className: string }[], zoom: number): number[] {
    if (!pieces.length) {
      return []
    }

    const elements = pieces.map(({ html, width, className }) => {
      const element = document.createElement('div')
      element.className = `doc-part ${className}`
      element.style.width = px(width)
      element.innerHTML = html

      return element
    })
    this.measureBox.replaceChildren(...elements)
    const heights = elements.map((element) => element.getBoundingClientRect().height / (zoom || 1))
    this.measureBox.replaceChildren()

    return heights
  }

  /** Draw the pages, changing only what changed. */
  draw(pages: readonly ChromePage[]): void {
    while (this.drawn.length > pages.length) {
      this.drawn.pop()!.element.remove()
    }

    pages.forEach((page, index) => {
      const drawn = this.drawn[index] ?? this.create()
      const last = drawn.page

      if (!last || last.top !== page.top || last.left !== page.left || last.width !== page.width || last.height !== page.height) {
        Object.assign(drawn.element.style, { top: px(page.top), left: px(page.left), width: px(page.width), height: px(page.height) })
      }

      if (!last || last.number !== page.number || last.kind !== page.kind) {
        drawn.element.dataset.page = String(page.number)

        for (const element of [drawn.header, drawn.footer]) {
          element.dataset.page = String(page.number)
          element.dataset.headerKind = page.kind
        }
      }

      if (!last || last.textLeft !== page.textLeft || last.textWidth !== page.textWidth || last.headerTop !== page.headerTop || last.bodyTop !== page.bodyTop || last.footerBottom !== page.footerBottom || last.bodyBottom !== page.bodyBottom) {
        const across = { left: px(page.textLeft), width: px(page.textWidth) }
        Object.assign(drawn.header.style, across, { top: px(page.headerTop), height: px(Math.max(8, page.bodyTop - page.headerTop)) })
        Object.assign(drawn.footer.style, across, { bottom: px(page.footerBottom), height: px(Math.max(8, page.bodyBottom - page.footerBottom)) })
        Object.assign(drawn.notes.style, across, { bottom: px(page.bodyBottom) })
      }

      if (last?.header !== page.header) {
        drawn.headerPart.innerHTML = page.header
      }

      if (last?.footer !== page.footer) {
        drawn.footerPart.innerHTML = page.footer
      }

      if (last?.notes !== page.notes) {
        drawn.notes.innerHTML = page.notes
        drawn.notes.hidden = !page.notes
      }

      drawn.page = page
    })
  }

  private create(): Drawn {
    const element = document.createElement('div')
    element.className = 'docs-page'
    const header = area('header')
    const footer = area('footer')
    const notes = document.createElement('div')
    notes.className = 'docs-page-notes doc-part doc-footnotes'
    notes.hidden = true
    element.append(header.element, notes, footer.element)
    this.layer.insertBefore(element, this.measureBox)
    const drawn: Drawn = { element, header: header.element, headerPart: header.inner, footer: footer.element, footerPart: footer.inner, notes, page: null }
    this.drawn.push(drawn)

    return drawn
  }

  /** The area of a page's header or footer, for an editor put over it. */
  areaOf(part: 'header' | 'footer', page: number): HTMLElement | null {
    const drawn = this.drawn[page - 1]

    return drawn ? (part === 'header' ? drawn.header : drawn.footer) : null
  }

  destroy(): void {
    this.layer.removeEventListener('dblclick', this.onDoubleClick)
    this.layer.replaceChildren()
  }
}
