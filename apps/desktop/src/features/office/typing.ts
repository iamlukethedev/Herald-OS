import type { EditorState, Transaction } from '@tiptap/pm/state'
import type { OfficeApp } from '../../../shared/office/files.ts'
import { cellName, parseRange } from '../../../shared/office/xlsx/address.ts'
import { withLeadingSpace } from '../../lib/voice/dictation.ts'
import type { Op } from './docs/model.ts'
import type { TextSession } from './slides/editor/active.ts'

/*
 * Dictation into the Office document in front in this window, without the clipboard: Herald Docs
 * takes the words at the caret, Herald Sheets in the active cell and on down the column, Herald
 * Slides in the text box being edited or selected, else in a new one; each lands as one step to
 * undo. Anything else (another window in front, a field outside the document with the focus, a
 * cell being edited) is left to the caller, which types the usual way.
 */

/** Dictated text as lines: a spoken "new line" or "new paragraph" starts the next one, and blank lines fold away as pasted text's do. */
export function dictatedLines(text: string): string[] {
  return text.replace(/^[ \t]+|[ \t]+$/g, '').split(/[ \t]*(?:\r?\n[ \t]*)+/)
}

/** Dictated words for a caption: one line, at most 60 characters. */
export const quoted = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 60)

/** The character just before the caret: '' at the start of a paragraph, a line break after a break or an image. */
export function characterBefore(state: EditorState): string {
  const before = state.selection.$from.nodeBefore

  return before?.isText ? (before.text ?? '').slice(-1) : before ? '\n' : ''
}

const LIST_ITEMS = new Set(['listItem', 'taskItem'])

/** What Enter does at the caret: a line break in code, the next item in a list, else a new paragraph (a plain one after a heading). */
function pressEnter(tr: Transaction): void {
  const marks = tr.storedMarks ?? tr.selection.$from.marks()

  if (!tr.selection.empty) {
    tr.deleteSelection()
  }

  const { $from } = tr.selection
  const block = $from.parent
  const paragraph = tr.doc.type.schema.nodes.paragraph
  const item = $from.depth > 1 ? $from.node(-1) : null

  if (block.type.spec.code) {
    tr.insertText('\n')
  } else if (item && LIST_ITEMS.has(item.type.name)) {
    tr.split($from.pos, 2, [{ type: item.type, attrs: item.type.name === 'taskItem' ? { ...item.attrs, checked: false } : item.attrs }])
  } else {
    tr.split($from.pos, 1, block.type !== paragraph && $from.parentOffset === block.content.size ? [{ type: paragraph, attrs: block.attrs }] : undefined)
  }

  tr.ensureMarks(marks)
}

/**
 * Dictated words into a document as typing them would put them: the first line joins the text at the
 * caret (after a space when it follows a word), each further line is what Enter does, "press enter"
 * ends with one, and the caret ends after the last word. One transaction, so one step to undo.
 */
export function typed(text: string, submit = false): Op {
  return (state) => {
    const tr = state.tr

    dictatedLines(text).forEach((line, index) => {
      if (index > 0) {
        pressEnter(tr)
      }

      const words = index === 0 ? withLeadingSpace(characterBefore(state), line) : line

      if (words) {
        tr.insertText(words)
      }
    })

    if (submit) {
      pressEnter(tr)
    }

    return tr.docChanged ? tr.scrollIntoView() : null
  }
}

/** Dictated words that add nothing at the caret: only the mark it follows already. */
export function addsNothing(state: EditorState, text: string, submit = false): boolean {
  const lines = dictatedLines(text)

  return !submit && lines.length === 1 && Boolean(lines[0]) && !withLeadingSpace(characterBefore(state), lines[0])
}

/** Where dictated lines go in a sheet: from the selection's first cell down its column; `next` is the cell after them (below the first when there are none, as Enter goes), where dictation carries on. */
export function columnPlacement(selection: string, lines: number): { first: string; next: { row: number; column: number; name: string } } | null {
  const range = parseRange(selection)

  if (!range) {
    return null
  }

  const row = range.startRow + Math.max(1, lines)

  return { first: cellName(range.startRow, range.startColumn), next: { row, column: range.startColumn, name: cellName(row, range.startColumn) } }
}

/** Univer keeps the keyboard in a hidden editable of its own while a cell is selected. */
const UNIVER_INPUT = '[data-u-comp="editor"]'

/** Steps after the words are in; none may fail the call, or the caller would type the words a second time. */
function afterwards(step: () => void): void {
  try {
    step()
  } catch {
    // Moving the selection or the focus is a nicety.
  }
}

const typedCaption = (text: string, submit: boolean, name: string): string => (text.trim() ? `Typed "${quoted(text)}"${submit ? ' and pressed Enter' : ''} in ${name}` : `Pressed Enter in ${name}`)

const alreadyCaption = (text: string, name: string): string => `Already after "${quoted(text)}" in ${name}`

/** The Office app whose window is in front here, when it has a document open in this window. */
async function officeInFront(): Promise<OfficeApp | null> {
  const { $focusedWindowId, $windows } = await import('../../store/windows.ts')
  const id = $focusedWindowId.get()
  const win = id ? $windows.get()[id] : undefined
  const app = win && (win.phase === 'open' || win.phase === 'opening') ? win.appId : null

  if (app !== 'docs' && app !== 'sheets' && app !== 'slides') {
    return null
  }

  // Importing an app's store opens its session: look at the sessions already open before loading one.
  const { loadedSessions } = await import('./session.ts')

  return loadedSessions.get(app)?.active() ? app : null
}

