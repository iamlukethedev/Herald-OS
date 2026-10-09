import { useStore } from '@nanostores/react'
import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { useEditorState } from '@tiptap/react'
import { Fragment, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { contentCss, looksCss } from '../../../../shared/office/doc-html.ts'
import { countWords, type DocJSON, pageOf } from '../../../../shared/office/document.ts'
import type { EditorHandle, OfficeDocument } from '../types.ts'
import * as act from './actions.ts'
import { BubbleBar } from './BubbleBar.tsx'
import { createDocsEditor } from './editor.ts'
import { FindBar } from './FindBar.tsx'
import { ImageBar } from './ImageBar.tsx'
import { LinkPopover } from './LinkPopover.tsx'
import { counts, outline } from './model.ts'
import { useScrollTick } from './overlay.ts'
import { SlashMenu } from './SlashMenu.tsx'
import { $editors, $find, $zoom, docsSession } from './store.ts'

/** Where a file was last dragged over a page, so a picture dropped from Files lands there. */
export const dragPoint = { key: '', left: 0, top: 0 }

const plural = (count: number, one: string, many: string): string => `${count.toLocaleString()} ${count === 1 ? one : many}`

function statusOf(editor: Editor, total: { words: number; characters: number }): string {
  const { from, to } = editor.state.selection
  const all = `${plural(total.words, 'word', 'words')} · ${plural(total.characters, 'character', 'characters')}`

  return to > from ? `${countWords(editor.state.doc.textBetween(from, to, '\n', ' ')).toLocaleString()} of ${all}` : all
}

/** One document on its page: white paper on a dark desk, at the document's page size and margins. */
export function DocsEditor({ doc, active }: { doc: OfficeDocument<DocJSON>; active: boolean }) {
  const mount = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const desk = useRef<HTMLDivElement>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const zoom = useStore($zoom)[doc.key] ?? 1
  const find = useStore($find)
  const tick = useScrollTick(desk)

  useEffect(() => {
    let destroyed = false
    let frameId = 0
    let counted: { doc: PMNode; words: number; characters: number } | null = null
    const instance = createDocsEditor(mount.current!, doc.initial, {
      onUpdate: () => docsSession.changed(doc),
      // The status bar shows the words selected.
      onSelection: () => {
        cancelAnimationFrame(frameId)
        frameId = requestAnimationFrame(() => docsSession.refresh(doc))
      }
    })
    const countsNow = () => {
      if (counted?.doc !== instance.state.doc) {
        counted = { doc: instance.state.doc, ...counts(instance.state.doc) }
      }

      return counted
    }
    const handle: EditorHandle<DocJSON> = {
      snapshot: () => instance.getJSON() as DocJSON,
      load: (model) => {
        // A new state: the version on disk, with history starting again from it.
        instance.view.updateState(EditorState.create({ doc: instance.schema.nodeFromJSON(model), plugins: instance.state.plugins }))
        // An empty step, so what reads the editor (the toolbar, the page size) reads it again.
        instance.view.dispatch(instance.state.tr.setMeta('addToHistory', false))
        docsSession.refresh(doc)
      },
      undo: () => instance.commands.undo(),
      redo: () => instance.commands.redo(),
      status: () => (destroyed ? '' : statusOf(instance, countsNow())),
      detail: () => {
        if (destroyed) {
          return undefined
        }

        const words = plural(countsNow().words, 'word', 'words')
        const heading = outline(instance.state.doc)
          .reverse()
          .find((entry) => entry.from < instance.state.selection.from)

        return heading ? `In “${heading.text}”, ${words}` : words
      },
      selection: () => {
        const { from, to } = instance.state.selection

        return destroyed || to <= from ? undefined : instance.state.doc.textBetween(from, to, '\n', ' ').slice(0, 2000) || undefined
      },
      focus: () => instance.commands.focus(),
      zoom: (step) => act.zoom(doc.key, step),
      dispose: () => {
        if (!destroyed) {
          destroyed = true
          instance.destroy()
        }
      }
    }

    $editors.set({ ...$editors.get(), [doc.key]: instance })
    setEditor(instance)
    docsSession.attach(doc, handle)

    return () => {
      cancelAnimationFrame(frameId)

      // The document outlives its view (a closed window keeps it until Herald quits): it keeps what was typed.
      if (!destroyed) {
        doc.initial = handle.snapshot()
      }

      if (doc.editor === handle) {
        docsSession.attach(doc, null)
      }

      const { [doc.key]: _closed, ...rest } = $editors.get()
      $editors.set(rest)
      handle.dispose()
    }
  }, [doc.key])

  // Keys the page handled (Word's shortcuts, formatting) do not go on to the window's menus or the desktop.
  useEffect(() => {
    const element = frame.current
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented && (event.metaKey || event.ctrlKey || event.altKey)) {
        event.stopPropagation()
      }
    }
    element?.addEventListener('keydown', onKeyDown)

    return () => element?.removeEventListener('keydown', onKeyDown)
  }, [])

  const attrs = useEditorState({ editor, selector: ({ editor: current }) => (current && !current.isDestroyed ? current.state.doc.attrs : null) }) ?? doc.initial.attrs
  const page = pageOf({ type: 'doc', attrs })
  const scope = `[data-docs-page="${doc.key}"] .tiptap`
  const css = useMemo(() => `${looksCss({ type: 'doc', attrs: { styles: attrs?.styles ?? null } }, scope)}\n${contentCss(scope, 'screen')}`, [attrs?.styles, scope])
  const { margins } = page

  // A click in the page's margin puts the caret at the nearest place in the text.
  const onSheetDown = (event: MouseEvent<HTMLDivElement>) => {
    if (!editor || event.target !== event.currentTarget) {
      return
    }

    event.preventDefault()
    const box = editor.view.dom.getBoundingClientRect()
    const at = editor.view.posAtCoords({ left: Math.max(box.left + 2, Math.min(box.right - 2, event.clientX)), top: Math.max(box.top + 2, Math.min(box.bottom - 2, event.clientY)) })
    editor
      .chain()
      .focus()
      .setTextSelection(at?.pos ?? editor.state.doc.content.size)
      .run()
  }

  return (
    <div ref={frame} className="docs-frame relative flex min-h-0 min-w-0 flex-1 flex-col">
      {editor && find?.key === doc.key && <FindBar key={editor.instanceId} editor={editor} replace={find.replace} at={find.at} onClose={() => $find.set(null)} />}
      <div
        ref={desk}
        className="docs-desk min-h-0 flex-1 overflow-auto"
        onDragOver={(event) => Object.assign(dragPoint, { key: doc.key, left: event.clientX, top: event.clientY })}
        onMouseDown={(event) => {
          if (editor && event.target === event.currentTarget) {
            event.preventDefault()
            editor.commands.focus('end')
          }
        }}
      >
        <style>{css}</style>
        <div className="docs-sheet" data-docs-page={doc.key} style={{ width: `${page.width}pt`, minHeight: `${page.height}pt`, padding: `${margins.top}pt ${margins.right}pt ${margins.bottom}pt ${margins.left}pt`, zoom }} onMouseDown={onSheetDown}>
          <div ref={mount} className="docs-mount" />
        </div>
      </div>
      {editor && active && (
        <Fragment key={editor.instanceId}>
          <BubbleBar editor={editor} frame={frame.current} tick={tick} />
          <LinkPopover editor={editor} docKey={doc.key} frame={frame.current} tick={tick} />
          <ImageBar editor={editor} frame={frame.current} tick={tick} />
        </Fragment>
      )}
      {active && <SlashMenu frame={frame.current} />}
    </div>
  )
}
