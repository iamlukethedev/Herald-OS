import './parts.css'
import { useStore } from '@nanostores/react'
import { IconCalendar, IconChevronDown, IconHash, IconSquare, IconSquareCheck, IconX } from '@tabler/icons-react'
import { Editor, Extension } from '@tiptap/core'
import { EditorState, Selection, type Transaction } from '@tiptap/pm/state'
import { useEditorState } from '@tiptap/react'
import { type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { type DocNode, type HeaderKind, headerKindFor, type NoteKind, noteLabel, type PageHeaders } from '../../../../shared/office/document.ts'
import { cn } from '../../../lib/cn.ts'
import { Menu } from '../../files/Menu.tsx'
import { applyLive, type FieldChoice, type HeaderOptions, insertField, notes, type PagePart, setHeaderFooter, setHeaderOptions, setNote } from './model.ts'
import { revealInDesk, useScrollTick } from './overlay.ts'
import { PageSetupDialog } from './PageSetupDialog.tsx'
import { fieldViewsOf, showField, withPageViews } from './pages/fields.ts'
import { paginatorOf } from './pages/paginator.ts'
import { $pageSetup, openPartOf, setOpenPart } from './parts.ts'
import { docsExtensions } from './schema.ts'
import { $noteEdit, $pages, $partEdit, $zoom } from './store.ts'
import { DocsTableView, imageView } from './views.ts'

/*
 * Headers, footers and notes edited where the page draws them, as in Word: an editor of the
 * document's own schema over the drawn area, at the page's text width and in the document's looks,
 * scrolling and zooming with the page. What is typed goes into the document as steps of its own
 * (after a rest in typing, at once on closing, and before the document is read), so the
 * document's undo takes it back too; the editor's own undo works while it is open.
 */

export interface PartEditorsProps {
  editor: Editor
  docKey: string
  frame: HTMLElement | null
  desk: HTMLElement | null
  active: boolean
}

/** How long typing rests before what was typed goes into the document, in milliseconds. */
const REST = 300

type Edit = { what: 'part'; part: PagePart; page: number; at: number } | { what: 'note'; kind: NoteKind; pos: number; at: number }

/** Headers, footers and notes edited in place on the page. */
export function PartEditors({ editor, docKey, frame, desk, active }: PartEditorsProps): ReactNode {
  const [edit, setEdit] = useState<Edit | null>(null)
  const setup = useStore($pageSetup)
  const headers = useEditorState({ editor, selector: ({ editor: current }) => (current.isDestroyed ? null : ((current.state.doc.attrs.headers as PageHeaders | null) ?? null)) })

  useEffect(
    () =>
      $partEdit.subscribe((request) => {
        if (request?.docKey === docKey) {
          $partEdit.set(null)
          setEdit({ what: 'part', part: request.part, page: request.page, at: Date.now() })
        }
      }),
    [docKey]
  )

  useEffect(
    () =>
      $noteEdit.subscribe((request) => {
        if (request?.docKey === docKey) {
          $noteEdit.set(null)
          setEdit({ what: 'note', kind: request.kind, pos: request.pos, at: Date.now() })
        }
      }),
    [docKey]
  )

  useEffect(() => {
    if (!active) {
      setEdit(null)
    }
  }, [active])

  const close = (refocus: boolean) => {
    setEdit(null)

    if (refocus && !editor.isDestroyed) {
      editor.commands.focus()
    }
  }

  const kind = edit?.what === 'part' ? headerKindFor(headers ?? null, edit.page) : null

  return (
    <>
      {edit?.what === 'part' && kind && (
        <HeaderFooterEditor
          key={`${edit.at}:${edit.part}:${edit.page}:${kind}`}
          main={editor}
          docKey={docKey}
          part={edit.part}
          page={edit.page}
          kind={kind}
          headers={headers ?? null}
          frame={frame}
          desk={desk}
          onSwitch={(part, page) => setEdit({ what: 'part', part, page, at: edit.at })}
          onClose={close}
        />
      )}
      {edit?.what === 'note' && <NoteEditor key={edit.at} main={editor} docKey={docKey} kind={edit.kind} pos={edit.pos} desk={desk} onClose={close} />}
      {active && setup === docKey && (
        <PageSetupDialog
          editor={editor}
          onClose={() => {
            $pageSetup.set(null)
            editor.commands.focus()
          }}
        />
      )}
    </>
  )
}

/** Puts what is being typed in a header, footer or note into the document, before it is read. */
export function flushPartEdits(docKey: string): void {
  openPartOf(docKey)?.flush()
}

// The editors.

const storyKeys = (onEscape: () => void) =>
  Extension.create({
    name: 'storyKeys',
    // Below lists and tables, which take Tab first.
    priority: 50,
    addKeyboardShortcuts() {
      const inList = () => this.editor.isActive('taskItem') || this.editor.isActive('listItem')

      return {
        Escape: () => {
          onEscape()

          return true
        },
        Tab: () => (this.editor.isActive('table') ? false : inList() || this.editor.commands.insertContent('\t')),
        'Shift-Tab': () => !this.editor.isActive('table'),
        // A page break has no place in a header, a footer or a note.
        'Mod-Enter': () => true
      }
    }
  })

const storyDoc = (blocks: readonly DocNode[]): DocNode => ({ type: 'doc', content: blocks.length ? [...blocks] : [{ type: 'paragraph' }] })

/** An editor of the document's schema in `element`, for a header, a footer or a note. */
function storyEditor(element: HTMLElement, blocks: readonly DocNode[], story: { label: string; className?: string; onEscape: () => void; onChange: () => void }): Editor {
  return new Editor({
    element,
    content: storyDoc(blocks),
    extensions: [...withPageViews(docsExtensions({ views: { image: imageView, table: DocsTableView } })), storyKeys(story.onEscape)],
    editorProps: {
      attributes: { ...(story.className ? { class: story.className } : {}), spellcheck: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': story.label },
      handleScrollToSelection: (view) => revealInDesk(view, view.state.selection.head)
    },
    onUpdate: story.onChange
  })
}

/** Show the document's content again in a story's editor, its history starting again. */
function reload(editor: Editor, blocks: readonly DocNode[]): void {
  const doc = editor.schema.nodeFromJSON(storyDoc(blocks))
  editor.view.updateState(EditorState.create({ doc, plugins: editor.state.plugins, selection: Selection.atEnd(doc) }))
  editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false))
}

