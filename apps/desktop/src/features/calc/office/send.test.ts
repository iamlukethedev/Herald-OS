import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import type { OfficeDocSummary, OfficePresence } from '../../../../shared/ipc.ts'
import type { OfficeApp } from '../../../../shared/office/files.ts'
import type { SheetRow } from '../engine/sheets.ts'
import type { DocumentResult } from '../engine/types.ts'
import { toDocsMarkdown } from './docs-table.ts'
import { copyToDocs, copyToSheets, OPEN_TIMEOUT_MS, sheetFormats } from './send.ts'

const mocks = vi.hoisted(() => ({
  panels: false,
  rows: [] as SheetRow[],
  runCommand: vi.fn(),
  openInOffice: vi.fn(),
  openEntries: vi.fn(async (): Promise<{ app: string; name: string }[]> => [])
}))

vi.mock('../../../store/shell.ts', () => ({
  get isPanels() {
    return mocks.panels
  }
}))
vi.mock('../../../store/os-commands.ts', () => ({ runCommand: mocks.runCommand }))
vi.mock('../../office/open.ts', () => ({ openInOffice: mocks.openInOffice }))
vi.mock('../../office/agent.ts', () => ({ openEntries: mocks.openEntries }))
vi.mock('../engine/sheets.ts', () => ({ toSheetRows: () => mocks.rows }))

const ROWS: SheetRow[] = [
  { value: null, label: 'Budget', heading: true },
  { value: 1200, label: 'Rent', format: '#,##0.00' },
  { value: 80, label: 'Bills', format: '#,##0.00' },
  { value: '=A2+A3', label: 'Total', format: '#,##0.00' },
  { value: null, label: '' },
  { value: 0.15, label: 'Tip', format: '0.00%' },
  { value: null, label: 'Food', heading: true },
  { value: null, label: '' },
  { value: null, label: '  ' }
]

const VALUES = JSON.stringify([
  [null, 'Budget'],
  [1200, 'Rent'],
  [80, 'Bills'],
  ['=A2+A3', 'Total'],
  [null, ''],
  [0.15, 'Tip'],
  [null, 'Food']
])

const FORMATS = [
  { range: 'A2:A4', format: '{"numberFormat":"#,##0.00"}' },
  { range: 'A6', format: '{"numberFormat":"0.00%"}' },
  { range: 'A1:B1', format: '{"bold":true}' },
  { range: 'A7:B7', format: '{"bold":true}' }
]

const NOTE: DocumentResult = {
  lines: [
    { index: 0, kind: 'value', source: 'Flights: $1,200', display: '$1,200.00' },
    { index: 1, kind: 'value', source: 'Hotel: 4 nights × $180', display: '$720.00' }
  ],
  total: null,
  totalDisplay: '$1,920.00',
  usesRates: false,
  functions: []
}

const doc = (key: string, name: string, more: Partial<OfficeDocSummary> = {}): OfficeDocSummary => ({ key, name, path: null, format: '.xlsx', modified: false, ...more })
const officeWindow = (app: OfficeApp, documents: OfficeDocSummary[], active: string | null = documents[documents.length - 1]?.key ?? null): OfficePresence => ({ app, at: 1, active, documents })

let presence: OfficePresence[]
let errors: MockInstance<typeof console.error>
/** window.heraldOS.office as main answers it: what the Office windows report, and a command run in one. */
const office = {
  presence: vi.fn(async (): Promise<OfficePresence[]> => structuredClone(presence)),
  run: vi.fn(async (_target: { app: OfficeApp; key: string }, _command: string, _args: Record<string, unknown>, _source: string): Promise<unknown> => ({ ok: true, summary: 'Done' }))
}

/** The Office window `app` shows a new blank document once asked for one. */
function opensBlank(app: OfficeApp, blank: OfficeDocSummary) {
  mocks.openInOffice.mockImplementation((asked: OfficeApp) => {
    if (asked === app) {
      const own = presence.find(entry => entry.app === app)
      presence = [...presence.filter(entry => entry !== own), officeWindow(app, [...(own?.documents ?? []), blank], blank.key)]
    }
  })
}

