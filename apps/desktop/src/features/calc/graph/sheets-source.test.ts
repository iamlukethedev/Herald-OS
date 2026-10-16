import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeEntry } from '../../office/agent-model.ts'
import { readSheetSeries, seriesFromCells } from './sheets-source.ts'

const mocks = vi.hoisted(() => ({
  main: true,
  entries: [] as OfficeEntry[],
  owned: [] as string[],
  runCommand: vi.fn(),
  run: vi.fn(),
  find: vi.fn()
}))

vi.mock('../../../store/os-commands.ts', () => ({ runCommand: mocks.runCommand }))

vi.mock('../../../store/shell.ts', () => ({
  get isMainSurface() {
    return mocks.main
  }
}))

vi.mock('../../office/agent.ts', () => ({ openEntries: async () => mocks.entries, resolve: (input: string) => input.replace(/^~/, '/Users/sam') }))

vi.mock('../../office/session.ts', () => ({ loadedSessions: new Map([['sheets', { summaries: () => mocks.owned.map(key => ({ key })) }]]) }))

const BUDGET: OfficeEntry = { app: 'sheets', key: 'sheets-1', name: 'Budget.xlsx', path: '/Users/sam/Budget.xlsx', format: '.xlsx', modified: false, active: true, front: true }

const COLUMN = [['Amount'], [1200], [null], [80.5], ['n/a'], [300]]

const answer = (values: unknown[][], name = 'Budget.xlsx') => ({ ok: true, summary: `${name}: Sheet1 (6×2)`, data: { name, path: `/Users/sam/${name}`, sheet: 'Sheet1', range: 'B1:B6', values } })

const file = (path: string, kind: 'file' | 'directory' = 'file') => ({ path, name: path.split('/').pop()!, extension: path.slice(path.lastIndexOf('.')).toLowerCase(), size: 1, modifiedAt: 0, lastUsedAt: 0, kind })

