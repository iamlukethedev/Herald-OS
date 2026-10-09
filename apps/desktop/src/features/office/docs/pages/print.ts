import { Editor, type NodeViewRenderer } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { type PrintPage, printView, tocBlockHtml } from '../../../../../shared/office/doc-html.ts'
import type { DocJSON, DocNode, NoteKind, StyleLooks } from '../../../../../shared/office/document.ts'
import { docsExtensions } from '../schema.ts'
import { DocsTableView, imageView } from '../views.ts'
import { pageCss } from './css.ts'
import { withPageViews } from './fields.ts'
import { sectionsOfDoc } from './geometry.ts'
import { type PageLayout, Pages, paginatorOf } from './paginator.ts'

/*
 * The print view as the page view lays the document out: the document drawn off screen at actual
 * size with the editor's own views and CSS, its pages worked out by the same code, then cut where
 * each page starts (ProseMirror's `cut`) and each part drawn by the print view's renderer on a
 * page of its own, with its header, footnotes and footer. A page that starts inside a list goes on
 * numbering it, and one that starts inside a paragraph or a list item shows no second first-line
 * indent, space or marker for it.
 */

/** Layouts in a row while fields and a table of contents' page numbers settle what lines hold. */
const ROUNDS = 3

interface TocView {
  dom: HTMLElement
  node: PMNode
  html: string
}

/** Part of a document between two positions, marked where it starts or ends inside a block, with cut ordered lists numbered on. */
export function sliceOf(doc: PMNode, from: number, to: number): DocNode[] {
  if (to <= from) {
    return []
  }

  const json = doc.cut(from, to).toJSON() as DocJSON
  const start = doc.resolve(from)
  let node: DocNode | undefined = json

  for (let depth = 1; depth <= start.depth; depth++) {
    node = node?.content?.[0]

    if (!node) {
      break
    }

    const attrs: Record<string, unknown> = { ...node.attrs }

    if (from > start.start(depth)) {
      attrs.continued = true
    }

    if (node.type === 'orderedList') {
      attrs.start = (Number(node.attrs?.start ?? 1) || 1) + start.index(depth)
    }

    node.attrs = attrs
  }

  const end = doc.resolve(to)
  node = json

  for (let depth = 1; depth <= end.depth; depth++) {
    node = node?.content?.[node.content.length - 1]

    if (!node) {
      break
    }

    if (to < end.end(depth)) {
      node.attrs = { ...node.attrs, continues: true }
    }
  }

  return json.content ?? []
}

/** The print view's pages from a layout of `doc`: each one's part of the document, its notes, and where its text goes. */
export function printPagesOf(doc: PMNode, layout: PageLayout): PrintPage[] {
  const notes: { pos: number; kind: NoteKind; content: DocNode[] }[] = []
  const headings: number[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'note') {
      notes.push({ pos, kind: node.attrs.kind === 'endnote' ? 'endnote' : 'footnote', content: (node.attrs.content as DocNode[] | null) ?? [] })
    } else if (node.type.name === 'heading') {
      headings.push(pos)
    }
  })
  const footnotes = notes.filter((note) => note.kind === 'footnote')
  const endnotes = notes.filter((note) => note.kind === 'endnote')
  const sections = sectionsOfDoc(doc)
  const before = (list: readonly { pos: number }[], pos: number) => list.filter((entry) => entry.pos < pos).length

  return layout.pages.map((page) => ({
    number: page.number,
    kind: page.kind,
    page: sections[page.section]?.page ?? sections[0].page,
    blocks: page.blank ? [] : sliceOf(doc, page.from, page.to),
    notes: { footnote: before(footnotes, page.from), endnote: before(endnotes, page.from) },
    headings: headings.filter((pos) => pos < page.from).length,
    footnotes: page.footnotes.map((number) => ({ number, content: footnotes[number - 1]?.content ?? [] })),
    endnotes: page.endnotes.map((number) => ({ number, content: endnotes[number - 1]?.content ?? [] })),
    endnoteRule: page.endnoteRule,
    bodyTop: page.bodyTop,
    bodyBottom: page.bodyBottom
  }))
}

/** Lay `model` out off screen as the page view does, and read its pages; null where there is no page to draw on. */
export async function printLayout(model: DocJSON): Promise<{ doc: DocJSON; pages: PrintPage[]; layout: PageLayout } | null> {
  if (typeof document === 'undefined') {
    return null
  }

  const key = `print-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position: fixed; left: -200000px; top: 0; visibility: hidden; pointer-events: none'
  const style = document.createElement('style')
  style.textContent = pageCss(key, (model.attrs?.styles as StyleLooks | null | undefined) ?? null)
  const sheet = document.createElement('div')
  sheet.className = 'docs-sheet'
  sheet.dataset.docsPage = key
  const layer = document.createElement('div')
  layer.className = 'docs-pages'
  const mount = document.createElement('div')
  mount.className = 'docs-mount'
  sheet.append(layer, mount)
  host.append(style, sheet)
  document.body.append(host)
  const tocs = new Set<TocView>()
  const tocView: NodeViewRenderer = ({ node }) => {
    const view: TocView = { dom: document.createElement('div'), node, html: '' }
    tocs.add(view)

    return { dom: view.dom, ignoreMutation: () => true, destroy: () => tocs.delete(view) }
  }
  let editor: Editor | null = null

  try {
    editor = new Editor({
      element: mount,
      content: model,
      editable: false,
      extensions: [...withPageViews(docsExtensions({ history: false, views: { image: imageView, table: DocsTableView } }), { tableOfContents: tocView }), Pages.configure({ host: { sheet, layer, mount }, zoom: () => 1 })]
    })
    const paginator = paginatorOf(editor.view)
    const json = () => editor!.state.doc.toJSON() as DocJSON
    const drawTocs = (headingPages: readonly number[]): boolean => {
      let changed = false

      for (const toc of tocs) {
        const html = tocBlockHtml(toc.node.toJSON() as DocNode, { doc: json(), headingPages })

        if (html !== toc.html) {
          toc.html = html
          toc.dom.innerHTML = html
          changed = true
        }
      }

      return changed
    }
    drawTocs([])
    await document.fonts?.ready
    await Promise.all([...mount.querySelectorAll('img')].map((image) => image.decode().catch(() => undefined)))
    let layout = paginator?.run() ?? null
    let shape = ''

    for (let round = 0; layout && round < ROUNDS; round++) {
      const next = JSON.stringify(layout.map.pages)
      const redrawn = drawTocs(layout.map.headings)

      if (next === shape && !redrawn) {
        break
      }

      shape = next
      layout = paginator?.run() ?? layout
    }

    return layout ? { doc: json(), pages: printPagesOf(editor.state.doc, layout), layout } : null
  } finally {
    editor?.destroy()
    host.remove()
  }
}

/** The print view of `model`: its pages as the page view lays them out, or the text flowing over pages where it cannot be laid out. */
export async function printDocument(model: DocJSON, title: string): Promise<string> {
  try {
    const laid = await printLayout(model)

    if (laid) {
      return printView(laid.doc, title, laid.pages)
    }
  } catch (error) {
    console.error('Herald Docs could not lay the pages out for printing', error)
  }

  return printView(model, title)
}
