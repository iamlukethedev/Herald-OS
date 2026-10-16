import type { OfficeDocSummary, OfficePresence } from '../../../../shared/ipc.ts'
import { OFFICE_APP_NAMES } from '../../../../shared/office/files.ts'
import { logFailure } from '../../../lib/report.ts'
import { type CommandResult, runCommand } from '../../../store/os-commands.ts'
import { isPanels } from '../../../store/shell.ts'
import { messageOf } from '../../canvas/errors.ts'
import { openInOffice } from '../../office/open.ts'
import { type SheetRow, toSheetRows } from '../engine/sheets.ts'
import type { DocumentResult } from '../engine/types.ts'
import { docsTable } from './docs-table.ts'

/*
 * Copy to Sheets and Copy to Docs: a note into a new workbook or document in Herald Office, through
 * the commands Hermes uses there. In desktop mode one command makes it whole. In panels mode each
 * Office app is a window of its own whose new documents start blank, so Calc opens one there, waits
 * for the window to report it, and has that window write the note in.
 */

type Target = 'sheets' | 'docs'

const NOUN: Record<Target, string> = { sheets: 'workbook', docs: 'document' }

/** How long a new blank document has to show up in its window, which may have to start first. */
export const OPEN_TIMEOUT_MS = 10_000
const POLL_MS = 150
/** Herald Sheets writes at most 10,000 cells at once, and a note takes two a line. */
const MAX_ROWS = 5_000

const NOTHING = 'This note has nothing to copy yet'

const plural = (count: number, word: string): string => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`

const wait = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

/** A name for the new tab, which is also the file name it is offered when saved. */
const tabName = (name: string): string => name.replace(/\s+/g, ' ').replace(/[/\\:]/g, '-').trim() || 'Calculations'

interface Format {
  range: string
  format: { numberFormat: string } | { bold: true }
}

const isEmpty = (row: SheetRow): boolean => (row.value === null || row.value === '') && !row.label.trim()

/**
 * A label as text Herald Sheets keeps as it is: text that reads as a plain number would become one
 * and a leading apostrophe would be taken off, so they get one more; one starting with = would be a
 * formula even after an apostrophe, so it gets a space.
 */
function labelCell(label: string): string {
  if (label.length > 1 && label.startsWith('=')) {
    return ` ${label}`
  }

  return label.startsWith("'") || /^-?(0|[1-9]\d*)(\.\d+)?$/.test(label.trim()) ? `'${label}` : label
}

/** Rows next to each other that share a key, by their row numbers from 1. */
function runsOf(rows: readonly SheetRow[], key: (row: SheetRow) => string | null): { key: string; first: number; last: number }[] {
  const runs: { key: string; first: number; last: number }[] = []

  rows.forEach((row, index) => {
    const value = key(row)
    const open = runs[runs.length - 1]

    if (value === null) {
      return
    }

    if (open && open.key === value && open.last === index) {
      open.last = index + 1
    } else {
      runs.push({ key: value, first: index + 1, last: index + 1 })
    }
  })

  return runs
}

const cells = (from: string, to: string, run: { first: number; last: number }): string => (from === to && run.first === run.last ? `${from}${run.first}` : `${from}${run.first}:${to}${run.last}`)

/** The number formats of column A and the bold of heading rows, as few ranges as they take. */
export function sheetFormats(rows: readonly SheetRow[]): Format[] {
  return [
    ...runsOf(rows, row => row.format?.trim() || null).map(run => ({ range: cells('A', 'A', run), format: { numberFormat: run.key } })),
    ...runsOf(rows, row => (row.heading ? 'bold' : null)).map(run => ({ range: cells('A', 'B', run), format: { bold: true as const } }))
  ]
}

/** What `work` gives; when it fails, an error saying `what` went wrong and why. */
async function told<T>(work: Promise<T>, what: string): Promise<T> {
  try {
    return await work
  } catch (error) {
    throw new Error(`${what}: ${messageOf(error)}`)
  }
}

/** Run a command here; a failure throws its error. */
async function command(id: string, args: Record<string, unknown>): Promise<CommandResult> {
  const result = await runCommand(id, args, { source: 'ui' })

  if (!result.ok) {
    throw new Error(result.error || result.summary)
  }

  return result
}

/** Have the Office window that has `doc` open run a command on it; a failure throws its error. */
async function inWindow(app: Target, doc: OfficeDocSummary, id: string, args: Record<string, unknown>): Promise<void> {
  let result: unknown

  try {
    result = await window.heraldOS.office.run({ app, key: doc.key }, id, args, 'ui')
  } catch (error) {
    throw new Error(messageOf(error))
  }

  if (result && typeof result === 'object' && (result as Partial<CommandResult>).ok === false) {
    const failed = result as Partial<CommandResult>

    throw new Error(failed.error || failed.summary || `${id} did not work`)
  }
}

