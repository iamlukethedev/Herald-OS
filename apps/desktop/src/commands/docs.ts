import type { CommandArg, CommandContext, OsCommand } from '../store/os-commands.ts'

/*
 * Herald Docs for Hermes, voice, the command bar and `herald-os docs`. A command works on the
 * `document` it names (a file, or an open document's name) or on the one in front; open in a
 * window, each change is one step to undo there, and the person watches it land. The editor's code
 * loads only when one of these runs.
 */

const agent = () => import('../features/office/docs/agent.ts')
const office = () => import('../features/office/agent.ts')

const document: CommandArg = { name: 'document', type: 'string', description: 'The document: a file (full path or ~/…) or the name of an open document as its tab shows it; the one in front in Herald Docs when left out' }

const placement: readonly CommandArg[] = [
  { name: 'at', type: 'string', description: 'Where: end (the default), start, selection (in place of what is selected, or at the caret), marked (in place of the text Herald marked for this request), after (under the paragraph the selection is in) or heading' },
  { name: 'heading', type: 'string', description: 'A heading (its text, or its number in the outline from 1): the content goes in its section' },
  { name: 'mode', type: 'string', description: 'With heading: append (at the end of the section, the default), prepend (right under the heading) or replace (in place of the section, keeping the heading)' }
]

const search: readonly CommandArg[] = [
  { name: 'caseSensitive', type: 'boolean', description: 'Match upper and lower case exactly' },
  { name: 'wholeWord', type: 'boolean', description: 'Match whole words only' },
  { name: 'regex', type: 'boolean', description: 'The text is a regular expression' }
]

/** Run where the document lives: here, or in its own window (panels mode). */
const run =
  (id: string, work: (args: Record<string, unknown>) => Promise<{ summary: string; data?: Record<string, unknown> }>) =>
  async (args: Record<string, unknown>, context: CommandContext) =>
    (await office()).inOwnWindow('docs', id, args, 'document', context, () => work(args))