interface Spot {
  top: number
  bottom: number
  left: number
  width: number
  height: number
}

/** Where something drawn on the page is in the sheet, in the sheet's own pixels (the zoom taken out). */
function spotIn(sheet: HTMLElement, element: Element, zoom: number): Spot {
  const outer = sheet.getBoundingClientRect()
  const box = element.getBoundingClientRect()

  return { top: (box.top - outer.top) / zoom, bottom: (box.bottom - outer.top) / zoom, left: (box.left - outer.left) / zoom, width: box.width / zoom, height: box.height / zoom }
}

/** Calls `away` for a press on the page outside `box`, but not on the desk's scroll bars. */
function usePressAway(desk: HTMLElement | null, box: RefObject<HTMLElement | null>, away: (event: MouseEvent) => void): void {
  const handler = useRef(away)
  handler.current = away

  useEffect(() => {
    if (!desk) {
      return
    }

    const onDown = (event: MouseEvent) => {
      const target = event.target instanceof Node ? event.target : null
      const onBars = target === desk && (event.offsetX >= desk.clientWidth || event.offsetY >= desk.clientHeight)

      if (target && !onBars && !box.current?.contains(target)) {
        handler.current(event)
      }
    }
    desk.addEventListener('mousedown', onDown, true)

    return () => desk.removeEventListener('mousedown', onDown, true)
  }, [desk, box])
}

/** A press on the box around a story's text, outside the text, puts the caret at its end. */
function focusFromBox(event: ReactMouseEvent<HTMLElement>, editor: Editor | null): void {
  if (editor && !editor.isDestroyed && event.target === event.currentTarget) {
    event.preventDefault()
    editor.commands.focus('end')
  }
}

// Headers and footers.

const partBlocks = (main: Editor, part: PagePart, kind: HeaderKind): DocNode[] => (main.state.doc.attrs.headers as PageHeaders | null)?.[part]?.[kind] ?? []

function partLabel(part: PagePart, kind: HeaderKind, headers: PageHeaders | null): string {
  const name = part === 'header' ? 'Header' : 'Footer'

  return kind === 'first' ? `First Page ${name}` : kind === 'even' ? `Even Page ${name}` : headers?.differentOddEven ? `Odd Page ${name}` : name
}

interface PartProps {
  main: Editor
  docKey: string
  part: PagePart
  page: number
  kind: HeaderKind
  headers: PageHeaders | null
  frame: HTMLElement | null
  desk: HTMLElement | null
  onSwitch: (part: PagePart, page: number) => void
  onClose: (refocus: boolean) => void
}

