import type { CommandArg, OsCommand } from '../store/os-commands.ts'
import { document, office, run } from './docs-shared.ts'

/*
 * Herald Docs' page and review for Hermes: headers and footers, fields, notes, sections, comments,
 * tables of contents, templates and statistics. Like the rest of docs.*, a command works on the
 * document it names or the one in front, and each change is one step to undo in an open document.
 */

const depth = () => import('../features/office/docs/agent-depth.ts')

const format: CommandArg = { name: 'format', type: 'string', description: 'markdown (the default) or text' }

const quote: CommandArg = { name: 'quote', type: 'string', description: 'Exact text in the document (a few words within one paragraph): it goes right after its first match' }

const heading: CommandArg = { name: 'heading', type: 'string', description: 'A heading (its text, or its number in the outline from 1): it goes in its section' }

const mode: CommandArg = { name: 'mode', type: 'string', description: 'With heading: append (at the end of its section, the default), prepend (right under the heading) or before (right before the heading)' }

/** Where something in a line of text goes, for a field or a note's number; `between` says where it goes at a place between paragraphs. */
const inText = (between: string): readonly CommandArg[] => [
  quote,
  { name: 'at', type: 'string', description: `Without quote: end (the default), start, selection (at the caret of an open document), marked (in place of the text Herald marked for this request), after (the marked text’s paragraph, or the selection’s when nothing is marked) or heading; at a place between paragraphs it goes ${between}` },
  heading,
  mode
]

/** Where a block goes, for a section break or a table of contents. */
const between = (fallback: 'end' | 'start'): readonly CommandArg[] => [
  { name: 'at', type: 'string', description: `Where: ${fallback} (the default), ${fallback === 'end' ? 'start' : 'end'}, selection (at the caret of an open document), marked (in place of the text Herald marked), after (under the marked text’s paragraph, or the selection’s when nothing is marked) or heading` },
  heading,
  mode,
  { name: 'quote', type: 'string', description: 'Exact text in the document: it goes after the paragraph with its first match' }
]

const kind: CommandArg = { name: 'kind', type: 'string', description: 'Which pages show it: default (every page, or the odd pages when even pages have their own; the default), first (the first page: turns Different first page on) or even (even pages: turns Different odd and even pages on)' }

const align: CommandArg = { name: 'align', type: 'string', description: 'left, center or right: how its lines sit' }

const partContent = (part: 'header' | 'footer'): CommandArg => ({ name: 'content', type: 'string', description: `What the ${part} says, in Markdown (one line or a few); {page} is the page number, {pages} the page count, {date} and {time} today's (or {date:d MMMM yyyy} with a picture of your own)`, required: true })

const note: CommandArg = { name: 'note', type: 'string', description: 'Which note: its kind and number ("footnote 2", "endnote 1"), or its place among all the notes from 1, as docs.listNotes gives them', required: true }

const comment: CommandArg = { name: 'comment', type: 'string', description: 'The comment’s id, as docs.listComments gives them (a reply’s id names the comment it answers)', required: true }

const toc: CommandArg = { name: 'toc', type: 'string', description: 'Which table of contents, from 1 in the order they come (the first, or the only one, when left out)' }

const levels: CommandArg = { name: 'levels', type: 'number', description: 'The heading levels it lists, from 1 to 6 (3 lists Heading 1 to Heading 3)' }

const title: CommandArg = { name: 'title', type: 'string', description: 'The title over it ("Contents" when left out on a new one); none for no title' }

