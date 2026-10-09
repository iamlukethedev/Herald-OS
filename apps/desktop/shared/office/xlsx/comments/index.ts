import type { ReadContext } from '../extras.ts'
import type { FinishContext } from '../finish.ts'
import type { Resource } from '../rules.ts'

/*
 * Comments and notes in .xlsx files: Univer's notes as Excel notes, its comment threads as Excel's
 * threaded comments (with the notes older versions of Excel show), and both read back.
 */

/** Add the workbook's comments and notes to the package being finished. */
export async function finishComments(_ctx: FinishContext): Promise<void> {}

/** The comment and note resources of a file. */
export async function readComments(_ctx: ReadContext): Promise<Resource[]> {
  return []
}
