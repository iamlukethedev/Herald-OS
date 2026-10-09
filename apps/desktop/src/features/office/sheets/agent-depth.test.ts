import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SystemInfo } from '../../../../shared/ipc.ts'
import { newSheet, newWorkbook, type WorkbookSnapshot } from '../../../../shared/office/workbook.ts'
import { workbookFromXlsx } from '../../../../shared/office/xlsx/read.ts'
import { xlsxFromWorkbook } from '../../../../shared/office/xlsx/write.ts'
import { sheetsDepthCommands } from '../../../commands/sheets-depth.ts'
import { COMMAND_ID, type CommandSource } from '../../../store/os-commands.ts'
import { $systemInfo } from '../../../store/system.ts'
import { sheetsAdapter } from './adapter.ts'
import { cleanOn, DEPTH, type DepthCommand, type DepthWork, editOn, HERMES_AUTHOR, sortOn } from './agent-depth.ts'
import { isDepthEdit, sheetEditsOf } from './agent-model.ts'
import { withHeadlessSheets } from './headless.ts'
import { changeFile, type FileAccess } from './live.ts'
import { getValidation, listCharts, listComments, listNames, listNotes, oneStep, readRange, type SheetsTarget, writeRange } from './model.ts'
import { changeAndUndo, matrixOf, salesBook, type Value } from './tools/fixtures.ts'

/** A workbook whose first sheet holds `rows` from A1, and an empty "Notes" sheet. */
const book = (rows: Value[][], name = 'Data'): WorkbookSnapshot => newWorkbook('book', 'Book', [newSheet('s1', name, matrixOf(rows)), newSheet('s2', 'Notes')])

/** A command's work on a workbook, as Hermes runs it unless another source is given. */
const run = async (on: SheetsTarget, command: DepthCommand, args: Record<string, unknown>, source: CommandSource = 'agent') => (DEPTH[command] as DepthWork).run(on, args, source)

const headless = <T>(snapshot: WorkbookSnapshot, work: (on: SheetsTarget) => Promise<T>) => withHeadlessSheets(snapshot, ({ univer, workbook }) => work({ univer, workbook })).then(({ result }) => result)

const MONTHLY: Value[][] = [
  ['Month', 'Revenue', 'Costs'],
  ['Jan', 1000, 600],
  ['Feb', 1100, 640],
  ['Mar', 1250, 700],
  ['Apr', 1180, 690]
]

const PEOPLE: Value[][] = [
  ['Name', 'City', 'Amount'],
  ['Jane', 'London', 10],
  ['Sam', 'New York', 20],
  ['jane', 'london', 10],
  ['Lee', 'London', 30],
  ['Jane', 'London', 10]
]

const REMOVALS = ['sheets.removeChart', 'sheets.deleteName', 'sheets.clearValidation', 'sheets.deleteComment', 'sheets.removeNote']

describe('the commands', () => {
  it('each run a work of their own, read without changing, and ask before removing what the person made', () => {
    expect(sheetsDepthCommands.map((command) => command.id)).toEqual(Object.keys(DEPTH).map((name) => `sheets.${name}`))

    for (const command of sheetsDepthCommands) {
      const work: DepthWork = DEPTH[command.id.slice('sheets.'.length) as DepthCommand]

      expect(COMMAND_ID.test(command.id)).toBe(true)
      expect(command.tier, command.id).toBe(!work.change && !work.view ? 'read' : REMOVALS.includes(command.id) ? 'mutate' : 'act')
      expect(command.args.filter((arg) => !arg.required && arg.enum)).toEqual([])
      expect(new Set(command.args.map((arg) => arg.name)).size).toBe(command.args.length)
    }
  })
})

