import { CustomCommandExecutionError, ICommandService, type Univer, UserManagerService } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import { SheetUpdateNoteCommand } from '@univerjs/sheets-note'
import { type IThreadComment, IThreadCommentDataSourceService } from '@univerjs/thread-comment'
import type { UNote } from '../../../../../shared/office/xlsx/comments/model.ts'
import { $commentName, askCommentName, commentNameFor } from '../../comment-name.ts'
import { authorNamed } from './author.ts'

/** Univer's note editor on the active cell. It writes the note as it is typed, and an empty one as soon as it opens. */
const NOTE_EDITOR = 'sheet.operation.add-note-popup'

/** A comment posted in Univer's editors, signed with the name the person confirmed; it is not added when they cancel the question. */
async function signed(comment: IThreadComment): Promise<IThreadComment> {
  const name = await askCommentName('sheets')

  if (!name) {
    throw new CustomCommandExecutionError('No name was confirmed for the comment')
  }

  const author = authorNamed(name)

  return { ...comment, personId: author.id, authorName: author.name }
}

/**
 * Before a workbook loads into this Univer: who writes the comments and notes made in it, by name
 * on each one, so files written in a worker without Univer still say who wrote them. Univer's
 * current user is the name the person confirmed (the neutral one until then, never the account's).
 * The first comment or reply posted in Univer's editors waits for the person to confirm a name:
 * Univer awaits its comment data source before it writes a comment, so the question waits there,
 * and a cancel fails the command, which adds nothing and leaves the text in the editor. The note
 * editor writes as it is typed, so it opens only once there is a name.
 */
export function setupComments(univer: Univer, _api: FUniver): void {
  const injector = univer.__getInjector()
  const users = injector.get(UserManagerService)
  const commands = injector.get(ICommandService)
  const become = () => {
    const author = authorNamed(commentNameFor())

    if (users.getCurrentUser()?.userID !== author.id) {
      users.setCurrentUser({ userID: author.id, name: author.name })
    }
  }

  become()
  univer.onDispose($commentName.listen(become))

  if (injector.has(IThreadCommentDataSourceService)) {
    const source = injector.get(IThreadCommentDataSourceService)
    const add = source.addComment.bind(source)

    // Univer's editors leave the author's name out; Herald's own comments (Hermes's, a command's) come signed.
    source.addComment = async (comment) => add(comment.authorName ? comment : await signed(comment))
  }

  commands.beforeCommandExecuted((command) => {
    if (command.id === NOTE_EDITOR && !$commentName.get()) {
      void askCommentName('sheets').then((name) => {
        if (name) {
          void commands.executeCommand(command.id, command.params)
        }
      })

      throw new CustomCommandExecutionError('The note editor opens once the person confirmed a name')
    }

    if (command.id === SheetUpdateNoteCommand.id) {
      const params = command.params as { note?: Partial<UNote> } | undefined

      if (params?.note && !params.note.author) {
        params.note = { ...params.note, author: commentNameFor() }
      }
    }
  })
}
