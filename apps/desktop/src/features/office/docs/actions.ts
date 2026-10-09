import type { ChainedCommands, Editor } from '@tiptap/core'
import { type CalloutKind, headerKindFor, type NoteKind, type PageHeaders, type SectionKind } from '../../../../shared/office/document.ts'
import { messageOf } from '../../canvas/errors.ts'
import { insertPictures, mimeOfName } from './editor.ts'
import {
  applyLive,
  type BlockStyle,
  clearFormatting,
  type FieldChoice,
  indent,
  insertField,
  insertNote,
  insertPageBreak,
  insertSectionBreak,
  insertTable,
  notes,
  type Op,
  type PageChange,
  type PagePart,
  setAlignment,
  setLineSpacing,
  setPage,
  setStyle,
  textWidthOf
} from './model.ts'
import { pageAt } from './pages/map.ts'
import { paginatorOf } from './pages/paginator.ts'
import { $pageSetup, openPartOf } from './parts.ts'
import { $find, $linkEdit, $noteEdit, $pages, $partEdit, $zoom, activeEditor, docsSession, type ScreenRect } from './store.ts'

/*
 * What the toolbar, the menus and the '/' menu do to the document in front. Formatting goes
 * through TipTap's commands (they carry formatting over to what is typed next); styles, layout
 * and insertions go through the document API, one undo step each. While a header, footer or note
 * is open on the page, formatting and insertions go to it; breaks, notes and the page stay the text's.
 */

/** The editor typing goes to in the document in front: a header, footer or note open on the page, else the document's text. */
export const typingEditor = (): Editor | null => openPartOf(docsSession.$activeKey.get())?.editor ?? activeEditor()

/** Whether the document in front has its text in front, with no header, footer or note open on it. */
export const inText = (): boolean => Boolean(activeEditor()) && !openPartOf(docsSession.$activeKey.get())

export function apply(op: Op, editor: Editor | null = typingEditor()): void {
  if (editor) {
    applyLive(editor.view, op)
    editor.commands.focus()
  }
}

export function chain(build: (chain: ChainedCommands) => ChainedCommands, editor: Editor | null = typingEditor()): void {
  if (editor) {
    build(editor.chain().focus()).run()
  }
}

export const hasEditor = (): boolean => Boolean(activeEditor())
export const isActive = (name: string, attrs?: Record<string, unknown>): boolean => Boolean(typingEditor()?.isActive(name, attrs))

export type MarkName = 'bold' | 'italic' | 'underline' | 'strike' | 'superscript' | 'subscript' | 'code'

export function toggleMark(name: MarkName): void {
  chain((c) => {
    switch (name) {
      case 'bold':
        return c.toggleBold()
      case 'italic':
        return c.toggleItalic()
      case 'underline':
        return c.toggleUnderline()
      case 'strike':
        return c.toggleStrike()
      case 'superscript':
        return c.unsetSubscript().toggleSuperscript()
      case 'subscript':
        return c.unsetSuperscript().toggleSubscript()
      case 'code':
        return c.toggleCode()
    }
  })
}

export const style = (name: BlockStyle): void => apply(setStyle(name))
export const align = (value: 'left' | 'center' | 'right' | 'justify'): void => apply(setAlignment(value))
export const lineSpacing = (multiple: number | null): void => apply(setLineSpacing(multiple))
export const font = (family: string | null): void => chain((c) => (family ? c.setFontFamily(family) : c.unsetFontFamily()))
export const fontSize = (points: number | null): void => chain((c) => (points ? c.setFontSize(`${points}pt`) : c.unsetFontSize()))
export const color = (value: string | null): void => chain((c) => (value ? c.setColor(value) : c.unsetColor()))
export const highlight = (value: string | null): void => chain((c) => (value ? c.setHighlight({ color: value }) : c.unsetHighlight()))
export const clear = (): void => {
  chain((c) => c.unsetAllMarks())
  apply(clearFormatting())
}

export type ListKind = 'bullet' | 'ordered' | 'task'

export const list = (kind: ListKind): void => chain((c) => (kind === 'bullet' ? c.toggleBulletList() : kind === 'ordered' ? c.toggleOrderedList() : c.toggleTaskList()))

const listItem = (): string | null => (isActive('taskItem') ? 'taskItem' : isActive('listItem') ? 'listItem' : null)

export function shiftIndent(direction: 1 | -1): void {
  const item = listItem()

  if (item) {
    chain((c) => (direction > 0 ? c.sinkListItem(item) : c.liftListItem(item)))
  } else {
    apply(indent(36 * direction))
  }
}

export function callout(kind: CalloutKind): void {
  if (isActive('callout')) {
    chain((c) => c.updateAttributes('callout', { kind }))
  } else {
    chain((c) => c.wrapIn('callout', { kind }))
  }
}

export const removeCallout = (): void => chain((c) => c.lift('callout'))

