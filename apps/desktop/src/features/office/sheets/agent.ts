import { baseName, extensionOf, officeAppFor } from '../../../../shared/office/files.ts'
import type { WorkbookSnapshot } from '../../../../shared/office/workbook.ts'
import { cellName, quoteSheet, rangeName } from '../../../../shared/office/xlsx/address.ts'
import type { CommandContext } from '../../../store/os-commands.ts'
import { isPanels } from '../../../store/shell.ts'
import { openApp } from '../../../store/windows.ts'
import { exists, homeDir, type Local, locate, openEntries, type Outcome, resolve, showDocument, withEditor } from '../agent.ts'
import { documentFileName, fileName, freePath, parseJsonArg, stepCount, tildePath } from '../agent-model.ts'
import { openInOffice } from '../open.ts'
import { sheetsAdapter } from './adapter.ts'
import { cleanOn, DEPTH, type DepthCommand, type DepthWork, editOn, sortOn } from './agent-depth.ts'
import { fillGrid, findInGrid, isDepthEdit, replaceInGrid, sheetEditsOf, sheetTemplateOf, trimTable, valuesOf } from './agent-model.ts'
import { withHeadlessSheets } from './headless.ts'
import { changeFile, liveTarget, selectionIn } from './live.ts'
import { addSheet, cellFor, type CellInput, describeWorkbook, filterRange, formatSteps, freeze, MAX_CELLS, oneStep, parseTarget, rangeOf, readRange, removeSheet, renameSheet, setFormat, settled, sheetOf, type SheetsTarget, writeRange } from './model.ts'
import { sheetsSession as session } from './store.ts'

/*
 * What Hermes (and voice, the command bar and `herald-os sheets`) does in Herald Sheets. A command
 * works on the workbook it names or the one in front. Open in a window, each change is one step to
 * undo there and saves the way the person's own edits do; a file that is not open is changed with
 * nothing drawn and written back, unless that would lose something Herald Sheets cannot keep.
 */

type Args = Record<string, unknown>

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '')

const where = (file: string | null): string => (file ? tildePath(file, homeDir()) : 'not saved yet')

const io = { read: (file: string) => window.heraldOS.office.read(file), write: (file: string, bytes: Uint8Array) => window.heraldOS.office.write(file, bytes) }

async function located(ref: unknown): Promise<Local<WorkbookSnapshot>> {
  const found = await locate('sheets', session, ref)

  if (found.kind === 'remote') {
    throw new Error(`${found.entry.name} is open in another Herald Sheets window: ask there`)
  }

  return found
}

interface Worked<T> {
  result: T
  name: string
  path: string | null
  /** The workbook is open in a window, where the selection is. */
  docKey: string | null
}

/**
 * Run `work` on a workbook: the live one in a window (a change is one step to undo there), or a file
 * read with nothing drawn (and, for a change, written back when nothing would be lost).
 */
async function onWorkbook<T>(target: Local<WorkbookSnapshot>, work: (on: SheetsTarget) => Promise<T> | T, change: boolean): Promise<Worked<T>> {
  if (target.kind === 'file') {
    const file = target.path

    if (change) {
      const { result } = await changeFile(file, work, sheetsAdapter, io)

      return { result, name: fileName(file), path: file, docKey: null }
    }

    const read = await sheetsAdapter.read((await io.read(file)).bytes, extensionOf(file), baseName(file))
    const { result } = await withHeadlessSheets(read.model, ({ univer, workbook }) => work({ univer, workbook }))

    return { result, name: fileName(file), path: file, docKey: null }
  }

  // Only a change brings a closed window back, so the person sees it land as a step they can undo.
  const { doc } = target

  if (change) {
    await withEditor('sheets', doc)
  }

  const live = liveTarget(doc.key)

  if (live) {
    const result = change ? await oneStep(live, () => work(live)) : await work(live)

    if (change) {
      await settled(live)
    }

    return { result, name: doc.name, path: doc.path, docKey: doc.key }
  }

  // Its window would not show it: the change goes into what the workbook holds, like a typed edit.
  const { result, snapshot } = await withHeadlessSheets(doc.editor?.snapshot() ?? doc.initial, ({ univer, workbook }) => work({ univer, workbook }))

  if (change) {
    doc.initial = snapshot
    session.changed(doc)
  }

  return { result, name: doc.name, path: doc.path, docKey: null }
}

