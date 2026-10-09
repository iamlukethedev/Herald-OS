import { generateRandomId, ICommandService, IUndoRedoService, UserManagerService } from '@univerjs/core'
import type { FWorksheet } from '@univerjs/sheets/facade'
import { RemoveNoteMutation, SheetsNoteModel, SheetUpdateNoteCommand, UpdateNoteMutation } from '@univerjs/sheets-note'
import { AddCommentCommand, DeleteCommentCommand, DeleteCommentTreeCommand, getDT, type IThreadComment, ResolveCommentCommand, ThreadCommentModel } from '@univerjs/thread-comment'
import { cellName, parseCell } from '../../../../../shared/office/xlsx/address.ts'
import { bodyOf, nameOfPersonId, plainTextOf, timeOfComment, type UNote } from '../../../../../shared/office/xlsx/comments/model.ts'
import { oneStep, rangeOf, type SheetsTarget, sheetOf } from '../model.ts'
import { commentAuthor } from './author.ts'

/* What Hermes's commands and the menus do with comments and notes on cells, on a workbook (see ../model.ts). */

export interface CommentReply {
  id: string
  author: string
  /** When it was written, in local time: "2026-10-09 14:30". */
  time: string
  text: string
}

export interface CommentThread extends CommentReply {
  sheet: string
  cell: string
  resolved: boolean
  replies: CommentReply[]
}

export interface CellNote {
  sheet: string
  cell: string
  text: string
  author: string
  /** Shown all the time rather than when the cell is pointed at. */
  shown: boolean
}

/** A new note's box, in pixels, as Univer draws one. */
const NOTE_SIZE = { width: 160, height: 72 }

const injector = (target: SheetsTarget) => target.univer.__getInjector()

const authorOf = (target: SheetsTarget, comment: IThreadComment): string => comment.authorName || injector(target).get(UserManagerService).getUser(comment.personId)?.name || nameOfPersonId(comment.personId) || comment.personId

const replyOf = (target: SheetsTarget, comment: IThreadComment): CommentReply => ({ id: comment.id, author: authorOf(target, comment), time: timeOfComment(comment.dT), text: plainTextOf(comment.text) })

/** The sheets a listing covers: the one named, or all of them. */
const sheetsOf = (target: SheetsTarget, sheet: unknown): FWorksheet[] => (sheet === undefined || sheet === null || sheet === '' ? target.workbook.getSheets() : [sheetOf(target.workbook, sheet)])

/** The threads on a sheet's cells (Univer can also hang them on drawings), top to bottom, then left to right. */
function threadsOn(target: SheetsTarget, sheet: FWorksheet) {
  return injector(target)
    .get(ThreadCommentModel)
    .getUnit(target.workbook.getId())
    .filter((thread) => thread.subUnitId === sheet.getSheetId() && parseCell(thread.root.ref ?? ''))
    .map((thread) => ({ ...thread, cell: parseCell(thread.root.ref)! }))
    .sort((a, b) => a.cell.row - b.cell.row || a.cell.column - b.cell.column)
}

/** The comment threads of a sheet, or of every sheet: each with its replies, authors, times and whether it is resolved. */
export function listComments(target: SheetsTarget, args: { sheet?: unknown } = {}): CommentThread[] {
  return sheetsOf(target, args.sheet).flatMap((sheet) =>
    threadsOn(target, sheet).map((thread) => ({
      ...replyOf(target, thread.root),
      sheet: sheet.getSheetName(),
      cell: cellName(thread.cell.row, thread.cell.column),
      resolved: Boolean(thread.root.resolved),
      replies: thread.children.map((child) => replyOf(target, child))
    }))
  )
}

/** One cell a command names ("B2", or "'Q1 sales'!B2"). */
function cellOf(target: SheetsTarget, cell: unknown, sheetName: unknown): { sheet: FWorksheet; row: number; column: number; name: string } {
  const { sheet, cells } = rangeOf(target.workbook, cell, sheetName)

  if (cells.startRow !== cells.endRow || cells.startColumn !== cells.endColumn) {
    throw new Error(`Comments and notes go on one cell, like B2; not on ${String(cell)}`)
  }

  return { sheet, row: cells.startRow, column: cells.startColumn, name: cellName(cells.startRow, cells.startColumn) }
}

const textArg = (text: unknown, what: string): string => {
  const value = String(text ?? '').trim()

  if (!value) {
    throw new Error(`Give the ${what}’s text`)
  }

  return value
}

