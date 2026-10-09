import { CELL_TYPE, type CellSnapshot, cellsOf, hasContent, plainTextOf, type SheetSnapshot, type WorkbookSnapshot } from '../../../../shared/office/workbook.ts'
import { type CellRange, MAX_COLUMNS as SHEET_COLUMNS, MAX_ROWS as SHEET_ROWS, parseRange, rangeName, splitSheet } from '../../../../shared/office/xlsx/address.ts'
import type { BodyStyle, Box, Deck, Fill, PlaceholderRole, Slide, SlideElement, TableCell, TableElement, TextAlign } from './deck.ts'
import { findSlide, withSlide } from './deck.ts'
import { keepOnSlide } from './elements.ts'
import { isEmptyPlaceholder, layoutPlaceholders, newSlide, placeholderFor } from './layouts.ts'
import type { DeckChange } from './model.ts'
import { cellBody, MAX_COLUMNS, MAX_ROWS, ROW_HEIGHT, settleSpans, tableElement } from './tables.ts'
import { DEFAULT_INSET } from './text.ts'

/*
 * Tables from Herald Sheets' workbooks: a range of a sheet as the text its cells show (numbers in
 * their formats, Excel's common ones worked out here), put on a slide as a table sized to its text,
 * or on slides of their own with the header row repeated when it is too tall for one. The table
 * layout and the estimate of how much text fits a line serve tables from documents too.
 */

// Number formats.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY = 86400000
/** Day 0 of Excel's two date systems, as JavaScript times (as the .xlsx reader counts them). */
const EPOCH = { date1900: Date.UTC(1899, 11, 30), date1904: Date.UTC(1904, 0, 1) }
const PLACEHOLDER = /^[0#?]$/

/** A piece of a number format: a code character, or text shown as it is (quoted, escaped, a space for `_x`, a currency symbol). */
interface Token {
  text: string
  literal: boolean
}

const isCode = (token: Token | undefined, pattern: RegExp): boolean => token !== undefined && !token.literal && pattern.test(token.text)

const joined = (tokens: readonly Token[]): string => tokens.map((token) => token.text).join('')

/** A format's sections (positive; negative; zero; text), split at semicolons outside quotes and brackets. */
function sectionsOf(format: string): string[] {
  const out = ['']
  let quoted = false
  let bracket = false

  for (let i = 0; i < format.length; i++) {
    const char = format[i]

    if (char === '\\' && !quoted) {
      out[out.length - 1] += format.slice(i, i + 2)
      i++
      continue
    }

    if (char === '"' && !bracket) {
      quoted = !quoted
    } else if ((char === '[' || char === ']') && !quoted) {
      bracket = char === '['
    } else if (char === ';' && !quoted && !bracket) {
      out.push('')
      continue
    }

    out[out.length - 1] += char
  }

  return out
}

function tokensOf(section: string): Token[] {
  const out: Token[] = []

  for (let i = 0; i < section.length; i++) {
    const char = section[i]

    if (char === '"') {
      const end = section.indexOf('"', i + 1)
      const close = end < 0 ? section.length : end
      out.push({ text: section.slice(i + 1, close), literal: true })
      i = close
    } else if (char === '\\' || char === '*') {
      // A fill character shows once, as the narrowest column would show it.
      out.push({ text: section[i + 1] ?? '', literal: true })
      i++
    } else if (char === '_') {
      out.push({ text: ' ', literal: true })
      i++
    } else if (char === '[') {
      const end = section.indexOf(']', i + 1)
      const close = end < 0 ? section.length : end
      const inner = section.slice(i + 1, close)
      const currency = /^\$([^-]*)/.exec(inner)
      i = close

      // Colours and conditions ([Red], [>=100]) show nothing.
      if (currency) {
        out.push({ text: currency[1], literal: true })
      } else if (/^(h+|m+|s+)$/i.test(inner)) {
        out.push({ text: `[${inner.toLowerCase()}]`, literal: false })
      }
    } else {
      out.push({ text: char, literal: false })
    }
  }

  return out
}

/** A number (not negative) to `places` decimals as its whole digits and its decimals, rounded as written in decimal: 1.005 to two places is 1.01, as in Excel. */
function decimal(value: number, places: number): { whole: string; fraction: string } {
  const [mantissa, exponent] = Number(value.toPrecision(15)).toExponential().split('e')
  const shifted = Math.round(Number(`${mantissa}e${Number(exponent) + places}`))

  if (!Number.isFinite(shifted)) {
    return { whole: String(Math.round(value)), fraction: '0'.repeat(places) }
  }

  const digits = BigInt(shifted).toString().padStart(places + 1, '0')

  return { whole: digits.slice(0, digits.length - places), fraction: digits.slice(digits.length - places) }
}

/** General: up to eleven characters of digits, or scientific notation beyond them, as Excel shows a number in a column of the standard width. */
function general(value: number): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''

  if (!abs) {
    return '0'
  }

  if (abs >= 1e11 || abs < 1e-9) {
    const [mantissa, exponent] = abs.toExponential(5).split('e')
    const power = Number(exponent)

    return `${sign}${mantissa.replace(/\.?0+$/, '')}E${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`
  }

  const { whole, fraction } = decimal(abs, Math.max(0, 10 - String(Math.floor(abs)).length))
  const decimals = fraction.replace(/0+$/, '')

  return `${sign}${whole}${decimals ? `.${decimals}` : ''}`
}