/** "selection" names what is selected in the open workbook; anything else is a range as given. */
function rangeArg(value: unknown, docKey: string | null): string {
  const given = text(value)

  if (given.toLowerCase() !== 'selection') {
    return given
  }

  const selection = docKey ? selectionIn(docKey) : null

  if (!selection) {
    throw new Error('Only a workbook open in Herald Sheets has a selection: give a range like B2:D9')
  }

  return `${quoteSheet(selection.sheet)}!${selection.range}`
}

/** A command's arguments with the cells they name as selection read as what is selected. */
function withSelection(args: Args, docKey: string | null): Args {
  const named = ['range', 'cell', 'refersTo'].filter((key) => text(args[key]).toLowerCase() === 'selection')

  return { ...args, ...Object.fromEntries(named.map((key) => [key, rangeArg(args[key], docKey)])) }
}

/** The cells of a sheet that hold something, from A1; null when it is empty. */
function usedRange(on: SheetsTarget, sheetName: unknown): string | null {
  const sheet = sheetOf(on.workbook, sheetName)
  const info = describeWorkbook(on).sheets.find((entry) => entry.name === sheet.getSheetName())

  return info && info.rows && info.columns ? `${quoteSheet(sheet.getSheetName())}!${rangeName({ startRow: 0, startColumn: 0, endRow: info.rows - 1, endColumn: info.columns - 1 })}` : null
}

const hasFormulas = (formulas: readonly (string | null)[][]): boolean => formulas.some((row) => row.some(Boolean))

/** Display text, where it says more than the value: formatted numbers and dates. */
function shownWhereDifferent(values: readonly CellInput[][], shown: readonly string[][]): string[][] | null {
  return shown.some((row, r) => row.some((cell, c) => cell !== (values[r]?.[c] === null || values[r]?.[c] === undefined ? '' : String(values[r][c])))) ? shown.map((row) => [...row]) : null
}

function contentsOf(on: SheetsTarget, range: string, sheet: unknown, withFormulas: boolean) {
  const read = readRange(on, { range, sheet })

  return { sheet: read.sheet, range: read.range, values: read.values, ...(withFormulas && hasFormulas(read.formulas) ? { formulas: read.formulas } : {}), ...(shownWhereDifferent(read.values, read.text) ? { text: read.text } : {}) }
}

// Commands.

export async function open(args: Args): Promise<Outcome> {
  if (!text(args.path)) {
    openInOffice('sheets')

    return { summary: 'Opened Herald Sheets' }
  }

  const file = resolve(text(args.path))

  if (!(await exists(file))) {
    throw new Error(`There is no file at ${file}`)
  }

  if (officeAppFor(file, { libreOffice: false }) !== 'sheets') {
    throw new Error(`Herald Sheets opens Excel workbooks (.xlsx) and CSV files, not ${fileName(file)}`)
  }

  if (isPanels) {
    openInOffice('sheets', { file })

    return { summary: `Opened ${fileName(file)} in Herald Sheets`, data: { path: file } }
  }

  openApp('sheets')
  const doc = await session.open(file)
  await showDocument('sheets', session, doc)
  const live = liveTarget(doc.key)
  const book = live ? describeWorkbook(live) : null

  return {
    summary: `Opened ${doc.name} in Herald Sheets${doc.notes.length ? ` (shown differently: ${doc.notes.join('; ')})` : ''}`,
    data: { name: doc.name, path: doc.path, ...(book ?? {}), ...(doc.notes.length ? { notes: doc.notes } : {}) }
  }
}

