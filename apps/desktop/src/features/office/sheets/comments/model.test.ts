import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SystemInfo } from '../../../../../shared/ipc.ts'
import { newSheet, newWorkbook, type WorkbookSnapshot } from '../../../../../shared/office/workbook.ts'
import { excelThreads } from '../../../../../shared/office/xlsx/comments/fixtures.ts'
import { workbookFromXlsx } from '../../../../../shared/office/xlsx/read.ts'
import { xlsxFromWorkbook } from '../../../../../shared/office/xlsx/write.ts'
import { $systemInfo } from '../../../../store/system.ts'
import { withHeadlessSheets } from '../headless.ts'
import type { SheetsTarget } from '../model.ts'
import { NEUTRAL_AUTHOR } from './author.ts'
import { addComment, deleteComment, listComments, listNotes, removeNote, replyToComment, resolveComment, setNote } from './model.ts'

const book = (): WorkbookSnapshot => newWorkbook('book', 'Book', [newSheet('s1', 'Plan'), newSheet('s2', 'Q1 sales')])

const run = <T>(work: (target: SheetsTarget) => Promise<T> | T, snapshot = book()) => withHeadlessSheets(snapshot, ({ univer, workbook }) => work({ univer, workbook }))

const failure = (promise: Promise<unknown>): Promise<string> => promise.then(() => 'no error', (error: Error) => error.message)

describe('comments', () => {
  beforeEach(() => $systemInfo.set({ fullName: 'Pat Example', userName: 'pat' } as SystemInfo))
  afterEach(() => $systemInfo.set(null))

  it('starts threads on cells, under the person’s name, and lists them with their replies', async () => {
    const { result } = await run(async (target) => {
      const made = await addComment(target, { cell: 'B2', text: 'Is rent right?\nIt went up.' })
      await addComment(target, { cell: "'Q1 sales'!C3", text: 'Check the March figure' })
      const reply = await replyToComment(target, { cell: 'B2', text: 'Yes, from March.' })
      await replyToComment(target, { id: reply.id, text: 'Thanks' })

      return { made, reply, plan: listComments(target, { sheet: 'plan' }), all: listComments(target) }
    })

    expect(result.made).toMatchObject({ sheet: 'Plan', cell: 'B2' })
    expect(result.reply.threadId).toBe(result.made.id)
    expect(result.plan).toEqual([
      {
        id: result.made.id,
        sheet: 'Plan',
        cell: 'B2',
        author: 'Pat Example',
        time: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d$/),
        text: 'Is rent right?\nIt went up.',
        resolved: false,
        replies: [
          { id: result.reply.id, author: 'Pat Example', time: expect.any(String), text: 'Yes, from March.' },
          { id: expect.any(String), author: 'Pat Example', time: expect.any(String), text: 'Thanks' }
        ]
      }
    ])
    expect(result.all.map((thread) => `${thread.sheet}!${thread.cell}`)).toEqual(['Plan!B2', 'Q1 sales!C3'])
  })

  it('writes under a neutral name when the system gives none', async () => {
    $systemInfo.set(null)
    const { result } = await run(async (target) => {
      await addComment(target, { cell: 'A1', text: 'Hello' })

      return listComments(target)[0].author
    })

    expect(result).toBe(NEUTRAL_AUTHOR)
  })

  it('resolves and opens threads again, and deletes a reply or a whole thread', async () => {
    const { result } = await run(async (target) => {
      const { id } = await addComment(target, { cell: 'B2', text: 'First' })
      const reply = await replyToComment(target, { id, text: 'Second' })
      const resolved = await resolveComment(target, { cell: 'B2' })
      const shown = listComments(target)[0].resolved
      const opened = await resolveComment(target, { id: reply.id, resolved: false })
      const deletedReply = await deleteComment(target, { id: reply.id })
      const left = listComments(target)[0].replies.length
      const deletedThread = await deleteComment(target, { cell: 'B2' })

      return { resolved, shown, opened, deletedReply, left, deletedThread, after: listComments(target) }
    })

    expect(result.resolved).toMatchObject({ cell: 'B2', resolved: true })
    expect(result.shown).toBe(true)
    expect(result.opened.resolved).toBe(false)
    expect(result.deletedReply).toMatchObject({ deleted: 'reply', cell: 'B2' })
    expect(result.left).toBe(0)
    expect(result.deletedThread).toMatchObject({ deleted: 'thread', cell: 'B2' })
    expect(result.after).toEqual([])
  })

  it('says what is wrong: a second thread, a note in the way, no comment, several cells, no text', async () => {
    const { result } = await run(async (target) => {
      await addComment(target, { cell: 'B2', text: 'One' })
      await setNote(target, { cell: 'C3', text: 'A note' })

      return Promise.all([
        failure(addComment(target, { cell: 'b2', text: 'Two' })),
        failure(addComment(target, { cell: 'C3', text: 'Two' })),
        failure(setNote(target, { cell: 'B2', text: 'Note' })),
        failure(replyToComment(target, { cell: 'D4', text: 'Hi' })),
        failure(resolveComment(target, { id: 'nope' })),
        failure(addComment(target, { cell: 'A1:B2', text: 'Hi' })),
        failure(addComment(target, { cell: 'A1', text: '  ' })),
        failure(deleteComment(target, {}))
      ])
    })

    expect(result).toEqual([
      'B2 has a comment already: reply to it',
      'C3 has a note; a cell holds a note or a comment, as in Excel: remove the note first',
      'B2 has a comment; a cell holds a note or a comment, as in Excel: delete the comment first',
      'D4 on Plan has no comment',
      'There is no comment with the id “nope”: listComments gives the ids',
      'Comments and notes go on one cell, like B2; not on A1:B2',
      'Give the comment’s text',
      'Say which comment: its cell (“B2”) or its id'
    ])
  })
})