/** A page's header or footer, of the kind it shows, edited over its area, with a bar of its options under or over it. */
function HeaderFooterEditor({ main, docKey, part, page, kind, headers, frame, desk, onSwitch, onClose }: PartProps) {
  const box = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const [own, setOwn] = useState<Editor | null>(null)
  const [, setVersion] = useState(0)
  const map = useStore($pages)[docKey]
  const zoom = useStore($zoom)[docKey] ?? 1
  const scrolled = useScrollTick(useMemo(() => ({ current: desk }), [desk]))
  const sheet = main.view.dom.closest<HTMLElement>('.docs-sheet')
  const label = partLabel(part, kind, headers)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const element = box.current

    if (!element) {
      return
    }

    let timer = 0
    let dirty = false
    let committing = false
    let committed = JSON.stringify(partBlocks(main, part, kind))
    const instance = storyEditor(element, partBlocks(main, part, kind), {
      label,
      onEscape: () => close.current(true),
      onChange: () => {
        dirty = true
        window.clearTimeout(timer)
        timer = window.setTimeout(commit, REST)
      }
    })

    function commit() {
      window.clearTimeout(timer)

      if (!dirty || main.isDestroyed || instance.isDestroyed) {
        return
      }

      dirty = false
      committing = true

      try {
        applyLive(main.view, setHeaderFooter(part, kind, { blocks: (instance.getJSON().content ?? []) as DocNode[] }))
      } finally {
        committing = false
      }

      committed = JSON.stringify(partBlocks(main, part, kind))
    }

    // The document changed otherwise (an undo, Hermes, a version from disk): show what it has now.
    const onMain = () => {
      const now = JSON.stringify(partBlocks(main, part, kind))

      if (!committing && !instance.isDestroyed && now !== committed) {
        committed = now
        dirty = false
        window.clearTimeout(timer)
        reload(instance, partBlocks(main, part, kind))
      }
    }
    const onOwn = () => setVersion((value) => value + 1)
    main.on('transaction', onMain)
    instance.on('transaction', onOwn)
    setOpenPart(docKey, { what: part, editor: instance, page, flush: commit })
    setOwn(instance)
    instance.commands.focus('end')

    return () => {
      main.off('transaction', onMain)
      commit()
      setOpenPart(docKey, null, instance)
      instance.destroy()
    }
  }, [docKey, kind, main, page, part])

  useEffect(() => {
    if (own && !own.isDestroyed) {
      own.view.dom.setAttribute('aria-label', label)
    }
  }, [own, label])

  // Fields show the page being edited, and the page count.
  useEffect(() => {
    if (own && !own.isDestroyed) {
      for (const field of fieldViewsOf(own.view)) {
        showField(field, page, map?.pages.length)
      }
    }
  })

  useEffect(() => {
    if (map && page > map.pages.length) {
      close.current(false)
    }
  }, [map, page])

  usePressAway(desk, box, (event) => {
    const area = event.target instanceof Element ? event.target.closest<HTMLElement>('.docs-page-area') : null

    if (area && sheet?.contains(area)) {
      event.preventDefault()
      event.stopPropagation()
      onSwitch(area.dataset.pagePart === 'footer' ? 'footer' : 'header', Number(area.dataset.page) || 1)
    } else {
      onClose(false)
    }
  })

  // The bar sits under a header and over a footer, inside the frame however the page scrolls.
  useLayoutEffect(() => {
    const element = bar.current
    const target = box.current

    if (!element || !target || !frame) {
      return
    }

    const outer = frame.getBoundingClientRect()
    const edge = target.getBoundingClientRect()
    const top = part === 'header' ? edge.bottom - outer.top + 6 : edge.top - outer.top - element.offsetHeight - 6
    element.style.left = `${Math.max(8, Math.min(edge.left - outer.left, outer.width - element.offsetWidth - 8))}px`
    element.style.top = `${Math.max(8, Math.min(top, outer.height - element.offsetHeight - 8))}px`
  })

  const option = (change: HeaderOptions) => {
    openPartOf(docKey)?.flush()
    applyLive(main.view, setHeaderOptions(change))
    own?.commands.focus()
  }

  const insert = (choice: FieldChoice) => {
    if (own && !own.isDestroyed) {
      applyLive(own.view, insertField(choice))
      own.commands.focus()
    }
  }

  void scrolled
  const area = paginatorOf(main.view)?.areaOf(part, page)
  const spot = sheet && area?.isConnected ? spotIn(sheet, area, zoom) : null
  const style: CSSProperties = spot ? { top: part === 'header' ? spot.top : spot.bottom, left: spot.left, width: spot.width, minHeight: spot.height } : { visibility: 'hidden' }
  const scope = `[data-docs-page="${docKey}"]`
  const css = [
    `${scope} .docs-mount, ${scope} .docs-page-notes { opacity: 0.4 }`,
    `${scope} .docs-page-area { outline: 1px dashed rgb(47 125 255 / 0.35); outline-offset: 2px }`,
    `${scope} .docs-page-area[data-page-part="${part}"][data-page="${page}"] > .doc-part { visibility: hidden }`
  ].join('\n')

  return (
    <>
      <style>{css}</style>
      {sheet && createPortal(<div ref={box} className={cn('docs-part-box doc-part', `doc-${part}`)} data-anchor={part === 'footer' ? 'end' : 'start'} style={style} onMouseDown={(event) => focusFromBox(event, own)} />, sheet)}
      <div ref={bar} role="toolbar" aria-label={label} className="float menu-surface absolute z-30 flex max-w-[calc(100%-16px)] flex-wrap items-center gap-0.5 rounded-xl p-1 text-[12px] animate-pop" onMouseDown={(event) => event.preventDefault()}>
        <span className="px-2 font-medium whitespace-nowrap text-fg">{label}</span>
        <BarDivider />
        <BarToggle label="Different first page" checked={Boolean(headers?.differentFirst)} onToggle={() => option({ differentFirst: !headers?.differentFirst })} />
        <BarToggle label="Different odd and even pages" checked={Boolean(headers?.differentOddEven)} onToggle={() => option({ differentOddEven: !headers?.differentOddEven })} />
        <BarDivider />
        <PageNumberMenu onPick={insert} />
        <BarButton label="Date" icon={<IconCalendar />} onClick={() => insert('date')} />
        <BarDivider />
        <BarButton label="Close" title="Close the header and footer (Esc)" icon={<IconX />} onClick={() => onClose(true)} />
      </div>
    </>
  )
}