export async function create(args: Args): Promise<Outcome> {
  const template = args.template !== undefined && args.template !== '' ? sheetTemplateOf(args.template) : null
  let file: string | null = null

  if (text(args.path)) {
    file = resolve(text(args.path))
    file = extensionOf(file) ? file : `${file}.xlsx`

    if (!['.xlsx', '.csv'].includes(extensionOf(file))) {
      throw new Error('A new workbook is saved as .xlsx or .csv')
    }

    if (await exists(file)) {
      throw new Error(`${fileName(file)} already exists: sheets.new never replaces a file (open it with sheets.open)`)
    }
  }

  const name = file ? baseName(file) : text(args.name) || template?.label || ''
  const given = args.values !== undefined && args.values !== '' ? valuesOf(args.values) : null
  const values = given ?? template?.values ?? null
  let model = sheetsAdapter.blank(name || 'Untitled')

  if (values) {
    model = (
      await withHeadlessSheets(model, async (on) => {
        await writeRange(on, { range: 'A1', values })

        // The template's formats fit its own rows, not values Hermes brought.
        if (template && !given) {
          for (const entry of template.formats) {
            await setFormat(on, entry)
          }

          if (template.freeze) {
            await freeze(on, template.freeze)
          }
        }
      })
    ).snapshot
  }

  if (isPanels) {
    openInOffice('sheets', { blank: true })

    return { summary: 'Started a new workbook in Herald Sheets; write into it with sheets.write', data: { name: name || 'Untitled' } }
  }

  const doc = session.create({ name: name || undefined, model })
  await showDocument('sheets', session, doc)

  if (file) {
    await session.save(doc, { to: file })
  }

  return { summary: `Started ${doc.name}${doc.path ? ` (saved as ${where(doc.path)})` : ''}${template ? ` from the ${template.label.toLowerCase()} template` : ''}`, data: { name: doc.name, path: doc.path } }
}

export async function list(): Promise<Outcome> {
  const books = (await openEntries()).filter((entry) => entry.app === 'sheets')
  const current = books.find((entry) => entry.active) ?? books[0]

  return {
    summary: books.length ? `${books.length} workbook${books.length === 1 ? '' : 's'} open${current ? `; in front: ${current.name}${current.selection ? ` (${current.selection})` : ''}` : ''}` : 'Nothing is open in Herald Sheets',
    data: { workbooks: books.map(({ key: _key, app: _app, front: _front, ...entry }) => entry), current: current ? (current.path ?? current.name) : null }
  }
}

export async function read(args: Args): Promise<Outcome> {
  const target = await located(args.workbook)
  const docKey = target.kind === 'live' ? target.doc.key : null
  const { result, name, path } = await onWorkbook(
    target,
    (on) => {
      const book = describeWorkbook(on)
      const asked = rangeArg(args.range, docKey)
      const range = asked || usedRange(on, args.sheet)
      const selection = docKey ? selectionIn(docKey) : null

      if (!range) {
        return { ...book, sheet: sheetOf(on.workbook, args.sheet).getSheetName(), empty: true, ...(selection ? { selection: `${quoteSheet(selection.sheet)}!${selection.range}` } : {}) }
      }

      const { cells } = rangeOf(on.workbook, range, args.sheet)
      const width = cells.endColumn - cells.startColumn + 1
      const rows = cells.endRow - cells.startRow + 1
      // A big used range is read from its top, as many rows as fit.
      const fits = Math.max(1, Math.floor(MAX_CELLS / width))
      const truncated = !asked && rows > fits
      const reading = truncated ? `${quoteSheet(parseTarget(range).sheet ?? sheetOf(on.workbook, args.sheet).getSheetName())}!${rangeName({ ...cells, endRow: cells.startRow + fits - 1 })}` : range

      return { ...book, ...contentsOf(on, reading, args.sheet, args.formulas !== false), ...(truncated ? { truncated: true, rows } : {}), ...(selection ? { selection: `${quoteSheet(selection.sheet)}!${selection.range}` } : {}) }
    },
    false
  )
  const sheets = result.sheets.map((sheet) => `${sheet.name} (${sheet.rows}×${sheet.columns})`).join(', ')

  return { summary: `${name}: ${sheets}${'range' in result ? `; read ${result.range}${'truncated' in result ? ' (its first rows)' : ''}` : ''}`, data: { name, path, ...result } }
}

export async function find(args: Args): Promise<Outcome> {
  const query = text(args.text)

  if (!query) {
    throw new Error('Say what to find (text)')
  }

  const options = { caseSensitive: args.caseSensitive === true, wholeCell: args.wholeCell === true, formulas: args.formulas === true }
  const { result, name } = await onWorkbook(
    await located(args.workbook),
    (on) => {
      const sheets = args.sheet ? [sheetOf(on.workbook, args.sheet)] : on.workbook.getSheets()
      const found: { sheet: string; cell: string; text: string; formula?: string }[] = []

      for (const sheet of sheets) {
        const used = usedRange(on, sheet.getSheetName())

        if (!used) {
          continue
        }

        const { cells } = rangeOf(on.workbook, used)
        const read = readRange(on, { range: used })

        for (const hit of findInGrid(read.text, read.formulas, query, options)) {
          found.push({ sheet: sheet.getSheetName(), cell: cellName(cells.startRow + hit.row, cells.startColumn + hit.column), text: hit.text, ...(hit.formula ? { formula: hit.formula } : {}) })
        }
      }

      return found
    },
    false
  )

  return { summary: `${result.length} cell${result.length === 1 ? '' : 's'} with “${query}” in ${name}`, data: { name, count: result.length, matches: result.slice(0, 100) } }
}

