import { ICommandService, type Univer, UserManagerService } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import { SheetUpdateNoteCommand } from '@univerjs/sheets-note'
import { AddCommentCommand, type IAddCommentCommandParams } from '@univerjs/thread-comment'
import type { UNote } from '../../../../../shared/office/xlsx/comments/model.ts'
import { $systemInfo } from '../../../../store/system.ts'
import { commentAuthor } from './author.ts'

/**
 * Before a workbook loads into this Univer: who writes the comments made in it (the account's
 * name when the system gives one), and their name on each comment and note made in it, so files
 * written in a worker without Univer still say who wrote them.
 */
export function setupComments(univer: Univer, _api: FUniver): void {
  const injector = univer.__getInjector()
  const users = injector.get(UserManagerService)
  const become = () => {
    const author = commentAuthor()
    users.setCurrentUser({ userID: author.id, name: author.name })
  }

  become()

  // The system's account name may come after the window opens.
  if (!$systemInfo.get()) {
    void window.heraldOS?.system
      ?.info()
      .then((info) => {
        if (info?.fullName && !$systemInfo.get()) {
          $systemInfo.set(info)
          become()
        }
      })
      .catch(() => {})
  }

  injector.get(ICommandService).beforeCommandExecuted((command) => {
    const name = users.getCurrentUser()?.name

    if (command.id === AddCommentCommand.id) {
      const comment = (command.params as IAddCommentCommandParams | undefined)?.comment

      if (comment && !comment.authorName && name) {
        comment.authorName = name
      }
    } else if (command.id === SheetUpdateNoteCommand.id) {
      const params = command.params as { note?: Partial<UNote> } | undefined

      if (params?.note && !params.note.author && name) {
        params.note = { ...params.note, author: name }
      }
    }
  })
}