async function typeIntoDocs(text: string, submit: boolean): Promise<string | null> {
  const [{ docsSession, editorOf }, { applyLive }, { isEditable }] = await Promise.all([import('./docs/store.ts'), import('./docs/model.ts'), import('../../store/edit-target.ts')])
  const doc = docsSession.active()
  const editor = editorOf(doc?.key)
  const focused = document.activeElement

  // A field outside the page (the find bar, a dialog, Hermes's composer) takes the words itself.
  if (!doc || !editor || editor.isDestroyed || !editor.isEditable || (isEditable(focused) && !editor.view.dom.contains(focused))) {
    return null
  }

  if (addsNothing(editor.view.state, text, submit)) {
    return alreadyCaption(text, doc.name)
  }

  if (!applyLive(editor.view, typed(text, submit))) {
    return null
  }

  afterwards(() => doc.editor?.focus?.())

  return typedCaption(text, submit, doc.name)
}

async function typeIntoSheets(text: string, submit: boolean): Promise<string | null> {
  const [{ sheetsSession }, { liveTarget, selectionIn }, { writeRange }, { coerceValue }, { isEditable }] = await Promise.all([import('./sheets/store.ts'), import('./sheets/live.ts'), import('./sheets/model.ts'), import('./sheets/agent-model.ts'), import('../../store/edit-target.ts')])
  const doc = sheetsSession.active()
  const target = doc ? liveTarget(doc.key) : null
  const selection = doc ? selectionIn(doc.key) : null
  const values = dictatedLines(text).filter(Boolean).map((line) => [coerceValue(line)])
  const place = selection ? columnPlacement(selection.range, values.length) : null
  const focused = document.activeElement

  // A cell being edited takes the words as typing, at its caret; so does a field outside the sheet.
  if (!doc || !target || !selection || !place || (!values.length && !submit) || target.workbook.isCellEditing() || (isEditable(focused) && !focused.closest(UNIVER_INPUT))) {
    return null
  }

  const written = values.length ? await writeRange(target, { range: place.first, values, sheet: selection.sheet }) : null

  afterwards(() => {
    const sheet = target.workbook.getSheetByName(selection.sheet)

    if (sheet && place.next.row < sheet.getMaxRows()) {
      sheet.getRange(place.next.row, place.next.column).activate()
    }
  })

  return written ? `Wrote "${quoted(text)}" in ${written.range} of ${doc.name}` : `Moved to ${place.next.name} in ${doc.name}`
}

/** How long a Slides text box may take to come up for typing once editing it starts (React mounts its editor on a later render). */
const EDITOR_WAIT_MS = 1000

async function editorUp(find: () => TextSession | null): Promise<TextSession | null> {
  for (let waited = 0; waited < EDITOR_WAIT_MS; waited += 20) {
    const session = find()

    if (session && !session.editor.isDestroyed) {
      return session
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  return null
}

async function typeIntoSlides(text: string, submit: boolean): Promise<string | null> {
  const [{ $presenting, decks, slidesSession }, { textSessionOf }, { change, editSelection }, { addText }, { applyLive }, { isEditable }] = await Promise.all([import('./slides/store.ts'), import('./slides/editor/active.ts'), import('./slides/editor/commands.ts'), import('./slides/model.ts'), import('./docs/model.ts'), import('../../store/edit-target.ts')])
  const doc = slidesSession.active()
  const deck = doc ? decks.get(doc.key) : undefined
  const editing = textSessionOf(deck)
  const lines = dictatedLines(text).filter(Boolean)
  const focused = document.activeElement

  // The notes, the find bar or a dialog takes the words itself, and a bare "press enter" outside a text box is the key itself.
  if (!doc || !deck || $presenting.get()?.key === doc.key || (isEditable(focused) && !editing?.editor.view.dom.contains(focused)) || (!editing && !lines.length)) {
    return null
  }

  // A text box, shape or table selected on the slide takes the words at the end, as Edit Text starts typing.
  if (!editing && deck.selected.length === 1) {
    editSelection('end')
  }

  const session = editing ?? (deck.editing ? await editorUp(() => textSessionOf(deck)) : null)

  if (session) {
    if (addsNothing(session.editor.view.state, text, submit)) {
      return alreadyCaption(text, doc.name)
    }

    // What the person typed before becomes a step of its own, so undo takes the dictation back alone;
    // a text box only just opened has nothing typed yet, and its height fits with the words.
    if (editing) {
      session.flush()
    }

    if (!applyLive(session.editor.view, typed(text, submit))) {
      return null
    }

    afterwards(() => session.flush())

    return typedCaption(text, submit, doc.name)
  }

  if (deck.editing) {
    return null
  }

  // Nothing to type into: the words make a new text box, as pasting them does, selected so more
  // dictation carries on in it. Opening it for typing would fit its height as a second step to undo.
  const added = change((current) => addText(current, deck.slideId, { text: lines.join('\n') }), deck)

  return added ? typedCaption(text, false, `a new text box in ${doc.name}`) : null
}

/**
 * Type dictated words into the Office document in front in this window (desktop mode, where the
 * Office apps are windows inside it). The caption says what happened; null leaves the words to the
 * caller, which types them the usual way.
 */
export async function typeIntoOffice(text: string, options: { submit?: boolean } = {}): Promise<string | null> {
  const submit = Boolean(options.submit)
  const app = text || submit ? await officeInFront() : null

  if (app === 'docs') {
    return typeIntoDocs(text, submit)
  }

  if (app === 'sheets') {
    return typeIntoSheets(text, submit)
  }

  return app === 'slides' ? typeIntoSlides(text, submit) : null
}
