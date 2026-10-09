import { ICommandService, UserManagerService } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { SheetsNoteModel } from '@univerjs/sheets-note'
import { AddCommentCommand, ThreadCommentModel } from '@univerjs/thread-comment'
import { afterEach, describe, expect, it } from 'vitest'
import type { SystemInfo } from '../../../../../shared/ipc.ts'
import { bodyOf } from '../../../../../shared/office/xlsx/comments/model.ts'
import { newWorkbook } from '../../../../../shared/office/workbook.ts'
import { $systemInfo } from '../../../../store/system.ts'
import { withHeadlessSheets } from '../headless.ts'
import { setupComments } from './attach.ts'

describe('who writes comments', () => {
  afterEach(() => $systemInfo.set(null))

  it('makes the person the current user, and puts their name on comments and notes made in Univer’s own editors', async () => {
    $systemInfo.set({ fullName: 'Pat Example', userName: 'pat' } as SystemInfo)
    const { result } = await withHeadlessSheets(newWorkbook('book', 'Book'), async ({ univer, workbook }) => {
      setupComments(univer, FUniver.newAPI(univer))
      const injector = univer.__getInjector()
      const user = injector.get(UserManagerService).getCurrentUser()
      const sheetId = workbook.getActiveSheet().getSheetId()
      const commands = injector.get(ICommandService)
      await commands.executeCommand(AddCommentCommand.id, { unitId: 'book', subUnitId: sheetId, comment: { id: 'c1', threadId: 'c1', ref: 'B2', dT: '2026/10/09 10:00', personId: user.userID, text: bodyOf('Hello'), unitId: 'book', subUnitId: sheetId } })
      commands.syncExecuteCommand('sheet.command.update-note', { unitId: 'book', subUnitId: sheetId, row: 1, col: 2, note: { width: 160, height: 72, note: 'A note' } })

      return {
        user,
        comment: injector.get(ThreadCommentModel).getComment('book', sheetId, 'c1')?.authorName,
        note: (injector.get(SheetsNoteModel).getNote('book', sheetId, { row: 1, col: 2 }) as { author?: string } | null)?.author
      }
    })

    expect(result).toEqual({ user: { userID: 'Owner_Pat Example', name: 'Pat Example' }, comment: 'Pat Example', note: 'Pat Example' })
  })
})
