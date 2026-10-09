import type { CommandArg, CommandContext, OsCommand } from '../store/os-commands.ts'

/*
 * Herald Sheets for Hermes, voice, the command bar and `herald-os sheets`. A command works on the
 * `workbook` it names (a file, or an open workbook's name) or on the one in front; open in a
 * window, each change is one step to undo there, and the person watches it land. Univer loads only
 * when one of these runs.
 */

const agent = () => import('../features/office/sheets/agent.ts')
const office = () => import('../features/office/agent.ts')

const workbook: CommandArg = { name: 'workbook', type: 'string', description: 'The workbook: a file (full path or ~/…) or the name of an open workbook as its tab shows it; the one in front in Herald Sheets when left out' }
const sheet: CommandArg = { name: 'sheet', type: 'string', description: 'The sheet, when the range does not name it; the one in front when left out' }
const range = (what: string, required = false): CommandArg => ({ name: 'range', type: 'string', description: `${what}: cells like B2, B2:D9, C:C or 'Q1 sales'!A1:F20, or selection for what is selected`, ...(required ? { required } : {}) })

const run =
  (id: string, work: (args: Record<string, unknown>) => Promise<{ summary: string; data?: Record<string, unknown> }>) =>
  async (args: Record<string, unknown>, context: CommandContext) =>
    (await office()).inOwnWindow('sheets', id, args, 'workbook', context, () => work(args))