/** A section with General in it: the number as General, with the section's text about it. */
function withGeneral(list: readonly Token[], value: number): string {
  let out = ''

  for (let i = 0; i < list.length; i++) {
    const word = list.slice(i, i + 7)

    if (word.length === 7 && word.every((token) => !token.literal) && joined(word).toLowerCase() === 'general') {
      out += general(value)
      i += 6
    } else {
      out += list[i].text
    }
  }

  return out
}

/**
 * Whole digits in placeholders: with thousands separators when a comma sits among them, else
 * filled from the right, the first placeholder taking all that are left. Where there is no digit,
 * `0` shows a zero, `?` a space and `#` nothing.
 */
function integerText(whole: string, tokens: readonly Token[]): string {
  const digits = whole === '0' ? '' : whole
  const empty = (token: Token) => (token.text === '0' ? '0' : token.text === '?' ? ' ' : '')

  if (tokens.some((token) => isCode(token, /^,$/))) {
    const least = tokens.filter((token) => isCode(token, /^0$/)).length

    return digits.padStart(least, '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  const leftmost = tokens.findIndex((token) => isCode(token, PLACEHOLDER))
  let rest = digits
  let out = ''

  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]

    if (!isCode(token, PLACEHOLDER)) {
      out = token.text + out
    } else if (i === leftmost) {
      out = (rest || empty(token)) + out
      rest = ''
    } else {
      out = (rest ? rest.slice(-1) : empty(token)) + out
      rest = rest.slice(0, -1)
    }
  }

  return out
}

/** Decimals in placeholders: trailing zeros dropped where `#` stands for them and shown as spaces where `?` does. */
function fractionText(fraction: string, tokens: readonly Token[]): string {
  let out = ''
  let trailing = true

  for (let i = tokens.length - 1; i >= 0; i--) {
    const digit = fraction[i] ?? '0'

    if (trailing && digit === '0' && tokens[i].text !== '0') {
      out = (tokens[i].text === '?' ? ' ' : '') + out
    } else {
      trailing = false
      out = digit + out
    }
  }

  return out
}

/** A number (not negative) in a section of digit placeholders, `minus` putting a sign before it (a negative number in a format of one section). */
function formatDigits(value: number, list: readonly Token[], minus: boolean): string {
  const sign = minus ? '-' : ''
  const places = list.flatMap((token, index) => (isCode(token, PLACEHOLDER) ? [index] : []))

  if (!places.length) {
    return sign + joined(list)
  }

  const marker = list.findIndex((token, index) => index > places[0] && isCode(token, /^e$/i) && isCode(list[index + 1], /^[+-]$/))
  const mantissa = marker < 0 ? places : places.filter((index) => index < marker)
  const first = mantissa[0]
  const last = mantissa[mantissa.length - 1]
  const point = list.findIndex((token, index) => index >= first - 1 && index < last && isCode(token, /^\.$/))
  const whole = point >= first ? list.slice(first, point) : point < 0 ? list.slice(first, last + 1) : []
  const decimals = point >= 0 ? list.slice(point + 1, last + 1).filter((token) => isCode(token, PLACEHOLDER)) : []
  let end = marker < 0 ? last + 1 : places[places.length - 1] + 1
  let scale = 0

  // Commas after the last digit count thousands: each one divides by a thousand.
  while (marker < 0 && isCode(list[end], /^,$/)) {
    scale++
    end++
  }

  let shown = (value * 100 ** list.filter((token) => isCode(token, /^%$/)).length) / 1000 ** scale
  let power = 0

  if (marker >= 0 && shown) {
    power = Math.floor(Math.log10(shown))
    shown /= 10 ** power

    if (decimal(shown, decimals.length).whole.length > 1) {
      shown /= 10
      power++
    }
  }

  const digits = decimal(shown, decimals.length)
  const exponent = marker < 0 ? '' : `${list[marker].text}${power < 0 ? '-' : list[marker + 1].text === '+' ? '+' : ''}${String(Math.abs(power)).padStart(places.filter((index) => index > marker).length, '0')}`
  const number = `${integerText(digits.whole, whole)}${point >= 0 ? `.${fractionText(digits.fraction, decimals)}` : ''}${exponent}`

  return `${sign}${joined(list.slice(0, point >= 0 && point < first ? point : first))}${number}${joined(list.slice(end))}`
}