describe('notes', () => {
  beforeEach(() => $systemInfo.set({ fullName: 'Pat Example', userName: 'pat' } as SystemInfo))
  afterEach(() => $systemInfo.set(null))

  it('writes, replaces and removes notes, each in one step to undo', async () => {
    const { result } = await run(async (target) => {
      const written = await setNote(target, { cell: 'B2', text: 'Remember\nthe deposit' })
      await setNote(target, { cell: 'A1', text: 'Top', sheet: 'Q1 sales' })
      const listed = listNotes(target)
      $systemInfo.set({ fullName: 'Sam Sample', userName: 'sam' } as SystemInfo)
      await setNote(target, { cell: 'B2', text: 'Changed' })
      const replaced = listNotes(target, { sheet: 'Plan' })
      target.workbook.undo()
      const undone = listNotes(target, { sheet: 'Plan' })
      const removed = await removeNote(target, { cell: 'B2' })
      const gone = listNotes(target, { sheet: 'Plan' })
      target.workbook.undo()

      return { written, listed, replaced, undone, removed, gone, back: listNotes(target, { sheet: 'Plan' }), missing: await failure(removeNote(target, { cell: 'Z9' })) }
    })

    expect(result.written).toEqual({ sheet: 'Plan', cell: 'B2', text: 'Remember\nthe deposit', author: 'Pat Example', shown: false })
    expect(result.listed.map((note) => `${note.sheet}!${note.cell}`)).toEqual(['Plan!B2', 'Q1 sales!A1'])
    expect(result.replaced).toEqual([{ sheet: 'Plan', cell: 'B2', text: 'Changed', author: 'Pat Example', shown: false }])
    expect(result.undone[0].text).toBe('Remember\nthe deposit')
    expect(result.removed).toEqual({ sheet: 'Plan', cell: 'B2', text: 'Remember\nthe deposit' })
    expect(result.gone).toEqual([])
    expect(result.back[0].text).toBe('Remember\nthe deposit')
    expect(result.missing).toBe('Z9 on Plan has no note')
  })
})

describe('comments and notes through .xlsx files', () => {
  beforeEach(() => $systemInfo.set({ fullName: 'Pat Example', userName: 'pat' } as SystemInfo))
  afterEach(() => $systemInfo.set(null))

  it('keeps threads, replies, resolved threads, authors, times and notes through a file Herald writes', async () => {
    const { result: before, snapshot } = await run(async (target) => {
      const { id } = await addComment(target, { cell: 'B2', text: 'Is rent right?' })
      await replyToComment(target, { id, text: 'Yes' })
      await addComment(target, { cell: 'C5', text: 'Done', sheet: 'Q1 sales' })
      await resolveComment(target, { cell: 'C5', sheet: 'Q1 sales' })
      await setNote(target, { cell: 'D1', text: 'Plain note' })

      return { comments: listComments(target), notes: listNotes(target) }
    })
    const { bytes, losses } = await xlsxFromWorkbook(snapshot)
    const { workbook } = await workbookFromXlsx(bytes, { id: 'again', name: 'Again' })
    const { result: after } = await run((target) => ({ comments: listComments(target), notes: listNotes(target) }), workbook)
    const withoutIds = (threads: typeof before.comments) => threads.map(({ id: _id, replies, ...thread }) => ({ ...thread, replies: replies.map(({ id: _reply, ...reply }) => reply) }))

    expect(losses).toEqual([])
    expect(withoutIds(after.comments)).toEqual(withoutIds(before.comments))
    expect(after.comments[1].resolved).toBe(true)
    expect(after.notes).toEqual(before.notes)
  })

  it('shows the threads of a file Excel wrote, with their people’s names', async () => {
    const { workbook } = await workbookFromXlsx(await excelThreads(), { id: 'excel', name: 'Excel' })
    const { result } = await run((target) => ({ comments: listComments(target), notes: listNotes(target) }), workbook)

    expect(result.comments.map((thread) => [thread.cell, thread.author, thread.text, thread.resolved, thread.replies.map((reply) => [reply.author, reply.text])])).toEqual([
      ['C2', 'Sam Sample', 'Fixed the rate', true, []],
      ['B3', 'Robin Example', 'Is this total right?\nIt looks high.', false, [['Sam Sample', '@Robin Example yes, checked.']]]
    ])
    expect(result.notes).toEqual([{ sheet: 'Hand Made', cell: 'A6', text: 'An old-style note', author: 'Robin Example', shown: false }])
  })
})