beforeEach(() => {
  mocks.panels = false
  mocks.rows = ROWS
  presence = []
  mocks.runCommand.mockReset().mockImplementation(async (id: string, args: Record<string, unknown>) => (id.endsWith('.new') ? { ok: true, summary: 'Started', data: { name: args.name } } : { ok: true, summary: 'Done' }))
  mocks.openInOffice.mockReset()
  mocks.openEntries.mockReset().mockResolvedValue([])
  office.presence.mockReset().mockImplementation(async () => structuredClone(presence))
  office.run.mockReset().mockImplementation(async () => ({ ok: true, summary: 'Done' }))
  vi.stubGlobal('window', { heraldOS: { office } })
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  errors.mockRestore()
  vi.unstubAllGlobals()
})

describe('the formats a note’s rows carry', () => {
  it('are number formats down column A and bold heading rows, in as few ranges as they take', () => {
    expect(sheetFormats(ROWS).map(entry => ({ range: entry.range, format: JSON.stringify(entry.format) }))).toEqual(FORMATS)
    expect(sheetFormats([{ value: 1, label: '' }])).toEqual([])
  })
})

describe('Copy to Sheets in desktop mode', () => {
  it('starts the workbook with the rows, then formats it, and says how many lines went', async () => {
    expect(await copyToSheets(NOTE, 'Budget')).toBe('Copied 6 lines to a new workbook in Herald Sheets')

    expect(mocks.runCommand.mock.calls).toEqual([
      ['sheets.new', { name: 'Budget', values: VALUES }, { source: 'ui' }],
      ...FORMATS.map(entry => ['sheets.format', { workbook: 'Budget', ...entry }, { source: 'ui' }])
    ])
    expect(mocks.openInOffice).not.toHaveBeenCalled()
    expect(office.run).not.toHaveBeenCalled()
  })

  it('names the workbook so it is not taken for one already open', async () => {
    mocks.openEntries.mockResolvedValue([
      { app: 'sheets', name: 'Budget' },
      { app: 'sheets', name: 'budget 2' },
      { app: 'docs', name: 'Budget 3' }
    ])
    mocks.rows = [{ value: 1, label: 'One', format: '0' }]
    await copyToSheets(NOTE, '  Budget  ')

    expect(mocks.runCommand.mock.calls.map(([id, args]) => [id, args.name ?? args.workbook])).toEqual([
      ['sheets.new', 'Budget 3'],
      ['sheets.format', 'Budget 3']
    ])
  })

  it('formats the workbook by the name Herald Sheets gave it', async () => {
    mocks.runCommand.mockImplementation(async (id: string) => (id === 'sheets.new' ? { ok: true, summary: 'Started', data: { name: 'Trip/Japan' } } : { ok: true, summary: 'Done' }))
    mocks.rows = [{ value: 1, label: 'One', format: '0' }]
    await copyToSheets(NOTE, 'Trip/Japan')

    expect(mocks.runCommand.mock.calls[0][1].name).toBe('Trip-Japan')
    expect(mocks.runCommand.mock.calls[1][1].workbook).toBe('Trip/Japan')
  })

  it('keeps labels as text where Sheets would read a number or a formula', async () => {
    mocks.rows = [
      { value: 2024, label: '2024' },
      { value: 1, label: "'quoted" },
      { value: 2, label: '=not a formula' },
      { value: 3, label: '-5' },
      { value: 4, label: '=' },
      { value: 5, label: '12 months' }
    ]
    await copyToSheets(NOTE, 'Labels')

    expect(JSON.parse(String(mocks.runCommand.mock.calls[0][1].values))).toEqual([
      [2024, "'2024"],
      [1, "''quoted"],
      [2, ' =not a formula'],
      [3, "'-5"],
      [4, '='],
      [5, '12 months']
    ])
  })

  it('tells the person when there is nothing to copy, or too much', async () => {
    mocks.rows = []
    await expect(copyToSheets(NOTE, 'Empty')).rejects.toThrow('This note has nothing to copy yet')

    mocks.rows = [{ value: null, label: '' }, { value: '', label: ' ' }]
    await expect(copyToSheets(NOTE, 'Empty')).rejects.toThrow('This note has nothing to copy yet')

    mocks.rows = Array.from({ length: 5001 }, (_, index) => ({ value: index, label: '' }))
    await expect(copyToSheets(NOTE, 'Long')).rejects.toThrow('This note is too long for one workbook: Herald Sheets takes 5,000 lines at a time')

    expect(mocks.runCommand).not.toHaveBeenCalled()
  })

  it('throws what went wrong when Herald Sheets cannot start the workbook', async () => {
    mocks.runCommand.mockResolvedValue({ ok: false, summary: 'sheets.new: "values" must be rows', error: 'sheets.new: "values" must be rows' })

    await expect(copyToSheets(NOTE, 'Budget')).rejects.toThrow('Herald Sheets could not make the workbook: sheets.new: "values" must be rows')
  })

  it('keeps the copy when a format fails, logging it and trying no more', async () => {
    mocks.runCommand.mockImplementation(async (id: string, args: Record<string, unknown>) => (id === 'sheets.new' ? { ok: true, summary: 'Started', data: { name: args.name } } : { ok: false, summary: 'Bad format', error: 'Bad format' }))

    expect(await copyToSheets(NOTE, 'Budget')).toBe('Copied 6 lines to a new workbook in Herald Sheets')
    expect(mocks.runCommand).toHaveBeenCalledTimes(2)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('[herald-os] sheets.format failed: Error: Bad format'))
  })
})