interface DatePart {
  /** y, m (month), n (minute), d, h, s; H, M and S for elapsed hours, minutes and seconds; ampm, fraction (of a second) or text. */
  kind: string
  width: number
  text: string
}

const DATE_KINDS = new Set(['y', 'm', 'n', 'd', 'h', 's', 'H', 'M', 'S'])

/** A serial date and time in a date format: days since the date system's day 0, the time of day as the fraction. */
function formatDate(serial: number, list: readonly Token[], date1904: boolean): string {
  const parts: DatePart[] = []

  for (let i = 0; i < list.length; i++) {
    const token = list[i]
    const lower = token.text.toLowerCase()
    const ahead = joined(list.slice(i, i + 5))

    if (token.literal) {
      parts.push({ kind: 'text', width: 0, text: token.text })
    } else if (lower.startsWith('[')) {
      parts.push({ kind: lower[1].toUpperCase(), width: lower.length - 2, text: '' })
    } else if ('ymdhs'.includes(lower)) {
      let width = 1

      while (isCode(list[i + width], new RegExp(`^${lower}$`, 'i'))) {
        width++
      }

      parts.push({ kind: lower, width, text: '' })
      i += width - 1
    } else if (/^am\/pm/i.test(ahead) || /^a\/p/i.test(ahead)) {
      const marker = /^am\/pm/i.test(ahead) ? ahead.slice(0, 5) : ahead.slice(0, 3)
      parts.push({ kind: 'ampm', width: 0, text: marker })
      i += marker.length - 1
    } else if (lower === '.' && parts[parts.length - 1]?.kind === 's' && isCode(list[i + 1], /^0$/)) {
      let width = 0

      while (isCode(list[i + 1 + width], /^0$/)) {
        width++
      }

      parts.push({ kind: 'fraction', width, text: '' })
      i += width
    } else {
      parts.push({ kind: 'text', width: 0, text: token.text })
    }
  }

  // An m of one or two letters after hours or before seconds is minutes.
  parts.forEach((part, index) => {
    if (part.kind !== 'm' || part.width > 2) {
      return
    }

    const before = parts.slice(0, index).findLast((entry) => DATE_KINDS.has(entry.kind))
    const after = parts.slice(index + 1).find((entry) => DATE_KINDS.has(entry.kind))

    if (before?.kind === 'h' || before?.kind === 'H' || after?.kind === 's' || after?.kind === 'S') {
      part.kind = 'n'
    }
  })

  const precision = Math.min(3, Math.max(0, ...parts.filter((part) => part.kind === 'fraction').map((part) => part.width)))
  const perSecond = 10 ** precision
  const units = Math.round(serial * 86400 * perSecond)
  const days = Math.floor(units / (86400 * perSecond))
  const within = units - days * 86400 * perSecond
  const seconds = Math.floor(within / perSecond)
  const elapsed = Math.floor(units / perSecond)
  const date = new Date((date1904 ? EPOCH.date1904 : EPOCH.date1900) + days * DAY)
  const [year, month, day, weekday] = [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCDay()]
  const hour = Math.floor(seconds / 3600)
  const twelve = parts.some((part) => part.kind === 'ampm')
  const pad = (n: number, width: number) => String(n).padStart(width, '0')

  return parts
    .map((part) => {
      switch (part.kind) {
        case 'y':
          return part.width > 2 ? String(year) : pad(year % 100, 2)
        case 'm':
          return part.width === 1 ? String(month + 1) : part.width === 2 ? pad(month + 1, 2) : part.width === 3 ? MONTHS[month].slice(0, 3) : part.width === 5 ? MONTHS[month][0] : MONTHS[month]
        case 'd':
          return part.width === 1 ? String(day) : part.width === 2 ? pad(day, 2) : part.width === 3 ? WEEKDAYS[weekday].slice(0, 3) : WEEKDAYS[weekday]
        case 'h':
          return pad(twelve ? hour % 12 || 12 : hour, Math.min(2, part.width))
        case 'n':
          return pad(Math.floor(seconds / 60) % 60, Math.min(2, part.width))
        case 's':
          return pad(seconds % 60, Math.min(2, part.width))
        case 'H':
          return pad(Math.floor(elapsed / 3600), part.width)
        case 'M':
          return pad(Math.floor(elapsed / 60), part.width)
        case 'S':
          return pad(elapsed, part.width)
        case 'ampm':
          return part.text.split('/')[hour < 12 ? 0 : 1]
        case 'fraction':
          return `.${pad(within % perSecond, precision).slice(0, part.width)}`
        default:
          return part.text
      }
    })
    .join('')
}

/**
 * A number as a cell in an Excel number format shows it: General; digits with thousands
 * separators, decimals and thousands scaling; percentages; currency and other text about the
 * number; scientific notation; and dates and times, counted in the 1900 date system unless
 * `date1904`. A format may have a section for negative numbers and one for zero. Fractions are
 * shown as General.
 */