export function table(rows = 3, cols = 3): void {
  const text = activeEditor()
  // A header, footer or note has no page of its own: its table shares the document's text width.
  const widths = text && !inText() ? Array.from({ length: cols }, () => Math.floor(textWidthOf(text.state.doc) / cols)) : undefined

  apply(insertTable({ rows, cols, widths }, 'selection'))
}

export const rule = (): void => chain((c) => c.setHorizontalRule())

export function pageBreak(): void {
  if (inText()) {
    apply(insertPageBreak(), activeEditor())
  }
}

export const page = (change: PageChange): void => apply(setPage(change), activeEditor())

export function editLink(): void {
  const key = docsSession.$activeKey.get()

  if (key && inText()) {
    $linkEdit.set({ key, at: Date.now() })
  }
}

export function openFind(replace: boolean): void {
  const key = docsSession.$activeKey.get()

  if (key) {
    $find.set({ key, replace, at: Date.now() })
  }
}

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

export function zoom(key: string, step: 'in' | 'out' | 'reset'): void {
  const current = $zoom.get()[key] ?? 1
  const index = ZOOM_STEPS.findIndex((value) => value >= current - 0.001)
  const next = step === 'reset' ? 1 : (ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, (index < 0 ? ZOOM_STEPS.length - 1 : index) + (step === 'in' ? 1 : -1)))] ?? 1)
  $zoom.set({ ...$zoom.get(), [key]: next })
}

// The page: headers and footers, fields, notes, breaks and page setup.

const screenRect = (element: Element | null | undefined): ScreenRect => {
  const box = element?.getBoundingClientRect()

  return box ? { left: box.left, top: box.top, width: box.width, height: box.height } : { left: 0, top: 0, width: 0, height: 0 }
}

/** Edit the header or footer of the page the caret is on, or of the page whose header or footer is open. */
export function editPart(part: PagePart): void {
  const editor = activeEditor()
  const key = docsSession.$activeKey.get()

  if (!editor || !key) {
    return
  }

  const page = openPartOf(key)?.page ?? pageAt($pages.get()[key], editor.state.selection.head)?.number ?? 1
  const kind = headerKindFor((editor.state.doc.attrs.headers as PageHeaders | null) ?? null, page)
  $partEdit.set({ docKey: key, part, kind, page, rect: screenRect(paginatorOf(editor.view)?.areaOf(part, page)) })
}

/** A page number, Page X of Y, the page count, the date or the time: in the header, footer or note open, else at the caret. */
export const field = (choice: FieldChoice): void => apply(insertField(choice))

/** A new footnote or endnote at the caret, opened to write in. */
export function note(kind: NoteKind): void {
  const editor = activeEditor()
  const key = docsSession.$activeKey.get()

  if (!editor || !key || !inText() || !applyLive(editor.view, insertNote(kind))) {
    return
  }

  const pos = editor.state.selection.from - 1
  const found = notes(editor.state.doc).find((entry) => entry.pos === pos)

  if (found) {
    $noteEdit.set({ docKey: key, kind, number: found.number, pos, rect: screenRect(editor.view.nodeDOM(pos) as Element | null) })
  }
}

export function sectionBreak(kind: SectionKind): void {
  if (inText()) {
    apply(insertSectionBreak(kind), activeEditor())
  }
}

export function pageSetup(): void {
  const key = docsSession.$activeKey.get()

  if (key && activeEditor()) {
    $pageSetup.set(key)
  }
}

/** Pictures picked in a file dialog, put in at the selection (of the header, footer or note open, if one is). */
export async function picturesFromFiles(files: readonly File[]): Promise<void> {
  const editor = typingEditor()

  if (!editor || !files.length) {
    return
  }

  const read = await Promise.all(files.map(async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type || mimeOfName(file.name) })))
  const added = await insertPictures(editor.view, read)

  if (added < read.length) {
    docsSession.notify('Herald Docs shows PNG, JPEG, GIF, WebP, BMP and SVG pictures', 'error')
  }

  editor.commands.focus()
}

/** A picture file dropped from Files or Finder, put in where it was dropped. */
export async function pictureFromPath(file: string, at?: { left: number; top: number }): Promise<void> {
  const editor = activeEditor()
  const mime = mimeOfName(file)

  if (!editor) {
    return
  }

  try {
    const data = await window.heraldOS.office.read(file)
    const pos = at ? editor.view.posAtCoords(at)?.pos : undefined
    const added = await insertPictures(editor.view, [{ bytes: data.bytes, mime }], pos === undefined ? 'selection' : { pos })

    if (!added) {
      docsSession.notify(`Herald Docs does not show ${file.split('/').pop()} as a picture`, 'error')
    }
  } catch (error) {
    docsSession.notify(`Could not add ${file.split('/').pop()}: ${messageOf(error)}`, 'error')
  }
}
