import type { CommandArg, CommandContext } from '../store/os-commands.ts'

/* What Herald Docs' commands share: the arguments that name a document and a place in it, and where they run. */

export const office = () => import('../features/office/agent.ts')

export const document: CommandArg = { name: 'document', type: 'string', description: 'The document: a file (full path or ~/…) or the name of an open document as its tab shows it; the one in front in Herald Docs when left out' }

export const placement: readonly CommandArg[] = [
  { name: 'at', type: 'string', description: 'Where: end (the default), start, selection (in place of what is selected, or at the caret), marked (in place of the text Herald marked for this request), after (under the paragraph the selection is in) or heading' },
  { name: 'heading', type: 'string', description: 'A heading (its text, or its number in the outline from 1): the content goes in its section' },
  { name: 'mode', type: 'string', description: 'With heading: append (at the end of the section, the default), prepend (right under the heading) or replace (in place of the section, keeping the heading)' }
]

export const search: readonly CommandArg[] = [
  { name: 'caseSensitive', type: 'boolean', description: 'Match upper and lower case exactly' },
  { name: 'wholeWord', type: 'boolean', description: 'Match whole words only' },
  { name: 'regex', type: 'boolean', description: 'The text is a regular expression' }
]

type Work = (args: Record<string, unknown>, context: CommandContext) => Promise<{ summary: string; data?: Record<string, unknown> }>

/** Run where the document lives: here, or in its own window (panels mode). */
export const run = (id: string, work: Work) => async (args: Record<string, unknown>, context: CommandContext) => (await office()).inOwnWindow('docs', id, args, 'document', context, () => work(args, context))