describe('Copy to Sheets in panels mode', () => {
  beforeEach(() => {
    mocks.panels = true
    presence = [officeWindow('sheets', [doc('sheets-1', 'Budget.xlsx', { path: '/h/Budget.xlsx' })]), officeWindow('docs', [doc('docs-1', 'Untitled', { format: '.docx' })])]
  })

  it('opens a blank workbook in the Sheets window and has that window write and format it', async () => {
    opensBlank('sheets', doc('sheets-2', 'Untitled 2'))

    expect(await copyToSheets(NOTE, 'Budget')).toBe('Copied 6 lines to a new workbook in Herald Sheets')

    const target = { app: 'sheets', key: 'sheets-2' }
    expect(mocks.openInOffice).toHaveBeenCalledWith('sheets', { blank: true })
    expect(office.run.mock.calls).toEqual([
      [target, 'sheets.write', { workbook: 'Untitled 2', range: 'A1', values: VALUES }, 'ui'],
      ...FORMATS.map(entry => [target, 'sheets.format', { workbook: 'Untitled 2', ...entry }, 'ui'])
    ])
    expect(mocks.runCommand).not.toHaveBeenCalled()
  })

  it('waits for a window that is still starting', async () => {
    vi.useFakeTimers()
    let asked = 0
    office.presence.mockImplementation(async () => (++asked < 5 ? structuredClone(presence) : [officeWindow('sheets', [doc('sheets-1', 'Untitled')])]))
    presence = []
    const copying = copyToSheets(NOTE, 'Budget')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(await copying).toBe('Copied 6 lines to a new workbook in Herald Sheets')
    expect(office.run.mock.calls[0][0]).toEqual({ app: 'sheets', key: 'sheets-1' })
  })

  it('writes only into a new blank workbook, never a file opened meanwhile or one being typed in', async () => {
    mocks.openInOffice.mockImplementation(() => {
      presence = [officeWindow('sheets', [doc('sheets-1', 'Budget.xlsx', { path: '/h/Budget.xlsx' }), doc('sheets-2', 'Untitled 2', { modified: true }), doc('sheets-3', 'Untitled 3'), doc('sheets-4', 'Costs.xlsx', { path: '/h/Costs.xlsx' })], 'sheets-4')]
    })
    await copyToSheets(NOTE, 'Budget')

    expect(office.run.mock.calls.every(([target, , args]) => target.key === 'sheets-3' && args.workbook === 'Untitled 3')).toBe(true)
  })

  it('gives up when no new workbook shows up in time', async () => {
    vi.useFakeTimers()
    const copying = copyToSheets(NOTE, 'Budget')
    const failed = expect(copying).rejects.toThrow('Herald Sheets did not open a new workbook in time')
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS + 500)
    await failed

    expect(office.run).not.toHaveBeenCalled()
  })

  it('says so when Herald Office does not answer', async () => {
    office.presence.mockRejectedValueOnce(new Error('gone'))

    await expect(copyToSheets(NOTE, 'Budget')).rejects.toThrow('Herald Office is not answering; try again in a moment')
    expect(mocks.openInOffice).not.toHaveBeenCalled()
  })

  it('throws what the Sheets window answered when it could not write', async () => {
    opensBlank('sheets', doc('sheets-2', 'Untitled 2'))
    office.run.mockResolvedValueOnce({ ok: false, summary: 'No workbook called “Untitled 2” is open', error: 'No workbook called “Untitled 2” is open' })

    await expect(copyToSheets(NOTE, 'Budget')).rejects.toThrow('Herald Sheets could not write the note into Untitled 2: No workbook called “Untitled 2” is open')

    opensBlank('sheets', doc('sheets-3', 'Untitled 3'))
    office.run.mockRejectedValueOnce(new Error("Error invoking remote method 'herald-os:office:run': Error: The Herald Sheets window did not answer in time"))

    await expect(copyToSheets(NOTE, 'Budget')).rejects.toThrow('Herald Sheets could not write the note into Untitled 3: The Herald Sheets window did not answer in time')
  })

  it('keeps the copy when a format fails there', async () => {
    opensBlank('sheets', doc('sheets-2', 'Untitled 2'))
    office.run.mockImplementation(async (_target, command) => (command === 'sheets.format' ? { ok: false, summary: 'Bad format', error: 'Bad format' } : { ok: true, summary: 'Wrote' }))

    expect(await copyToSheets(NOTE, 'Budget')).toBe('Copied 6 lines to a new workbook in Herald Sheets')
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('[herald-os] sheets.format failed: Error: Bad format'))
  })
})

