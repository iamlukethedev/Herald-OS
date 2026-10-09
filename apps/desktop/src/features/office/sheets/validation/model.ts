import { DataValidationErrorStyle, DataValidationOperator, DataValidationType, DateSystem, type IDataValidationRule, type IDataValidationRuleOptions } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import type { FWorksheet } from '@univerjs/sheets/facade'
import { type CellRange, columnName, parseRange, quoteSheet, rangeName, splitSheet } from '../../../../../shared/office/xlsx/address.ts'
import { dateOfSerial, listOf, serialOfDate } from '../../../../../shared/office/xlsx/rules.ts'
import { oneStep, rangeOf, type SheetsTarget, sheetOf } from '../model.ts'

/* What Hermes's commands and the menus do with data validation: list dropdowns, number, date, text-length and formula rules with their messages, on a workbook (see ../model.ts). */

export const OPERATORS = ['between', 'notBetween', 'equal', 'notEqual', 'greaterThan', 'lessThan', 'greaterThanOrEqual', 'lessThanOrEqual'] as const
export type Operator = (typeof OPERATORS)[number]
export type Bound = number | string

export type ValidationRule =
  | { type: 'list'; items?: string[]; source?: string }
  | { type: 'whole' | 'decimal' | 'date' | 'textLength'; operator: Operator; value?: Bound; min?: Bound; max?: Bound }
  | { type: 'custom'; formula: string }
  /** Any value goes in: a rule for its input message alone. */
  | { type: 'any' }

export type ErrorStyle = 'stop' | 'warning' | 'information'

export interface ValidationSettings {
  /** The cells the rule covers, as "B2:B9" (several areas with commas). */
  range: string
  /** A rule Herald Sheets reads but does not make ("time", "checkbox") keeps its own type. */
  rule: ValidationRule | { type: 'time' | 'checkbox'; operator?: Operator; value?: Bound; min?: Bound; max?: Bound }
  allowBlank: boolean
  /** Lists only: whether the cell shows the list's arrow. */
  dropdown?: boolean
  input?: { title: string; message: string }
  /** The alert after a value the rule does not allow; null when any value goes in without one. */
  error: { style: ErrorStyle; title: string; message: string } | null
}

const TYPES = ['list', 'whole', 'decimal', 'date', 'textLength', 'custom', 'any'] as const
const STYLES: Record<ErrorStyle, DataValidationErrorStyle> = { stop: DataValidationErrorStyle.STOP, warning: DataValidationErrorStyle.WARNING, information: DataValidationErrorStyle.INFO }
const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/
/** The most characters Excel keeps of a rule's texts and of a list written into it. */
const LIMITS = { inputTitle: 32, inputMessage: 255, errorTitle: 32, errorMessage: 225, list: 255 }

const usesDate1904 = (target: SheetsTarget): boolean => target.workbook.getWorkbook().getDateSystem() === DateSystem.Date1904

/** A bound of a number, date or length rule as Univer keeps it: a number, a date as "yyyy-mm-dd", or a formula with its "=". */
function boundOf(value: unknown, type: 'whole' | 'decimal' | 'date' | 'textLength', what: string): string {
  const text = String(value ?? '').trim()

  if (text.startsWith('=') && text.length > 1) {
    return text
  }

  if (type === 'date') {
    if (serialOfDate(text) === null) {
      throw new Error(`${what} is a date as yyyy-mm-dd (2026-10-09), or a formula like =TODAY(); not “${text}”`)
    }

    return text
  }

  const number = typeof value === 'number' ? value : NUMBER.test(text) ? Number(text) : NaN

  if (!Number.isFinite(number)) {
    throw new Error(`${what} is a number, or a formula like =B1; not “${text}”`)
  }

  if ((type === 'whole' || type === 'textLength') && !Number.isInteger(number)) {
    throw new Error(`${what} is a whole number for ${type === 'whole' ? 'a whole-number rule' : 'a text length'}; not ${number}`)
  }

  if (type === 'textLength' && number < 0) {
    throw new Error(`${what} is a length of text: 0 or more, not ${number}`)
  }

  return String(number)
}

