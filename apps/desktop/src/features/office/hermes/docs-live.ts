import { undoDepth } from '@tiptap/pm/history'
import { markedRangeOf, setMarked } from '../docs/marked.ts'
import { docsSession, editorOf } from '../docs/store.ts'
import type { LiveDoc } from './ask.ts'

/** A Herald Docs document open in this window, for a request to Hermes: its selection, marked first when asked, and its history. */
export function docsLive(docKey: string, mark: boolean): LiveDoc | null {
  const doc = docsSession.find(docKey)
  const editor = editorOf(docKey)

  if (!doc) {
    return null
  }

  if (!editor || editor.isDestroyed) {
    return { name: doc.name, path: doc.path, selection: null, depth: () => null, watch: () => () => {}, undo: () => {}, unmark: () => {} }
  }

  const { from, to } = editor.state.selection
  const alive = () => !editor.isDestroyed

  if (mark) {
    setMarked(editor.view, { from, to })
  }

  return {
    name: doc.name,
    path: doc.path,
    selection: { kind: 'text', text: editor.state.doc.textBetween(from, to, '\n', ' '), marked: mark },
    depth: () => (alive() ? undoDepth(editor.state) : null),
    watch: (listener) => {
      editor.on('transaction', listener)

      return () => editor.off('transaction', listener)
    },
    undo: () => {
      if (alive()) {
        editor.commands.undo()
      }
    },
    unmark: () => {
      if (alive() && markedRangeOf(editor.state)) {
        setMarked(editor.view, null)
      }
    }
  }
}
