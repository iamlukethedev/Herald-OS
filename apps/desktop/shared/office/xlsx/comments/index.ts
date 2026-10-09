import type { ReadContext } from '../extras.ts'
import type { FinishContext } from '../finish.ts'
import type { Resource } from '../rules.ts'
import { readCommentResources } from './read.ts'
import { writeComments } from './write.ts'

/*
 * Comments and notes in .xlsx files: Univer's notes as Excel notes, its comment threads as Excel's
 * threaded comments (with the notes older versions of Excel show), and both read back.
 */

export * from './model.ts'

/** Add the workbook's comments and notes to the package being finished. */
export async function finishComments(ctx: FinishContext): Promise<void> {
  await writeComments(ctx)
}

/** The comment and note resources of a file. */
export async function readComments(ctx: ReadContext): Promise<Resource[]> {
  return readCommentResources(ctx)
}