export const sheetsCommands: readonly OsCommand[] = [
  {
    id: 'sheets.open',
    title: 'Open Herald Sheets',
    description: 'Open Herald Sheets, or open a workbook in it (.xlsx or .csv) so the person sees it. The answer lists its sheets and how much of each holds data, and anything Herald shows differently from the file.',
    tier: 'act',
    args: [{ name: 'path', type: 'string', description: 'An Excel workbook or CSV file (full path or ~/…)' }],
    phrases: ['open herald sheets', 'open sheets', 'open the spreadsheet app'],
    run: async ({ path }) => (await office()).done((await agent()).open({ path }))
  },
  {
    id: 'sheets.new',
    title: 'Start a new workbook',
    description: 'Start a new workbook in Herald Sheets and show it: blank, from a template, or with values written from A1 (rows; text starting with = is a formula). With path it is saved there at once (.xlsx or .csv, never over a file that exists).',
    tier: 'act',
    args: [
      { name: 'name', type: 'string', description: 'The tab’s name, and the file name it is offered when saved' },
      { name: 'values', type: 'string', description: 'What it starts with, as JSON rows: [["Item", "Cost"], ["Rent", 1200], ["Total", "=SUM(B2:B2)"]]' },
      { name: 'template', type: 'string', description: 'A template to start from: budget, expenses, todo, schedule or invoice' },
      { name: 'path', type: 'string', description: 'Save it here at once: a new .xlsx or .csv file (full path or ~/…)' }
    ],
    phrases: ['new spreadsheet', 'new workbook', 'start a new spreadsheet'],
    run: async (args) => (await office()).done((await agent()).create(args))
  },
  {
    id: 'sheets.list',
    title: 'What is open in Herald Sheets',
    description: 'The workbooks open in Herald Sheets (name, path, unsaved edits), which one is in front, and the sheet and range selected in each.',
    tier: 'read',
    args: [],
    run: async () => (await office()).done((await agent()).list())
  },
  {
    id: 'sheets.read',
    title: 'Read a workbook',
    description:
      'Read a workbook: its sheets (size, hidden, frozen panes) and a range’s values, formulas and what the cells show (formatted numbers and dates); without a range, the cells of the sheet that hold something (a big sheet from its top, as many rows as fit in 10,000 cells). It also says what is selected in an open workbook.',
    tier: 'read',
    args: [workbook, range('The cells to read'), sheet, { name: 'formulas', type: 'boolean', description: 'Include formulas (true, the default)' }],
    run: run('sheets.read', async (args) => (await agent()).read(args))
  },
  {
    id: 'sheets.find',
    title: 'Find in a workbook',
    description: 'Find text in a workbook’s cells (what they show; their formulas too with formulas=true), on every sheet or one: the cells where it is.',
    tier: 'read',
    args: [
      workbook,
      { name: 'text', type: 'string', description: 'What to find', required: true },
      { name: 'sheet', type: 'string', description: 'Only this sheet; every sheet when left out' },
      { name: 'caseSensitive', type: 'boolean', description: 'Match upper and lower case exactly' },
      { name: 'wholeCell', type: 'boolean', description: 'The whole cell has to match' },
      { name: 'formulas', type: 'boolean', description: 'Look in formulas too' }
    ],
    run: run('sheets.find', async (args) => (await agent()).find(args))
  },
  {
    id: 'sheets.write',
    title: 'Write cells',
    description:
      'Write values and formulas into cells as one step to undo: rows from a first cell (as many as given), or exactly a range’s size, or one value into every cell of a range. Text starting with = is a formula (English function names, commas between arguments); text that reads as a plain number becomes a number, and a leading apostrophe keeps it text. The answer shows what the cells now hold and show.',
    tier: 'act',
    args: [workbook, range('Where: the first cell, or the whole range', true), { name: 'values', type: 'string', description: 'JSON rows: [["Item", "Cost"], ["Rent", 1200]], or one value', required: true }, sheet],
    run: run('sheets.write', async (args) => (await agent()).write(args))
  },
  {
    id: 'sheets.fill',
    title: 'Fill a formula across cells',
    description: 'Fill a formula down or across a range as one step to undo, the way dragging the fill handle does: it goes in the first cell as given and its relative references move for each other cell ($ keeps one fixed). Without formula, the first cell’s own formula is filled.',
    tier: 'act',
    args: [workbook, range('The cells to fill, the first one included', true), { name: 'formula', type: 'string', description: 'The first cell’s formula, e.g. =B2*C2' }, sheet],
    run: run('sheets.fill', async (args) => (await agent()).fill(args))
  },
  {
    id: 'sheets.format',
    title: 'Format cells',
    description: 'Format a range as one step to undo: number format ("#,##0.00", "0%", "yyyy-mm-dd", "$#,##0"), bold, italic, underline, strikethrough, font, size, colour, background, alignment, vertical alignment, wrapping and borders.',
    tier: 'act',
    args: [
      workbook,
      range('The cells to format', true),
      { name: 'format', type: 'string', description: 'JSON: {"numberFormat": "#,##0.00", "bold": true, "italic": false, "underline": false, "strikethrough": false, "font": "Arial", "size": 12, "color": "#1f2937", "background": "#fff3bf", "align": "left|center|right|general", "verticalAlign": "top|middle|bottom", "wrap": true, "border": {"edges": "all|outside|inside|top|bottom|left|right|none", "style": "thin|medium|thick|dashed|dotted|double", "color": "#999999"}}', required: true },
      sheet
    ],
    run: run('sheets.format', async (args) => (await agent()).format(args))
  },
  {
    id: 'sheets.sort',
    title: 'Sort cells',
    description: 'Sort a range’s rows by one column as one step to undo; header=true keeps its first row in place.',
    tier: 'act',
    args: [workbook, range('The rows to sort', true), { name: 'by', type: 'string', description: 'The column: a letter (C), a header in the first row (Cost), or a number from the range’s first column (1)', required: true }, { name: 'ascending', type: 'boolean', description: 'A to Z, smallest first (true, the default); false for descending' }, { name: 'header', type: 'boolean', description: 'The first row is a header row' }, sheet],
    run: run('sheets.sort', async (args) => (await agent()).sort(args))
  },
  {
    id: 'sheets.filter',
    title: 'Filter rows',
    description: 'Filter a range by one column as one step to undo: keep rows whose cell shows one of values, or meets a condition; clear=true takes the sheet’s filter off.',
    tier: 'act',
    args: [
      workbook,
      range('The rows to filter, the header row first'),
      { name: 'by', type: 'string', description: 'The column: a letter, a header in the first row, or a number from the range’s first column' },
      { name: 'values', type: 'string', description: 'JSON list of what to keep, as the cells show it: ["Paid", "Due"]' },
      { name: 'condition', type: 'string', description: 'JSON: {"operator": "greaterThan", "value": 100}; operator is equal, notEqual, greaterThan, greaterThanOrEqual, lessThan or lessThanOrEqual' },
      { name: 'clear', type: 'boolean', description: 'Take the filter off' },
      sheet
    ],
    run: run('sheets.filter', async (args) => (await agent()).filter(args))
  },
  {
    id: 'sheets.freeze',
    title: 'Freeze rows and columns',
    description: 'Keep the first rows and columns of a sheet in view while it scrolls; 0 and 0 unfreezes.',
    tier: 'act',
    args: [workbook, { name: 'rows', type: 'number', description: 'Rows to keep in view from the top (0)' }, { name: 'columns', type: 'number', description: 'Columns to keep in view from the left (0)' }, sheet],
    run: run('sheets.freeze', async (args) => (await agent()).freezePanes(args))
  },
  {
    id: 'sheets.addSheet',
    title: 'Add a sheet',
    description: 'Add a sheet to a workbook as one step to undo, at the end unless index says where.',
    tier: 'act',
    args: [workbook, { name: 'name', type: 'string', description: 'Its name (at most 31 characters, none of [ ] : * ? / \\)' }, { name: 'index', type: 'number', description: 'Its place among the sheets, from 0' }],
    run: run('sheets.addSheet', async (args) => (await agent()).newSheet(args))
  },
  {
    id: 'sheets.renameSheet',
    title: 'Rename a sheet',
    description: 'Rename a sheet as one step to undo.',
    tier: 'act',
    args: [workbook, { name: 'sheet', type: 'string', description: 'The sheet to rename; the one in front when left out' }, { name: 'name', type: 'string', description: 'Its new name', required: true }],
    run: run('sheets.renameSheet', async (args) => (await agent()).renameSheetIn(args))
  },
  {
    id: 'sheets.removeSheet',
    title: 'Remove a sheet',
    description: 'Remove a sheet and everything on it (one step to undo in an open workbook). A workbook keeps at least one visible sheet.',
    tier: 'mutate',
    args: [workbook, { name: 'sheet', type: 'string', description: 'The sheet to remove', required: true }],
    run: run('sheets.removeSheet', async (args) => (await agent()).removeSheetIn(args))
  },
  {
    id: 'sheets.replace',
    title: 'Find and replace in a workbook',
    description: 'Replace text in cells as one step to undo, on every sheet (or one, or a range): text cells only, unless formulas=true also changes formulas; numbers and dates are left alone.',
    tier: 'act',
    args: [
      workbook,
      { name: 'find', type: 'string', description: 'The text to replace', required: true },
      { name: 'replacement', type: 'string', description: 'What goes in its place (nothing deletes it)' },
      range('Only in these cells'),
      { name: 'sheet', type: 'string', description: 'Only this sheet; every sheet when left out' },
      { name: 'all', type: 'boolean', description: 'Every match (true, the default) or only the first' },
      { name: 'caseSensitive', type: 'boolean', description: 'Match upper and lower case exactly' },
      { name: 'wholeCell', type: 'boolean', description: 'The whole cell has to match' },
      { name: 'formulas', type: 'boolean', description: 'Change formulas too' }
    ],
    run: run('sheets.replace', async (args) => (await agent()).replace(args))
  },
  {
    id: 'sheets.clean',
    title: 'Clean data',
    description:
      'Clean a range as one step to undo. action: dedupe (remove rows repeating an earlier one, by every column or the columns in by; the rest move up), trim (spaces at the ends and doubled inside), numbers (numbers kept as text, like "1,200", "$5", "(300)" or "12%", become numbers), dates (dates kept as text become real dates in dateFormat; day or month first is read from the data, or order), split (one column split at delimiter into the columns to its right) or case (upper, lower or title). Formulas are kept.',
    tier: 'act',
    args: [
      workbook,
      range('The cells to clean', true),
      { name: 'action', type: 'string', description: 'dedupe, trim, numbers, dates, split or case', required: true },
      { name: 'header', type: 'boolean', description: 'The first row is a header row and stays as it is' },
      { name: 'by', type: 'string', description: 'dedupe: the columns that make a row a repeat, comma-separated letters or headers (every column when left out)' },
      { name: 'delimiter', type: 'string', description: 'split: where to split: a character, or comma (the default), semicolon, space, tab or pipe' },
      { name: 'overwrite', type: 'boolean', description: 'split: write over data in the columns to the right' },
      { name: 'dateFormat', type: 'string', description: 'dates: the number format the dates get (yyyy-mm-dd)' },
      { name: 'order', type: 'string', description: 'dates: dmy (day first) or mdy (month first) for dates like 03/04/2025, when the data does not say' },
      { name: 'case', type: 'string', description: 'case: upper, lower or title (the default)' },
      sheet
    ],
    run: run('sheets.clean', async (args) => (await agent()).clean(args))
  },
  {
    id: 'sheets.edit',
    title: 'Make several edits in a workbook at once',
    description:
      'Make several changes to a workbook as ONE step to undo: edits is a JSON list of objects, each with an op and that op’s arguments: write (range, values, sheet), fill (range, formula), format (range, format), sort (range, by, ascending, header), filter (range, by, values, condition, clear), freeze (rows, columns, sheet), addSheet (name, index), renameSheet (sheet, name), removeSheet (sheet), clean (the sheets.clean arguments) and replace (the sheets.replace arguments).',
    tier: 'act',
    args: [workbook, { name: 'edits', type: 'string', description: 'JSON list: [{"op": "write", "range": "A1", "values": [["Month", "Sales"]]}, {"op": "format", "range": "A1:B1", "format": {"bold": true}}]', required: true }],
    run: run('sheets.edit', async (args) => (await agent()).edit(args))
  },
  {
    id: 'sheets.save',
    title: 'Save a workbook',
    description:
      'Save a workbook open in Herald Sheets: over its own file, or as a new one with to (.xlsx or .csv; an existing file is replaced only with overwrite=true). Saving over a file follows Herald’s policy: the first time, the person sees what Herald cannot keep, and the original goes to Herald’s Office backups. A file that is not open is saved as another format with to.',
    tier: 'mutate',
    args: [workbook, { name: 'to', type: 'string', description: 'Save as this file instead (full path or ~/…)' }, { name: 'overwrite', type: 'boolean', description: 'Replace a file at to' }],
    phrases: ['save the spreadsheet', 'save the workbook'],
    run: run('sheets.save', async (args) => (await agent()).save(args))
  },
  {
    id: 'sheets.exportPdf',
    title: 'Export a workbook as a PDF',
    description: 'Write the sheet in front of a workbook as a PDF, laid out as it prints: to a file you name, or a new file in ~/Documents. An existing file is replaced only with overwrite=true.',
    tier: 'act',
    args: [workbook, { name: 'to', type: 'string', description: 'The PDF to write (full path or ~/…)' }, { name: 'overwrite', type: 'boolean', description: 'Replace a file at to' }],
    run: run('sheets.exportPdf', async (args) => (await agent()).exportPdf(args))
  },
  {
    id: 'sheets.undo',
    title: 'Undo in Herald Sheets',
    description: 'Undo the last change to a workbook open in Herald Sheets, whoever made it (each Hermes change is one step); steps undoes several.',
    tier: 'act',
    args: [workbook, { name: 'steps', type: 'number', description: 'How many steps (1)' }],
    run: run('sheets.undo', async (args) => (await agent()).step('undo', args))
  },
  {
    id: 'sheets.redo',
    title: 'Redo in Herald Sheets',
    description: 'Redo what was last undone in a workbook open in Herald Sheets; steps redoes several.',
    tier: 'act',
    args: [workbook, { name: 'steps', type: 'number', description: 'How many steps (1)' }],
    run: run('sheets.redo', async (args) => (await agent()).step('redo', args))
  }
]