describe('charts', () => {
  it('recommends, inserts, lists, describes, changes, moves and removes a chart, each change one step to undo', async () => {
    const result = await headless(book(MONTHLY, 'Sales'), async (on) => {
      const recommended = await run(on, 'recommendCharts', { range: 'A1' })
      const inserted = await run(on, 'insertChart', { range: 'A1:C5', kind: 'line', title: 'Revenue and costs', legend: 'bottom' })
      const id = String(inserted.data.chart)
      const listed = await run(on, 'listCharts', {})
      const described = await run(on, 'describeChart', { chart: id })
      const updated = await run(on, 'updateChart', { chart: '1', kind: 'column', title: 'none', axes: '{"y": {"min": 0, "title": "AUD"}}', palette: '#4472c4, #ed7d31' })
      const same = await run(on, 'updateChart', { chart: id, kind: 'column' })
      const moved = await run(on, 'moveChart', { chart: id, at: 'H2', width: 600 })
      const removed = await run(on, 'removeChart', { chart: id })
      const after = await run(on, 'listCharts', { sheet: 'Sales' })
      on.workbook.undo()

      return { id, recommended, inserted, listed, described, updated, same, moved, removed, after, back: listCharts(on) }
    })

    expect(result.recommended.said).toMatch(/^A1 suits an? [a-z]+ chart best/)
    expect(result.recommended.data.recommendations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: expect.any(String), reason: expect.any(String) })]))
    expect(result.inserted.said).toMatch(new RegExp(`^inserted a line chart “Revenue and costs” \\(${result.id}\\) of 2 series at Sales![A-Z]+\\d+$`))
    expect(result.listed).toMatchObject({ said: '1 chart', data: { charts: [{ chart: result.id, kind: 'line', title: 'Revenue and costs', sheet: 'Sales', series: 2 }] } })
    expect(result.described.data).toMatchObject({ kind: 'line', legend: 'bottom', series: [{ name: 'Revenue' }, { name: 'Costs' }] })
    expect(result.updated.said).toBe(`changed ${result.id}: now a column chart of 2 series`)
    expect(result.updated.data).toMatchObject({ kind: 'column', title: '', axes: { y: { min: 0, title: 'AUD' } }, palette: ['#4472c4', '#ed7d31'] })
    expect(result.same.said).toBe(`${result.id} is already as asked`)
    expect(result.moved).toMatchObject({ said: `moved ${result.id} to Sales!H2, 600×288 pixels`, data: { at: 'H2', size: { width: 600, height: 288 } } })
    expect(result.removed.said).toBe(`removed ${result.id} (a column chart) from Sales`)
    expect(result.after.said).toBe('no charts on Sales')
    expect(result.back.map((chart) => chart.chart)).toEqual([result.id])
  })

  it('says what to give instead', async () => {
    await headless(book(MONTHLY, 'Sales'), async (on) => {
      await expect(run(on, 'describeChart', { chart: 'chart-none' })).rejects.toThrow(/no charts yet: insertChart makes one/)
      await expect(run(on, 'insertChart', { range: 'A1:C5', kind: 'radar' })).rejects.toThrow(/kind is one of column, bar, line/)
      await expect(run(on, 'insertChart', { range: 'A1:C5', series: 'B2:B5' })).rejects.toThrow(/series is a list/)
    })
  })
})