/** Cells a list takes its items from, as Univer keeps them: "='Other sheet'!$A$1:$A$9", on the rule's sheet when none is named. */
function sourceOf(target: SheetsTarget, source: unknown, sheet: FWorksheet): string {
  const text = String(source ?? '').trim().replace(/^=\s*/, '')
  const { sheet: named, ref } = splitSheet(text)
  const range = parseRange(ref)

  if (!range) {
    throw new Error(`source is the cells a list takes its items from, like A2:A9 or 'Lists'!A2:A9; not “${text}”`)
  }

  const on = named ? sheetOf(target.workbook, named) : sheet
  const absolute = (row: number, column: number) => `$${columnName(column)}$${row + 1}`
  const cells = range.startRow === range.endRow && range.startColumn === range.endColumn ? absolute(range.startRow, range.startColumn) : `${absolute(range.startRow, range.startColumn)}:${absolute(range.endRow, range.endColumn)}`

  return `=${named || on.getSheetId() !== sheet.getSheetId() ? `${quoteSheet(on.getSheetName())}!` : ''}${cells}`
}

/** A rule as Univer's criteria (type, operator, formulas), checked. */
function criteriaOf(target: SheetsTarget, rule: unknown, sheet: FWorksheet): { type: DataValidationType; operator?: DataValidationOperator; formula1?: string; formula2?: string } {
  const given = (rule && typeof rule === 'object' ? rule : {}) as Record<string, unknown>
  const type = String(given.type ?? '') as (typeof TYPES)[number]

  if (!TYPES.includes(type)) {
    throw new Error(`A rule's type is ${TYPES.join(', ')}: {"type": "list", "items": ["Yes", "No"]} or {"type": "whole", "operator": "between", "min": 1, "max": 10}`)
  }

  if (type === 'list') {
    if (given.items !== undefined && given.source !== undefined) {
      throw new Error('A list takes its items from items or from source (cells), not both')
    }

    if (given.source !== undefined) {
      return { type: DataValidationType.LIST, formula1: sourceOf(target, given.source, sheet) }
    }

    const items = Array.isArray(given.items) ? given.items.map((item) => String(item ?? '').trim()).filter(Boolean) : []

    if (!items.length) {
      throw new Error('Give the list its items (["Yes", "No"]) or the cells they are in (source: "A2:A9")')
    }

    if (items.some((item) => item.includes(','))) {
      throw new Error('List items cannot have commas in them (Excel separates items with commas): put such items in cells and give their range as source')
    }

    if (items.join(',').length > LIMITS.list) {
      throw new Error(`The items are ${items.join(',').length} characters together; Excel keeps at most ${LIMITS.list} written into a rule: put them in cells and give their range as source`)
    }

    return { type: DataValidationType.LIST, formula1: JSON.stringify([...new Set(items)]) }
  }

  if (type === 'any') {
    return { type: DataValidationType.ANY }
  }

  if (type === 'custom') {
    const formula = String(given.formula ?? '').trim().replace(/^=?\s*/, '')

    if (!formula) {
      throw new Error('A custom rule is a formula that is TRUE for the values allowed, worked out for the first cell: {"type": "custom", "formula": "=B2<=C2"}')
    }

    return { type: DataValidationType.CUSTOM, formula1: `=${formula}` }
  }

  const operator = (given.operator ?? (given.min !== undefined || given.max !== undefined ? 'between' : undefined)) as Operator | undefined

  if (!operator || !OPERATORS.includes(operator)) {
    throw new Error(`Say how to compare: operator is one of ${OPERATORS.join(', ')}`)
  }

  const what = type === 'textLength' ? 'The length' : type === 'date' ? 'The date' : 'The value'

  if (operator === 'between' || operator === 'notBetween') {
    if (given.min === undefined || given.max === undefined || given.min === '' || given.max === '') {
      throw new Error(`${operator} takes a min and a max`)
    }

    const [min, max] = [boundOf(given.min, type, `${what} min`), boundOf(given.max, type, `${what} max`)]
    const order = (bound: string) => (type === 'date' ? serialOfDate(bound) : Number(bound))

    if (!min.startsWith('=') && !max.startsWith('=') && order(min)! > order(max)!) {
      throw new Error(`min (${min}) is more than max (${max})`)
    }

    return { type: type as DataValidationType, operator: operator as DataValidationOperator, formula1: min, formula2: max }
  }

  if (given.value === undefined || given.value === '') {
    throw new Error(`${operator} takes a value`)
  }

  return { type: type as DataValidationType, operator: operator as DataValidationOperator, formula1: boundOf(given.value, type, what) }
}