export const docsCommands: readonly OsCommand[] = [
  {
    id: 'docs.open',
    title: 'Open Herald Docs',
    description: 'Open Herald Docs, or open a document in it (.docx, .md or .txt) so the person sees it. The answer gives its outline, and lists anything Herald shows differently from the file.',
    tier: 'act',
    args: [{ name: 'path', type: 'string', description: 'A Word document, Markdown or text file (full path or ~/…)' }],
    phrases: ['open herald docs', 'open docs', 'open the word processor'],
    run: async ({ path }) => (await office()).done((await agent()).open({ path }))
  },
  {
    id: 'docs.new',
    title: 'Start a new document',
    description:
      'Start a new document in Herald Docs and show it: blank, from a template, or with content (Markdown: headings, lists, tables, pictures from files). With path it is saved there at once (never over a file that exists). Draft from a brief by writing the content yourself.',
    tier: 'act',
    args: [
      { name: 'name', type: 'string', description: 'The tab’s name, and the file name it is offered when saved' },
      { name: 'content', type: 'string', description: 'What it starts with, in Markdown' },
      { name: 'template', type: 'string', description: 'A template to start from: letter, cover letter, report, memo, meeting notes, resume, proposal or essay' },
      { name: 'path', type: 'string', description: 'Save it here at once: a new .docx, .md or .txt file (full path or ~/…)' }
    ],
    phrases: ['new document', 'start a new document', 'new doc'],
    run: async (args) => (await office()).done((await agent()).create(args))
  },
  {
    id: 'docs.list',
    title: 'What is open in Herald Docs',
    description: 'The documents open in Herald Docs (name, path, unsaved edits), which one is in front, and the text selected in each.',
    tier: 'read',
    args: [],
    run: async () => (await office()).done((await agent()).list())
  },
  {
    id: 'docs.read',
    title: 'Read a document',
    description:
      'Read a document: its outline (headings), word count, page, and content as Markdown (the default) or plain text, the whole of it or one heading’s section; part=selection gives just the selected and marked text of an open document. Long documents come back cut at maxChars: read them by section.',
    tier: 'read',
    args: [
      document,
      { name: 'part', type: 'string', description: 'markdown (the default), text, outline or selection' },
      { name: 'heading', type: 'string', description: 'Only this heading’s section (its text, or its number in the outline from 1)' },
      { name: 'maxChars', type: 'number', description: 'At most this many characters of content (20000)' }
    ],
    run: run('docs.read', async (args) => (await agent()).read(args))
  },
  {
    id: 'docs.find',
    title: 'Find in a document',
    description: 'Find text in a document: how many times it appears, and each place with the words around it and the heading it is under.',
    tier: 'read',
    args: [document, { name: 'text', type: 'string', description: 'What to find', required: true }, ...search],
    run: run('docs.find', async (args) => (await agent()).find(args))
  },
  {
    id: 'docs.write',
    title: 'Write in a document',
    description:
      'Put content in a document as one step to undo: Markdown by default (headings, bold and italic, lists, task lists, tables, links, quotes, code, pictures from files as ![alt](~/path.png)), at the end, the start, the selection, the marked text, under the selection’s paragraph, or in a heading’s section (append, prepend or replace). One paragraph at the selection joins its line of text.',
    tier: 'act',
    args: [document, { name: 'content', type: 'string', description: 'What to write, in Markdown (or plain text with format=text)', required: true }, { name: 'format', type: 'string', description: 'markdown (the default) or text' }, ...placement],
    run: run('docs.write', async (args) => (await agent()).write(args))
  },
  {
    id: 'docs.replace',
    title: 'Find and replace in a document',
    description: 'Replace text in a document as one step to undo: every match (the default) or the first; each replacement keeps the formatting where its match starts. An empty replacement deletes the matches.',
    tier: 'act',
    args: [document, { name: 'find', type: 'string', description: 'The text to replace', required: true }, { name: 'replacement', type: 'string', description: 'What goes in its place (nothing deletes it)' }, { name: 'all', type: 'boolean', description: 'Every match (true, the default) or only the first (false)' }, ...search],
    run: run('docs.replace', async (args) => (await agent()).replace(args))
  },
  {
    id: 'docs.format',
    title: 'Format text in a document',
    description:
      'Format part of a document as one step to undo: a paragraph style (normal, title, subtitle, heading1 to heading6, quote, code), bold, italic, underline, strikethrough, colour, highlight, font, size in points, a link, alignment or line spacing; "none" takes a colour, highlight, font, size or link off. It applies to the selection, the marked text, everything, a heading (or its whole section) or every place some text appears.',
    tier: 'act',
    args: [
      document,
      { name: 'at', type: 'string', description: 'What to format: selection (the default), marked, all, heading (the heading line), section (the heading and its section) or text (every match of text)' },
      { name: 'heading', type: 'string', description: 'With at=heading or section: the heading (text, or number from 1)' },
      { name: 'text', type: 'string', description: 'With at=text: the words to format, wherever they are' },
      { name: 'style', type: 'string', description: 'normal, title, subtitle, heading1 … heading6, quote or code' },
      { name: 'bold', type: 'boolean', description: 'Bold on or off' },
      { name: 'italic', type: 'boolean', description: 'Italic on or off' },
      { name: 'underline', type: 'boolean', description: 'Underline on or off' },
      { name: 'strike', type: 'boolean', description: 'Strikethrough on or off' },
      { name: 'color', type: 'string', description: 'Text colour (any CSS colour), or none' },
      { name: 'highlight', type: 'string', description: 'Highlight colour, or none' },
      { name: 'font', type: 'string', description: 'A font family, or none' },
      { name: 'size', type: 'number', description: 'Font size in points (0 goes back to the style’s)' },
      { name: 'link', type: 'string', description: 'A web address to link to, or none' },
      { name: 'align', type: 'string', description: 'left, center, right or justify' },
      { name: 'lineSpacing', type: 'number', description: 'Line spacing as a multiple: 1, 1.15, 1.5, 2' },
      { name: 'clear', type: 'boolean', description: 'Clear the formatting first' },
      ...search
    ],
    run: run('docs.format', async (args) => (await agent()).format(args))
  },
  {
    id: 'docs.insertTable',
    title: 'Put a table in a document',
    description: 'Put a table in a document as one step to undo, with its cells (rows of text) or empty rows and columns; the first row is a header row unless header=false. On the page, its columns share the text width.',
    tier: 'act',
    args: [
      document,
      { name: 'cells', type: 'string', description: 'The cells as JSON rows: [["Item", "Cost"], ["Rent", "1200"]]' },
      { name: 'rows', type: 'number', description: 'Rows, for an empty table' },
      { name: 'cols', type: 'number', description: 'Columns, for an empty table' },
      { name: 'header', type: 'boolean', description: 'The first row is a header row (true, the default)' },
      ...placement
    ],
    run: run('docs.insertTable', async (args) => (await agent()).table(args))
  },
  {
    id: 'docs.insertImage',
    title: 'Put a picture in a document',
    description: 'Put a picture from a file (PNG, JPEG, GIF, WebP, BMP or SVG) in a document as one step to undo, at most as wide as the text unless width says less.',
    tier: 'act',
    args: [document, { name: 'source', type: 'string', description: 'The picture file (full path or ~/…)', required: true }, { name: 'alt', type: 'string', description: 'What it shows, for screen readers' }, { name: 'width', type: 'number', description: 'Width in pixels' }, ...placement],
    run: run('docs.insertImage', async (args) => (await agent()).image(args))
  },
  {
    id: 'docs.setPage',
    title: 'Set up the page of a document',
    description: 'Change a document’s page as one step to undo: size (a4 or letter), orientation (portrait or landscape) and margins (points, or "1in", "20mm").',
    tier: 'act',
    args: [document, { name: 'size', type: 'string', description: 'a4 or letter' }, { name: 'orientation', type: 'string', description: 'portrait or landscape' }, { name: 'margins', type: 'string', description: 'All four margins: points, or with a unit ("1in", "2cm", "20mm")' }],
    run: run('docs.setPage', async (args) => (await agent()).page(args))
  },
  {
    id: 'docs.edit',
    title: 'Make several edits in a document at once',
    description:
      'Make several changes to a document as ONE step to undo: edits is a JSON list of objects, each with an op and that op’s arguments: write (content, format, at, heading, mode), replace (find, replacement, all, caseSensitive, wholeWord, regex), format (the docs.format arguments), table (cells or rows and cols, header, at, heading, mode), image (source, alt, at, heading, mode), pageBreak (at, heading, mode) and page (size, orientation, margins). Each edit sees the document as the ones before left it.',
    tier: 'act',
    args: [document, { name: 'edits', type: 'string', description: 'JSON list: [{"op": "write", "content": "## Summary\\n…", "at": "start"}, {"op": "replace", "find": "draft", "replacement": "final"}]', required: true }],
    run: run('docs.edit', async (args) => (await agent()).edit(args))
  },
  {
    id: 'docs.insertRange',
    title: 'Put a sheet range in a document',
    description: 'Put a range of a Herald Sheets workbook (open, or a file) in a document as a table, as its cells show (formatted numbers and dates), as one step to undo. Without a range, the workbook’s selection, or else its sheet’s cells that hold something.',
    tier: 'act',
    args: [
      document,
      { name: 'workbook', type: 'string', description: 'The workbook: a file (full path or ~/…) or an open workbook’s name; the one in front in Herald Sheets when left out' },
      { name: 'range', type: 'string', description: 'The cells, like A1:D12 or \'Q1 sales\'!B2:F9; selection for what is selected' },
      { name: 'sheet', type: 'string', description: 'The sheet, when the range does not name it' },
      { name: 'header', type: 'boolean', description: 'The first row is a header row (true, the default)' },
      ...placement
    ],
    run: run('docs.insertRange', async (args) => (await agent()).insertRange(args))
  },
  {
    id: 'docs.save',
    title: 'Save a document',
    description:
      'Save a document open in Herald Docs: over its own file, or as a new one with to (.docx, .md or .txt; an existing file is replaced only with overwrite=true). Saving over a file follows Herald’s policy: the first time, the person sees what Herald cannot keep, and the original goes to Herald’s Office backups. A file that is not open is saved as another format with to.',
    tier: 'mutate',
    args: [document, { name: 'to', type: 'string', description: 'Save as this file instead (full path or ~/…)' }, { name: 'overwrite', type: 'boolean', description: 'Replace a file at to' }],
    phrases: ['save the document'],
    run: run('docs.save', async (args) => (await agent()).save(args))
  },
  {
    id: 'docs.exportPdf',
    title: 'Export a document as a PDF',
    description: 'Write a document as a PDF, laid out as it prints: to a file you name, or a new file in ~/Documents. An existing file is replaced only with overwrite=true.',
    tier: 'act',
    args: [document, { name: 'to', type: 'string', description: 'The PDF to write (full path or ~/…)' }, { name: 'overwrite', type: 'boolean', description: 'Replace a file at to' }],
    run: run('docs.exportPdf', async (args) => (await agent()).exportPdf(args))
  },
  {
    id: 'docs.undo',
    title: 'Undo in Herald Docs',
    description: 'Undo the last change to a document open in Herald Docs, whoever made it (each Hermes change is one step); steps undoes several.',
    tier: 'act',
    args: [document, { name: 'steps', type: 'number', description: 'How many steps (1)' }],
    run: run('docs.undo', async (args) => (await agent()).step('undo', args))
  },
  {
    id: 'docs.redo',
    title: 'Redo in Herald Docs',
    description: 'Redo what was last undone in a document open in Herald Docs; steps redoes several.',
    tier: 'act',
    args: [document, { name: 'steps', type: 'number', description: 'How many steps (1)' }],
    run: run('docs.redo', async (args) => (await agent()).step('redo', args))
  }
]