describe('Copy to Docs', () => {
  it('starts a document with the note as a table in desktop mode', async () => {
    mocks.openEntries.mockResolvedValue([{ app: 'docs', name: 'Trip - Japan' }])

    expect(await copyToDocs(NOTE, 'Trip / Japan')).toBe('Copied 2 lines to a new document in Herald Docs')
    expect(mocks.runCommand.mock.calls).toEqual([['docs.new', { name: 'Trip - Japan 2', content: toDocsMarkdown(NOTE, 'Trip / Japan') }, { source: 'ui' }]])
    expect(toDocsMarkdown(NOTE, 'Trip / Japan').startsWith('# Trip / Japan\n')).toBe(true)
  })

  it('opens a blank document in the Docs window and has it write the note there in panels mode', async () => {
    mocks.panels = true
    presence = [officeWindow('docs', [doc('docs-1', 'Letter.docx', { path: '/h/Letter.docx', format: '.docx' })])]
    opensBlank('docs', doc('docs-2', 'Untitled', { format: '.docx' }))

    expect(await copyToDocs(NOTE, 'Trip')).toBe('Copied 2 lines to a new document in Herald Docs')
    expect(mocks.openInOffice).toHaveBeenCalledWith('docs', { blank: true })
    expect(office.run.mock.calls).toEqual([[{ app: 'docs', key: 'docs-2' }, 'docs.write', { document: 'Untitled', content: toDocsMarkdown(NOTE, 'Trip') }, 'ui']])
    expect(mocks.runCommand).not.toHaveBeenCalled()
  })

  it('gives up in panels mode when no new document shows up in time', async () => {
    mocks.panels = true
    vi.useFakeTimers()
    const copying = copyToDocs(NOTE, 'Trip')
    const failed = expect(copying).rejects.toThrow('Herald Docs did not open a new document in time')
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS + 500)
    await failed
  })

  it('tells the person when there is nothing to copy, or what went wrong', async () => {
    await expect(copyToDocs({ ...NOTE, lines: [{ index: 0, kind: 'blank', source: '' }], totalDisplay: null }, 'Empty')).rejects.toThrow('This note has nothing to copy yet')
    expect(mocks.runCommand).not.toHaveBeenCalled()

    mocks.runCommand.mockResolvedValue({ ok: false, summary: 'Herald Docs is busy', error: 'Herald Docs is busy' })

    await expect(copyToDocs(NOTE, 'Trip')).rejects.toThrow('Herald Docs could not make the document: Herald Docs is busy')
  })
})
