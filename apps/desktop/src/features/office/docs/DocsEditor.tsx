import { useStore } from '@nanostores/react'
import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { useEditorState } from '@tiptap/react'
import { Fragment, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { countWords, type DocJSON, pageOf } from '../../../../shared/office/document.ts'
import type { EditorHandle, OfficeDocument } from '../types.ts'
import * as act from './actions.ts'
import { BubbleBar } from './BubbleBar.tsx'
import { CommentsPanel } from './CommentsPanel.tsx'
import { createDocsEditor } from './editor.ts'
import { FindBar } from './FindBar.tsx'
import { ImageBar } from './ImageBar.tsx'
import { LinkPopover } from './LinkPopover.tsx'
import { counts, outline } from './model.ts'
import { NavigationPane } from './NavigationPane.tsx'
import { useScrollTick } from './overlay.ts'
import { pageCss } from './pages/css.ts'
import { pageAt } from './pages/map.ts'
import { paginatorOf } from './pages/paginator.ts'
import { flushPartEdits, PartEditors } from './PartEditor.tsx'
import { SlashMenu } from './SlashMenu.tsx'
import { $editors, $find, $noteEdit, $pages, $partEdit, $zoom, docsSession, type ScreenRect } from './store.ts'
import { withTocPages } from './toc.ts'

/** Where a file was last dragged over a page, so a picture dropped from Files lands there. */
export const dragPoint = { key: '', left: 0, top: 0 }

const plural = (count: number, one: string, many: string): string => `${count.toLocaleString()} ${count === 1 ? one : many}`

const screenRect = ({ left, top, width, height }: DOMRect): ScreenRect => ({ left, top, width, height })

/** The page the selection ends on, and how many pages there are. */
function caretPage(editor: Editor, key: string): { number: number; count: number } | null {
  const map = $pages.get()[key]
  const page = pageAt(map, editor.state.selection.head)

  return page && map ? { number: page.number, count: map.pages.length } : null
}

function statusOf(editor: Editor, key: string, total: { words: number; characters: number }): string {
  const { from, to } = editor.state.selection
  const all = `${plural(total.words, 'word', 'words')} · ${plural(total.characters, 'character', 'characters')}`
  const words = to > from ? `${countWords(editor.state.doc.textBetween(from, to, '\n', ' ')).toLocaleString()} of ${all}` : all
  const page = caretPage(editor, key)

  return page ? `Page ${page.number.toLocaleString()} of ${page.count.toLocaleString()} · ${words}` : words
}

/** One document on its pages: white paper on a dark desk, at the document's page sizes and margins. */
export function DocsEditor({ doc, active }: { doc: OfficeDocument<DocJSON>; active: boolean }) {
  const mount = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
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
    let shown = ''
    const instance = createDocsEditor(
      mount.current!,
      doc.initial,
      {
        onUpdate: () => docsSession.changed(doc),
        // The status bar shows the words selected.
        onSelection: () => {
          cancelAnimationFrame(frameId)
          frameId = requestAnimationFrame(() => docsSession.refresh(doc))
        }
      },
      {
        host: { sheet: sheet.current!, layer: layer.current!, mount: mount.current! },
        zoom: () => $zoom.get()[doc.key] ?? 1,
        onLayout: (layout) => {
          $pages.set({ ...$pages.get(), [doc.key]: layout.map })
          const where = `${pageAt(layout.map, instance.state.selection.head)?.number}/${layout.map.pages.length}`

          if (where !== shown) {
            shown = where
            docsSession.refresh(doc)
          }
        },
        onPartEdit: ({ part, kind, page, rect }) => $partEdit.set({ docKey: doc.key, part, kind, page, rect: screenRect(rect) }),
        onNoteEdit: ({ kind, number, pos, rect }) => $noteEdit.set({ docKey: doc.key, kind, number, pos, rect: screenRect(rect) })
      }
    )
    const countsNow = () => {
      if (counted?.doc !== instance.state.doc) {
        counted = { doc: instance.state.doc, ...counts(instance.state.doc) }
      }

      return counted
    }
    const handle: EditorHandle<DocJSON> = {
      snapshot: () => {
        flushPartEdits(doc.key)

        return withTocPages(instance.getJSON() as DocJSON, doc.key)
      },
      load: (model) => {
        // A new state: the version on disk, with history starting again from it.
        instance.view.updateState(EditorState.create({ doc: instance.schema.nodeFromJSON(model), plugins: instance.state.plugins }))
        // An empty step, so what reads the editor (the toolbar, the page size) reads it again.
        instance.view.dispatch(instance.state.tr.setMeta('addToHistory', false))
        docsSession.refresh(doc)
      },
      undo: () => instance.commands.undo(),
      redo: () => instance.commands.redo(),
      status: () => (destroyed ? '' : statusOf(instance, doc.key, countsNow())),
      detail: () => {
        if (destroyed) {
          return undefined
        }

        const words = plural(countsNow().words, 'word', 'words')
        const page = caretPage(instance, doc.key)
        const where = page ? `On page ${page.number} of ${page.count}` : null
        const heading = outline(instance.state.doc)
          .reverse()
          .find((entry) => entry.from < instance.state.selection.from)

        if (heading) {
          return `${where ? `${where}, in` : 'In'} “${heading.text}”, ${words}`
        }

        return where ? `${where}, ${words}` : words
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
      const { [doc.key]: _laid, ...others } = $pages.get()
      $pages.set(others)
      handle.dispose()
    }
  }, [doc.key])

  // The pages are measured on screen, so a new zoom lays them out again.
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      paginatorOf(editor.view)?.schedule()
    }
  }, [editor, zoom])

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
  const css = useMemo(() => pageCss(doc.key, attrs?.styles ?? null), [attrs?.styles, doc.key])

  // A click on the paper or between pages puts the caret at the nearest place in that page's text.
  const onSheetDown = (event: MouseEvent<HTMLDivElement>) => {
    if (!editor || (event.target instanceof Node && mount.current?.contains(event.target))) {
      return
    }

    event.preventDefault()
    const box = event.currentTarget.getBoundingClientRect()
    const y = (event.clientY - box.top) / zoom
    const pages = paginatorOf(editor.view)?.layout?.pages.filter((entry) => !entry.blank) ?? []
    const near = pages.find((entry) => y < entry.top + entry.frame.height) ?? pages[pages.length - 1]
    const text = editor.view.dom.getBoundingClientRect()
    let top = Math.max(text.top + 2, Math.min(text.bottom - 2, event.clientY))

    if (near) {
      top = Math.max(box.top + (near.top + near.bodyTop + 2) * zoom, Math.min(box.top + (near.top + near.frame.height - near.bodyBottom - near.notesHeight - 2) * zoom, event.clientY))
    }

    const at = editor.view.posAtCoords({ left: Math.max(text.left + 2, Math.min(text.right - 2, event.clientX)), top })
    editor
      .chain()
      .focus()
      .setTextSelection(at?.pos ?? editor.state.doc.content.size)
      .run()
  }

  return (
    <div ref={frame} className="docs-frame relative flex min-h-0 min-w-0 flex-1 flex-col">
      {editor && find?.key === doc.key && <FindBar key={`find-${editor.instanceId}`} editor={editor} replace={find.replace} at={find.at} onClose={() => $find.set(null)} />}
      <div className="flex min-h-0 min-w-0 flex-1">
        {editor && <NavigationPane key={`navigation-${editor.instanceId}`} editor={editor} docKey={doc.key} />}
        <div
          ref={desk}
          className="docs-desk min-h-0 min-w-0 flex-1 overflow-auto"
          onDragOver={(event) => Object.assign(dragPoint, { key: doc.key, left: event.clientX, top: event.clientY })}
          onMouseDown={(event) => {
            if (editor && event.target === event.currentTarget) {
              event.preventDefault()
              editor.commands.focus('end')
            }
          }}
        >
          <style>{css}</style>
          <div ref={sheet} className="docs-sheet" data-docs-page={doc.key} style={{ width: `${page.width}pt`, minHeight: `${page.height}pt`, zoom }} onMouseDown={onSheetDown}>
            <div ref={layer} className="docs-pages" aria-hidden="true" />
            <div ref={mount} className="docs-mount" />
          </div>
        </div>
        {editor && <CommentsPanel key={`comments-${editor.instanceId}`} editor={editor} docKey={doc.key} />}
      </div>
      {editor && <PartEditors key={`parts-${editor.instanceId}`} editor={editor} docKey={doc.key} frame={frame.current} desk={desk.current} active={active} />}
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
