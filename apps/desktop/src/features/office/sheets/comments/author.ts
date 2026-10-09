import { personIdOf } from '../../../../../shared/office/xlsx/comments/model.ts'
import { $systemInfo } from '../../../../store/system.ts'

/** The name comments and notes made in Herald go under when the system does not give the person's. */
export const NEUTRAL_AUTHOR = 'Herald user'

/** Who writes the comments made in Herald: the account's full name when the system gives one, else a neutral name. */
export function commentAuthor(): { id: string; name: string } {
  const name = $systemInfo.get()?.fullName?.trim() || NEUTRAL_AUTHOR

  return { id: personIdOf(name), name }
}
