import { type CommandResult, runCommand } from '../../../store/os-commands.ts'
import { isMainSurface } from '../../../store/shell.ts'
import { messageOf } from '../../canvas/errors.ts'
import { findEntry, isPathLike, type OfficeEntry } from '../../office/agent-model.ts'
import type { GraphSeries, SheetPlotRef } from './types.ts'

/* Points from Herald Sheets, for an open workbook or a closed file. */

const office = () => import('../../office/agent.ts')
const sessions = () => import('../../office/session.ts')

const SPREADSHEETS = ['.xlsx', '.xlsm', '.xls', '.csv', '.ods']
/** The most cells sheets.read hands back at once. */
const MAX_CELLS = 10_000

/** What sheets.read answers with, as far as a plot reads it. */
interface Reading {
  name?: string
  values?: unknown[][]
}

type Read = (args: Record<string, unknown>) => Promise<unknown>

const stem = (name: string): string => name.toLowerCase().replace(/\.[^./]+$/, '')

/** The spreadsheet in the home folder called `name` (its extension left out, any spreadsheet's). */
async function findWorkbook(name: string): Promise<string | null> {
  const found = await window.heraldOS.fs.find(name, 8).catch(() => [])
  const sheets = found.filter(file => file.kind === 'file' && SPREADSHEETS.includes(file.extension.toLowerCase()) && !file.name.startsWith('~$'))
  const wanted = name.toLowerCase()

  return (sheets.find(file => file.name.toLowerCase() === wanted) ?? sheets.find(file => stem(file.name) === stem(wanted)))?.path ?? null
}

async function ownedHere(entry: OfficeEntry): Promise<boolean> {
  const { loadedSessions } = await sessions()

  return Boolean(loadedSessions.get('sheets')?.summaries().some(doc => doc.key === entry.key))
}

/**
 * How to read the workbook: in the window that has it open (here, or through main to Herald
 * Sheets' own window in panels mode), or the file on disk, which Herald Sheets reads unseen.
 */
async function readerFor(wanted: string): Promise<Read> {
  const { openEntries, resolve } = await office()
  const path = isPathLike(wanted) ? resolve(wanted) : null
  const entry = findEntry(await openEntries(), 'sheets', wanted, path)

  if (entry) {
    const workbook = entry.path ?? entry.name

    if (isMainSurface || (await ownedHere(entry))) {
      return args => runCommand('sheets.read', { ...args, workbook }, { source: 'ui' })
    }

    return args => window.heraldOS.office.run({ app: 'sheets', key: entry.key }, 'sheets.read', { ...args, workbook }, 'ui')
  }

  const file = path ?? (await findWorkbook(wanted))

  if (!file) {
    throw new Error(`No workbook called ${wanted} is open or in your home folder`)
  }

  return args => runCommand('sheets.read', { ...args, workbook: file }, { source: 'ui' })
}

function readingOf(answer: unknown): Reading {
  const result = answer as Partial<CommandResult> | null

  if (!result || typeof result !== 'object') {
    throw new Error('Herald Sheets did not answer')
  }

  if (result.ok === false) {
    throw new Error(messageOf(result.error ?? result.summary ?? 'Herald Sheets could not read that'))
  }

  return (result.data ?? {}) as Reading
}

const columnIndex = (letters: string): number => [...letters.toUpperCase()].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0)

/** "B:D" as its first and last column and how many there are; null for any other range. */
function wholeColumns(range: string): { first: string; last: string; count: number } | null {
  const match = /^\$?([A-Z]{1,3}):\$?([A-Z]{1,3})$/i.exec(range.trim())

  return match ? { first: match[1].toUpperCase(), last: match[2].toUpperCase(), count: columnIndex(match[2]) - columnIndex(match[1]) + 1 } : null
}

async function readCells(read: Read, ref: SheetPlotRef): Promise<Reading> {
  const args = { range: ref.range, formulas: false, ...(ref.sheet ? { sheet: ref.sheet } : {}) }

  try {
    return readingOf(await read(args))
  } catch (error) {
    const columns = wholeColumns(ref.range)
    const message = messageOf(error)

    // A whole column of a long sheet is more than one read: plot as many rows as one read holds.
    if (!columns || columns.count < 1 || !/read at most/i.test(message)) {
      throw new Error(message)
    }

    const rows = Math.max(1, Math.floor(MAX_CELLS / columns.count))

    return readingOf(await read({ ...args, range: `${columns.first}1:${columns.last}${rows}` }))
  }
}

/** "Column B", "Columns B to D", or the range as given. */
function cellsName(range: string): string {
  const columns = wholeColumns(range)

  if (!columns) {
    return range.replace(/\$/g, '').toUpperCase()
  }

  return columns.first === columns.last ? `Column ${columns.first}` : `Columns ${columns.first} to ${columns.last}`
}

const fileName = (workbook: string): string => workbook.split('/').pop() || workbook

/** The numbers in a sheet's cells as points, in reading order (x is their place: 1, 2, 3…); a text first cell names them. */
export function seriesFromCells(values: readonly unknown[][], name: string, ref: SheetPlotRef): GraphSeries {
  const cells = values.flat()
  const first = cells.find(cell => cell !== null && cell !== undefined && cell !== '')
  const header = typeof first === 'string' ? first.trim() : ''
  const points: Array<[number, number]> = []

  for (const cell of cells) {
    if (typeof cell === 'number' && Number.isFinite(cell)) {
      points.push([points.length + 1, cell])
    }
  }

  const cellsCalled = cellsName(ref.range)

  if (!points.length) {
    throw new Error(`${cellsCalled} of ${ref.sheet ? `${ref.sheet} in ${name}` : name} has no numbers`)
  }

  const label = [name, ref.sheet, header || cellsCalled.replace(/^Column/, 'column')].filter(Boolean).join(' · ')

  return { label, points }
}

/** The numbers in a sheet's cells as points (x is their position); throws a plain message when it cannot. */
export async function readSheetSeries(ref: SheetPlotRef): Promise<GraphSeries> {
  const wanted = ref.workbook.trim()

  if (!wanted) {
    throw new Error('Name the workbook to plot, like column B of Budget.xlsx')
  }

  try {
    const reading = await readCells(await readerFor(wanted), ref)

    return seriesFromCells(reading.values ?? [], reading.name || fileName(wanted), ref)
  } catch (error) {
    throw new Error(messageOf(error))
  }
}
