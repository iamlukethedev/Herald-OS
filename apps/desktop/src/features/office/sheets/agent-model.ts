import { slideFormula } from '../../../../shared/office/xlsx/formula.ts'
import { parseJsonArg } from '../agent-model.ts'
import type { CellInput } from './model.ts'

/*
 * Herald Sheets for Hermes, without a window: values as callers send them, a formula filled across
 * a range, finding and replacing in cells, the data cleaning tools (duplicates, spaces, numbers and
 * dates kept as text, a column split in several, letter case), batches of edits, and the templates
 * a new workbook starts from. Tested directly.
 */

type Args = Record<string, unknown>

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '')

/** Text that reads as a plain number becomes one; a leading apostrophe keeps it text (as in Excel), and so does a leading zero. */
export function coerceValue(value: CellInput): CellInput {
  if (typeof value !== 'string') {
    return value
  }

  if (value.startsWith("'")) {
    return value.slice(1)
  }

  return /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value.trim()) && value.trim().length <= 15 ? Number(value.trim()) : value
}

/** The values a write takes: rows as a list of lists (or JSON text of one), or one value for every cell. */
export function valuesOf(value: unknown): unknown {
  const parsed = parseJsonArg(value, 'values')
  const coerce = (cell: unknown) => (cell === null || ['string', 'number', 'boolean'].includes(typeof cell) ? coerceValue(cell as CellInput) : cell)

  if (Array.isArray(parsed)) {
    return parsed.map((row) => (Array.isArray(row) ? row.map(coerce) : coerce(row)))
  }

  return coerce(parsed)
}

/** `formula` written in the first cell of a rows × columns block, its relative references moved for each other cell. */
export function fillGrid(formula: string, rows: number, columns: number): string[][] {
  const start = formula.trim().startsWith('=') ? formula.trim() : `=${formula.trim()}`

  return Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => slideFormula(start, row, column)))
}

export interface FindOptions {
  caseSensitive?: boolean
  /** The whole cell has to match, not part of it. */
  wholeCell?: boolean
  /** Look in formulas too. */
  formulas?: boolean
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function cellPattern(query: string, options: FindOptions): RegExp {
  const source = escapeRegExp(query)

  return new RegExp(options.wholeCell ? `^${source}$` : source, options.caseSensitive ? 'g' : 'gi')
}

/** Where `query` shows in a block of cells (what each cell shows, and its formula), counted from its top-left corner. */
export function findInGrid(shown: readonly string[][], formulas: readonly (string | null)[][], query: string, options: FindOptions = {}): { row: number; column: number; text: string; formula?: string }[] {
  const pattern = cellPattern(query, options)
  const out: { row: number; column: number; text: string; formula?: string }[] = []

  shown.forEach((line, row) =>
    line.forEach((cell, column) => {
      const formula = formulas[row]?.[column] ?? null
      pattern.lastIndex = 0
      const inText = pattern.test(cell)
      pattern.lastIndex = 0
      const inFormula = Boolean(options.formulas && formula && pattern.test(formula))

      if (inText || inFormula) {
        out.push({ row, column, text: cell, ...(formula ? { formula } : {}) })
      }
    })
  )

  return out
}

/**
 * The cells a replace changes: text cells (and, with `formulas`, formulas) with every match of
 * `query` replaced. Numbers, dates and true/false are left alone, and so are formulas otherwise.
 */
export function replaceInGrid(values: readonly CellInput[][], formulas: readonly (string | null)[][], query: string, replacement: string, options: FindOptions = {}): { row: number; column: number; value: CellInput }[] {
  const pattern = cellPattern(query, options)
  const out: { row: number; column: number; value: CellInput }[] = []

  values.forEach((line, row) =>
    line.forEach((value, column) => {
      const formula = formulas[row]?.[column] ?? null

      if (formula) {
        if (options.formulas) {
          const next = formula.replace(pattern, () => replacement)

          if (next !== formula) {
            out.push({ row, column, value: next })
          }
        }

        return
      }

      if (typeof value === 'string') {
        const next = value.replace(pattern, () => replacement)

        if (next !== value) {
          out.push({ row, column, value: coerceValue(next) })
        }
      }
    })
  )

  return out
}

// Cleaning.

export const CLEAN_ACTIONS = ['dedupe', 'trim', 'numbers', 'dates', 'split', 'case'] as const

export type CleanAction = (typeof CLEAN_ACTIONS)[number]

const CLEAN_ALIASES: Record<string, CleanAction> = { duplicates: 'dedupe', 'remove duplicates': 'dedupe', removeduplicates: 'dedupe', deduplicate: 'dedupe', spaces: 'trim', whitespace: 'trim', number: 'numbers', date: 'dates', splitcolumn: 'split', 'split column': 'split', text: 'case' }

export function cleanActionOf(value: unknown): CleanAction {
  const name = text(value).toLowerCase()
  const found = CLEAN_ACTIONS.find((action) => action === name) ?? CLEAN_ALIASES[name]

  if (!found) {
    throw new Error(`action is one of ${CLEAN_ACTIONS.join(', ')}, not “${name}”`)
  }

  return found
}

/** Rows whose key cells repeat an earlier row's are dropped; the rest move up, and the rows freed at the bottom are emptied. */
export function dedupeRows(values: readonly CellInput[][], keyColumns: readonly number[] | null, header: boolean): { values: CellInput[][]; removed: number } {
  const seen = new Set<string>()
  const width = Math.max(0, ...values.map((row) => row.length))
  const kept: CellInput[][] = []
  let removed = 0

  values.forEach((row, index) => {
    if (header && index === 0) {
      kept.push([...row])

      return
    }

    const key = JSON.stringify((keyColumns ?? row.map((_, column) => column)).map((column) => normalisedKey(row[column] ?? null)))

    if (seen.has(key)) {
      removed++
    } else {
      seen.add(key)
      kept.push([...row])
    }
  })

  while (kept.length < values.length) {
    kept.push(Array.from({ length: width }, () => null))
  }

  return { values: kept, removed }
}

const normalisedKey = (value: CellInput): string => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : String(value))

