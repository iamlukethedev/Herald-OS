import type { DepthCommand } from '../features/office/sheets/agent-depth.ts'
import type { CommandArg, OsCommand } from '../store/os-commands.ts'
import { range, run, sheet, workbook } from './sheets-shared.ts'

/*
 * Herald Sheets' charts, summaries, data tools, named ranges, validation, comments and notes for
 * Hermes, voice, the command bar and `herald-os sheets`, on the workbook named or the one in front
 * as the other sheets.* commands are. Each change is one step to undo in an open workbook, but
 * comment threads change outside the undo history, as Univer keeps them.
 */

const agent = () => import('../features/office/sheets/agent.ts')

const depth = (command: DepthCommand) => run(`sheets.${command}`, async (args, context) => (await agent()).depth(command, args, context))

const table = (what: string, required = true): CommandArg => range(`${what}, or one cell inside a table for all of it`, required)
const preview: CommandArg = { name: 'preview', type: 'boolean', description: 'Say what it would do, and change nothing' }
const header: CommandArg = { name: 'header', type: 'boolean', description: 'The first row is a header row and stays as it is (read from the data when left out)' }

const chart: CommandArg = { name: 'chart', type: 'string', description: 'The chart: its id (from sheets.listCharts or sheets.insertChart), its title, or its number in sheets.listCharts (1 is the first)', required: true }
const where: readonly CommandArg[] = [
  { name: 'at', type: 'string', description: 'Where on its sheet: a cell for its top-left corner (H2), or cells for it to cover (H2:N18), which size it' },
  { name: 'width', type: 'number', description: 'Its width in pixels, 80 to 4000 (480 for a new chart)' },
  { name: 'height', type: 'number', description: 'Its height in pixels, 80 to 4000 (288 for a new chart)' }
]
const settings: readonly CommandArg[] = [
  { name: 'kind', type: 'string', description: 'column, bar, line, area, pie, doughnut, scatter or combo (columns and lines together)' },
  { name: 'title', type: 'string', description: 'The chart’s title; none for no title' },
  { name: 'series', type: 'string', description: 'The whole list of series, as JSON: [{"values": "B2:B13", "name": "Sales" (or "nameCell": "B1"), "categories": "A2:A13", "color": "#4472c4", "type": "column", "secondary": false, "smooth": false, "markers": true}]; type (column, line or area) and secondary (a second value axis) are for combo charts' },
  { name: 'categories', type: 'string', description: 'The category labels (a scatter chart’s x values) for every series, cells like A2:A13; none for none' },
  { name: 'legend', type: 'string', description: 'Where the legend goes: top, bottom, left, right or none' },
  { name: 'labels', type: 'string', description: 'Data labels: none, value, percent or category' },
  { name: 'axes', type: 'string', description: 'JSON: {"x": {…}, "y": {…}, "y2": {…}} (the category axis, the value axis, a combo chart’s second value axis), each with title, min, max, gridlines, format ("0%", "#,##0"), hidden and reverse (the other way round); null for a key takes it off' },
  { name: 'stacking', type: 'string', description: 'none, stacked or percent (columns, bars, lines and areas)' },
  { name: 'palette', type: 'string', description: 'The series’ colours in turn: a JSON list or comma-separated ("#4472c4, #ed7d31"), or workbook for the workbook theme’s' },
  { name: 'hole', type: 'number', description: 'A doughnut’s hole as a percentage of its size, 0 to 90 (50)' }
]

const cell: CommandArg = { name: 'cell', type: 'string', description: "The cell, like B2 or 'Q1 sales'!C3, or selection", required: true }
const thread: readonly CommandArg[] = [
  { name: 'cell', type: 'string', description: 'The comment’s cell, like B2, or selection' },
  { name: 'commentId', type: 'string', description: 'Or a comment’s id, from sheets.listComments' }
]
const name = (what: string, required = true): CommandArg => ({ name: 'name', type: 'string', description: what, ...(required ? { required } : {}) })
const scope: CommandArg = { name: 'scope', type: 'string', description: 'workbook (the default) or a sheet’s name, for a name only that sheet’s formulas see; with several names so spelled, which one' }

