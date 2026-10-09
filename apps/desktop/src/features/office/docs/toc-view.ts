import { Extension, type NodeViewRenderer } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { tocBlockHtml } from '../../../../shared/office/doc-html.ts'
import type { DocNode } from '../../../../shared/office/document.ts'
import { headingsOf } from './model.ts'
import { paginatorOf } from './pages/paginator.ts'
import { $pages } from './store.ts'

/*
 * A table of contents on the page: the print view's own HTML for it, so the page and the PDF lay it
 * out alike, drawn again (at once, so the page view measures it as drawn) whenever the headings
 * change or the pages they are on do. A click on an entry goes to its heading; a click on its
 * title, or on the grip beside it, selects it.
 */

/** Layouts in a row a table of contents asks for while its page numbers settle what its lines hold. */
const SETTLE_RUNS = 3

/** How far below the top of the desk a heading gone to sits, in pixels. */
const HEADING_MARGIN = 64

interface TocDrawing {
  dom: HTMLElement
  grip: HTMLElement
  node: PMNode
  html: string
}

const drawings = new WeakMap<EditorView, Set<TocDrawing>>()

const htmlOf = (view: EditorView, toc: TocDrawing): string => tocBlockHtml(toc.node.toJSON() as DocNode, { doc: headingsOf(view.state.doc), headingPages: paginatorOf(view)?.layout?.map.headings })

function show(toc: TocDrawing, html: string): void {
  toc.html = html
  toc.dom.innerHTML = html
  toc.dom.append(toc.grip)
}

/** Draw every table of contents of a view again; true when one changed. */
function redraw(view: EditorView): boolean {
  let changed = false

  for (const toc of drawings.get(view) ?? []) {
    const html = htmlOf(view, toc)

    if (html !== toc.html) {
      show(toc, html)
      changed = true
    }
  }

  return changed
}

/** Put the caret at the start of the document's heading number `index` (from 0), shown near the top of the desk. */
function goToHeading(view: EditorView, index: number): void {
  let target = -1
  let count = 0
  view.state.doc.descendants((node, pos) => {
    if (target >= 0) {
      return false
    }

    if (node.type.name === 'heading') {
      if (count++ === index) {
        target = pos
      }

      return false
    }

    return !node.isTextblock
  })

  if (target < 0) {
    return
  }

  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target + 1)))
  view.focus()
  const desk = view.dom.closest('.docs-desk')

  if (desk instanceof HTMLElement) {
    desk.scrollTop += view.coordsAtPos(target + 1).top - desk.getBoundingClientRect().top - HEADING_MARGIN
  }
}

const entryLink = (target: EventTarget | null): Element | null => (target instanceof Element ? target.closest('.doc-toc-entry a') : null)

export const tocView: NodeViewRenderer = ({ node, view, getPos }) => {
  const dom = document.createElement('div')
  dom.className = 'docs-toc'
  const grip = document.createElement('span')
  grip.className = 'docs-toc-grip'
  grip.title = 'Select the table of contents'
  const toc: TocDrawing = { dom, grip, node, html: '' }
  show(toc, htmlOf(view, toc))
  const set = drawings.get(view) ?? new Set<TocDrawing>()
  drawings.set(view, set)
  set.add(toc)

  dom.addEventListener('mousedown', (event) => {
    if (event.button !== 0) {
      return
    }

    const link = entryLink(event.target)

    if (event.target === grip) {
      event.preventDefault()
      const pos = getPos()

      if (typeof pos === 'number') {
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
        view.focus()
      }
    } else if (link) {
      event.preventDefault()
      const index = Number(/doc-heading-(\d+)$/.exec(link.getAttribute('href') ?? '')?.[1])

      if (Number.isInteger(index)) {
        goToHeading(view, index)
      }
    }
  })
  // The entries link to anchors only the PDF has.
  dom.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a')) {
      event.preventDefault()
    }
  })

  return {
    dom,
    update: (next) => {
      if (next.type !== toc.node.type) {
        return false
      }

      toc.node = next
      const html = htmlOf(view, toc)

      if (html !== toc.html) {
        show(toc, html)
      }

      return true
    },
    selectNode: () => dom.classList.add('is-selected'),
    deselectNode: () => dom.classList.remove('is-selected'),
    stopEvent: (event) => event.target === grip || Boolean(entryLink(event.target)),
    ignoreMutation: () => true,
    destroy: () => {
      set.delete(toc)
    }
  }
}

/** Tables of contents drawn again when the document changes, and when the pages its headings are on do. */
export const TocLive = Extension.create({
  name: 'tocLive',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        view: (editorView) => {
          let settling = 0
          let laid: unknown = null
          const unlisten = $pages.listen(() => {
            const map = paginatorOf(editorView)?.layout?.map

            if (!map || map === laid || editorView.isDestroyed) {
              return
            }

            laid = map
            let moved = false

            for (const toc of drawings.get(editorView) ?? []) {
              const html = htmlOf(editorView, toc)

              if (html !== toc.html) {
                const before = toc.dom.offsetHeight
                show(toc, html)
                moved ||= toc.dom.offsetHeight !== before
              }
            }

            // A page number that changes what an entry's line holds moves where the pages end.
            settling = moved && settling < SETTLE_RUNS ? settling + 1 : 0

            if (settling) {
              paginatorOf(editorView)?.schedule()
            }
          })

          return {
            update: (current, prev) => {
              if (current.state.doc !== prev.doc) {
                settling = 0
                redraw(current)
              }
            },
            destroy: unlisten
          }
        }
      })
    ]
  }
})