/** After a write, what the cells hold and show (formulas worked out), when there are few enough to say. */
function afterWrite(on: SheetsTarget, range: string, sheet: unknown) {
  const { cells } = rangeOf(on.workbook, range, sheet)

  return (cells.endRow - cells.startRow + 1) * (cells.endColumn - cells.startColumn + 1) <= 200 ? contentsOf(on, range, sheet, true) : null
}

export async function write(args: Args): Promise<Outcome> {
  if (args.values === undefined) {
    throw new Error('Say what to write (values: rows like [["Item", "Cost"], ["Rent", 1200]], or one value)')
  }

  const target = await located(args.workbook)
  const docKey = target.kind === 'live' ? target.doc.key : null
  const range = rangeArg(args.range, docKey)
  const written = await onWorkbook(target, (on) => writeRange(on, { range, values: valuesOf(args.values), sheet: args.sheet }), true)
  const check = await onWorkbook(target, (on) => afterWrite(on, `${quoteSheet(written.result.sheet)}!${written.result.range}`, undefined), false).catch(() => null)

  return {
    summary: `Wrote ${written.result.cells} cell${written.result.cells === 1 ? '' : 's'} in ${written.result.sheet}!${written.result.range} of ${written.name}`,
    data: { name: written.name, path: written.path, ...written.result, ...(check?.result ? { now: check.result } : {}) }
  }
}

/** Fill a formula (the first cell's own when none is given) across a range, its references moving for each cell. */
async function fillOn(on: SheetsTarget, args: Args, range: string): Promise<{ sheet: string; range: string; cells: number; formula: string }> {
  const { sheet, cells } = rangeOf(on.workbook, range, args.sheet)
  const formula = text(args.formula) || sheet.getRange(cells.startRow, cells.startColumn).getFormula()

  if (!formula) {
    throw new Error(`Give the formula for ${cellName(cells.startRow, cells.startColumn)} (formula), or put one there first`)
  }

  const grid = fillGrid(formula, cells.endRow - cells.startRow + 1, cells.endColumn - cells.startColumn + 1)
  const result = await writeRange(on, { range: `${quoteSheet(sheet.getSheetName())}!${rangeName(cells)}`, values: grid })

  return { ...result, formula: grid[0][0] }
}

export async function fill(args: Args): Promise<Outcome> {
  const target = await located(args.workbook)
  const range = rangeArg(args.range, target.kind === 'live' ? target.doc.key : null)

  if (!range) {
    throw new Error('Say which cells to fill (range, like D2:D20)')
  }

  const { result, name, path } = await onWorkbook(target, (on) => fillOn(on, args, range), true)

  return { summary: `Filled ${result.formula} across ${result.sheet}!${result.range} of ${name}`, data: { name, path, ...result } }
}

export async function format(args: Args): Promise<Outcome> {
  const target = await located(args.workbook)
  const range = rangeArg(args.range, target.kind === 'live' ? target.doc.key : null)
  const formatArg = parseJsonArg(args.format, 'format')
  formatSteps(formatArg)
  const { result, name, path } = await onWorkbook(target, (on) => setFormat(on, { range, format: formatArg, sheet: args.sheet }), true)

  return { summary: `Formatted ${result.sheet}!${result.range} of ${name}: ${result.changes.join(', ')}`, data: { name, path, ...result } }
}

export async function sort(args: Args): Promise<Outcome> {
  const target = await located(args.workbook)
  const range = rangeArg(args.range, target.kind === 'live' ? target.doc.key : null)
  const { result, name, path } = await onWorkbook(target, (on) => sortOn(on, args, range), true)

  return { summary: `Sorted ${result.sheet}!${result.range} of ${name} by ${result.column}, ${result.ascending ? 'ascending' : 'descending'}`, data: { name, path, ...result } }
}