export function formatNumber(value: number, format = 'General', date1904 = false): string {
  if (!Number.isFinite(value)) {
    return '#NUM!'
  }

  const sections = sectionsOf(format.trim() || 'General')
  const negative = value < 0 && sections.length > 1
  const section = negative ? sections[1] : value === 0 && sections.length > 2 ? sections[2] : sections[0]
  const shown = negative ? -value : value
  const list = tokensOf(section)
  const code = joined(list.filter((token) => !token.literal))

  if (/general/i.test(code)) {
    return withGeneral(list, shown).trim()
  }

  if (/[ymdhs[]|am\/pm|a\/p/i.test(code)) {
    return formatDate(shown, list, date1904).trim()
  }

  // Fractions, and a number in the text format (@), show as General.
  if (/[0#?]\s*\/\s*[0-9#?]/.test(code) || (code.includes('@') && !/[0#?]/.test(code))) {
    return general(shown)
  }

  return formatDigits(Math.abs(shown), list, shown < 0).trim()
}

// Ranges of cells.

/** A cell as it shows: its text, whether it holds a number (dates and times do), how it lines up and whether it is bold or italic. */
export interface SheetCell {
  text: string
  number: boolean
  /** Its own alignment, else right for a number. */
  align?: TextAlign
  bold?: boolean
  italic?: boolean
}

export interface SheetRange {
  /** The range taken, in A1 style; empty when there was nothing to take. */
  ref: string
  /** Its cells row by row, a cell for each column, without the sheet's hidden rows and columns. */
  cells: SheetCell[][]
  /** Its merged cells, by row and column of `cells`. */
  merges: CellRange[]
}

/** The style settings a cell's text shows in: Univer's number format, bold, italic and alignment. */
interface CellStyle {
  n?: { pattern?: unknown } | null
  bl?: unknown
  it?: unknown
  ht?: unknown
}

type Lines = Record<number, { s?: unknown; hd?: unknown } | undefined>

/** Univer's horizontal alignments. */
const ALIGNS: Record<number, TextAlign> = { 1: 'left', 2: 'center', 3: 'right', 4: 'justify' }

function styleFrom(style: unknown, styles: Record<string, unknown>): CellStyle | undefined {
  const found = typeof style === 'string' ? styles[style] : style

  return found && typeof found === 'object' ? (found as CellStyle) : undefined
}

/** A cell's number, unless it is text (a number kept as text stays text). */
function numberOf(cell: CellSnapshot | undefined): number | null {
  const value = cell?.v

  if (!cell || cell.t === CELL_TYPE.string || cell.t === CELL_TYPE.text) {
    return null
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  return typeof value === 'string' && cell.t === CELL_TYPE.number && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null
}

/** What a cell shows: rich text as its text, a number in its format (its own, else its column's, else its row's), a boolean as TRUE or FALSE, a formula as its last result. */
function shownCell(sheet: SheetSnapshot, row: number, column: number, styles: Record<string, unknown>, date1904: boolean): SheetCell {
  const cell = sheet.cellData?.[row]?.[column]
  const layers = [styleFrom(cell?.s, styles), styleFrom((sheet.columnData as Lines | undefined)?.[column]?.s, styles), styleFrom((sheet.rowData as Lines | undefined)?.[row]?.s, styles)]
  const pick = <K extends keyof CellStyle>(key: K): CellStyle[K] => layers.find((layer) => layer?.[key] !== undefined && layer?.[key] !== null)?.[key]
  const value = cell?.v
  const ht = pick('ht')
  const own = typeof ht === 'number' ? ALIGNS[ht] : undefined
  const looks = { ...(own ? { align: own } : {}), ...(pick('bl') === 1 ? { bold: true } : {}), ...(pick('it') === 1 ? { italic: true } : {}) }
  const number = numberOf(cell)

  if (cell?.t === CELL_TYPE.boolean || typeof value === 'boolean') {
    return { text: value === true || value === 1 || value === '1' || String(value).toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE', number: false, ...looks }
  }

  if (number !== null) {
    const pattern = pick('n')?.pattern

    return { text: formatNumber(number, typeof pattern === 'string' ? pattern : undefined, date1904), number: true, align: 'right', ...looks }
  }

  return { text: plainTextOf(cell) || (value === undefined || value === null ? '' : String(value)), number: false, ...looks }
}

function mergesOf(sheet: SheetSnapshot): CellRange[] {
  return (sheet.mergeData ?? []).flatMap((entry) => {
    const merge = (entry ?? {}) as Partial<CellRange>

    return [merge.startRow, merge.startColumn, merge.endRow, merge.endColumn].every((n) => Number.isInteger(n) && n! >= 0) ? [merge as CellRange] : []
  })
}

/** The cells a sheet has anything in, merged cells reaching as far as they do; null for an empty sheet. */
function usedRange(sheet: SheetSnapshot): CellRange | null {
  let [top, left, bottom, right] = [Infinity, Infinity, -1, -1]

  for (const { row, column, cell } of cellsOf(sheet)) {
    if (hasContent(cell)) {
      ;[top, left, bottom, right] = [Math.min(top, row), Math.min(left, column), Math.max(bottom, row), Math.max(right, column)]
    }
  }

  for (const merge of mergesOf(sheet)) {
    if (hasContent(sheet.cellData?.[merge.startRow]?.[merge.startColumn])) {
      ;[top, left, bottom, right] = [Math.min(top, merge.startRow), Math.min(left, merge.startColumn), Math.max(bottom, merge.endRow), Math.max(right, merge.endColumn)]
    }
  }

  return bottom < 0 ? null : { startRow: top, startColumn: left, endRow: bottom, endColumn: right }
}

/** The indexes from `from` to `to` that are not hidden, at most `most` of them. */
function shownLines(from: number, to: number, most: number, lines: Lines | undefined): number[] {
  const out: number[] = []

  for (let index = from; index <= to && out.length < most; index++) {
    if (!lines?.[index]?.hd) {
      out.push(index)
    }
  }

  return out
}

/**
 * A range of a sheet as its cells show: `A1:D10` style (a sheet's name before it, as in
 * `Sheet2!A1:D10`, is passed over, the sheet being given), whole columns (`A:C`) or rows (`3:5`)
 * as far as the sheet is used, and no range the used range. Hidden rows and columns are left out, and at most
 * MAX_ROWS rows and MAX_COLUMNS columns are taken, as a table holds. The workbook gives the styles
 * the cells name and its date system.
 */
export function sheetRange(sheet: SheetSnapshot, range?: string, workbook?: Pick<WorkbookSnapshot, 'styles'> & { dateSystem?: unknown }): SheetRange {
  const ref = range?.trim() ? splitSheet(range.trim()).ref : ''
  const asked = ref ? parseRange(ref) : null

  if (ref && !asked) {
    throw new Error(`${range} is not a range of cells; give one such as A1:D10`)
  }

  const used = usedRange(sheet)
  const wholeColumns = asked !== null && asked.startRow === 0 && asked.endRow >= SHEET_ROWS - 1
  const wholeRows = asked !== null && asked.startColumn === 0 && asked.endColumn >= SHEET_COLUMNS - 1
  let bounds = asked ?? used

  if (asked && (wholeColumns || wholeRows)) {
    bounds = used && { ...asked, ...(wholeColumns ? { startRow: used.startRow, endRow: used.endRow } : {}), ...(wholeRows ? { startColumn: used.startColumn, endColumn: used.endColumn } : {}) }
  }

  const rows = bounds ? shownLines(bounds.startRow, bounds.endRow, MAX_ROWS, sheet.rowData as Lines | undefined) : []
  const columns = bounds ? shownLines(bounds.startColumn, bounds.endColumn, MAX_COLUMNS, sheet.columnData as Lines | undefined) : []

  if (!rows.length || !columns.length) {
    return { ref: '', cells: [], merges: [] }
  }

  const styles = workbook?.styles ?? {}
  const date1904 = workbook?.dateSystem === 'date1904'
  const cells = rows.map((row) => columns.map((column) => shownCell(sheet, row, column, styles, date1904)))
  const merges: CellRange[] = []

  for (const merge of mergesOf(sheet)) {
    const down = rows.flatMap((row, index) => (row >= merge.startRow && row <= merge.endRow ? [index] : []))
    const across = columns.flatMap((column, index) => (column >= merge.startColumn && column <= merge.endColumn ? [index] : []))

    if (down.length && across.length && down.length * across.length > 1) {
      merges.push({ startRow: down[0], startColumn: across[0], endRow: down[down.length - 1], endColumn: across[across.length - 1] })
      cells[down[0]][across[0]] = shownCell(sheet, merge.startRow, merge.startColumn, styles, date1904)
    }
  }

  return { ref: rangeName({ startRow: rows[0], startColumn: columns[0], endRow: rows[rows.length - 1], endColumn: columns[columns.length - 1] }), cells, merges }
}

/** A workbook's sheet by name or id, else the one in front, else the first. */
function sheetOf(workbook: WorkbookSnapshot, name?: string): SheetSnapshot {
  const sheets = workbook.sheetOrder.map((id) => workbook.sheets[id]).filter(Boolean)

  if (name) {
    const found = sheets.find((sheet) => sheet.name === name) ?? sheets.find((sheet) => sheet.id === name) ?? sheets.find((sheet) => sheet.name.toLowerCase() === name.toLowerCase())

    if (!found) {
      throw new Error(`There is no sheet called ${name}; the workbook has ${sheets.map((sheet) => sheet.name).join(', ')}`)
    }

    return found
  }

  const sheet = (typeof workbook.activeSheetId === 'string' ? workbook.sheets[workbook.activeSheetId] : undefined) ?? sheets[0]

  if (!sheet) {
    throw new Error('The workbook has no sheets')
  }

  return sheet
}

/** The range asked for on its sheet (the range's own sheet first, as in `Sheet2!A1:B5`), with something in it. */
function takeRange(workbook: WorkbookSnapshot, options: { sheet?: string; range?: string }): { sheet: SheetSnapshot; taken: SheetRange } {
  const sheet = sheetOf(workbook, (options.range ? splitSheet(options.range.trim()).sheet : undefined) ?? options.sheet)
  const taken = sheetRange(sheet, options.range, workbook)

  if (!taken.cells.length) {
    throw new Error(options.range ? `There is nothing to show in ${options.range} on ${sheet.name}` : `${sheet.name} is empty`)
  }

  return { sheet, taken }
}

// Laying out tables and text.

/** A cell to lay out in a table: its text (a line a paragraph), and how it lines up and stands out. */
export interface GridCell {
  text: string
  align?: TextAlign
  bold?: boolean
  italic?: boolean
}

/** Single line spacing, as a multiple of the text's size. */
export const LINE = 1.2
/** About how wide a character of text is, as a share of its size (a proportional face's average). */
const CHARACTER = 0.5
/** How much wider bold text is. */
const BOLD = 1.1
/** The sizes a table's text is tried at, largest first. */
const TABLE_SIZES = [18, 16, 14, 12]
const HEADER: Fill = { color: 'accent1' }
/** Herald's content area on a slide of 960 by 540 points: the text of its Title and Content layout. */
const CONTENT: Box = { x: 60, y: 136, width: 840, height: 364 }
/** The room between a title and what is under it, on a slide 540 points tall. */
const UNDER_TITLE = 16
const ACROSS = DEFAULT_INSET[0] + DEFAULT_INSET[2]

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

function wrapped(line: string, perLine: number): number {
  let lines = 1
  let used = 0

  for (const word of line.split(/\s+/)) {
    let length = [...word].length

    if (!length) {
      continue
    }

    if (used && used + 1 + length <= perLine) {
      used += 1 + length
      continue
    }

    if (used) {
      lines++
    }

    while (length > perLine) {
      lines++
      length -= perLine
    }

    used = length
  }

  return lines
}

/** About how many lines text takes in a box `width` points wide at `size` points: each of its lines wrapped at spaces, a word too long for a line broken. */
export function lineCount(text: string, width: number, size: number, character = CHARACTER): number {
  const perLine = Math.max(1, Math.floor(width / (size * character)))

  return text.split('\n').reduce((total, line) => total + wrapped(line, perLine), 0)
}

/** A table row's height for lines of text at `size` points: PowerPoint's 29.2 points for a line at 18. */
const rowHeight = (lines: number, size: number): number => ROW_HEIGHT + (lines * size - 18) * LINE

interface Layout {
  size: number
  columns: number[]
  rows: number[]
}

/** How far each cell reaches across and down from its top left; null where a merged cell covers it. */
type Reach = { across: number; down: number } | null

function reachOf(rows: number, columns: number, merges: readonly CellRange[]): Reach[][] {
  const reach: Reach[][] = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ({ across: 1, down: 1 })))

  for (const merge of merges) {
    const bottom = Math.min(rows - 1, merge.endRow)
    const right = Math.min(columns - 1, merge.endColumn)

    if (merge.startRow > bottom || merge.startColumn > right || !reach[merge.startRow][merge.startColumn]) {
      continue
    }

    for (let row = merge.startRow; row <= bottom; row++) {
      for (let column = merge.startColumn; column <= right; column++) {
        reach[row][column] = null
      }
    }

    reach[merge.startRow][merge.startColumn] = { across: right - merge.startColumn + 1, down: bottom - merge.startRow + 1 }
  }

  return reach
}

/** Columns across `width` in proportion to their text (none more than half of it), and each row as tall as its text wraps to, at `size` points. */
function layoutAt(cells: readonly GridCell[][], reach: readonly Reach[][], size: number, width: number, header: boolean): Layout {
  const factor = (cell: GridCell, row: number) => CHARACTER * ((header && row === 0) || cell.bold ? BOLD : 1)
  const wide = (cell: GridCell, row: number) => Math.max(...cell.text.split('\n').map((line) => [...line].length)) * size * factor(cell, row) + ACROSS + size / 2
  const natural = (cells[0] ?? []).map((_, column) => Math.min(width / 2, Math.max(size * 2 + ACROSS, ...cells.map((row, r) => (reach[r][column]?.across === 1 ? wide(row[column], r) : 0)))))
  const columns = natural.map((part) => (part * width) / sum(natural))
  const rows = cells.map((row, r) =>
    Math.max(
      rowHeight(1, size),
      ...row.map((cell, column) => {
        const span = reach[r][column]

        return span && span.down === 1 ? rowHeight(lineCount(cell.text, sum(columns.slice(column, column + span.across)) - ACROSS, size, factor(cell, r)), size) : 0
      })
    )
  )

  return { size, columns, rows }
}

/** Rows in groups that each fit `room` points, the header row heading every group. */
function groupsOf(rows: readonly number[], header: boolean, room: number): number[][] {
  const head = header ? [0] : []
  const groups: number[][] = []
  let group: number[] = []
  let used = header ? rows[0] : 0

  for (let row = head.length; row < rows.length; row++) {
    if (group.length && used + rows[row] > room) {
      groups.push([...head, ...group])
      group = []
      used = header ? rows[0] : 0
    }

    group.push(row)
    used += rows[row]
  }

  if (group.length || !groups.length) {
    groups.push([...head, ...group])
  }

  return groups
}

/** A table of some rows of the grid (`group`), its merged cells cut to the rows it has. */
function tableOf(grid: readonly GridCell[][], merges: readonly CellRange[], layout: Layout, group: readonly number[], header: boolean, area: Box): TableElement {
  const heights = group.map((row) => layout.rows[row])
  const box = { x: area.x, y: area.y, width: sum(layout.columns), height: sum(heights) }
  // The default table's bands, as its rows under the header have them.
  const made = tableElement(box, 3, 1)
  const bands = [made.cells[1][0].fill, made.cells[2][0].fill]
  const at = new Map(group.map((row, index) => [row, index]))
  const starts = new Map<string, { across: number; down: number; cell: GridCell }>()
  const count = layout.columns.length
  const numeric = (grid[0] ?? []).map((_, column) => {
    const below = grid.slice(1).filter((row) => row[column].text.trim())

    return below.length > 0 && below.every((row) => row[column].align === 'right')
  })

  for (const merge of merges) {
    const across = Math.min(count - 1, merge.endColumn) - merge.startColumn + 1
    const runs: number[][] = []

    for (const row of group) {
      const run = runs[runs.length - 1]

      if (row < merge.startRow || row > merge.endRow) {
        continue
      }

      if (run && row === run[run.length - 1] + 1) {
        run.push(row)
      } else {
        runs.push([row])
      }
    }

    for (const run of runs) {
      if (across * run.length > 1) {
        starts.set(`${at.get(run[0])}:${merge.startColumn}`, { across, down: run.length, cell: grid[merge.startRow][merge.startColumn] })
      }
    }
  }

  const cells = group.map((row, index) =>
    grid[row].map((own, column): TableCell => {
      const start = starts.get(`${index}:${column}`)
      const cell = start?.cell ?? own
      const head = header && row === 0
      const italic = cell.italic ? { italic: true } : {}
      const style: Partial<BodyStyle> = head ? { size: layout.size, color: 'bg1', bold: true, ...italic } : { size: layout.size, ...(cell.bold ? { bold: true } : {}), ...italic }
      const body = cellBody(style, cell.text)
      const align = cell.align ?? (head && numeric[column] ? 'right' : undefined)

      return {
        body: align ? { ...body, paragraphs: body.paragraphs.map((paragraph) => ({ ...paragraph, align })) } : body,
        fill: head ? HEADER : bands[(header ? index - 1 : index) % 2],
        ...(start ? { colSpan: start.across, rowSpan: start.down } : {})
      }
    })
  )

  return { ...made, columns: [...layout.columns], rows: heights, width: box.width, height: box.height, cells: settleSpans(cells, count) }
}

/**
 * Cells as tables in `area`: as wide as the area, columns in proportion to their text, at the
 * largest text size from 18 points down to 12 at which every row fits. Too tall even at 12 points,
 * the rows run on below the area, or with `split` go on in further tables of what fits, the header
 * row heading each. The header row is bold in the background colour on the first accent (numbers'
 * headings right-aligned over them); the other rows take the default table's bands.
 */
export function tablesFor(cells: readonly (readonly GridCell[])[], merges: readonly CellRange[], area: Box, options: { header: boolean; split: boolean }): TableElement[] {
  if (!cells.length) {
    return []
  }

  const count = Math.max(1, ...cells.map((row) => row.length))
  const grid = cells.map((row) => Array.from({ length: count }, (_, column) => row[column] ?? { text: '' }))
  const reach = reachOf(grid.length, count, merges)
  let layout = layoutAt(grid, reach, TABLE_SIZES[0], area.width, options.header)

  for (const size of TABLE_SIZES.slice(1)) {
    if (sum(layout.rows) <= area.height) {
      break
    }

    layout = layoutAt(grid, reach, size, area.width, options.header)
  }

  const groups = options.split ? groupsOf(layout.rows, options.header, area.height) : [grid.map((_, row) => row)]

  return groups.map((group) => tableOf(grid, merges, layout, group, options.header, area))
}

/**
 * Where a table or a block goes on a slide: in place of its empty text placeholder; else under its
 * title, across the deck's content area (its Title and Content layout's text) and down to its
 * foot; else that area.
 */
export function contentArea(deck: Pick<Deck, 'size' | 'master'>, slide: Slide): { box: Box; replaces?: SlideElement } {
  const body = placeholderFor(slide, 'body')

  if (body && isEmptyPlaceholder(body)) {
    return { box: { x: body.x, y: body.y, width: body.width, height: body.height }, replaces: body }
  }

  const sx = deck.size.width / 960
  const sy = deck.size.height / 540
  const content = layoutPlaceholders('title-content', deck.size, deck.master).find((spec) => spec.role === 'body')?.box ?? { x: CONTENT.x * sx, y: CONTENT.y * sy, width: CONTENT.width * sx, height: CONTENT.height * sy }
  const title = placeholderFor(slide, 'title')
  const bottom = content.y + content.height
  const top = title ? Math.max(content.y, title.y + title.height + UNDER_TITLE * sy) : content.y

  return { box: bottom - top >= content.height / 4 ? { x: content.x, y: top, width: content.width, height: bottom - top } : { ...content } }
}

/** A slide whose placeholder of `role` holds `text`, a paragraph a line in its first paragraph's settings. */
export function withPlaceholderText(slide: Slide, role: PlaceholderRole, text: string, nth = 0): Slide {
  const element = placeholderFor(slide, role, nth)

  if (!element || (element.kind !== 'text' && element.kind !== 'shape')) {
    return slide
  }

  const first = element.body.paragraphs[0]
  const paragraphs = text.split('\n').map((line) => ({ ...first, runs: [{ text: line }] }))

  return { ...slide, elements: slide.elements.map((entry) => (entry.id === element.id ? { ...element, body: { ...element.body, paragraphs } } : entry)) }
}

/** The deck with slides after `after` (at the end without one, or when it is not there), as a new slide goes in. */
export function insertSlides(deck: Deck, slides: readonly Slide[], after?: string | null): Deck {
  const index = after ? deck.slides.findIndex((slide) => slide.id === after) + 1 : deck.slides.length
  const next = [...deck.slides]
  next.splice(index > 0 ? index : next.length, 0, ...slides)

  return { ...deck, slides: next }
}

// Tables from sheets.

/**
 * A range of a sheet (the one in front unless `sheet` names one) as a table on a slide: in place of
 * its empty text placeholder, else under its title, else in its content area, or in `box`, at a
 * text size its rows fit. The range's first row is the header unless `header` is false. Says which
 * sheet and range (A1 style) it took.
 */
export function addTableFromSheet(deck: Deck, slideId: string, workbook: WorkbookSnapshot, options: { sheet?: string; range?: string; header?: boolean; box?: Box } = {}): DeckChange & { elementId: string; sheet: string; range: string } {
  const slide = findSlide(deck, slideId)

  if (!slide) {
    throw new Error(`There is no slide ${slideId} in this presentation`)
  }

  const { sheet, taken } = takeRange(workbook, options)
  const { box, replaces } = options.box ? { box: options.box, replaces: undefined } : contentArea(deck, slide)
  const [table] = tablesFor(taken.cells, taken.merges, box, { header: options.header ?? true, split: false })
  const placed = keepOnSlide(table, deck.size)

  return {
    deck: withSlide(deck, slideId, (entry) => ({ ...entry, elements: [...entry.elements.filter((element) => element.id !== replaces?.id), placed] })),
    label: 'Table from Sheet',
    elementId: placed.id,
    sheet: sheet.name,
    range: taken.ref,
    focus: { slideId, selected: [placed.id] }
  }
}

/**
 * A range of a sheet on a new Title Only slide after `after` (at the end without one), titled with
 * the sheet's name unless `title` is given. A range too tall for the slide goes on over further
 * slides titled "… (continued)", the header row repeated on each. Says which sheet and range it took.
 */
export function addSlideFromSheet(deck: Deck, workbook: WorkbookSnapshot, options: { sheet?: string; range?: string; title?: string; header?: boolean; after?: string | null } = {}): DeckChange & { slideIds: string[]; sheet: string; range: string } {
  const { sheet, taken } = takeRange(workbook, options)
  const title = options.title ?? sheet.name
  const slideFor = (index: number) => withPlaceholderText(newSlide('title-only', deck.size, deck.master), 'title', index ? `${title} (continued)` : title)
  const first = slideFor(0)
  const tables = tablesFor(taken.cells, taken.merges, contentArea(deck, first).box, { header: options.header ?? true, split: true })
  const slides = tables.map((table, index) => {
    const slide = index ? slideFor(index) : first

    return { ...slide, elements: [...slide.elements, table] }
  })

  return {
    deck: insertSlides(deck, slides, options.after),
    label: slides.length > 1 ? 'Slides from Sheet' : 'Slide from Sheet',
    slideIds: slides.map((slide) => slide.id),
    sheet: sheet.name,
    range: taken.ref,
    focus: { slideId: slides[0].id, selected: [] }
  }
}