const textOf = (value: unknown, limit: number, what: string): string => {
  const text = String(value ?? '').trim()

  if (text.length > limit) {
    throw new Error(`${what} is ${text.length} characters long; Excel keeps at most ${limit}`)
  }

  return text
}

/** The messages of a rule as Univer's options: an input message when there is one; an alert unless `error` is false. */
function messagesOf(args: { input?: unknown; error?: unknown }): IDataValidationRuleOptions {
  const input = (args.input && typeof args.input === 'object' ? args.input : {}) as Record<string, unknown>
  const promptTitle = textOf(input.title, LIMITS.inputTitle, 'The input message’s title')
  const prompt = textOf(input.message, LIMITS.inputMessage, 'The input message')

  if (args.error === false || args.error === null) {
    return { showInputMessage: Boolean(promptTitle || prompt), promptTitle, prompt, showErrorMessage: false }
  }

  const error = (args.error && typeof args.error === 'object' ? args.error : {}) as Record<string, unknown>
  const style = String(error.style ?? 'stop') as ErrorStyle

  if (!(style in STYLES)) {
    throw new Error('An error alert’s style is stop (the value is refused), warning (the person may keep it) or information')
  }

  return {
    showInputMessage: Boolean(promptTitle || prompt),
    promptTitle,
    prompt,
    showErrorMessage: true,
    errorStyle: STYLES[style],
    errorTitle: textOf(error.title, LIMITS.errorTitle, 'The error alert’s title'),
    error: textOf(error.message, LIMITS.errorMessage, 'The error message')
  }
}

/** A rule's bounds as people give them: numbers as numbers, dates as "yyyy-mm-dd", formulas with their "=". */
function boundShown(formula: string | undefined, type: string, date1904: boolean): Bound | undefined {
  if (formula === undefined || formula === '') {
    return undefined
  }

  if (formula.startsWith('=') || !NUMBER.test(formula)) {
    return formula
  }

  if (type === 'date') {
    return dateOfSerial(Number(formula), date1904)
  }

  if (type === 'time') {
    return dateOfSerial(Number(formula), false).slice(11) || '00:00'
  }

  return Number(formula)
}

const rangesText = (ranges: CellRange[]): string => ranges.map(rangeName).join(',')