export async function filter(args: Args): Promise<Outcome> {
  const target = await located(args.workbook)
  const range = rangeArg(args.range, target.kind === 'live' ? target.doc.key : null)
  const by = typeof args.by === 'string' && /^\d+$/.test(args.by) ? Number(args.by) : args.by
  const values = parseJsonArg(args.values, 'values')
  const condition = parseJsonArg(args.condition, 'condition')
  const { result, name, path } = await onWorkbook(target, (on) => filterRange(on, { range: range || undefined, by, values: values === '' ? undefined : values, condition: condition === '' ? undefined : condition, clear: args.clear, sheet: args.sheet }), true)

  return { summary: args.clear === true ? `Took the filter off ${result.sheet} in ${name}` : `Filtered ${result.sheet}!${result.range} of ${name} by ${result.column}: ${result.hidden} row${result.hidden === 1 ? '' : 's'} hidden`, data: { name, path, ...result } }
}

export async function freezePanes(args: Args): Promise<Outcome> {
  const { result, name, path } = await onWorkbook(await located(args.workbook), (on) => freeze(on, { rows: args.rows, columns: args.columns, sheet: args.sheet }), true)

  return { summary: result.rows || result.columns ? `Froze ${[result.rows ? `${result.rows} row${result.rows === 1 ? '' : 's'}` : '', result.columns ? `${result.columns} column${result.columns === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')} of ${result.sheet} in ${name}` : `Unfroze ${result.sheet} in ${name}`, data: { name, path, ...result } }
}

export async function newSheet(args: Args): Promise<Outcome> {
  const { result, name, path } = await onWorkbook(await located(args.workbook), (on) => addSheet(on, { name: args.name, index: args.index }), true)

  return { summary: `Added the sheet ${result.sheet} to ${name}`, data: { name, path, ...result } }
}

export async function renameSheetIn(args: Args): Promise<Outcome> {
  const { result, name, path } = await onWorkbook(await located(args.workbook), (on) => renameSheet(on, { sheet: args.sheet, name: args.name }), true)

  return { summary: `Renamed ${result.from} to ${result.to} in ${name}`, data: { name, path, ...result } }
}

export async function removeSheetIn(args: Args): Promise<Outcome> {
  const { result, name, path } = await onWorkbook(await located(args.workbook), (on) => removeSheet(on, { sheet: args.sheet }), true)

  return { summary: `Removed the sheet ${result.sheet} from ${name}`, data: { name, path, ...result } }
}

/** Replace text in cells, on one sheet or every one, within `range` when given. */
async function replaceOn(on: SheetsTarget, args: Args, range: string): Promise<{ replaced: number; sheets: string[] }> {
  const query = typeof args.find === 'string' ? args.find : ''

  if (!query) {
    throw new Error('Say what to replace (find)')
  }

  const replacement = typeof args.replacement === 'string' ? args.replacement : ''
  const options = { caseSensitive: args.caseSensitive === true, wholeCell: args.wholeCell === true, formulas: args.formulas === true }
  const ranges = range ? [range] : (args.sheet ? [sheetOf(on.workbook, args.sheet)] : on.workbook.getSheets()).map((sheet) => usedRange(on, sheet.getSheetName())).filter((entry): entry is string => Boolean(entry))
  let replaced = 0
  const touched: string[] = []

  for (const entry of ranges) {
    const { sheet, cells } = rangeOf(on.workbook, entry, args.sheet)
    const read = readRange(on, { range: entry, sheet: args.sheet })
    let changes = replaceInGrid(read.values, read.formulas, query, replacement, options)

    if (args.all === false) {
      changes = changes.slice(0, Math.max(0, 1 - replaced))
    }

    for (const change of changes) {
      sheet.getRange(cells.startRow + change.row, cells.startColumn + change.column).setValues([[cellFor(change.value)]])
    }

    if (changes.length) {
      replaced += changes.length
      touched.push(sheet.getSheetName())
    }
  }

  return { replaced, sheets: touched }
}

export async function replace(args: Args): Promise<Outcome> {
  const target = await located(args.workbook)
  const range = rangeArg(args.range, target.kind === 'live' ? target.doc.key : null)
  const { result, name, path } = await onWorkbook(target, (on) => replaceOn(on, args, range), true)

  return { summary: result.replaced ? `Replaced “${String(args.find)}” in ${result.replaced} cell${result.replaced === 1 ? '' : 's'} of ${name}` : `“${String(args.find)}” is in no cell of ${name} that can change`, data: { name, path, ...result } }
}

export async function clean(args: Args): Promise<Outcome> {
  const target = await located(args.workbook)
  const range = rangeArg(args.range, target.kind === 'live' ? target.doc.key : null)

  if (!range) {
    throw new Error('Say which cells to clean (range, like A1:D200, or selection)')
  }

  const { result, name, path } = await onWorkbook(target, (on) => cleanOn(on, args, range), true)

  return { summary: `Cleaned ${result.sheet}!${result.range} of ${name}: ${result.detail}`, data: { name, path, ...result } }
}

/**
 * A command for charts, summaries, data tools, names, validation, comments or notes (agent-depth.ts):
 * a change is one step to undo, a preview changes nothing, and going to a name shows it in the
 * window of the open workbook.
 */
export async function depth(command: DepthCommand, args: Args, context: Pick<CommandContext, 'source'>): Promise<Outcome> {
  const work: DepthWork = DEPTH[command]
  const target = await located(args.workbook)
  const given = withSelection(args, target.kind === 'live' ? target.doc.key : null)

  if (work.view) {
    if (target.kind === 'file') {
      throw new Error(`${fileName(target.path)} is not open in Herald Sheets: open it (sheets.open) first`)
    }

    const live = (await showDocument('sheets', session, target.doc)) ? liveTarget(target.doc.key) : null

    if (!live) {
      throw new Error(`${target.doc.name} is not showing in Herald Sheets`)
    }

    const { said, data } = await work.run(live, given, context.source)

    return { summary: `${target.doc.name}: ${said}`, data: { name: target.doc.name, path: target.doc.path, ...data } }
  }

  const change = work.change && given.preview !== true && given.preview !== 'true'
  const { result, name, path } = await onWorkbook(target, (on) => work.run(on, given, context.source), change)

  return { summary: `${name}: ${result.said}`, data: { name, path, ...result.data } }
}

/** A batch of edits as one step to undo. */
export async function edit(args: Args, context?: Pick<CommandContext, 'source'>): Promise<Outcome> {
  const edits = sheetEditsOf(args.edits)
  const target = await located(args.workbook)
  const docKey = target.kind === 'live' ? target.doc.key : null
  const { result, name, path } = await onWorkbook(
    target,
    async (on) => {
      const done: string[] = []

      for (const entry of edits) {
        if (isDepthEdit(entry)) {
          done.push(await editOn(on, withSelection(entry, docKey) as typeof entry, context?.source))
          continue
        }

        const range = rangeArg(entry.range, docKey)
        const sheet = entry.sheet

        switch (entry.op) {
          case 'write':
            done.push(`wrote ${(await writeRange(on, { range, values: valuesOf(entry.values), sheet })).range}`)
            break
          case 'fill':
            done.push(`filled ${(await fillOn(on, entry, range)).range}`)
            break
          case 'format':
            done.push(`formatted ${(await setFormat(on, { range, format: parseJsonArg(entry.format, 'format'), sheet })).range}`)
            break
          case 'sort':
            done.push(`sorted ${(await sortOn(on, entry, range)).range}`)
            break
          case 'filter':
            await filterRange(on, { range: range || undefined, by: entry.by, values: parseJsonArg(entry.values, 'values'), condition: parseJsonArg(entry.condition, 'condition'), clear: entry.clear, sheet })
            done.push('filtered')
            break
          case 'freeze':
            await freeze(on, { rows: entry.rows, columns: entry.columns, sheet })
            done.push('froze panes')
            break
          case 'addSheet':
            done.push(`added ${(await addSheet(on, { name: entry.name, index: entry.index })).sheet}`)
            break
          case 'renameSheet':
            done.push(`renamed ${(await renameSheet(on, { sheet, name: entry.name })).from}`)
            break
          case 'removeSheet':
            done.push(`removed ${(await removeSheet(on, { sheet })).sheet}`)
            break
          case 'clean':
            done.push((await cleanOn(on, entry, range)).detail)
            break
          case 'replace':
            done.push(`replaced ${(await replaceOn(on, entry, range)).replaced} cells`)
        }
      }

      return done
    },
    true
  )

  return { summary: `Made ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${name} as one step: ${result.join('; ')}`, data: { name, path, edits: result } }
}

/** A range of a workbook as rows of what its cells show, for a table elsewhere (a document, a slide). */
export async function rangeTable(args: { workbook?: unknown; range?: unknown; sheet?: unknown }): Promise<{ cells: string[][]; name: string; sheet: string; range: string }> {
  const target = await located(args.workbook)
  const docKey = target.kind === 'live' ? target.doc.key : null
  const { result, name } = await onWorkbook(
    target,
    (on) => {
      const range = rangeArg(args.range, docKey) || usedRange(on, args.sheet)

      if (!range) {
        throw new Error('That sheet is empty')
      }

      const read = readRange(on, { range, sheet: args.sheet })

      return { cells: trimTable(read.text), sheet: read.sheet, range: read.range }
    },
    false
  )

  if (!result.cells.length) {
    throw new Error(`${result.sheet}!${result.range} of ${name} is empty`)
  }

  return { ...result, name }
}

export async function save(args: Args): Promise<Outcome> {
  const target = await located(args.workbook)
  const to = text(args.to) ? resolve(text(args.to)) : null

  if (to && (await exists(to)) && args.overwrite !== true) {
    throw new Error(`${fileName(to)} already exists: pass overwrite=true to replace it`)
  }

  if (target.kind === 'file') {
    if (!to) {
      return { summary: `${fileName(target.path)} is not open, so there is nothing unsaved: changes to it are written as they are made`, data: { path: target.path } }
    }

    const read = await sheetsAdapter.read((await io.read(target.path)).bytes, extensionOf(target.path), baseName(target.path))
    const written = await sheetsAdapter.write(read.model, extensionOf(to), extensionOf(to) === extensionOf(target.path) ? read.layout : undefined)
    await io.write(to, written.bytes)

    return { summary: `Saved ${fileName(target.path)} as ${fileName(to)}${written.losses.length ? ` (it cannot keep: ${written.losses.join('; ')})` : ''}`, data: { path: to, ...(written.losses.length ? { losses: written.losses } : {}) } }
  }

  const { doc } = target

  if (!to && !doc.path) {
    throw new Error(`${doc.name} has never been saved: say where, with to=~/Documents/${documentFileName(doc.name, '.xlsx')}`)
  }

  const saved = await session.save(doc, to ? { to } : {})

  if (!saved) {
    return { summary: `${doc.name} was not saved: the person kept the file as it was`, data: { name: doc.name, path: doc.path, saved: false } }
  }

  return { summary: `Saved ${doc.name} (${where(doc.path)})`, data: { name: doc.name, path: doc.path, saved: true } }
}

export async function exportPdf(args: Args): Promise<Outcome> {
  const target = await located(args.workbook)
  const name = target.kind === 'file' ? fileName(target.path) : target.doc.name
  let to = text(args.to) ? resolve(text(args.to)) : null
  to = to && !to.toLowerCase().endsWith('.pdf') ? `${to}.pdf` : to

  if (to && (await exists(to)) && args.overwrite !== true) {
    throw new Error(`${fileName(to)} already exists: pass overwrite=true to replace it`)
  }

  const file = to ?? (await freePath(resolve('~/Documents'), `${name.replace(/\.[a-z0-9]{1,5}$/i, '')}.pdf`, exists))

  if (target.kind === 'file') {
    const read = await sheetsAdapter.read((await io.read(target.path)).bytes, extensionOf(target.path), name)
    const view = await sheetsAdapter.print(read.model, name)
    await window.heraldOS.office.exportPdf({ html: view.html, suggestedName: name, landscape: view.landscape, path: file })
  } else if (!(await session.exportPdf(target.doc, file))) {
    throw new Error(`Could not export ${name} as a PDF`)
  }

  return { summary: `Exported ${name} as ${where(file)}`, data: { path: file } }
}

export async function step(direction: 'undo' | 'redo', args: Args): Promise<Outcome> {
  const target = await located(args.workbook)

  if (target.kind === 'file') {
    throw new Error(`Undo works in the open Herald Sheets window: ${fileName(target.path)} is not open`)
  }

  const { doc } = target
  await withEditor('sheets', doc)

  if (!doc.editor) {
    throw new Error(`${doc.name} is not showing in Herald Sheets`)
  }

  const count = stepCount(args.steps)

  for (let n = 0; n < count; n++) {
    if (direction === 'undo') {
      doc.editor.undo()
    } else {
      doc.editor.redo()
    }

    await new Promise((done) => setTimeout(done, 30))
  }

  return { summary: `${direction === 'undo' ? 'Undid' : 'Redid'} ${count === 1 ? 'a step' : `${count} steps`} in ${doc.name}`, data: { name: doc.name, steps: count } }
}
