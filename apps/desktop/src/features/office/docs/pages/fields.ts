import { type AnyExtension, Node, type NodeViewRenderer } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { fieldText } from '../../../../../shared/office/fields.ts'

/*
 * Fields in the text show what they stand for where they are: the page view tells each one its
 * page and the page count once it has laid the pages out, and the date fields show today.
 */

export interface FieldView {
  dom: HTMLElement
  node: PMNode
  pos: () => number | undefined
  page: number | undefined
  pages: number | undefined
}

const views = new WeakMap<EditorView, Set<FieldView>>()

export const fieldViewsOf = (view: EditorView): ReadonlySet<FieldView> => views.get(view) ?? new Set()

/** Show a field as it reads on page `page` of `pages`; true when what it shows changed. */
export function showField(field: FieldView, page: number | undefined, pages: number | undefined): boolean {
  field.page = page
  field.pages = pages
  const text = fieldText(field.node.attrs, { page, pages })

  if (field.dom.textContent === text) {
    return false
  }

  field.dom.textContent = text

  return true
}

export const fieldView: NodeViewRenderer = ({ node, view, getPos, HTMLAttributes }) => {
  const dom = document.createElement('span')

  for (const [name, value] of Object.entries(HTMLAttributes)) {
    if (value !== null && value !== undefined && value !== false) {
      dom.setAttribute(name, String(value))
    }
  }

  dom.classList.add('doc-field')
  const field: FieldView = { dom, node, pos: () => (typeof getPos === 'function' ? getPos() : undefined), page: undefined, pages: undefined }
  dom.textContent = fieldText(node.attrs)
  const set = views.get(view) ?? new Set<FieldView>()
  views.set(view, set)
  set.add(field)

  return {
    dom,
    update: (next) => {
      if (next.type !== field.node.type) {
        return false
      }

      field.node = next
      dom.dataset.field = String(next.attrs.kind)
      showField(field, field.page, field.pages)

      return true
    },
    ignoreMutation: () => true,
    destroy: () => {
      set.delete(field)
    }
  }
}

/** A document's extensions with fields drawn as the page view shows them, and any other nodes drawn by `views`. */
export function withPageViews(extensions: readonly AnyExtension[], views: Readonly<Record<string, NodeViewRenderer>> = {}): AnyExtension[] {
  const drawn: Record<string, NodeViewRenderer> = { field: fieldView, ...views }

  return extensions.map((extension) => (extension instanceof Node && drawn[extension.name] ? extension.extend({ addNodeView: () => drawn[extension.name] }) : extension))
}