const BarDivider = () => <span className="mx-0.5 h-5 w-px shrink-0 bg-line" />

const BAR_BUTTON = 'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 whitespace-nowrap text-fg-2 hover:bg-white/8 hover:text-fg [&_svg]:size-4'

function BarButton({ label, title, icon, onClick }: { label: string; title?: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button type="button" title={title ?? label} onClick={onClick} className={BAR_BUTTON}>
      {icon}
      {label}
    </button>
  )
}

function BarToggle({ label, checked, onToggle }: { label: string; checked: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} onClick={onToggle} className={cn(BAR_BUTTON, checked && 'text-fg')}>
      {checked ? <IconSquareCheck className="text-accent" /> : <IconSquare />}
      {label}
    </button>
  )
}

const PAGE_FIELDS: readonly { id: FieldChoice; label: string }[] = [
  { id: 'page', label: 'Page Number' },
  { id: 'pageOfPages', label: 'Page X of Y' },
  { id: 'pages', label: 'Page Count' }
]

function PageNumberMenu({ onPick }: { onPick: (choice: FieldChoice) => void }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onClick={() => setOpen(!open)}
        className={cn(BAR_BUTTON, 'pr-1', open && 'bg-white/10 text-fg')}
      >
        <IconHash />
        Page Number
        <IconChevronDown size={13} className="text-fg-3" />
      </button>
      {open && <Menu align="left" className="top-full mt-1" onClose={() => setOpen(false)} items={PAGE_FIELDS.map((entry) => ({ id: entry.id, label: entry.label, onSelect: () => onPick(entry.id) }))} />}
    </div>
  )
}

// Notes.

interface NoteProps {
  main: Editor
  docKey: string
  kind: NoteKind
  pos: number
  desk: HTMLElement | null
  onClose: (refocus: boolean) => void
}