const noteAt = (target: SheetsTarget, sheet: FWorksheet, row: number, column: number): UNote | null => (injector(target).get(SheetsNoteModel).getNote(target.workbook.getId(), sheet.getSheetId(), { row, col: column }) as UNote | null | undefined) ?? null

/** The thread a command means: by the id of any of its comments, or by its cell. */
function threadOf(target: SheetsTarget, args: { cell?: unknown; id?: unknown; sheet?: unknown }) {
  if (args.id !== undefined && args.id !== null && args.id !== '') {
    const id = String(args.id)

    for (const sheet of sheetsOf(target, args.sheet)) {
      const thread = threadsOn(target, sheet).find((entry) => entry.root.id === id || entry.threadId === id || entry.children.some((child) => child.id === id))

      if (thread) {
        return { sheet, thread, reply: thread.children.find((child) => child.id === id) ?? null }
      }
    }

    throw new Error(`There is no comment with the id “${id}”: listComments gives the ids`)
  }

  if (args.cell === undefined || args.cell === null || args.cell === '') {
    throw new Error('Say which comment: its cell (“B2”) or its id')
  }

  const { sheet, row, column, name } = cellOf(target, args.cell, args.sheet)
  const thread = threadsOn(target, sheet).find((entry) => entry.cell.row === row && entry.cell.column === column)

  if (!thread) {
    throw new Error(`${name} on ${sheet.getSheetName()} has no comment`)
  }

  return { sheet, thread, reply: null }
}

async function run(target: SheetsTarget, command: string, params: object, failure: string): Promise<void> {
  const done = await oneStep(target, () => injector(target).get(ICommandService).executeCommand(command, params))

  if (!done) {
    throw new Error(failure)
  }
}

/** Start a comment thread on a cell. A cell holds a thread or a note, as in Excel. */
export async function addComment(target: SheetsTarget, args: { cell: unknown; text: unknown; sheet?: unknown }): Promise<{ id: string; sheet: string; cell: string }> {
  const { sheet, row, column, name } = cellOf(target, args.cell, args.sheet)
  const text = textArg(args.text, 'comment')

  if (threadsOn(target, sheet).some((entry) => entry.cell.row === row && entry.cell.column === column)) {
    throw new Error(`${name} has a comment already: reply to it`)
  }

  if (noteAt(target, sheet, row, column)) {
    throw new Error(`${name} has a note; a cell holds a note or a comment, as in Excel: remove the note first`)
  }

  const author = commentAuthor()
  const id = generateRandomId()
  const comment: IThreadComment = { id, threadId: id, ref: name, dT: getDT(), personId: author.id, authorName: author.name, text: bodyOf(text) as IThreadComment['text'], attachments: [], unitId: target.workbook.getId(), subUnitId: sheet.getSheetId() }
  await run(target, AddCommentCommand.id, { unitId: target.workbook.getId(), subUnitId: sheet.getSheetId(), comment }, `The comment on ${name} was not added`)

  return { id, sheet: sheet.getSheetName(), cell: name }
}

/** Reply to the thread on a cell, or the thread of a comment's id. */
export async function replyToComment(target: SheetsTarget, args: { cell?: unknown; id?: unknown; text: unknown; sheet?: unknown }): Promise<{ id: string; threadId: string; sheet: string; cell: string }> {
  const { sheet, thread } = threadOf(target, args)
  const text = textArg(args.text, 'reply')
  const author = commentAuthor()
  const id = generateRandomId()
  const reply: IThreadComment = { id, threadId: thread.threadId, parentId: thread.root.id, ref: thread.root.ref, dT: getDT(), personId: author.id, authorName: author.name, text: bodyOf(text) as IThreadComment['text'], attachments: [], unitId: target.workbook.getId(), subUnitId: sheet.getSheetId() }
  await run(target, AddCommentCommand.id, { unitId: target.workbook.getId(), subUnitId: sheet.getSheetId(), comment: reply }, 'The reply was not added')

  return { id, threadId: thread.root.id, sheet: sheet.getSheetName(), cell: thread.root.ref }
}