beforeEach(() => {
  mocks.main = true
  mocks.entries = []
  mocks.owned = []
  mocks.runCommand.mockReset()
  mocks.run.mockReset()
  mocks.find.mockReset()
  vi.stubGlobal('window', { heraldOS: { office: { run: mocks.run }, fs: { find: mocks.find } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('reading a sheet to plot', () => {
  it('reads a workbook open here through Herald Sheets’ command, numbers only, the header as its name', async () => {
    mocks.entries = [BUDGET]
    mocks.runCommand.mockResolvedValue(answer(COLUMN))

    expect(await readSheetSeries({ workbook: 'Budget.xlsx', range: 'B:B' })).toEqual({
      label: 'Budget.xlsx · Amount',
      points: [
        [1, 1200],
        [2, 80.5],
        [3, 300]
      ]
    })
    expect(mocks.runCommand).toHaveBeenCalledWith('sheets.read', { workbook: '/Users/sam/Budget.xlsx', range: 'B:B', formulas: false }, { source: 'ui' })
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.find).not.toHaveBeenCalled()
  })

  it('asks Herald Sheets’ own window when the workbook is open there (panels mode)', async () => {
    mocks.main = false
    mocks.entries = [BUDGET]
    mocks.run.mockResolvedValue(answer(COLUMN))

    const series = await readSheetSeries({ workbook: 'budget', range: 'B:B', sheet: 'Expenses' })

    expect(series.label).toBe('Budget.xlsx · Expenses · Amount')
    expect(mocks.run).toHaveBeenCalledWith({ app: 'sheets', key: 'sheets-1' }, 'sheets.read', { workbook: '/Users/sam/Budget.xlsx', range: 'B:B', formulas: false, sheet: 'Expenses' }, 'ui')
    expect(mocks.runCommand).not.toHaveBeenCalled()
  })

  it('reads here when this window has the workbook open, main surface or not', async () => {
    mocks.main = false
    mocks.entries = [BUDGET]
    mocks.owned = ['sheets-1']
    mocks.runCommand.mockResolvedValue(answer(COLUMN))

    await readSheetSeries({ workbook: 'Budget.xlsx', range: 'B:B' })

    expect(mocks.runCommand).toHaveBeenCalledTimes(1)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('finds a closed workbook by its name in the home folder, and reads the file', async () => {
    mocks.find.mockResolvedValue([file('/Users/sam/Old/Budget 2.xlsx'), file('/Users/sam/Budget.xlsx', 'directory'), file('/Users/sam/Documents/~$Budget.xlsx'), file('/Users/sam/Documents/Budget.xlsx')])
    mocks.runCommand.mockResolvedValue(answer([[3], [4]]))

    expect(await readSheetSeries({ workbook: 'Budget.xlsx', range: 'C2:C3' })).toEqual({
      label: 'Budget.xlsx · C2:C3',
      points: [
        [1, 3],
        [2, 4]
      ]
    })
    expect(mocks.find).toHaveBeenCalledWith('Budget.xlsx', 8)
    expect(mocks.runCommand).toHaveBeenCalledWith('sheets.read', { workbook: '/Users/sam/Documents/Budget.xlsx', range: 'C2:C3', formulas: false }, { source: 'ui' })
  })

  it('reads a path as given, without looking for it', async () => {
    mocks.runCommand.mockResolvedValue(answer([[1], [4], [9]], 'Sales.csv'))

    const series = await readSheetSeries({ workbook: '~/Documents/Sales.csv', range: 'A:A' })

    expect(series.label).toBe('Sales.csv · column A')
    expect(mocks.find).not.toHaveBeenCalled()
    expect(mocks.runCommand).toHaveBeenCalledWith('sheets.read', { workbook: '/Users/sam/Documents/Sales.csv', range: 'A:A', formulas: false }, { source: 'ui' })
  })

  it('says plainly when no such workbook is open or in the home folder', async () => {
    mocks.find.mockResolvedValue([file('/Users/sam/Budget.docx')])

    await expect(readSheetSeries({ workbook: 'Budget.xlsx', range: 'B:B' })).rejects.toThrow('No workbook called Budget.xlsx is open or in your home folder')
  })

  it('says plainly when the cells hold no numbers', async () => {
    mocks.entries = [BUDGET]
    mocks.runCommand.mockResolvedValue(answer([['Amount'], ['n/a'], [null]]))

    await expect(readSheetSeries({ workbook: 'Budget.xlsx', range: 'B:B' })).rejects.toThrow('Column B of Budget.xlsx has no numbers')
    await expect(readSheetSeries({ workbook: 'Budget.xlsx', range: 'B2:B9', sheet: 'Expenses' })).rejects.toThrow('B2:B9 of Expenses in Budget.xlsx has no numbers')
  })

  it('passes Herald Sheets’ own message on, without Electron’s prefix', async () => {
    mocks.entries = [BUDGET]
    mocks.runCommand.mockResolvedValue({ ok: false, summary: '', error: 'There is no sheet called “Q9”; the sheets are Sheet1' })

    await expect(readSheetSeries({ workbook: 'Budget.xlsx', range: 'B:B', sheet: 'Q9' })).rejects.toThrow('There is no sheet called “Q9”; the sheets are Sheet1')

    mocks.main = false
    mocks.run.mockRejectedValue(new Error("Error invoking remote method 'herald-os:office:run': Error: The Herald Sheets window did not answer in time"))

    await expect(readSheetSeries({ workbook: 'Budget.xlsx', range: 'B:B' })).rejects.toThrow(/^The Herald Sheets window did not answer in time$/)
  })

  it('plots the first rows of a whole column too long for one read', async () => {
    mocks.entries = [BUDGET]
    mocks.runCommand.mockResolvedValueOnce({ ok: false, summary: '', error: 'B1:C20101 has 40,202 cells; read at most 10,000 at a time' }).mockResolvedValueOnce(answer(COLUMN))

    await readSheetSeries({ workbook: 'Budget.xlsx', range: 'B:C' })

    expect(mocks.runCommand).toHaveBeenLastCalledWith('sheets.read', { workbook: '/Users/sam/Budget.xlsx', range: 'B1:C5000', formulas: false }, { source: 'ui' })
  })
})

describe('the numbers in a range', () => {
  it('takes them in reading order and skips text, empty cells and true or false', () => {
    const series = seriesFromCells(
      [
        [null, 2],
        [3, 'x'],
        [true, 4]
      ],
      'Data.xlsx',
      { workbook: 'Data.xlsx', range: 'A1:B3' }
    )

    expect(series).toEqual({
      label: 'Data.xlsx · A1:B3',
      points: [
        [1, 2],
        [2, 3],
        [3, 4]
      ]
    })
  })
})