/** Spaces at either end of text go, and runs of spaces inside become one. */
export function trimValues(values: readonly CellInput[][]): { values: CellInput[][]; changed: number } {
  let changed = 0
  const out = values.map((row) =>
    row.map((value) => {
      if (typeof value !== 'string') {
        return value
      }

      const next = value.replace(/[\u00a0\s]+/g, ' ').trim()

      if (next !== value) {
        changed++
      }

      return next || null
    })
  )

  return { values: out, changed }
}

/** A number written as text: "1,200", "$5.00", "(300)", "12%", "€ 4.5". Null when it is not one. */
export function parseNumber(value: string): number | null {
  let body = value.trim().replace(/\u00a0/g, ' ')

  if (!body) {
    return null
  }

  const negative = /^\(.*\)$/.test(body) || /^-/.test(body) || /-$/.test(body)
  body = body.replace(/^\(|\)$/g, '').replace(/^-|-$/g, '').trim()
  const percent = body.endsWith('%')
  body = body.replace(/%$/, '').replace(/^[$€£¥₹]|[$€£¥₹]$/g, '').replace(/^(USD|AUD|EUR|GBP|NZD|CAD)\s*|\s*(USD|AUD|EUR|GBP|NZD|CAD)$/i, '').trim()

  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(body)) {
    return null
  }

  const number = Number(body.replace(/,/g, '')) * (negative ? -1 : 1)

  return percent ? number / 100 : number
}

