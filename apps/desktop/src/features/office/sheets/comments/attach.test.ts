import { CommandType, ICommandService, type IUser, UserManagerService } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { SheetsNoteModel } from '@univerjs/sheets-note'
import { AddCommentCommand, ThreadCommentModel } from '@univerjs/thread-comment'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SystemInfo } from '../../../../../shared/ipc.ts'
import { bodyOf, personIdOf } from '../../../../../shared/office/xlsx/comments/model.ts'
import { newWorkbook } from '../../../../../shared/office/workbook.ts'
import { $systemInfo } from '../../../../store/system.ts'
import { $commentName, $nameQuestion, answerCommentName, NEUTRAL_NAME } from '../../comment-name.ts'
import { withHeadlessSheets } from '../headless.ts'
import { setupComments } from './attach.ts'

const NOTE_EDITOR = 'sheet.operation.add-note-popup'

interface Book {
  commands: ICommandService
  user: () => IUser
  /** A comment on a cell as Univer's comment editor posts it: by the current user's id, with no name. */
  post: (id: string, cell: string, authorName?: string) => Promise<boolean>
  authorOf: (id: string) => string | undefined
  /** Write a note on a cell as Univer's note editor does, and give its author. */
  note: (row: number, col: number) => string | undefined
}

/** Run `work` on a workbook whose Univer is set up as a Sheets window sets it up. */
async function inSheets<T>(work: (book: Book) => Promise<T>): Promise<T> {
  const { result } = await withHeadlessSheets(newWorkbook('book', 'Book'), ({ univer, workbook }) => {
    setupComments(univer, FUniver.newAPI(univer))
    const injector = univer.__getInjector()
    const commands = injector.get(ICommandService)
    const users = injector.get(UserManagerService)
    const sheetId = workbook.getActiveSheet().getSheetId()
    const at = { unitId: 'book', subUnitId: sheetId }

    return work({
      commands,
      user: () => users.getCurrentUser(),
      post: (id, cell, authorName) =>
        commands.executeCommand(AddCommentCommand.id, { ...at, comment: { ...at, id, threadId: id, ref: cell, dT: '2026/10/09 10:00', personId: users.getCurrentUser().userID, text: bodyOf('Hello'), ...(authorName ? { authorName } : {}) } }),
      authorOf: (id) => injector.get(ThreadCommentModel).getComment('book', sheetId, id)?.authorName,
      note: (row, col) => {
        commands.syncExecuteCommand('sheet.command.update-note', { ...at, row, col, note: { width: 160, height: 72, note: 'A note' } })

        return (injector.get(SheetsNoteModel).getNote('book', sheetId, { row, col }) as { author?: string } | null)?.author
      }
    })
  })

  return result
}

/** The question, once it shows. */
const asked = () => vi.waitUntil(() => $nameQuestion.get())

afterEach(() => {
  answerCommentName(null)
  $commentName.set('')
  $systemInfo.set(null)
})

describe('who writes comments and notes in Herald Sheets', () => {
  it('makes the confirmed name Univer’s current user, the neutral name until there is one, and never the account’s', async () => {
    $systemInfo.set({ fullName: 'Pat Example', userName: 'pat' } as SystemInfo)
    const users = await inSheets(async ({ user }) => {
      const before = user()
      $commentName.set('Sam Rivera')

      return { before, after: user() }
    })

    expect(users).toEqual({ before: { userID: personIdOf(NEUTRAL_NAME), name: NEUTRAL_NAME }, after: { userID: personIdOf('Sam Rivera'), name: 'Sam Rivera' } })
  })

  it('holds the first comment posted in Univer’s editors until the person confirms a name, then signs it with that name', async () => {
    $systemInfo.set({ fullName: 'Pat Example', userName: 'pat' } as SystemInfo)
    const result = await inSheets(async ({ post, authorOf, user }) => {
      const posting = post('c1', 'B2')
      const question = await asked()
      const meanwhile = authorOf('c1')
      answerCommentName('Sam Rivera')
      const done = await posting

      return { question, meanwhile, done, author: authorOf('c1'), user: user().name, reply: await post('c2', 'C3'), replyAuthor: authorOf('c2'), askedAgain: $nameQuestion.get() }
    })

    expect(result).toEqual({ question: { app: 'sheets', proposed: 'Pat Example' }, meanwhile: undefined, done: true, author: 'Sam Rivera', user: 'Sam Rivera', reply: true, replyAuthor: 'Sam Rivera', askedAgain: null })
  })

  it('adds nothing when the person cancels the question, and asks again at the next comment', async () => {
    const result = await inSheets(async ({ post, authorOf }) => {
      const posting = post('c1', 'B2')
      await asked()
      answerCommentName(null)
      const done = await posting
      const again = post('c2', 'B2')
      const askedAgain = Boolean(await asked())
      answerCommentName('Sam Rivera')

      return { done, cancelled: authorOf('c1'), askedAgain, again: await again, author: authorOf('c2') }
    })

    expect(result).toEqual({ done: false, cancelled: undefined, askedAgain: true, again: true, author: 'Sam Rivera' })
  })

  it('signs comments and notes with the confirmed name without asking', async () => {
    $commentName.set('Sam Rivera')
    const result = await inSheets(async ({ post, authorOf, note }) => ({ done: await post('c1', 'B2'), author: authorOf('c1'), note: note(2, 2), asked: $nameQuestion.get() }))

    expect(result).toEqual({ done: true, author: 'Sam Rivera', note: 'Sam Rivera', asked: null })
  })

  it('leaves Hermes’s comments, and those of commands, signed as they come, without asking', async () => {
    const result = await inSheets(async ({ post, authorOf }) => ({ done: await post('c1', 'B2', 'Hermes'), author: authorOf('c1'), asked: $nameQuestion.get() }))

    expect(result).toEqual({ done: true, author: 'Hermes', asked: null })
  })

  it('opens the note editor once the person confirmed a name, and not when they cancel', async () => {
    const result = await inSheets(async ({ commands }) => {
      let opened = 0
      commands.registerCommand({ id: NOTE_EDITOR, type: CommandType.OPERATION, handler: () => ++opened > 0 })
      const first = await commands.executeCommand(NOTE_EDITOR)
      await asked()
      const whileAsked = opened
      answerCommentName(null)
      await new Promise((resolve) => setTimeout(resolve, 10))
      const cancelled = opened
      const second = await commands.executeCommand(NOTE_EDITOR)
      await asked()
      answerCommentName('Sam Rivera')
      await vi.waitUntil(() => opened === 1)
      const third = await commands.executeCommand(NOTE_EDITOR)

      return { first, whileAsked, cancelled, second, third, opened }
    })

    expect(result).toEqual({ first: false, whileAsked: 0, cancelled: 0, second: false, third: true, opened: 2 })
  })

  it('puts the neutral name on a note written before a name is confirmed, never the account’s', async () => {
    $systemInfo.set({ fullName: 'Pat Example', userName: 'pat' } as SystemInfo)

    expect(await inSheets(async ({ note }) => note(1, 1))).toBe(NEUTRAL_NAME)
  })
})