/** Mark a thread resolved (or, with resolved false, open again). */
export async function resolveComment(target: SheetsTarget, args: { cell?: unknown; id?: unknown; resolved?: unknown; sheet?: unknown }): Promise<{ id: string; sheet: string; cell: string; resolved: boolean }> {
  const { sheet, thread } = threadOf(target, args)
  const resolved = args.resolved !== false && args.resolved !== 'false'

  if (Boolean(thread.root.resolved) !== resolved) {
    await run(target, ResolveCommentCommand.id, { unitId: target.workbook.getId(), subUnitId: sheet.getSheetId(), commentId: thread.root.id, resolved }, 'The comment was not changed')
  }

  return { id: thread.root.id, sheet: sheet.getSheetName(), cell: thread.root.ref, resolved }
}

/** Delete a whole thread (by its cell or its first comment's id), or one reply (by the reply's id). */
export async function deleteComment(target: SheetsTarget, args: { cell?: unknown; id?: unknown; sheet?: unknown }): Promise<{ deleted: 'thread' | 'reply'; id: string; sheet: string; cell: string }> {
  const { sheet, thread, reply } = threadOf(target, args)
  const params = { unitId: target.workbook.getId(), subUnitId: sheet.getSheetId(), commentId: reply?.id ?? thread.root.id }
  await run(target, reply ? DeleteCommentCommand.id : DeleteCommentTreeCommand.id, params, 'The comment was not deleted')

  return { deleted: reply ? 'reply' : 'thread', id: params.commentId, sheet: sheet.getSheetName(), cell: thread.root.ref }
}

/** The notes of a sheet, or of every sheet, top to bottom, then left to right. */
export function listNotes(target: SheetsTarget, args: { sheet?: unknown } = {}): CellNote[] {
  const model = injector(target).get(SheetsNoteModel)

  return sheetsOf(target, args.sheet).flatMap((sheet) =>
    [...(model.getSheetNotes(target.workbook.getId(), sheet.getSheetId())?.values() ?? [])]
      .map((note) => note as UNote)
      .sort((a, b) => a.row - b.row || a.col - b.col)
      .map((note) => ({ sheet: sheet.getSheetName(), cell: cellName(note.row, note.col), text: note.note, author: note.author ?? '', shown: Boolean(note.show) }))
  )
}

/** Write a cell's note (replacing the note it had); one step to undo. A cell holds a note or a comment thread, as in Excel. */
export async function setNote(target: SheetsTarget, args: { cell: unknown; text: unknown; sheet?: unknown }): Promise<CellNote> {
  const { sheet, row, column, name } = cellOf(target, args.cell, args.sheet)
  const text = String(args.text ?? '')

  if (!text.trim()) {
    throw new Error(`Give the note’s text (removeNote takes a note off ${name})`)
  }

  if (threadsOn(target, sheet).some((entry) => entry.cell.row === row && entry.cell.column === column)) {
    throw new Error(`${name} has a comment; a cell holds a note or a comment, as in Excel: delete the comment first`)
  }

  const current = noteAt(target, sheet, row, column)
  const note: Partial<UNote> = { ...NOTE_SIZE, ...current, note: text, author: current?.author ?? commentAuthor().name }
  await oneStep(target, () => injector(target).get(ICommandService).syncExecuteCommand(SheetUpdateNoteCommand.id, { unitId: target.workbook.getId(), subUnitId: sheet.getSheetId(), row, col: column, note }))

  return { sheet: sheet.getSheetName(), cell: name, text, author: note.author ?? '', shown: Boolean(note.show) }
}

/** Take a cell's note off; one step to undo. */
export async function removeNote(target: SheetsTarget, args: { cell: unknown; sheet?: unknown }): Promise<{ sheet: string; cell: string; text: string }> {
  const { sheet, row, column, name } = cellOf(target, args.cell, args.sheet)
  const note = noteAt(target, sheet, row, column)

  if (!note) {
    throw new Error(`${name} on ${sheet.getSheetName()} has no note`)
  }

  const unitId = target.workbook.getId()
  const redo = { id: RemoveNoteMutation.id, params: { unitId, sheetId: sheet.getSheetId(), noteId: note.id } }
  const undo = { id: UpdateNoteMutation.id, params: { unitId, sheetId: sheet.getSheetId(), row, col: column, note: { ...note } } }

  // Univer's own command removes the note of the selected cell only: this is it, for any cell.
  await oneStep(target, () => {
    if (injector(target).get(ICommandService).syncExecuteCommand(redo.id, redo.params)) {
      injector(target).get(IUndoRedoService).pushUndoRedo({ unitID: unitId, redoMutations: [redo], undoMutations: [undo] })
    }
  })

  return { sheet: sheet.getSheetName(), cell: name, text: note.note }
}
