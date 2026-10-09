import type { DocJSON } from '../../../../shared/office/document.ts'
import type { CommandContext } from '../../../store/os-commands.ts'
import type { Local, Outcome } from '../agent.ts'
import { change, contentOf, located, reading } from './agent.ts'
import {
  addCommentsChange,
  type Change,
  clearPartChange,
  commentAuthor,
  commentItemOf,
  commentItemsOf,
  deleteCommentChange,
  type DepthPart,
  editCommentChange,
  headerOptionsChange,
  insertFieldChange,
  insertNoteChange,
  insertSectionBreakChange,
  insertTocChange,
  partReading,
  removeNoteChange,
  removeSectionBreakChange,
  removeTocChange,
  replyChange,
  resolveChange,
  setNoteChange,
  setPartChange,
  setTocChange,
  statisticsOutcome,
  type StoryContent,
  templatesOutcome,
  updateTocsChange
} from './agent-depth-model.ts'
import { headingRef } from './agent-model.ts'
import { $commentsShown } from './comments.ts'
import { textWidthOf } from './model.ts'
import { $pages } from './store.ts'
import { savedTemplates } from './templates/saved.ts'

/*
 * What Hermes (and voice, the command bar and `herald-os docs`) does with a document's page and
 * review in Herald Docs: headers and footers, fields, notes, sections, comments, tables of contents,
 * templates and statistics. As in agent.ts, a command works on the document it names or the one in
 * front, and each change is one step to undo in an open document, or the file written back.
 */

type Args = Record<string, unknown>

/** Make a change to the document a command names; an open document shows the comments it was given. */
async function changing(args: Args, made: Change, options: { comments?: boolean } = {}): Promise<Outcome> {
  const target = await located(args.document)
  const result = await change(target, made.build)

  if (options.comments && result.changed && target.kind === 'live') {
    $commentsShown.setKey(target.doc.key, true)
  }

  return made.outcome(result)
}

/** A change with content of its own (a header, a note), read in first with the pictures it names. */
async function withContent(args: Args, make: (content: StoryContent) => Change): Promise<Outcome> {
  const target = await located(args.document)
  const made = make(await contentOf(args, textWidthOf((await reading(target)).state.doc)))

  return made.outcome(await change(target, made.build))
}

async function readingPart(args: Args, part: DepthPart): Promise<Outcome> {
  const { name, path, state } = await reading(await located(args.document))
  const found = partReading(state.doc, part, args.heading === undefined || args.heading === '' ? undefined : headingRef(args.heading))

  return { summary: found.summary(name), data: { name, path, ...found.data } }
}

/** The pages of an open document as its page view last laid them out. */
const laidOut = (target: Local<DocJSON>) => (target.kind === 'live' ? $pages.get()[target.doc.key] : undefined)

export const setHeader = (args: Args) => withContent(args, (content) => setPartChange('header', args, content))

export const setFooter = (args: Args) => withContent(args, (content) => setPartChange('footer', args, content))

export const clearHeader = (args: Args) => changing(args, clearPartChange('header', args))

export const clearFooter = (args: Args) => changing(args, clearPartChange('footer', args))

export const setHeaderOptions = (args: Args) => changing(args, headerOptionsChange(args))

export const insertField = (args: Args) => changing(args, insertFieldChange(args))

export const insertNote = (args: Args) => withContent(args, (content) => insertNoteChange(args, content))

export const listNotes = (args: Args) => readingPart(args, 'notes')

export const setNote = (args: Args) => withContent(args, (content) => setNoteChange(args, content))

export const removeNote = (args: Args) => changing(args, removeNoteChange(args))

export const insertSectionBreak = (args: Args) => changing(args, insertSectionBreakChange(args))

export const listSections = (args: Args) => readingPart(args, 'sections')

export const removeSectionBreak = (args: Args) => changing(args, removeSectionBreakChange(args))

export const listComments = (args: Args) => readingPart(args, 'comments')

export const addComment = (args: Args, context: CommandContext) => changing(args, addCommentsChange([commentItemOf(args)], commentAuthor(context), true), { comments: true })

export const addComments = (args: Args, context: CommandContext) => changing(args, addCommentsChange(commentItemsOf(args.comments), commentAuthor(context)), { comments: true })

export const replyToComment = (args: Args, context: CommandContext) => changing(args, replyChange(args, commentAuthor(context)), { comments: true })

export const editComment = (args: Args) => changing(args, editCommentChange(args))

export const resolveComment = (args: Args) => changing(args, resolveChange(args))

export const deleteComment = (args: Args) => changing(args, deleteCommentChange(args))

export const insertToc = (args: Args) => changing(args, insertTocChange(args))

export const setToc = (args: Args) => changing(args, setTocChange(args))

export const removeToc = (args: Args) => changing(args, removeTocChange(args))

export async function updateTocs(args: Args): Promise<Outcome> {
  const target = await located(args.document)
  const made = updateTocsChange(laidOut(target)?.headings ?? null)

  return made.outcome(await change(target, made.build))
}

export async function statistics(args: Args): Promise<Outcome> {
  const target = await located(args.document)
  const { name, path, state, live } = await reading(target)

  return statisticsOutcome(state, args, live, { name, path, pages: laidOut(target)?.pages.length })
}

export const listTemplates = async (): Promise<Outcome> => templatesOutcome(await savedTemplates().catch(() => []))