/** Numbers kept as text become numbers. */
export function numberValues(values: readonly CellInput[][]): { values: CellInput[][]; changed: number } {
  let changed = 0
  const out = values.map((row) =>
    row.map((value) => {
      const number = typeof value === 'string' ? parseNumber(value) : null

      if (number === null) {
        return value
      }

      changed++

      return number
    })
  )

  return { values: out, changed }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const monthOf = (name: string): number => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1

const fullYear = (year: number): number => (year < 100 ? (year < 50 ? 2000 + year : 1900 + year) : year)

/** The serial number a spreadsheet keeps a date as: days since 30 December 1899. */
export function dateSerial(year: number, month: number, day: number): number | null {
  const date = new Date(Date.UTC(year, month - 1, day))

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null
  }

  return Math.round((date.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000)
}

export type DayOrder = 'dmy' | 'mdy'

/** A date written as text, as its serial number: ISO, day and month either way round, or with the month's name. */
export function parseDate(value: string, order: DayOrder): number | null {
  const body = value.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ')
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(body)

  if (match) {
    return dateSerial(Number(match[1]), Number(match[2]), Number(match[3]))
  }

  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(body)

  if (match) {
    const [first, second, year] = [Number(match[1]), Number(match[2]), fullYear(Number(match[3]))]
    const [day, month] = order === 'dmy' ? [first, second] : [second, first]

    return dateSerial(year, month, day)
  }

  match = /^(\d{1,2})[ -]([a-z]{3,9})\.?[ -](\d{2}|\d{4})$/i.exec(body)

  if (match && monthOf(match[2])) {
    return dateSerial(fullYear(Number(match[3])), monthOf(match[2]), Number(match[1]))
  }

  match = /^([a-z]{3,9})\.? (\d{1,2}) (\d{2}|\d{4})$/i.exec(body)

  if (match && monthOf(match[1])) {
    return dateSerial(fullYear(Number(match[3])), monthOf(match[1]), Number(match[2]))
  }

  return null
}

/** Which way round day and month go in these dates: a first number over 12 means day first, a second one month first, else `fallback`. */
export function dayOrderOf(values: readonly CellInput[][], fallback: DayOrder): DayOrder {
  for (const row of values) {
    for (const value of row) {
      const match = typeof value === 'string' ? /^\s*(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}\s*$/.exec(value) : null

      if (match && Number(match[1]) > 12) {
        return 'dmy'
      }

      if (match && Number(match[2]) > 12) {
        return 'mdy'
      }
    }
  }

  return fallback
}

/** Dates kept as text become dates; `cells` lists where, for the date format. */
export function dateValues(values: readonly CellInput[][], order: DayOrder): { values: CellInput[][]; cells: { row: number; column: number }[] } {
  const cells: { row: number; column: number }[] = []
  const out = values.map((row, r) =>
    row.map((value, c) => {
      const serial = typeof value === 'string' ? parseDate(value, order) : null

      if (serial === null) {
        return value
      }

      cells.push({ row: r, column: c })

      return serial
    })
  )

  return { values: out, cells }
}

/** Cells grouped into runs down each column, so a format goes on in as few calls as it can. */
export function columnRuns(cells: readonly { row: number; column: number }[]): { row: number; column: number; rows: number }[] {
  const sorted = [...cells].sort((a, b) => a.column - b.column || a.row - b.row)
  const runs: { row: number; column: number; rows: number }[] = []

  for (const cell of sorted) {
    const last = runs[runs.length - 1]

    if (last && last.column === cell.column && last.row + last.rows === cell.row) {
      last.rows++
    } else {
      runs.push({ row: cell.row, column: cell.column, rows: 1 })
    }
  }

  return runs
}

/** Each cell of one column split at `delimiter` into as many columns as the longest needs. */
export function splitValues(column: readonly CellInput[], delimiter: string, header: boolean): { values: CellInput[][]; columns: number } {
  const parts = column.map((value, index) => (header && index === 0 ? [value] : typeof value === 'string' ? value.split(delimiter).map((part) => coerceValue(part.trim()) || null) : [value]))
  const columns = Math.max(1, ...parts.map((row) => row.length))

  return { values: parts.map((row) => Array.from({ length: columns }, (_, index) => row[index] ?? null)), columns }
}

export const delimiterOf = (value: unknown): string => {
  const given = typeof value === 'string' ? value : ''

  return ({ tab: '\t', space: ' ', comma: ',', semicolon: ';', pipe: '|', '': ',' } as Record<string, string>)[given.toLowerCase()] ?? given
}

/** Text in upper, lower or title case. */
export function caseValues(values: readonly CellInput[][], mode: unknown): { values: CellInput[][]; changed: number } {
  const wanted = text(mode).toLowerCase() || 'title'

  if (!['upper', 'lower', 'title'].includes(wanted)) {
    throw new Error(`case is upper, lower or title, not “${wanted}”`)
  }

  let changed = 0
  const out = values.map((row) =>
    row.map((value) => {
      if (typeof value !== 'string') {
        return value
      }

      const next = wanted === 'upper' ? value.toUpperCase() : wanted === 'lower' ? value.toLowerCase() : value.toLowerCase().replace(/(^|[\s\-/(])(\p{L})/gu, (_, before: string, letter: string) => `${before}${letter.toUpperCase()}`)

      if (next !== value) {
        changed++
      }

      return next
    })
  )

  return { values: out, changed }
}

// Batches.

export const SHEET_EDIT_OPS = ['write', 'fill', 'format', 'sort', 'filter', 'freeze', 'addSheet', 'renameSheet', 'removeSheet', 'clean', 'replace'] as const

export type SheetEditOp = (typeof SHEET_EDIT_OPS)[number]

/** The edits of a batch: a list of objects, each with an `op` and that op's arguments. */
export function sheetEditsOf(value: unknown): (Args & { op: SheetEditOp })[] {
  const parsed = parseJsonArg(value, 'edits')

  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error('edits is a list: [{"op": "write", "range": "A1", "values": [["Item", "Cost"]]}, {"op": "format", "range": "A1:B1", "format": {"bold": true}}]')
  }

  if (parsed.length > 100) {
    throw new Error('At most 100 edits in one batch')
  }

  return parsed.map((edit, index) => {
    const op = edit && typeof edit === 'object' ? text((edit as Args).op) : ''
    const found = SHEET_EDIT_OPS.find((name) => name.toLowerCase() === op.toLowerCase())

    if (!found) {
      throw new Error(`Edit ${index + 1}: op is one of ${SHEET_EDIT_OPS.join(', ')}, not “${op}”`)
    }

    return { ...(edit as Args), op: found }
  })
}

// Templates.

export interface SheetTemplate {
  label: string
  values: CellInput[][]
  formats: { range: string; format: Record<string, unknown> }[]
  freeze?: { rows: number; columns: number }
}

export const SHEET_TEMPLATES: Record<string, SheetTemplate> = {
  budget: {
    label: 'Budget',
    values: [
      ['Category', 'Planned', 'Actual', 'Difference'],
      ['Housing', 0, 0, '=B2-C2'],
      ['Food', 0, 0, '=B3-C3'],
      ['Transport', 0, 0, '=B4-C4'],
      ['Fun', 0, 0, '=B5-C5'],
      ['Savings', 0, 0, '=B6-C6'],
      ['Total', '=SUM(B2:B6)', '=SUM(C2:C6)', '=B7-C7']
    ],
    formats: [
      { range: 'A1:D1', format: { bold: true, background: '#e8eefc' } },
      { range: 'B2:D7', format: { numberFormat: '#,##0.00' } },
      { range: 'A7:D7', format: { bold: true } }
    ],
    freeze: { rows: 1, columns: 0 }
  },
  expenses: {
    label: 'Expenses',
    values: [
      ['Date', 'Description', 'Category', 'Amount'],
      [null, null, null, null],
      ['Total', null, null, '=SUM(D2:D2)']
    ],
    formats: [
      { range: 'A1:D1', format: { bold: true, background: '#e8eefc' } },
      { range: 'A2:A2', format: { numberFormat: 'yyyy-mm-dd' } },
      { range: 'D2:D3', format: { numberFormat: '#,##0.00' } },
      { range: 'A3:D3', format: { bold: true } }
    ],
    freeze: { rows: 1, columns: 0 }
  },
  todo: {
    label: 'To-do list',
    values: [['Task', 'Owner', 'Due', 'Done']],
    formats: [{ range: 'A1:D1', format: { bold: true, background: '#e8eefc' } }],
    freeze: { rows: 1, columns: 0 }
  },
  schedule: {
    label: 'Schedule',
    values: [
      ['Time', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      ['09:00', null, null, null, null, null],
      ['10:00', null, null, null, null, null],
      ['11:00', null, null, null, null, null],
      ['12:00', null, null, null, null, null],
      ['13:00', null, null, null, null, null],
      ['14:00', null, null, null, null, null],
      ['15:00', null, null, null, null, null],
      ['16:00', null, null, null, null, null]
    ],
    formats: [{ range: 'A1:F1', format: { bold: true, background: '#e8eefc' } }, { range: 'A2:A9', format: { bold: true } }],
    freeze: { rows: 1, columns: 1 }
  },
  invoice: {
    label: 'Invoice',
    values: [
      ['Invoice', null, null, null],
      ['Number', null, 'Date', null],
      ['Bill to', null, null, null],
      [null, null, null, null],
      ['Item', 'Quantity', 'Unit price', 'Amount'],
      [null, 0, 0, '=B6*C6'],
      [null, 0, 0, '=B7*C7'],
      [null, 0, 0, '=B8*C8'],
      [null, null, 'Total', '=SUM(D6:D8)']
    ],
    formats: [
      { range: 'A1:A1', format: { bold: true, size: 18 } },
      { range: 'A5:D5', format: { bold: true, background: '#e8eefc' } },
      { range: 'C6:D9', format: { numberFormat: '#,##0.00' } },
      { range: 'C9:D9', format: { bold: true } }
    ]
  }
}

const SHEET_TEMPLATE_ALIASES: Record<string, string> = { 'to-do': 'todo', 'to do': 'todo', tasks: 'todo', 'expense report': 'expenses', expense: 'expenses', timetable: 'schedule', bill: 'invoice' }

export function sheetTemplateOf(value: unknown): SheetTemplate & { id: string } {
  const name = text(value).toLowerCase()
  const id = SHEET_TEMPLATES[name] ? name : SHEET_TEMPLATE_ALIASES[name]

  if (!id || !SHEET_TEMPLATES[id]) {
    throw new Error(`template is one of ${Object.keys(SHEET_TEMPLATES).join(', ')}, not “${name}”`)
  }

  return { id, ...SHEET_TEMPLATES[id] }
}

/** Trailing rows and columns with nothing in them go: a range read as a table keeps what it shows. */
export function trimTable(cells: readonly string[][]): string[][] {
  let rows = cells.map((row) => [...row])

  while (rows.length && rows[rows.length - 1].every((cell) => !cell.trim())) {
    rows = rows.slice(0, -1)
  }

  const width = Math.max(0, ...rows.map((row) => row.reduce((last, cell, index) => (cell.trim() ? index + 1 : last), 0)))

  return rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ''))
}