export const docsDepthCommands: readonly OsCommand[] = [
  {
    id: 'docs.setHeader',
    title: 'Set a document’s header',
    description:
      'Put content in a document’s header, in place of what it said, as one step to undo: Markdown (or plain text with format=text) where {page} becomes the page number, {pages} the page count, and {date} and {time} today’s date and time. kind says which pages show it. docs.read part=headers shows what each header and footer says.',
    tier: 'act',
    args: [document, partContent('header'), format, kind, align],
    run: run('docs.setHeader', async (args) => (await depth()).setHeader(args))
  },
  {
    id: 'docs.setFooter',
    title: 'Set a document’s footer',
    description:
      'Put content in a document’s footer, in place of what it said, as one step to undo: Markdown (or plain text with format=text) where {page} becomes the page number, {pages} the page count ("Page {page} of {pages}"), and {date} and {time} today’s date and time. kind says which pages show it.',
    tier: 'act',
    args: [document, partContent('footer'), format, kind, align],
    run: run('docs.setFooter', async (args) => (await depth()).setFooter(args))
  },
  {
    id: 'docs.clearHeader',
    title: 'Take a document’s header away',
    description: 'Take a document’s header away as one step to undo: one kind (default, first or even), or every header when kind is left out.',
    tier: 'mutate',
    args: [document, { name: 'kind', type: 'string', description: 'default, first or even; every kind when left out' }],
    run: run('docs.clearHeader', async (args) => (await depth()).clearHeader(args))
  },
  {
    id: 'docs.clearFooter',
    title: 'Take a document’s footer away',
    description: 'Take a document’s footer away as one step to undo: one kind (default, first or even), or every footer when kind is left out.',
    tier: 'mutate',
    args: [document, { name: 'kind', type: 'string', description: 'default, first or even; every kind when left out' }],
    run: run('docs.clearFooter', async (args) => (await depth()).clearFooter(args))
  },
  {
    id: 'docs.setHeaderOptions',
    title: 'Set a document’s header and footer options',
    description:
      'Turn a document’s header and footer options on or off as one step to undo: differentFirst (the first page shows a header and footer of its own, kind=first) and differentOddEven (even pages show their own, kind=even, and the default ones go on odd pages). The headers and footers written for them are kept either way.',
    tier: 'act',
    args: [document, { name: 'differentFirst', type: 'boolean', description: 'Different first page on or off' }, { name: 'differentOddEven', type: 'boolean', description: 'Different odd and even pages on or off' }],
    run: run('docs.setHeaderOptions', async (args) => (await depth()).setHeaderOptions(args))
  },
  {
    id: 'docs.insertField',
    title: 'Put a field in a document',
    description:
      'Put a field in a document’s text as one step to undo: the page number, “Page X of Y”, the page count, the date or the time, worked out wherever it shows. It goes into the line of text right after quote, at the caret, or in place of the marked text, and on a line of its own at the other places. For headers and footers, write {page} and {pages} in docs.setHeader or docs.setFooter instead.',
    tier: 'act',
    args: [
      document,
      { name: 'field', type: 'string', description: 'page (the page number), pageOfPages (“Page 2 of 9”), pages (the page count), date or time', required: true },
      { name: 'format', type: 'string', description: 'For date or time, a picture in Word’s terms: "d MMMM yyyy", "dd/MM/yyyy", "HH:mm" (the locale’s own when left out)' },
      ...inText('on a line of its own')
    ],
    run: run('docs.insertField', async (args) => (await depth()).insertField(args))
  },
  {
    id: 'docs.insertNote',
    title: 'Put a footnote or endnote in a document',
    description:
      'Put a footnote (at the foot of its page) or an endnote (at the end of the document) in a document as one step to undo: its number goes in the text right after quote (or at the caret, or at the end of the text at the place at and heading say) and the note says content. Notes are numbered in the order they come; Markdown written with docs.write can hold footnotes too ([^1]).',
    tier: 'act',
    args: [document, { name: 'content', type: 'string', description: 'What the note says, in Markdown', required: true }, { name: 'kind', type: 'string', description: 'footnote (the default) or endnote' }, format, ...inText('at the end of the text before it')],
    run: run('docs.insertNote', async (args) => (await depth()).insertNote(args))
  },
  {
    id: 'docs.listNotes',
    title: 'List a document’s notes',
    description: 'A document’s footnotes and endnotes in the order they come: each one’s name (note: "footnote 2", for docs.setNote and docs.removeNote), kind, number, label as the page shows it (1, 2… for footnotes, i, ii… for endnotes), what it says, and the words its number follows.',
    tier: 'read',
    args: [document, { name: 'heading', type: 'string', description: 'Only the notes in this heading’s section (its text, or its number in the outline from 1)' }],
    run: run('docs.listNotes', async (args) => (await depth()).listNotes(args))
  },
  {
    id: 'docs.setNote',
    title: 'Change a note',
    description: 'Change what a footnote or endnote says, as one step to undo.',
    tier: 'act',
    args: [document, note, { name: 'content', type: 'string', description: 'What the note says now, in Markdown', required: true }, format],
    run: run('docs.setNote', async (args) => (await depth()).setNote(args))
  },
  {
    id: 'docs.removeNote',
    title: 'Take a note out of a document',
    description: 'Take a footnote or endnote and its number in the text out of a document, as one step to undo; the notes after it are numbered again.',
    tier: 'mutate',
    args: [document, note],
    run: run('docs.removeNote', async (args) => (await depth()).removeNote(args))
  },
  {
    id: 'docs.insertSectionBreak',
    title: 'Put a section break in a document',
    description:
      'Start a new section in a document as one step to undo, so the pages from the break on can have a page setup of their own (landscape pages for a wide table, other margins): kind says where it starts. With size, orientation or margins the new section gets that page, otherwise the page of the section it is in; docs.setPage section= changes it later.',
    tier: 'act',
    args: [
      document,
      { name: 'kind', type: 'string', description: 'nextPage (on a new page, the default), continuous (on the same page), oddPage or evenPage' },
      ...between('end'),
      { name: 'size', type: 'string', description: 'The new section’s paper: a4, letter, legal, a5, or width by height ("8.5x11in")' },
      { name: 'orientation', type: 'string', description: 'The new section’s orientation: portrait or landscape' },
      { name: 'margins', type: 'string', description: 'The new section’s four margins: points, or "1in", "20mm"' }
    ],
    run: run('docs.insertSectionBreak', async (args) => (await depth()).insertSectionBreak(args))
  },
  {
    id: 'docs.listSections',
    title: 'List a document’s sections',
    description: 'A document’s sections in order: each one’s number (for docs.setPage section= and docs.removeSectionBreak), how it starts, its page (size, orientation, width and height, the four margins and the header and footer distances, in points) and its first words.',
    tier: 'read',
    args: [document],
    run: run('docs.listSections', async (args) => (await depth()).listSections(args))
  },
  {
    id: 'docs.removeSectionBreak',
    title: 'Take a section break out of a document',
    description: 'Take a section break out of a document as one step to undo: the section it started joins the one before it, and takes that section’s page.',
    tier: 'mutate',
    args: [document, { name: 'section', type: 'string', description: 'The section the break starts, from 2 (docs.listSections); the only break when left out' }],
    run: run('docs.removeSectionBreak', async (args) => (await depth()).removeSectionBreak(args))
  },
  {
    id: 'docs.listComments',
    title: 'List a document’s comments',
    description: 'A document’s comments in the order of their text: each one’s id (for docs.replyToComment, resolveComment, editComment and deleteComment), author, date, what it says, the text it is on (quote), the heading it is under, whether it is resolved, and its replies.',
    tier: 'read',
    args: [document, { name: 'heading', type: 'string', description: 'Only the comments in this heading’s section (its text, or its number in the outline from 1)' }],
    run: run('docs.listComments', async (args) => (await depth()).listComments(args))
  },
  {
    id: 'docs.addComment',
    title: 'Comment on a document',
    description:
      'Comment on text in a document as one step to undo: on quote (exact text in the document; all=true for every place it appears), on a heading’s line, or on the selection or the marked text of an open document (the selection when none of them is given). The answer gives the new comment’s id; an open document shows its comments.',
    tier: 'act',
    args: [
      document,
      { name: 'text', type: 'string', description: 'What the comment says', required: true },
      { name: 'quote', type: 'string', description: 'Exact text in the document the comment is on (a few words within one paragraph)' },
      { name: 'heading', type: 'string', description: 'A heading (its text, or its number in the outline from 1): the comment goes on the heading line' },
      { name: 'at', type: 'string', description: 'selection or marked, for an open document' },
      { name: 'all', type: 'boolean', description: 'With quote: on every match, not only the first' }
    ],
    run: run('docs.addComment', async (args, context) => (await depth()).addComment(args, context))
  },
  {
    id: 'docs.addComments',
    title: 'Add several comments to a document',
    description:
      'Add several comments to a document as ONE step to undo, all by one author (a review). Each item is {"text": "the comment", "quote": "exact text in the document it is on"}; instead of quote an item may give heading (a heading’s text or its number in the outline: the comment goes on the heading line) or at ("selection" or "marked"), and "all": true puts it on every match of its quote. The answer says how many were added and lists the items whose text was not found (data: added, missing, and ids of the new comments); an open document shows its comments.',
    tier: 'act',
    args: [document, { name: 'comments', type: 'string', description: 'JSON list: [{"text": "Source?", "quote": "grew by a third"}, {"text": "Shorter?", "heading": "Summary"}]', required: true }],
    run: run('docs.addComments', async (args, context) => (await depth()).addComments(args, context))
  },
  {
    id: 'docs.replyToComment',
    title: 'Reply to a comment',
    description: 'Reply to a comment in a document, as one step to undo.',
    tier: 'act',
    args: [document, comment, { name: 'text', type: 'string', description: 'What the reply says', required: true }],
    run: run('docs.replyToComment', async (args, context) => (await depth()).replyToComment(args, context))
  },
  {
    id: 'docs.editComment',
    title: 'Change a comment',
    description: 'Change what a comment or one of its replies says, as one step to undo.',
    tier: 'act',
    args: [document, { ...comment, description: 'The id of the comment or the reply, as docs.listComments gives them' }, { name: 'text', type: 'string', description: 'What it says now', required: true }],
    run: run('docs.editComment', async (args) => (await depth()).editComment(args))
  },
  {
    id: 'docs.resolveComment',
    title: 'Resolve a comment',
    description: 'Mark a comment resolved (resolved=true, the default) or open it again (resolved=false), as one step to undo.',
    tier: 'act',
    args: [document, comment, { name: 'resolved', type: 'boolean', description: 'true (the default) resolves it, false opens it again' }],
    run: run('docs.resolveComment', async (args) => (await depth()).resolveComment(args))
  },
  {
    id: 'docs.deleteComment',
    title: 'Delete a comment',
    description: 'Delete a comment with its replies, or one reply, as one step to undo; all=true deletes every comment in the document.',
    tier: 'mutate',
    args: [document, { name: 'comment', type: 'string', description: 'The id of the comment or the reply, as docs.listComments gives them' }, { name: 'all', type: 'boolean', description: 'Every comment in the document, in place of comment' }],
    run: run('docs.deleteComment', async (args) => (await depth()).deleteComment(args))
  },
  {
    id: 'docs.insertToc',
    title: 'Put a table of contents in a document',
    description:
      'Put a table of contents in a document as one step to undo: it lists the headings down to levels under title, with the page each is on, and follows the headings as they change. It goes at the start, or where at, heading and mode say (heading with mode=before puts it right before that heading).',
    tier: 'act',
    args: [document, levels, title, ...between('start')],
    run: run('docs.insertToc', async (args) => (await depth()).insertToc(args))
  },
  {
    id: 'docs.updateTocs',
    title: 'Update a document’s tables of contents',
    description: 'Bring the page numbers of a document’s tables of contents up to date with its pages as Herald Docs lays them out, as one step to undo (their entries always follow the headings).',
    tier: 'act',
    args: [document],
    run: run('docs.updateTocs', async (args) => (await depth()).updateTocs(args))
  },
  {
    id: 'docs.setToc',
    title: 'Change a table of contents',
    description: 'Change the levels a table of contents lists or its title, as one step to undo; docs.read part=tocs lists them.',
    tier: 'act',
    args: [document, toc, levels, title],
    run: run('docs.setToc', async (args) => (await depth()).setToc(args))
  },
  {
    id: 'docs.removeToc',
    title: 'Take a table of contents out of a document',
    description: 'Take a table of contents out of a document, as one step to undo.',
    tier: 'mutate',
    args: [document, { ...toc, description: 'Which table of contents, from 1 in the order they come (the only one when left out)' }],
    run: run('docs.removeToc', async (args) => (await depth()).removeToc(args))
  },
  {
    id: 'docs.listTemplates',
    title: 'List Herald Docs’ templates',
    description: 'The templates a new document can start from (docs.new template=): Herald Docs’ own, each with its id, name and what it holds, and those the person saved, with their id, name and when.',
    tier: 'read',
    args: [],
    run: async () => (await office()).done((await depth()).listTemplates())
  },
  {
    id: 'docs.statistics',
    title: 'A document’s statistics',
    description:
      'A document’s statistics: words, characters with and without spaces, paragraphs, sentences, words per sentence, reading and speaking time, reading ease (Flesch, from 0 to 100, with what it means) and the US school grade (Flesch-Kincaid), and its pages when it is open. They count the body, not notes, comments, headers or footers; heading gives one section’s, selection=true the selection’s.',
    tier: 'read',
    args: [document, { name: 'heading', type: 'string', description: 'Only this heading’s section (its text, or its number in the outline from 1)' }, { name: 'selection', type: 'boolean', description: 'Only the selected text of an open document' }],
    run: run('docs.statistics', async (args) => (await depth()).statistics(args))
  }
]