/** A Univer rule as Herald's settings. */
function settingsOf(rule: IDataValidationRule, unitId: string, date1904: boolean): ValidationSettings {
  const type = String(rule.type)
  const range = rangesText(rule.ranges as CellRange[])
  const settings = (shape: ValidationSettings['rule']): ValidationSettings => ({
    range,
    rule: shape,
    allowBlank: rule.allowBlank !== false,
    ...(type === 'list' || type === 'listMultiple' ? { dropdown: rule.showDropDown !== false } : {}),
    ...(rule.showInputMessage ? { input: { title: rule.promptTitle ?? '', message: rule.prompt ?? '' } } : {}),
    error: rule.showErrorMessage ? { style: (Object.entries(STYLES).find(([, value]) => value === rule.errorStyle)?.[0] as ErrorStyle) ?? 'stop', title: rule.errorTitle ?? '', message: rule.error ?? '' } : null
  })

  if (type === 'list' || type === 'listMultiple') {
    const formula = rule.formula1 ?? ''

    return settings(formula.startsWith('=') ? { type: 'list', source: formula.slice(1).split(`[${unitId}]`).join('') } : { type: 'list', items: listOf(formula) })
  }

  if (type === 'custom') {
    return settings({ type: 'custom', formula: rule.formula1 ?? '' })
  }

  if (type === 'whole' || type === 'decimal' || type === 'date' || type === 'textLength' || type === 'time') {
    const operator = (rule.operator ?? 'between') as Operator
    const [first, second] = [boundShown(rule.formula1, type, date1904), boundShown(rule.formula2, type, date1904)]
    const bounds = operator === 'between' || operator === 'notBetween' ? { min: first, max: second } : { value: first }

    return settings({ type, operator, ...bounds } as ValidationSettings['rule'])
  }

  return settings({ type: type === 'checkbox' ? 'checkbox' : 'any' })
}

/**
 * Set what a range takes: a list (items, or cells as source), whole or decimal numbers, dates
 * ("yyyy-mm-dd") or text lengths compared with an operator, a custom formula, or any value (for
 * an input message alone). Blanks are allowed and lists show their arrow unless told not to; the
 * input message shows when the cell is selected; the error alert (stop by default; false for
 * none) follows a value the rule does not allow. Replaces the rules the range had; one step to undo.
 */
export async function setValidation(target: SheetsTarget, args: { range: unknown; rule: unknown; sheet?: unknown; allowBlank?: unknown; dropdown?: unknown; input?: unknown; error?: unknown }): Promise<{ sheet: string; rules: ValidationSettings[] }> {
  const { sheet, range, cells } = rangeOf(target.workbook, args.range, args.sheet)
  const criteria = criteriaOf(target, args.rule, sheet)
  const allowBlank = args.allowBlank !== false && args.allowBlank !== 'false'
  const options: IDataValidationRuleOptions = { ...messagesOf(args), ...(criteria.type === DataValidationType.LIST ? { showDropDown: args.dropdown !== false && args.dropdown !== 'false' } : {}) }

  if (criteria.type === DataValidationType.ANY) {
    if (!options.showInputMessage) {
      throw new Error('A rule that takes any value is there for its input message: give input {"title": …, "message": …}, or clearValidation to take the rules off')
    }

    options.showErrorMessage = false
  }

  const rule = FUniver.newAPI(target.univer).newDataValidation().build()
  rule.setCriteria(criteria.type, [criteria.operator as DataValidationOperator, criteria.formula1 ?? '', criteria.formula2 ?? ''], allowBlank)
  rule.setOptions(options)
  await oneStep(target, () => range.setDataValidation(rule))

  return getValidation(target, { range: rangeName(cells), sheet: sheet.getSheetName() })
}

/** The rules that cover any of a range's cells, each with all the cells it covers. */
export function getValidation(target: SheetsTarget, args: { range: unknown; sheet?: unknown }): { sheet: string; rules: ValidationSettings[] } {
  const { sheet, range } = rangeOf(target.workbook, args.range, args.sheet)
  const date1904 = usesDate1904(target)

  return { sheet: sheet.getSheetName(), rules: range.getDataValidations().map((rule) => settingsOf(rule.rule, target.workbook.getId(), date1904)) }
}

/** Take the rules off a range's cells (the rules keep the rest of their cells); one step to undo. */
export async function clearValidation(target: SheetsTarget, args: { range: unknown; sheet?: unknown }): Promise<{ sheet: string; range: string; cleared: number }> {
  const { sheet, range, cells } = rangeOf(target.workbook, args.range, args.sheet)
  const cleared = range.getDataValidations().length

  if (cleared) {
    await oneStep(target, () => range.setDataValidation(null))
  }

  return { sheet: sheet.getSheetName(), range: rangeName(cells), cleared }
}
