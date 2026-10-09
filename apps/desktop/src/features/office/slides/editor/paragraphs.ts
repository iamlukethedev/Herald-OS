import type { Editor } from '@tiptap/core'
import type { Node as ProseNode } from '@tiptap/pm/model'
import type { ListKind } from '../deck.ts'
import { MAX_LEVEL } from '../text.ts'

/*
 * Paragraph settings on the text being typed. The menus and the formatting bar reach these through
 * the editor in front, so they come without the text editor itself, which loads when typing starts.
 */

/** The paragraph's settings at the selection, from its first paragraph. */
export function selectedParagraphs(editor: Editor): { node: ProseNode; pos: number }[] {
  const { from, to } = editor.state.selection
  const found: { node: ProseNode; pos: number }[] = []

  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'paragraph') {
      found.push({ node, pos })

      return false
    }

    return true
  })

  return found
}

/** Change the paragraphs at the selection, each by `change`, as one editing step. */
export function changeParagraphs(editor: Editor, change: (attrs: Record<string, unknown>) => Record<string, unknown>): boolean {
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      for (const { node, pos } of selectedParagraphs(editor)) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...change(node.attrs) })
      }

      return true
    })
    .run()
}

/** One level deeper or shallower for the list paragraphs at the selection. */
export function shiftLevel(editor: Editor, by: number): boolean {
  if (!selectedParagraphs(editor).some(({ node }) => node.attrs.list)) {
    return false
  }

  return changeParagraphs(editor, (attrs) => (attrs.list ? { level: Math.max(0, Math.min(MAX_LEVEL, Number(attrs.level ?? 0) + by)), bullet: null, numbering: null } : {}))
}

/** Bullets or numbers for the paragraphs at the selection, or none when they all have that kind already. */
export function toggleList(editor: Editor, kind: ListKind): boolean {
  const all = selectedParagraphs(editor).every(({ node }) => node.attrs.list === kind)

  return changeParagraphs(editor, () => (all ? { list: null, level: null, bullet: null, numbering: null, startAt: null } : { list: kind, bullet: null, numbering: null, startAt: null }))
}
