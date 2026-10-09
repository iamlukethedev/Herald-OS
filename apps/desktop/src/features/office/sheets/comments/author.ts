import { personIdOf } from '../../../../../shared/office/xlsx/comments/model.ts'
import { commentNameFor } from '../../comment-name.ts'

/** A person as Univer keeps the people of comments: an id that carries their name, and the name. */
export const authorNamed = (name: string): { id: string; name: string } => ({ id: personIdOf(name), name })

/** Who signs what a command writes, when it gives nobody: the name the person confirmed, else the neutral one (never the account's name unconfirmed). */
export const commentAuthor = (): { id: string; name: string } => authorNamed(commentNameFor())
