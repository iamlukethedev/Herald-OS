import { slideFormula } from '../../../../shared/office/xlsx/formula.ts'
import { parseJsonArg } from '../agent-model.ts'
import type { CellInput } from './model.ts'

/*
 * Herald Sheets for Hermes, without a window: values as callers send them, a formula filled across
 * a range, finding and replacing in cells, which cleaning sheets.clean is asked for and which way
 * round day and month go in dates (the cleaning itself is the data tools', in tools/), batches of
 * edits, and the templates a new workbook starts from. Tested directly.
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

export type DayOrder = 'dmy' | 'mdy'

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

// Batches.

/** The ops of a batch that are sheets commands of their own (agent-depth.ts), named as the commands are, so a batch asks as they do. */
export const DEPTH_EDIT_OPS = ['insertChart', 'updateChart', 'moveChart', 'removeChart', 'summarize', 'refreshSummary', 'removeDuplicates', 'splitText', 'trimText', 'changeCase', 'convertToNumbers', 'convertToDates', 'fillDown', 'highlightDuplicates', 'sortBy', 'createName', 'updateName', 'deleteName', 'setValidation', 'clearValidation', 'addComment', 'replyToComment', 'resolveComment', 'deleteComment', 'setNote', 'removeNote'] as const

export type DepthEditOp = (typeof DEPTH_EDIT_OPS)[number]

export const SHEET_EDIT_OPS = ['write', 'fill', 'format', 'sort', 'filter', 'freeze', 'addSheet', 'renameSheet', 'removeSheet', 'clean', 'replace', ...DEPTH_EDIT_OPS] as const

export type SheetEditOp = (typeof SHEET_EDIT_OPS)[number]

export const isDepthEdit = <T extends { op: SheetEditOp }>(edit: T): edit is T & { op: DepthEditOp } => (DEPTH_EDIT_OPS as readonly string[]).includes(edit.op)

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

    if ((edit as Args).preview === true || (edit as Args).preview === 'true') {
      throw new Error(`Edit ${index + 1}: a batch makes its changes, so preview has no place in it: preview with sheets.${found} alone`)
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