/** A footnote or endnote edited where it is drawn (at its page's foot, or after the text), else under its reference. */
function NoteEditor({ main, docKey, kind, pos, desk, onClose }: NoteProps) {
  const box = useRef<HTMLDivElement>(null)
  const at = useRef(pos)
  const placed = useRef(false)
  const [own, setOwn] = useState<Editor | null>(null)
  const [, setVersion] = useState(0)
  const map = useStore($pages)[docKey]
  const zoom = useStore($zoom)[docKey] ?? 1
  const sheet = main.view.dom.closest<HTMLElement>('.docs-sheet')
  const close = useRef(onClose)
  close.current = onClose
  const doc = main.state.doc
  const number = useMemo(() => notes(doc).filter((note) => note.kind === kind && note.pos <= at.current).length, [doc, kind])

  useEffect(() => {
    const element = box.current
    const start = main.state.doc.nodeAt(at.current)

    if (!element || start?.type.name !== 'note') {
      close.current(false)

      return
    }

    let timer = 0
    let dirty = false
    let committing = false
    let committed = JSON.stringify(start.attrs.content ?? [])
    const instance = storyEditor(element, (start.attrs.content as DocNode[] | null) ?? [], {
      label: kind === 'endnote' ? 'Endnote' : 'Footnote',
      className: 'doc-note',
      onEscape: () => close.current(true),
      onChange: () => {
        dirty = true
        window.clearTimeout(timer)
        timer = window.setTimeout(commit, REST)
      }
    })

    function commit() {
      window.clearTimeout(timer)

      if (!dirty || main.isDestroyed || instance.isDestroyed) {
        return
      }

      dirty = false
      committing = true

      try {
        applyLive(main.view, setNote({ pos: at.current }, { blocks: (instance.getJSON().content ?? []) as DocNode[] }))
        committed = JSON.stringify(main.state.doc.nodeAt(at.current)?.attrs.content ?? [])
      } catch {
        // The note went with its reference.
      } finally {
        committing = false
      }
    }

    // Its reference moves with the text, and deleting it deletes the note.
    const onMain = ({ transaction }: { transaction: Transaction }) => {
      if (committing || instance.isDestroyed) {
        return
      }

      const mapped = transaction.mapping.mapResult(at.current)
      const node = main.state.doc.nodeAt(mapped.pos)

      if (mapped.deletedAfter || node?.type.name !== 'note') {
        dirty = false
        close.current(false)

        return
      }

      at.current = mapped.pos
      const now = JSON.stringify(node.attrs.content ?? [])

      if (now !== committed) {
        committed = now
        dirty = false
        window.clearTimeout(timer)
        reload(instance, (node.attrs.content as DocNode[] | null) ?? [])
      }
    }
    const onOwn = () => setVersion((value) => value + 1)
    main.on('transaction', onMain)
    instance.on('transaction', onOwn)
    setOpenPart(docKey, { what: 'note', editor: instance, page: null, flush: commit })
    setOwn(instance)
    instance.commands.focus('end')

    return () => {
      main.off('transaction', onMain)
      commit()
      setOpenPart(docKey, null, instance)
      instance.destroy()
    }
  }, [docKey, kind, main])

  usePressAway(desk, box, () => onClose(false))

  void map
  const holder = kind === 'footnote' ? '.docs-page-notes' : '.doc-endnotes'
  const drawn = sheet?.querySelector(`${holder} .doc-note[data-note="${kind}"][data-number="${number}"]`)
  const reference = drawn ? null : main.view.nodeDOM(at.current)
  let style: CSSProperties = { visibility: 'hidden' }

  if (sheet && drawn) {
    const spot = spotIn(sheet, drawn, zoom)
    style = { top: kind === 'footnote' ? spot.bottom : spot.top, left: spot.left, width: spot.width, minHeight: spot.height }
  } else if (sheet && reference instanceof Element) {
    const spot = spotIn(sheet, reference, zoom)
    const column = spotIn(sheet, main.view.dom, zoom)
    style = { top: spot.bottom + 4, left: column.left, width: column.width }
  }

  // Once the page draws a new note, its editor moves there: the caret goes with it into view.
  useLayoutEffect(() => {
    if (drawn && !placed.current && own && !own.isDestroyed) {
      placed.current = true
      revealInDesk(own.view, own.state.selection.head)
    }
  })

  const css = `[data-docs-page="${docKey}"] ${holder} .doc-note[data-note="${kind}"][data-number="${number}"] { visibility: hidden }`

  return (
    <>
      <style>{css}</style>
      {sheet &&
        createPortal(
          <div
            ref={box}
            className="docs-part-box doc-part"
            data-anchor={drawn && kind === 'footnote' ? 'end' : 'start'}
            data-note={kind}
            style={{ ...style, '--docs-note-label': JSON.stringify(noteLabel(kind, Math.max(1, number))) } as CSSProperties}
            onMouseDown={(event) => focusFromBox(event, own)}
          />,
          sheet
        )}
    </>
  )
}