export const sheetsDepthCommands: readonly OsCommand[] = [
  // Charts.
  {
    id: 'sheets.insertChart',
    title: 'Insert a chart',
    description:
      'Insert a chart of a block of cells as one step to undo: the first row and column name the series and categories, as in Excel. Of kind, else the kind that fits the data best (sheets.recommendCharts says which and why); titled from the data when it shows one series; beside the data unless at says where. The answer gives the chart’s id, for sheets.describeChart, updateChart, moveChart and removeChart.',
    tier: 'act',
    args: [workbook, table('The data, with its headers'), ...settings, ...where, { name: 'sheet', type: 'string', description: 'The sheet it goes on, the data’s when left out; a range without a sheet name is on it' }],
    run: depth('insertChart')
  },
  {
    id: 'sheets.listCharts',
    title: 'List the charts',
    description: 'The charts in a workbook, or on one sheet: each one’s id, kind, title, sheet, the cell under its top-left corner, size in pixels and number of series.',
    tier: 'read',
    args: [workbook, { name: 'sheet', type: 'string', description: 'Only this sheet; every sheet when left out' }],
    run: depth('listCharts')
  },
  {
    id: 'sheets.describeChart',
    title: 'Describe a chart',
    description: 'A chart’s settings as sheets.updateChart takes them: kind, title, each series’ cells (values, name, categories), type and colour, legend, data labels, stacking, axes, palette and hole; where it is and its size.',
    tier: 'read',
    args: [workbook, chart],
    run: depth('describeChart')
  },
  {
    id: 'sheets.updateChart',
    title: 'Change a chart',
    description: 'Change a chart as one step to undo: what is given changes, the rest stays. range lays its series out again from other cells; series replaces the whole list. The answer describes it as it is now.',
    tier: 'act',
    args: [workbook, chart, ...settings, range('Lay the series out again from these cells')],
    run: depth('updateChart')
  },
  {
    id: 'sheets.moveChart',
    title: 'Move or size a chart',
    description: 'Move a chart on its sheet and size it, as one step to undo: at a cell for its corner, or over cells, which sizes it to them; width and height in pixels.',
    tier: 'act',
    args: [workbook, chart, ...where],
    run: depth('moveChart')
  },
  {
    id: 'sheets.removeChart',
    title: 'Remove a chart',
    description: 'Remove a chart from its sheet (one step to undo in an open workbook); the data it showed stays.',
    tier: 'mutate',
    args: [workbook, chart],
    run: depth('removeChart')
  },
  {
    id: 'sheets.recommendCharts',
    title: 'Recommend charts',
    description: 'The kinds of chart that suit a block of cells, the best first, each with why (and stacking where it helps). Read it before sheets.insertChart.',
    tier: 'read',
    args: [workbook, table('The data, with its headers'), sheet],
    run: depth('recommendCharts')
  },
  // Summaries.
  {
    id: 'sheets.summarize',
    title: 'Summarize a table',
    description:
      'Summarize a table as a pivot table does, in live formulas, as one step to undo: the distinct values of rowFields go down (and of columnFields across), and each of valueFields is worked out for them with SUMIFS, COUNTIFS, AVERAGEIFS, MINIFS or MAXIFS over the table’s whole columns, so the numbers follow the data; grand totals close it. It goes on a new sheet unless destination says where. Labels the data gains later come with sheets.refreshSummary. preview=true gives its shape and changes nothing.',
    tier: 'act',
    args: [
      workbook,
      table('The table, its first row the headers'),
      { name: 'rowFields', type: 'string', description: 'The columns whose values go down the summary, by header or letter: a JSON list (["Region"]) or comma-separated', required: true },
      { name: 'columnFields', type: 'string', description: 'Columns whose values go across it, as rowFields' },
      { name: 'valueFields', type: 'string', description: 'What is worked out, as JSON: [{"field": "Amount", "fn": "sum"}]; fn is sum, count, average, min or max (sum for numbers, count for the rest, when left out). Comma-separated columns take their fn so', required: true },
      { name: 'filters', type: 'string', description: 'The rows to count in, as JSON: [{"field": "Status", "values": ["Paid", "Due"]}]; "(blank)" stands for empty cells' },
      { name: 'destination', type: 'string', description: "Where it goes: new (a new sheet, the default), a sheet’s name, or its first cell, like H2 (on the sheet in front) or 'Report'!B2" },
      preview,
      sheet
    ],
    run: depth('summarize')
  },
  {
    id: 'sheets.refreshSummary',
    title: 'Refresh a summary',
    description: 'Refresh summaries made by sheets.summarize, as one step to undo: read each table again as it has grown or shrunk, and rewrite the summary in place with the labels it has now. Every summary on the sheet unless summary names one.',
    tier: 'act',
    args: [
      workbook,
      { name: 'summary', type: 'string', description: 'Which: its id (summary-1), its number on the sheet, or a cell inside it' },
      { name: 'sheet', type: 'string', description: 'The summaries’ sheet: the one in front, or the only sheet with summaries, when left out' }
    ],
    run: depth('refreshSummary')
  },
  {
    id: 'sheets.listSummaries',
    title: 'List the summaries',
    description: 'The summaries made by sheets.summarize in a workbook, or on one sheet: each one’s id, sheet, cells, the table it reads, its row, column and value fields, and its filters.',
    tier: 'read',
    args: [workbook, { name: 'sheet', type: 'string', description: 'Only this sheet; every sheet when left out' }],
    run: depth('listSummaries')
  },
  // Data tools.
  {
    id: 'sheets.removeDuplicates',
    title: 'Remove duplicate rows',
    description:
      'Take out the rows of a range that repeat an earlier row in every column, or in the columns of by, keeping the first of each, as one step to undo: the rows under them move up with their formulas, and the range ends in empty rows; nothing outside it moves. Text compares in any case; empty rows stay. preview=true counts them and changes nothing.',
    tier: 'act',
    args: [workbook, table('The rows'), { name: 'by', type: 'string', description: 'The columns that make a row a repeat: comma-separated letters, headers or numbers (1 is the first); every column when left out' }, header, preview, sheet],
    run: depth('removeDuplicates')
  },
  {
    id: 'sheets.splitText',
    title: 'Split text into columns',
    description:
      'Split the text of one column at a delimiter into the columns to its right (or from destination), as one step to undo. Parts in double quotes keep the delimiter; plain numbers become numbers (not ones with leading zeros); formulas and numbers stay. It will not write over data unless overwrite=true; preview=true says where the parts go and what they would write over, and changes nothing.',
    tier: 'act',
    args: [
      workbook,
      range('The column: its cells, or one cell for its column of the table around it', true),
      { name: 'delimiter', type: 'string', description: 'comma (the default), semicolon, tab, space or pipe, or the text to split at, like / or -' },
      { name: 'consecutive', type: 'boolean', description: 'Runs of the delimiter count as one' },
      { name: 'destination', type: 'string', description: "The first cell the parts go to, like D2 or 'Other'!A1; the column itself when left out" },
      { name: 'overwrite', type: 'boolean', description: 'Write over cells with data where the parts go' },
      { name: 'header', type: 'boolean', description: 'The first row is a header row and stays as it is' },
      preview,
      sheet
    ],
    run: depth('splitText')
  },
  {
    id: 'sheets.trimText',
    title: 'Trim text',
    description: 'Trim the text in a range as one step to undo: spaces at the ends go, runs of spaces inside become one, and characters that print nothing are taken out. Formulas, numbers and linked text stay.',
    tier: 'act',
    args: [workbook, table('The cells'), sheet],
    run: depth('trimText')
  },
  {
    id: 'sheets.changeCase',
    title: 'Change the case of text',
    description: 'Put the text in a range in UPPER, lower, Title or Sentence case as one step to undo. Formulas, numbers and linked text stay.',
    tier: 'act',
    args: [workbook, table('The cells'), { name: 'case', type: 'string', description: 'upper, lower, title (each word’s first letter) or sentence (each sentence’s first letter)', required: true }, sheet],
    run: depth('changeCase')
  },
  {
    id: 'sheets.convertToNumbers',
    title: 'Convert text to numbers',
    description:
      'Turn numbers kept as text into numbers, as one step to undo: thousands separators, a currency symbol before or after ("$1,200.50", "1,200 €"), percentages ("12%") and negatives in parentheses or with a minus after, read as 1,234.50 is written. A cell without a number format of its own gets one that shows the number as the text did. The answer lists text it could not read. preview=true changes nothing.',
    tier: 'act',
    args: [workbook, table('The cells'), preview, sheet],
    run: depth('convertToNumbers')
  },
  {
    id: 'sheets.convertToDates',
    title: 'Convert text to dates',
    description:
      'Turn dates kept as text into dates, as one step to undo: numbers in order ("31/12/2025" in DMY), a year written first, or the month’s name ("31 Dec 2025", "Dec 31, 2025"); a time may follow. They get dateFormat (with the time when the text has one). The answer lists text it could not read. preview=true changes nothing.',
    tier: 'act',
    args: [
      workbook,
      table('The cells'),
      { name: 'order', type: 'string', description: 'How dates written in numbers go: dmy (day first), mdy (month first) or ymd; when left out, read from the data (a first number over 12 is a day), else the person’s own' },
      { name: 'dateFormat', type: 'string', description: 'The date format they get: yyyy-mm-dd (the default), d mmm yyyy, dd/mm/yyyy, mm/dd/yyyy or mmmm d, yyyy' },
      preview,
      sheet
    ],
    run: depth('convertToDates')
  },
  {
    id: 'sheets.fillDown',
    title: 'Fill empty cells down',
    description: 'Fill each empty cell of a range with the cell above it, down each column, as one step to undo: values with their formats, formulas with their relative references moved. Empty cells above a column’s first value stay empty. For labels written once per group.',
    tier: 'act',
    args: [workbook, table('The cells'), sheet],
    run: depth('fillDown')
  },
  {
    id: 'sheets.highlightDuplicates',
    title: 'Highlight duplicate values',
    description: 'Highlight the cells of a range whose value appears more than once in it, as a conditional format that follows the data (light red, as Excel’s, unless color), in one step to undo; clear=true takes that highlight off instead.',
    tier: 'act',
    args: [
      workbook,
      range('The cells, or one cell for its column of the table around it', true),
      { name: 'color', type: 'string', description: 'The fill, like #ffc7ce or rgb(255, 199, 206)' },
      { name: 'clear', type: 'boolean', description: 'Take the duplicate highlight off the range instead' },
      sheet
    ],
    run: depth('highlightDuplicates')
  },
  {
    id: 'sheets.sortBy',
    title: 'Sort by several columns',
    description: 'Sort a range’s rows by several columns in turn, as one step to undo; a header row (given, or as the first row reads) stays on top.',
    tier: 'act',
    args: [
      workbook,
      table('The rows'),
      { name: 'keys', type: 'string', description: 'The columns, the first first: JSON [{"column": "Region", "ascending": true}, {"column": "C", "ascending": false}], or text like "Region, Amount desc"; a column is a header, a letter or a number from 1', required: true },
      header,
      sheet
    ],
    run: depth('sortBy')
  },
  // Named ranges.
  {
    id: 'sheets.listNames',
    title: 'List the named ranges',
    description: 'The names in a workbook: each one, what it stands for (=Data!$B$2:$D$9, or a constant or formula like =0.07), its scope (workbook, or the sheet whose formulas alone see it) and its comment.',
    tier: 'read',
    args: [workbook],
    run: depth('listNames')
  },
  {
    id: 'sheets.createName',
    title: 'Name cells or a value',
    description: 'Name cells, or a constant or formula, for the workbook or one sheet, as one step to undo; formulas can then use the name (=SUM(Sales)*TaxRate).',
    tier: 'act',
    args: [
      workbook,
      name('The name: a letter or _ first, then letters, digits, _ or .; not a cell like A1 or R1C1'),
      { name: 'refersTo', type: 'string', description: 'What it stands for: cells like Data!B2:D9 (on the sheet in front without a sheet name), selection, or a constant or formula like =0.07', required: true },
      scope,
      { name: 'comment', type: 'string', description: 'What it is for, as the Name manager shows it' }
    ],
    run: depth('createName')
  },
  {
    id: 'sheets.updateName',
    title: 'Change a named range',
    description: 'Rename a name, or change what it stands for or its comment, as one step to undo.',
    tier: 'act',
    args: [
      workbook,
      name('The name as it is now'),
      { name: 'newName', type: 'string', description: 'Its new name' },
      { name: 'refersTo', type: 'string', description: 'What it stands for now: cells, selection, or a constant or formula like =0.08' },
      { name: 'comment', type: 'string', description: 'Its comment; none takes it off' },
      scope
    ],
    run: depth('updateName')
  },
  {
    id: 'sheets.deleteName',
    title: 'Remove a named range',
    description: 'Remove a name (one step to undo in an open workbook); formulas that use it show #NAME? until it is back.',
    tier: 'mutate',
    args: [workbook, name('The name'), scope],
    run: depth('deleteName')
  },
  {
    id: 'sheets.goToName',
    title: 'Go to a named range',
    description: 'Select the cells a name stands for in a workbook open in Herald Sheets, bringing their sheet to the front, so the person sees them.',
    tier: 'act',
    args: [workbook, name('The name'), scope],
    run: depth('goToName')
  },
  // Validation.
  {
    id: 'sheets.setValidation',
    title: 'Set what cells take',
    description:
      'Set what a range’s cells take, as one step to undo, in place of the rules they had: a dropdown list (items, or the cells they are in), whole or decimal numbers, dates or text lengths compared with an operator, a custom formula, or any value (for an input message alone). An input message shows when a cell is selected; an error alert follows a value the rule does not allow.',
    tier: 'act',
    args: [
      workbook,
      range('The cells', true),
      {
        name: 'rule',
        type: 'string',
        description:
          'JSON: {"type": "list", "items": ["Yes", "No"]} or {"type": "list", "source": "Lists!A2:A9"}; {"type": "whole", "operator": "between", "min": 1, "max": 10}, or decimal, date (yyyy-mm-dd) or textLength with an operator (between, notBetween, equal, notEqual, greaterThan, lessThan, greaterThanOrEqual, lessThanOrEqual) and value, or min and max (a bound can be a formula like =TODAY()); {"type": "custom", "formula": "=B2<=C2"} (TRUE for what is allowed, as worked out for the first cell); {"type": "any"}',
        required: true
      },
      { name: 'allowBlank', type: 'boolean', description: 'Empty cells are allowed (true, the default)' },
      { name: 'dropdown', type: 'boolean', description: 'A list shows its arrow in the cell (true, the default)' },
      { name: 'input', type: 'string', description: 'The input message, as JSON: {"title": "Status", "message": "Pick one from the list"}' },
      { name: 'alert', type: 'string', description: 'The error alert, as JSON: {"style": "stop", "title": "Not on the list", "message": "Pick Yes or No"}; style is stop (the value is refused, the default), warning (the person may keep it), information, or none for no alert' },
      sheet
    ],
    run: depth('setValidation')
  },
  {
    id: 'sheets.getValidation',
    title: 'Read what cells take',
    description: 'The validation rules that cover any of a range’s cells, as sheets.setValidation takes them: each with all the cells it covers, its rule, whether blanks are allowed, the dropdown, the input message and the error alert.',
    tier: 'read',
    args: [workbook, range('The cells', true), sheet],
    run: depth('getValidation')
  },
  {
    id: 'sheets.clearValidation',
    title: 'Take validation off cells',
    description: 'Take the validation rules off a range’s cells (one step to undo in an open workbook); a rule keeps the rest of its cells.',
    tier: 'mutate',
    args: [workbook, range('The cells', true), sheet],
    run: depth('clearValidation')
  },
  // Comments and notes.
  {
    id: 'sheets.listComments',
    title: 'List the comments',
    description: 'The comment threads in a workbook, or on one sheet: each one’s id, cell, author, time, text, whether it is resolved, and its replies with their ids.',
    tier: 'read',
    args: [workbook, { name: 'sheet', type: 'string', description: 'Only this sheet; every sheet when left out' }],
    run: depth('listComments')
  },
  {
    id: 'sheets.addComment',
    title: 'Comment on a cell',
    description: 'Start a comment thread on a cell; comments Hermes writes are signed Hermes. A cell holds a comment or a note, as in Excel. Comments stay out of the undo history: sheets.deleteComment takes one off. The answer gives the comment’s id.',
    tier: 'act',
    args: [workbook, cell, { name: 'text', type: 'string', description: 'The comment', required: true }, sheet],
    run: depth('addComment')
  },
  {
    id: 'sheets.replyToComment',
    title: 'Reply to a comment',
    description: 'Reply to the comment thread on a cell (or of a comment’s id); replies Hermes writes are signed Hermes. Replies stay out of the undo history: sheets.deleteComment takes one off.',
    tier: 'act',
    args: [workbook, ...thread, { name: 'text', type: 'string', description: 'The reply', required: true }, sheet],
    run: depth('replyToComment')
  },
  {
    id: 'sheets.resolveComment',
    title: 'Resolve a comment',
    description: 'Mark the comment thread on a cell (or of a comment’s id) resolved, or with resolved=false open it again (not a step to undo: comments stay out of the undo history).',
    tier: 'act',
    args: [workbook, ...thread, { name: 'resolved', type: 'boolean', description: 'Resolved (true, the default) or open again (false)' }, sheet],
    run: depth('resolveComment')
  },
  {
    id: 'sheets.deleteComment',
    title: 'Delete a comment',
    description: 'Delete the comment thread on a cell with its replies, or one reply by its id. Comments stay out of the undo history, so this cannot be undone.',
    tier: 'mutate',
    args: [workbook, ...thread, sheet],
    run: depth('deleteComment')
  },
  {
    id: 'sheets.listNotes',
    title: 'List the notes',
    description: 'The notes on cells in a workbook, or on one sheet: each one’s cell, text, author and whether it shows all the time.',
    tier: 'read',
    args: [workbook, { name: 'sheet', type: 'string', description: 'Only this sheet; every sheet when left out' }],
    run: depth('listNotes')
  },
  {
    id: 'sheets.setNote',
    title: 'Write a note on a cell',
    description: 'Write a cell’s note, in place of the note it had, as one step to undo; a note Hermes starts is signed Hermes. A cell holds a note or a comment, as in Excel.',
    tier: 'act',
    args: [workbook, cell, { name: 'text', type: 'string', description: 'The note', required: true }, sheet],
    run: depth('setNote')
  },
  {
    id: 'sheets.removeNote',
    title: 'Remove a note',
    description: 'Take a cell’s note off (one step to undo in an open workbook).',
    tier: 'mutate',
    args: [workbook, cell, sheet],
    run: depth('removeNote')
  }
]