describe('summaries', () => {
  it('previews a summary, makes it in live formulas, lists it, and refreshes it for a label the data gained', async () => {
    const result = await headless(salesBook(), async (on) => {
      const preview = await run(on, 'summarize', { range: 'A1', rowFields: 'Region', valueFields: '[{"field": "Amount", "fn": "sum"}]', preview: true })
      const sheets = on.workbook.getSheets().length
      const made = await run(on, 'summarize', { range: 'Sales!A1', rowFields: '["Region"]', columnFields: 'Quarter', valueFields: 'Amount' })
      const listed = await run(on, 'listSummaries', {})
      await writeRange(on, { range: 'Sales!A12:D12', values: [['South', 'Apples', 'Q1', 50]] })
      on.workbook.setActiveSheet(on.workbook.getSheetByName('Sales')!)
      const refreshed = await run(on, 'refreshSummary', {})

      return { preview, sheets, made, listed, refreshed, formulas: readRange(on, { range: String(made.data.range), sheet: 'Summary' }).formulas?.flat() ?? [] }
    })
    const rows = Number(result.made.data.rows)

    expect(result.preview.said).toMatch(/^a summary of Sales!A1:D11 would take a new sheet, Summary!A1:[A-Z]+\d+: Sum of Amount for \d+ row labels \(nothing changed\)$/)
    expect(result.preview.data.shape).toEqual(expect.arrayContaining([expect.arrayContaining(['Grand total'])]))
    expect(result.sheets).toBe(2)
    expect(result.made.said).toMatch(/^summarized Sales!A1:D11 as summary-1 at a new sheet, Summary!A1:[A-Z]+\d+: Sum of Amount for \d+ row labels and 2 column labels$/)
    expect(result.listed).toMatchObject({ said: '1 summary', data: { summaries: [{ sheet: 'Summary', id: 'summary-1', source: 'Sales!A1:D11', rows: ['Region'], columns: ['Quarter'], values: ['Sum of Amount'] }] } })
    expect(result.refreshed.said).toBe(`refreshed summary-1 (${rows + 1} row labels, ${rows} before) on Summary`)
    expect(result.formulas.some((formula) => /^=?SUMIFS\(/i.test(formula ?? ''))).toBe(true)
  })
})

describe('data tools', () => {
  it('removes duplicate rows by the columns given, after a preview that changes nothing', async () => {
    const preview = await changeAndUndo(book(PEOPLE), (on) => run(on, 'removeDuplicates', { range: 'A1:C6', preview: true }))
    const done = await changeAndUndo(book(PEOPLE), async (on) => ({ done: await run(on, 'removeDuplicates', { range: 'B2', by: 'City' }), read: readRange(on, { range: 'A1:C6' }).values }))

    expect(preview.unchanged).toBe(true)
    expect(preview.value.said).toBe('2 rows repeat an earlier one in Data!A1:C6 (nothing changed)')
    expect(done.value.done.said).toBe('removed 3 duplicate rows from Data!A1:C6, keeping 2 rows')
    expect(done.value.read).toEqual([['Name', 'City', 'Amount'], ['Jane', 'London', 10], ['Sam', 'New York', 20], [null, null, null], [null, null, null], [null, null, null]])
    expect(done.undone).toBe(true)
  })

  it('splits a column at a delimiter into the columns to its right, keeping a header row as it is, or into other cells', async () => {
    const comma = await changeAndUndo(book([['First, last'], ['Doe, Jane'], ['Roe, Sam']]), async (on) => ({ done: await run(on, 'splitText', { range: 'A1:A3', delimiter: 'comma', header: true }), read: readRange(on, { range: 'A1:B3' }).values }))
    const pipe = await changeAndUndo(book([['a|b'], ['c|d']]), async (on) => ({ done: await run(on, 'splitText', { range: 'A1:A2', delimiter: 'pipe', destination: 'D1' }), read: readRange(on, { range: 'A1:E2' }).values }))

    expect(comma.value.done.said).toBe('split 2 cells of A1:A3 into 2 columns at Data!A1:B3')
    expect(comma.value.read).toEqual([['First, last', null], ['Doe', 'Jane'], ['Roe', 'Sam']])
    expect(comma.undone).toBe(true)
    expect(pipe.value.done.said).toBe('split 2 cells of A1:A2 into 2 columns at Data!D1:E2')
    expect(pipe.value.read).toEqual([['a|b', null, null, 'a', 'b'], ['c|d', null, null, 'c', 'd']])
  })

  it('trims text and changes its case, leaving numbers and formulas alone', async () => {
    const trimmed = await changeAndUndo(book([['  Jane  Doe '], ['Sam'], [42], ['=A2']]), (on) => run(on, 'trimText', { range: 'A1:A4' }))
    const cased = await changeAndUndo(book([['new york'], ['MARY-JANE o’neil'], [7]]), async (on) => ({ done: await run(on, 'changeCase', { range: 'A1:A3', case: 'title' }), read: readRange(on, { range: 'A1:A3' }).values }))

    expect(trimmed.value.said).toBe('trimmed 1 cell of Data!A1:A4')
    expect(cased.value.done.said).toBe('put 2 cells of Data!A1:A3 in title case')
    expect(cased.value.read).toEqual([['New York'], ['Mary-Jane O’neil'], [7]])
    await headless(book([['a']]), async (on) => expect(run(on, 'changeCase', { range: 'A1', case: 'sponge' })).rejects.toThrow('case is upper, lower, title, sentence, not “sponge”'))
  })

  it('turns numbers and dates kept as text into numbers and dates, the day first as the data shows', async () => {
    const numbers = await changeAndUndo(book([['Amount'], ['$1,200.50'], ['(300)'], ['12%'], ['soon']]), async (on) => ({ done: await run(on, 'convertToNumbers', { range: 'A2:A5' }), read: readRange(on, { range: 'A2:A5' }).values }))
    const dates = await changeAndUndo(book([['13/02/2025'], ['04/03/2025'], ['n/a']]), async (on) => ({ done: await run(on, 'convertToDates', { range: 'A1:A3' }), read: readRange(on, { range: 'A1:A3' }) }))
    const preview = await changeAndUndo(book([['13/02/2025'], ['04/03/2025'], ['n/a']]), (on) => run(on, 'convertToDates', { range: 'A1:A3', order: 'mdy', dateFormat: 'dd/mm/yyyy', preview: true }))

    expect(numbers.value.done.said).toBe('turned 3 cells of Data!A2:A5 into numbers; 1 text cell does not read as a number (A5)')
    expect(numbers.value.read).toEqual([[1200.5], [-300], [0.12], ['soon']])
    expect(dates.value.done.said).toBe('turned 2 cells of Data!A1:A3 into dates, read day first; 1 text cell does not read as a date (A3)')
    expect(dates.value.read.values).toEqual([[45701], [45720], ['n/a']])
    expect(dates.value.read.text).toEqual([['2025-02-13'], ['2025-03-04'], ['n/a']])
    expect(preview.unchanged).toBe(true)
    expect(preview.value.said).toBe('1 cell of Data!A1:A3 would become dates, read month first; 2 text cells do not read as a date (A1, A3) (nothing changed)')
    await headless(book([['1/2/2025']]), async (on) => expect(run(on, 'convertToDates', { range: 'A1', dateFormat: 'General' })).rejects.toThrow(/dateFormat is a date format like yyyy-mm-dd/))
  })

  it('fills empty cells down, highlights duplicates and takes the highlight off, and sorts by several columns', async () => {
    const filled = await changeAndUndo(book([['Region', 'Amount'], ['East', 10], [null, 20], [null, 30], ['West', 40], [null, 50]]), async (on) => ({ done: await run(on, 'fillDown', { range: 'A1:B6' }), read: readRange(on, { range: 'A1:A6' }).values }))
    const highlight = await headless(book(PEOPLE), async (on) => {
      const lit = await run(on, 'highlightDuplicates', { range: 'B2:B6' })
      const rules = on.workbook.getActiveSheet().getConditionalFormattingRules().length
      const cleared = await run(on, 'highlightDuplicates', { range: 'B2:B6', clear: true })

      return { lit, rules, cleared, left: on.workbook.getActiveSheet().getConditionalFormattingRules().length }
    })
    const team: Value[][] = [['Name', 'City', 'Amount'], ['Jane', 'Paris', 10], ['Sam', 'Rome', 20], ['Lee', 'Paris', 30], ['Kim', 'Oslo', 5]]
    const sorted = await changeAndUndo(book(team), async (on) => ({ done: await run(on, 'sortBy', { range: 'A1', keys: 'City, Amount desc' }), read: readRange(on, { range: 'A1:A5' }).values }))

    expect(filled.value.done.said).toBe('filled 3 empty cells of Data!A1:B6 from the cells above')
    expect(filled.value.read).toEqual([['Region'], ['East'], ['East'], ['East'], ['West'], ['West']])
    expect(highlight.lit.said).toBe('highlighted 4 cells of Data!B2:B6 whose value repeats')
    expect([highlight.rules, highlight.left]).toEqual([1, 0])
    expect(highlight.cleared.said).toBe('took the duplicate highlight off Data!B2:B6')
    expect(sorted.value.done.said).toBe('sorted Data!A2:C5 by B ascending, then C descending, under its header row')
    expect(sorted.value.read).toEqual([['Name'], ['Kim'], ['Lee'], ['Jane'], ['Sam']])
    expect(sorted.undone).toBe(true)
  })
})

describe('names and validation', () => {
  it('creates, lists, changes, goes to and removes names', async () => {
    const result = await headless(book(MONTHLY, 'Sales'), async (on) => {
      const created = await run(on, 'createName', { name: 'Revenue', refersTo: 'B2:B5', comment: 'Monthly revenue' })
      const rate = await run(on, 'createName', { name: 'TaxRate', refersTo: '=0.1', scope: 'Notes' })
      const listed = await run(on, 'listNames', {})
      const renamed = await run(on, 'updateName', { name: 'Revenue', newName: 'Income', comment: 'none' })
      const went = await run(on, 'goToName', { name: 'Income' })
      const removed = await run(on, 'deleteName', { name: 'TaxRate' })

      return { created, rate, listed, renamed, went, removed, left: listNames(on).map((entry) => entry.name) }
    })

    expect(result.created.said).toBe('created the name Revenue for =Sales!$B$2:$B$5')
    expect(result.rate.said).toBe('created the name TaxRate for =0.1, seen on Notes')
    expect(result.listed).toMatchObject({ said: '2 names', data: { names: [{ name: 'Revenue', scope: 'workbook', comment: 'Monthly revenue' }, { name: 'TaxRate', scope: 'Notes' }] } })
    expect(result.renamed).toMatchObject({ said: 'renamed Revenue Income: it stands for =Sales!$B$2:$B$5', data: { name: 'Income', comment: '' } })
    expect(result.went).toMatchObject({ said: 'selected Income, Sales!B2:B5', data: { sheet: 'Sales', range: 'B2:B5' } })
    expect(result.removed.said).toBe('removed the name TaxRate (it stood for =0.1); formulas that use it show #NAME?')
    expect(result.left).toEqual(['Income'])
  })

  it('sets a dropdown list with its messages, reads it, and takes it off', async () => {
    const result = await headless(book(MONTHLY, 'Sales'), async (on) => {
      const set = await run(on, 'setValidation', { range: 'D2:D5', rule: '{"type": "list", "items": ["Yes", "No"]}', input: '{"title": "Paid", "message": "Yes or No"}', alert: '{"style": "warning", "message": "Yes or No only"}' })
      const read = await run(on, 'getValidation', { range: 'D3' })
      const quiet = await run(on, 'setValidation', { range: 'E2:E5', rule: { type: 'whole', operator: 'between', min: 1, max: 10 }, input: 'From 1 to 10', alert: 'none' })
      const cleared = await run(on, 'clearValidation', { range: 'D2:D5' })

      return { set, read, quiet, cleared, after: await run(on, 'getValidation', { range: 'D2:D5' }) }
    })

    expect(result.set.said).toBe('set a dropdown list on Sales!D2:D5')
    expect(result.read).toMatchObject({ said: '1 rule covers Sales!D3', data: { rules: [{ range: 'D2:D5', rule: { type: 'list', items: ['Yes', 'No'] }, allowBlank: true, dropdown: true, input: { title: 'Paid', message: 'Yes or No' }, error: { style: 'warning', message: 'Yes or No only' } }] } })
    expect(result.quiet).toMatchObject({ said: 'set a whole-number rule on Sales!E2:E5', data: { rules: [{ input: { title: '', message: 'From 1 to 10' }, error: null }] } })
    expect(result.cleared.said).toBe('took 1 rule off Sales!D2:D5')
    expect(result.after.said).toBe('no rule covers Sales!D2:D5')
  })
})

describe('comments and notes', () => {
  beforeEach(() => $systemInfo.set({ fullName: 'Pat Example', userName: 'pat' } as SystemInfo))
  afterEach(() => $systemInfo.set(null))

  it('signs what Hermes writes Hermes, and what comes from anywhere else with the person’s name', async () => {
    const result = await headless(book(MONTHLY, 'Sales'), async (on) => {
      const added = await run(on, 'addComment', { cell: 'B2', text: 'Is January right?' })
      const reply = await run(on, 'replyToComment', { commentId: String(added.data.id), text: 'Yes, from the bank.' }, 'palette')
      await run(on, 'addComment', { cell: 'C3', text: 'Costs went up' }, 'voice')
      await run(on, 'replyToComment', { cell: 'C3', text: 'Noted' })
      const resolved = await run(on, 'resolveComment', { cell: 'B2' })
      const listed = await run(on, 'listComments', {})
      const reopened = await run(on, 'resolveComment', { commentId: String(added.data.id), resolved: false })
      const unreplied = await run(on, 'deleteComment', { commentId: String(reply.data.id) })
      const deleted = await run(on, 'deleteComment', { cell: 'C3' })
      const note = await run(on, 'setNote', { cell: 'A5', text: 'Estimate' })
      await run(on, 'setNote', { cell: 'A4', text: 'From the bank' }, 'cli')
      const edited = await run(on, 'setNote', { cell: 'A4', text: 'From the bank statement' })
      const notes = await run(on, 'listNotes', {})
      const removed = await run(on, 'removeNote', { cell: 'A5' })

      return { added, resolved, listed, reopened, unreplied, deleted, note, edited, notes, removed, comments: listComments(on), notesLeft: listNotes(on) }
    })

    expect(result.added).toMatchObject({ said: 'added a comment to Sales!B2 as Hermes', data: { sheet: 'Sales', cell: 'B2', author: HERMES_AUTHOR.name } })
    expect(result.resolved.said).toBe('resolved the comment on Sales!B2')
    expect(result.listed).toMatchObject({
      said: '2 comment threads (1 resolved)',
      data: {
        comments: [
          { cell: 'B2', author: 'Hermes', text: 'Is January right?', resolved: true, replies: [{ author: 'Pat Example', text: 'Yes, from the bank.' }] },
          { cell: 'C3', author: 'Pat Example', resolved: false, replies: [{ author: 'Hermes', text: 'Noted' }] }
        ]
      }
    })
    expect(result.reopened.said).toBe('opened again the comment on Sales!B2')
    expect(result.unreplied.said).toBe('deleted a reply to the comment on Sales!B2')
    expect(result.deleted.said).toBe('deleted the comment on Sales!C3 with its replies')
    expect(result.comments).toMatchObject([{ cell: 'B2', author: 'Hermes', resolved: false, replies: [] }])
    expect(result.note).toMatchObject({ said: 'wrote the note on Sales!A5', data: { author: 'Hermes', text: 'Estimate' } })
    expect(result.edited.data).toMatchObject({ cell: 'A4', author: 'Pat Example', text: 'From the bank statement' })
    expect(result.notes.said).toBe('2 notes')
    expect(result.removed.said).toBe('removed the note on Sales!A5')
    expect(result.notesLeft.map((entry) => [entry.cell, entry.author])).toEqual([['A4', 'Pat Example']])
  })
})

describe('a batch of edits', () => {
  it('makes charts, names, validation, notes and data changes as one step to undo, and comments, which stay out of the undo history', async () => {
    const edits = sheetEditsOf([
      { op: 'insertChart', range: 'A1:C5', kind: 'column' },
      { op: 'createName', name: 'Revenue', refersTo: 'B2:B5' },
      { op: 'setValidation', range: 'D2:D5', rule: { type: 'list', items: ['Yes', 'No'] } },
      { op: 'addComment', cell: 'B3', text: 'Check February' },
      { op: 'setNote', cell: 'C2', text: 'Estimate' },
      { op: 'changeCase', range: 'A2:A5', case: 'upper' }
    ])
    const result = await headless(book(MONTHLY, 'Sales'), async (on) => {
      const said = await oneStep(on, async () => {
        const done: string[] = []

        for (const edit of edits) {
          if (isDepthEdit(edit)) {
            done.push(await editOn(on, edit, 'agent'))
          }
        }

        return done
      })
      const state = () => ({ charts: listCharts(on).length, names: listNames(on).length, rules: getValidation(on, { range: 'D2:D5' }).rules.length, comments: listComments(on).map((comment) => comment.author), notes: listNotes(on).map((note) => note.author), months: readRange(on, { range: 'A2:A3' }).values })
      const made = state()
      on.workbook.undo()

      return { said, made, undone: state() }
    })

    expect(result.said[0]).toMatch(/^inserted a column chart/)
    expect(result.said.slice(1)).toEqual(['created the name Revenue for =Sales!$B$2:$B$5', 'set a dropdown list on Sales!D2:D5', 'added a comment to Sales!B3 as Hermes', 'wrote the note on Sales!C2', 'put 4 cells of Sales!A2:A5 in upper case'])
    expect(result.made).toEqual({ charts: 1, names: 1, rules: 1, comments: ['Hermes'], notes: ['Hermes'], months: [['JAN'], ['FEB']] })
    expect(result.undone).toEqual({ charts: 0, names: 0, rules: 0, comments: ['Hermes'], notes: [], months: [['Jan'], ['Feb']] })
  })
})

describe('a file that is not open', () => {
  it('gets a chart and a comment signed Hermes, written back to it', async () => {
    const files: Record<string, Uint8Array> = { '/tmp/sales.xlsx': (await xlsxFromWorkbook(book(MONTHLY, 'Sales'))).bytes }
    const io: FileAccess = {
      read: async (path) => ({ bytes: files[path] }),
      write: async (path, bytes) => {
        files[path] = bytes
      }
    }
    await changeFile('/tmp/sales.xlsx', async (on) => {
      await run(on, 'insertChart', { range: 'A1:C5', kind: 'line' })
      await run(on, 'addComment', { cell: 'B2', text: 'Check' })
    }, sheetsAdapter, io)
    const { workbook } = await workbookFromXlsx(files['/tmp/sales.xlsx'], { id: 'again', name: 'sales' })
    const result = await headless(workbook, async (on) => ({ charts: listCharts(on), comments: listComments(on) }))

    expect(result.charts).toMatchObject([{ kind: 'line', sheet: 'Sales', series: 2 }])
    expect(result.comments).toMatchObject([{ cell: 'B2', author: 'Hermes', text: 'Check' }])
  })
})

describe('sheets.clean and sheets.sort, on the data tools', () => {
  const BUDGET: Value[][] = [
    ['Item', 'Cost', 'Paid'],
    ['Rent', 1200, 'yes'],
    ['Food', 310.5, 'no'],
    ['Bus', 60, 'yes']
  ]

  it('sorts under a header by a column named by its header, in one step', async () => {
    const result = await changeAndUndo(book(BUDGET, 'Budget'), async (on) => ({ sorted: await sortOn(on, { by: 'Cost', header: true, ascending: false }, 'A1:C4'), read: readRange(on, { range: 'A1:A4' }).values }))

    expect(result.value.sorted).toEqual({ sheet: 'Budget', range: 'A2:C4', column: 'B', ascending: false, header: true })
    expect(result.value.read).toEqual([['Item'], ['Rent'], ['Food'], ['Bus']])
    expect(result.undone).toBe(true)
  })

  it('sorts a range that does not start in column A by the column named, its header kept when by names it', async () => {
    const told = await changeAndUndo(book(BUDGET, 'Budget'), async (on) => {
      await sortOn(on, { by: 'Cost', header: true }, 'B1:C4')

      return readRange(on, { range: 'B1:B4' }).values
    })
    const named = await changeAndUndo(book(BUDGET, 'Budget'), async (on) => ({ sorted: await sortOn(on, { by: 'Cost' }, 'B1:C4'), read: readRange(on, { range: 'B1:B4' }).values }))

    expect(told.value).toEqual([['Cost'], [60], [310.5], [1200]])
    expect(named.value).toEqual({ sorted: { sheet: 'Budget', range: 'B2:C4', column: 'B', ascending: true, header: true }, read: [['Cost'], [60], [310.5], [1200]] })
  })

  it('sorts every row by a letter or a number when no header is given', async () => {
    const result = await changeAndUndo(book([['Zoe', 3], ['Adam', 1], ['Bob', 2]]), async (on) => ({ byLetter: await sortOn(on, { by: 'A' }, 'A1:B3'), first: readRange(on, { range: 'A1:A3' }).values, byNumber: await sortOn(on, { by: '2', ascending: 'descending' }, 'A1:B3'), second: readRange(on, { range: 'A1:A3' }).values }))

    expect(result.value.byLetter).toEqual({ sheet: 'Data', range: 'A1:B3', column: 'A', ascending: true, header: false })
    expect(result.value.first).toEqual([['Adam'], ['Bob'], ['Zoe']])
    expect(result.value.byNumber).toMatchObject({ column: 'B', ascending: false, header: false })
    expect(result.value.second).toEqual([['Zoe'], ['Bob'], ['Adam']])
  })

  it('removes repeated rows by every column or by some, keeping the header, and moves formulas with their rows', async () => {
    const rows: Value[][] = [['Name', 'Email'], ['Sam', 'sam@x.io'], ['sam', 'SAM@x.io'], ['Ana', 'ana@x.io'], ['Sam', 'other@x.io']]
    const all = await changeAndUndo(book(rows), async (on) => ({ done: await cleanOn(on, { action: 'dedupe', header: true }, 'A1:B5'), read: readRange(on, { range: 'A1:B5' }).values }))
    const byName = await changeAndUndo(book(rows), (on) => cleanOn(on, { action: 'Remove duplicates', by: 'Name' }, 'A1:B5'))
    const formulas = await changeAndUndo(book([['Item', 'Cost', 'Tax'], ['Rent', 100, '=B2*0.1'], ['Rent', 100, '=B3*0.1'], ['Food', 40, '=B4*0.1']]), async (on) => {
      await cleanOn(on, { action: 'dedupe', by: 'A', header: true }, 'A1:C4')

      return readRange(on, { range: 'C2:C3' }).formulas
    })

    expect(all.value.done).toEqual({ sheet: 'Data', range: 'A1:B5', action: 'dedupe', changed: 1, detail: '1 duplicate row removed' })
    expect(all.value.read).toEqual([['Name', 'Email'], ['Sam', 'sam@x.io'], ['Ana', 'ana@x.io'], ['Sam', 'other@x.io'], [null, null]])
    expect(all.undone).toBe(true)
    expect(byName.value).toMatchObject({ changed: 2, detail: '2 duplicate rows removed' })
    expect(formulas.value).toEqual([['=B2*0.1'], ['=B3*0.1']])
  })

  it('trims spaces, changes case and reads numbers kept as text', async () => {
    const trimmed = await changeAndUndo(book([['  a  b ', 3, '\u00a0c']]), async (on) => ({ done: await cleanOn(on, { action: 'trim' }, 'A1:C1'), read: readRange(on, { range: 'A1:C1' }).values }))
    const cased = await changeAndUndo(book([['new york', 'MARY-JANE o’neil']]), async (on) => ({ done: await cleanOn(on, { action: 'case' }, 'A1:B1'), read: readRange(on, { range: 'A1:B1' }).values }))
    const upper = await changeAndUndo(book([['abc']]), async (on) => ({ done: await cleanOn(on, { action: 'case', case: 'upper' }, 'A1'), read: readRange(on, { range: 'A1' }).values }))
    const numbers = await changeAndUndo(book([['1,200', 'x', 4, '$5.50', '(300)', '12%']]), async (on) => ({ done: await cleanOn(on, { action: 'numbers' }, 'A1:F1'), read: readRange(on, { range: 'A1:F1' }).values }))

    expect(trimmed.value).toEqual({ done: { sheet: 'Data', range: 'A1:C1', action: 'trim', changed: 2, detail: '2 cells changed' }, read: [['a b', 3, 'c']] })
    expect(cased.value).toMatchObject({ done: { action: 'case', changed: 2 }, read: [['New York', 'Mary-Jane O’neil']] })
    expect(upper.value.read).toEqual([['ABC']])
    expect(numbers.value).toMatchObject({ done: { action: 'numbers', changed: 4, detail: '4 cells changed' }, read: [[1200, 'x', 4, 5.5, -300, 0.12]] })
    await headless(book([['a']]), async (on) => expect(cleanOn(on, { action: 'case', case: 'sponge' }, 'A1')).rejects.toThrow(/case is upper, lower, title, sentence/))
  })

  it('reads dates kept as text, day or month first as the data shows or as told', async () => {
    const shown = await changeAndUndo(book([['Date'], ['13/02/2025'], ['04/03/2025'], ['n/a']]), async (on) => ({ done: await cleanOn(on, { action: 'dates' }, 'A1:A4'), read: readRange(on, { range: 'A2:A3' }) }))
    const told = await changeAndUndo(book([['03/04/2025'], ['2025-03-04']]), async (on) => ({ done: await cleanOn(on, { action: 'date', order: 'mdy', dateFormat: 'dd/mm/yyyy' }, 'A1:A2'), read: readRange(on, { range: 'A1:A2' }) }))

    expect(shown.value.done).toEqual({ sheet: 'Data', range: 'A1:A4', action: 'dates', changed: 2, detail: '2 dates read day first' })
    expect(shown.value.read.values).toEqual([[45701], [45720]])
    expect(shown.value.read.text).toEqual([['2025-02-13'], ['2025-03-04']])
    expect(told.value.done.detail).toBe('2 dates read month first')
    expect(told.value.read.text).toEqual([['04/03/2025'], ['04/03/2025']])
  })

  it('splits a column into the columns to its right, keeping a header, and writes over data only when told', async () => {
    const split = await changeAndUndo(book([['Full name'], ['Jane Doe'], ['Sam Lee Roe'], [7]]), async (on) => ({ done: await cleanOn(on, { action: 'split', delimiter: 'space', header: true }, 'A1:A4'), read: readRange(on, { range: 'A1:C4' }).values }))
    const blocked = await headless(book([['a,b', 'keep'], ['c,d', null]]), async (on) => {
      await expect(cleanOn(on, { action: 'split' }, 'A1:A2')).rejects.toThrow(/writes over a cell with data in A1:B2: give overwrite: true/)
      await cleanOn(on, { action: 'split', overwrite: true }, 'A1:A2')

      return readRange(on, { range: 'A1:B2' }).values
    })
    const nothing = await changeAndUndo(book([['abc'], ['def']]), (on) => cleanOn(on, { action: 'split', delimiter: ';' }, 'A1:A2'))

    expect(split.value.done).toEqual({ sheet: 'Data', range: 'A1:C4', action: 'split', changed: 2, detail: 'split into 3 columns' })
    expect(split.value.read).toEqual([['Full name', null, null], ['Jane', 'Doe', null], ['Sam', 'Lee', 'Roe'], [7, null, null]])
    expect(split.undone).toBe(true)
    expect(blocked).toEqual([['a', 'b'], ['c', 'd']])
    expect(nothing.value).toEqual({ sheet: 'Data', range: 'A1:A2', action: 'split', changed: 0, detail: 'nothing to split' })
    expect(nothing.unchanged).toBe(true)
  })
})