/** `name`, or the first of "name 2", "name 3"… that no open document of the app has. */
async function freeName(app: Target, name: string): Promise<string> {
  let open: string[] = []

  try {
    const { openEntries } = await import('../../office/agent.ts')
    open = (await openEntries()).filter(entry => entry.app === app).map(entry => entry.name)
  } catch (error) {
    logFailure('office.openEntries')(error)
  }

  const taken = new Set(open.map(entry => entry.trim().toLowerCase()))
  let candidate = name

  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    candidate = `${name} ${n}`
  }

  return candidate
}

/** The new blank document among what the Office windows report: one not there before, never saved or changed, the one in front first. */
function newBlank(presence: readonly OfficePresence[], app: Target, before: ReadonlySet<string>): OfficeDocSummary | null {
  const fresh = presence.filter(entry => entry.app === app).flatMap(entry => entry.documents.filter(doc => !before.has(doc.key) && doc.path === null && !doc.modified).map(doc => ({ doc, front: doc.key === entry.active })))

  return (fresh.find(candidate => candidate.front) ?? fresh[fresh.length - 1])?.doc ?? null
}

/** Panels mode: open a blank document in the app's own window and wait for the window to report it. */
async function openBlank(app: Target): Promise<OfficeDocSummary> {
  const office = window.heraldOS.office
  const known = await office.presence().catch(() => null)

  if (!known) {
    throw new Error('Herald Office is not answering; try again in a moment')
  }

  const before = new Set(known.filter(entry => entry.app === app).flatMap(entry => entry.documents.map(doc => doc.key)))
  openInOffice(app, { blank: true })
  const until = Date.now() + OPEN_TIMEOUT_MS

  while (Date.now() < until) {
    await wait(POLL_MS)
    const found = newBlank(await office.presence().catch(() => []), app, before)

    if (found) {
      return found
    }
  }

  throw new Error(`${OFFICE_APP_NAMES[app]} did not open a new ${NOUN[app]} in time`)
}

/** Apply formats one by one; the values are in already, so a format that fails is only logged. */
async function applyFormats(formats: readonly Format[], format: (args: { range: string; format: string }) => Promise<unknown>): Promise<void> {
  try {
    for (const entry of formats) {
      await format({ range: entry.range, format: JSON.stringify(entry.format) })
    }
  } catch (error) {
    logFailure('sheets.format')(error)
  }
}

/** A new workbook in Herald Sheets from a note: formulas where they map, values otherwise, labels beside them. Resolves to a line for a toast. */
export async function copyToSheets(document: DocumentResult, name: string): Promise<string> {
  const all = toSheetRows(document)
  let end = all.length

  while (end > 0 && isEmpty(all[end - 1])) {
    end--
  }

  const rows = all.slice(0, end)
  const lines = rows.filter(row => !isEmpty(row)).length

  if (!lines) {
    throw new Error(NOTHING)
  }

  if (rows.length > MAX_ROWS) {
    throw new Error(`This note is too long for one workbook: Herald Sheets takes ${plural(MAX_ROWS, 'line')} at a time`)
  }

  const values = JSON.stringify(rows.map(row => [row.value, labelCell(row.label)]))
  const formats = sheetFormats(rows)

  if (isPanels) {
    const workbook = await openBlank('sheets')
    await told(inWindow('sheets', workbook, 'sheets.write', { workbook: workbook.name, range: 'A1', values }), `Herald Sheets could not write the note into ${workbook.name}`)
    await applyFormats(formats, args => inWindow('sheets', workbook, 'sheets.format', { workbook: workbook.name, ...args }))
  } else {
    const wanted = await freeName('sheets', tabName(name))
    const created = await told(command('sheets.new', { name: wanted, values }), 'Herald Sheets could not make the workbook')
    const workbook = typeof created.data?.name === 'string' && created.data.name ? created.data.name : wanted
    await applyFormats(formats, args => command('sheets.format', { workbook, ...args }))
  }

  return `Copied ${plural(lines, 'line')} to a new workbook in Herald Sheets`
}

/** A new document in Herald Docs with a note as a neat table. Resolves to a line for a toast. */
export async function copyToDocs(document: DocumentResult, name: string): Promise<string> {
  const { markdown, lines } = docsTable(document, name)

  if (!lines) {
    throw new Error(NOTHING)
  }

  if (isPanels) {
    const doc = await openBlank('docs')
    await told(inWindow('docs', doc, 'docs.write', { document: doc.name, content: markdown }), `Herald Docs could not write the note into ${doc.name}`)
  } else {
    const wanted = await freeName('docs', tabName(name))
    await told(command('docs.new', { name: wanted, content: markdown }), 'Herald Docs could not make the document')
  }

  return `Copied ${plural(lines, 'line')} to a new document in Herald Docs`
}
