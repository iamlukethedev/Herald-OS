import type { ConditionalFormattingOptions, ConditionalFormattingRule, Style } from 'exceljs'
import { type CellRange, cellName, parseCell, parseRange, parseRanges, rangeName, splitSheet } from './address.ts'
import { argbOf, type ExcelColor, type Palette, resolveColor } from './colors.ts'
import { formulaFromExcel, formulaToExcel } from './formula.ts'
import { excelFont, fontStyle, type UStyle } from './styles.ts'
import { decodeXml, elementsOf, encodeXml, firstElement, textOf } from './xml.ts'

/*
 * The sheet features Univer keeps in its plugins' resources (data validation, filters, conditional
 * formats, defined names) and links in cells, between a file's XML or ExcelJS's model and Univer's
 * JSON. Each reader says what it could not map; each writer what the file cannot keep.
 */

export const RESOURCES = {
  definedNames: 'SHEET_DEFINED_NAME_PLUGIN',
  filter: 'SHEET_FILTER_PLUGIN',
  validation: 'SHEET_DATA_VALIDATION_PLUGIN',
  conditional: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN'
} as const

export interface Resource {
  name: string
  data: string
}

export function readResource<T>(resources: unknown, name: string): T | null {
  const found = Array.isArray(resources) ? (resources as Resource[]).find((resource) => resource?.name === name) : undefined

  if (!found?.data) {
    return null
  }

  try {
    return JSON.parse(found.data) as T
  } catch {
    return null
  }
}

let nextId = 0

/** An id for a rule or link that is unique in this workbook. */
export const ruleId = (prefix: string): string => `${prefix}${(++nextId).toString(36)}${Math.random().toString(36).slice(2, 6)}`

const withSheet = (range: CellRange) => ({ ...range, rangeType: 0 })

export interface UValidation {
  uid: string
  ranges: CellRange[]
  type: string
  allowBlank?: boolean
  formula1?: string
  formula2?: string
  operator?: string
  showDropDown?: boolean
  showErrorMessage?: boolean
  error?: string
  errorStyle?: number
  errorTitle?: string
  showInputMessage?: boolean
  prompt?: string
  promptTitle?: string
}

/** Univer's `DataValidationErrorStyle`. */
const ERROR_STYLE: Record<string, number> = { information: 0, stop: 1, warning: 2 }
const TYPES = new Set(['whole', 'decimal', 'list', 'date', 'time', 'textLength', 'custom'])
const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/

/** A list written in a rule (`"a,b,c"`) as its items; null when the rule refers to cells or a name. */
function listItems(formula: string): string[] | null {
  const match = /^"((?:[^"]|"")*)"$/.exec(formula.trim())

  return match ? match[1].replace(/""/g, '"').split(',').map((item) => item.trim()).filter(Boolean) : null
}

const isTrue = (value: string | undefined): boolean => value === '1' || value === 'true'

/** A sheet's data validation, regular and Excel 2010 extension (`x14:`) rules, from the XML after its cells. */
export function validationsFromXml(tail: string): UValidation[] {
  const rules: UValidation[] = []

  for (const { attributes, inner } of elementsOf(tail, 'dataValidation')) {
    const ranges = parseRanges(attributes.sqref ?? textOf(inner, 'sqref') ?? '')
    const type = attributes.type ?? 'none'

    if (!ranges.length || (type !== 'none' && !TYPES.has(type))) {
      continue
    }

    const formula = (name: string): string | undefined => {
      const text = textOf(inner, name)?.trim()

      if (!text) {
        return undefined
      }

      if (type === 'list') {
        const items = listItems(text)

        return items ? JSON.stringify(items) : formulaFromExcel(text)
      }

      return NUMBER.test(text) ? text : formulaFromExcel(text)
    }
    const rule: UValidation = { uid: ruleId('dv'), ranges, type: type === 'none' ? 'any' : type }
    const formula1 = formula('formula1')
    const formula2 = formula('formula2')

    if (formula1 !== undefined) {
      rule.formula1 = formula1
    }

    if (formula2 !== undefined) {
      rule.formula2 = formula2
    }

    if (['whole', 'decimal', 'date', 'time', 'textLength'].includes(type)) {
      rule.operator = attributes.operator ?? 'between'
    }

    rule.allowBlank = isTrue(attributes.allowBlank)
    rule.showErrorMessage = isTrue(attributes.showErrorMessage)
    rule.showInputMessage = isTrue(attributes.showInputMessage)
    rule.errorStyle = ERROR_STYLE[attributes.errorStyle ?? 'stop'] ?? 1

    // In the file, showDropDown="1" hides the list's arrow.
    if (type === 'list') {
      rule.showDropDown = !isTrue(attributes.showDropDown)
    }

    for (const key of ['error', 'errorTitle', 'prompt', 'promptTitle'] as const) {
      if (attributes[key]) {
        rule[key] = attributes[key]
      }
    }

    rules.push(rule)
  }

  return rules
}

const sqref = (ranges: CellRange[]): string => ranges.map(rangeName).join(' ')

/** Text for an attribute value: line breaks and tabs as character references, as a parser would turn them into spaces. */
export const attributeXml = (text: string): string => encodeXml(text).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;')

const DAY = 86400000
const EPOCH = { date1900: Date.UTC(1899, 11, 30), date1904: Date.UTC(1904, 0, 1) }

/** "2024-01-31" (or with slashes, or a time after it) as Excel's day number; null for anything else. */
export function serialOfDate(text: string, date1904 = false): number | null {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text.trim())

  if (!match) {
    return null
  }

  const [year, month, day, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0))
  const time = Date.UTC(year, month - 1, day, hours, minutes, seconds)
  const date = new Date(time)

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hours > 23 || minutes > 59 || seconds > 59) {
    return null
  }

  return (time - (date1904 ? EPOCH.date1904 : EPOCH.date1900)) / DAY
}

/** Excel's day number as "2024-01-31", with the time when it has one ("2024-01-31 08:30"). */
export function dateOfSerial(serial: number, date1904 = false): string {
  const date = new Date(Math.round((date1904 ? EPOCH.date1904 : EPOCH.date1900) + serial * DAY))
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = `${String(date.getUTCFullYear()).padStart(4, '0')}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  const time = date.getUTCHours() || date.getUTCMinutes() || date.getUTCSeconds() ? ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}${date.getUTCSeconds() ? `:${pad(date.getUTCSeconds())}` : ''}` : ''

  return `${day}${time}`
}

/** "08:30" or "08:30:15" as the part of a day Excel keeps a time as; null for anything else. */
function serialOfTime(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim())
  const [hours, minutes, seconds] = (match?.slice(1) ?? []).map((part) => Number(part ?? 0))

  return match && hours < 24 && minutes < 60 && seconds < 60 ? (hours * 3600 + minutes * 60 + seconds) / 86400 : null
}

const numberText = (n: number): string => String(Number(n.toFixed(10)))

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** A list rule's items, as Univer keeps them (a JSON list, or text with commas). */
export function listOf(formula: string): string[] {
  const parsed = parsedJson(formula)

  return (Array.isArray(parsed) ? parsed.map(String) : formula.split(',')).map((item) => item.trim()).filter(Boolean)
}

/** The most characters Excel keeps of a rule's texts, and of a list written into the rule. */
const MESSAGE_LIMITS = { promptTitle: 32, prompt: 255, errorTitle: 32, error: 225 } as const
const LIST_LIMIT = 255

/** A rule's formula as the file writes it: a list as `"a,b"`, a date or time as Excel's number, a formula without its "="; null when the file cannot hold it. */
function validationFormula(rule: UValidation, formula: string, unitId: string, date1904: boolean, losses: Set<string>): string | null {
  if (formula.startsWith('=')) {
    return formulaToExcel(formula, unitId)
  }

  if (rule.type === 'list' || rule.type === 'listMultiple') {
    const items = listOf(formula)

    if (items.some((item) => item.includes(','))) {
      losses.add('List items with commas in them are split at the commas: Excel separates a list’s items with commas.')
    }

    if (items.join(',').length > LIST_LIMIT) {
      losses.add(`Dropdown lists longer than ${LIST_LIMIT} characters written into a rule are not saved: put the items in cells and make the list from them.`)

      return null
    }

    return `"${items.join(',').replace(/"/g, '""')}"`
  }

  if ((rule.type === 'date' || rule.type === 'time') && !NUMBER.test(formula)) {
    const serial = rule.type === 'time' ? (serialOfTime(formula) ?? serialOfDate(formula, date1904)) : serialOfDate(formula, date1904)

    if (serial === null) {
      losses.add(`A ${rule.type} validation rule with a ${rule.type} Excel cannot read (“${formula}”) is not saved.`)
    }

    return serial === null ? null : numberText(serial)
  }

  return formula
}

/** A sheet's rules as a `<dataValidations>` element, and what it could not keep; dates count from 1904 in a workbook that does. */
export function validationsXml(rules: UValidation[], unitId: string, options: { date1904?: boolean } = {}): { xml: string; losses: string[] } {
  const losses = new Set<string>()
  const written: string[] = []

  for (const rule of rules) {
    if (!rule.ranges?.length) {
      continue
    }

    let type = rule.type

    if (type === 'listMultiple') {
      losses.add('Lists that allow picking several items are saved as lists of one item.')
      type = 'list'
    } else if (type === 'checkbox') {
      losses.add('Checkbox validation is not saved: Excel has no such rule.')
      continue
    } else if (type === 'any' || type === 'none') {
      type = 'none'
    } else if (!TYPES.has(type)) {
      losses.add(`A validation rule Excel does not have (${type}) is not saved.`)
      continue
    }

    const texts = Object.fromEntries(
      (Object.keys(MESSAGE_LIMITS) as (keyof typeof MESSAGE_LIMITS)[]).map((key) => {
        const text = rule[key]

        if (text && text.length > MESSAGE_LIMITS[key]) {
          losses.add('Validation messages longer than Excel keeps (32 characters for a title, 255 for an input message, 225 for an error message) are shortened.')

          return [key, text.slice(0, MESSAGE_LIMITS[key])]
        }

        return [key, text || undefined]
      })
    ) as Partial<Record<keyof typeof MESSAGE_LIMITS, string>>
    const twoValues = !['list', 'custom', 'none'].includes(type) && (rule.operator === undefined || rule.operator === 'between' || rule.operator === 'notBetween')
    const formulas = (['formula1', 'formula2'] as const)
      .filter((key) => type !== 'none' && rule[key] !== undefined && rule[key] !== '' && (key === 'formula1' || twoValues))
      .map((key) => ({ key, text: validationFormula({ ...rule, type }, rule[key]!, unitId, Boolean(options.date1904), losses) }))

    // A rule whose values the file cannot hold is left out whole rather than saved meaning something else.
    if (formulas.some((formula) => formula.text === null)) {
      continue
    }

    const attributes: [string, string | undefined][] = [
      ['type', type === 'none' ? undefined : type],
      ['errorStyle', rule.errorStyle === 2 ? 'warning' : rule.errorStyle === 0 ? 'information' : undefined],
      ['operator', rule.operator && rule.operator !== 'between' && type !== 'list' && type !== 'custom' && type !== 'none' ? rule.operator : undefined],
      ['allowBlank', rule.allowBlank ? '1' : undefined],
      ['showDropDown', type === 'list' && rule.showDropDown === false ? '1' : undefined],
      ['showInputMessage', rule.showInputMessage ? '1' : undefined],
      ['showErrorMessage', rule.showErrorMessage ? '1' : undefined],
      ['errorTitle', texts.errorTitle],
      ['error', texts.error],
      ['promptTitle', texts.promptTitle],
      ['prompt', texts.prompt],
      ['sqref', sqref(rule.ranges)]
    ]
    written.push(`<dataValidation${attributes.map(([key, value]) => (value !== undefined ? ` ${key}="${attributeXml(value)}"` : '')).join('')}>${formulas.map(({ key, text }) => `<${key}>${encodeXml(text!)}</${key}>`).join('')}</dataValidation>`)
  }

  return { xml: written.length ? `<dataValidations count="${written.length}">${written.join('')}</dataValidations>` : '', losses: [...losses] }
}

export interface UFilterColumn {
  colId: number
  filters?: { blank?: true; filters?: string[] }
  customFilters?: { and?: 1; customFilters: { val: string | number; operator?: string }[] }
}

export interface UAutoFilter {
  ref: CellRange & { rangeType?: number }
  filterColumns?: UFilterColumn[]
  cachedFilteredOut?: number[]
}

const FILTER_OPERATORS = new Set(['equal', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual', 'notEqual'])

/** A sheet's filter from its `<autoFilter>`, with the kinds of condition Univer has no filter for. */
export function filterFromXml(tail: string): { filter: UAutoFilter | null; dropped: boolean } {
  const element = firstElement(tail, 'autoFilter')
  const ref = element ? parseRange(element.attributes.ref ?? '') : null

  if (!element || !ref) {
    return { filter: null, dropped: false }
  }

  const columns: UFilterColumn[] = []
  let dropped = false

  for (const column of elementsOf(element.inner, 'filterColumn')) {
    const colId = ref.startColumn + Number(column.attributes.colId ?? 0)
    const filters = firstElement(column.inner, 'filters')
    const custom = firstElement(column.inner, 'customFilters')

    if (filters) {
      const values = elementsOf(filters.inner, 'filter').map((entry) => entry.attributes.val ?? '')
      dropped ||= /<(?:\w+:)?dateGroupItem/.test(filters.inner)
      columns.push({ colId, filters: { ...(isTrue(filters.attributes.blank) ? { blank: true as const } : {}), ...(values.length ? { filters: values } : {}) } })
    } else if (custom) {
      const conditions = elementsOf(custom.inner, 'customFilter').map(({ attributes }) => ({
        val: NUMBER.test(attributes.val ?? '') ? Number(attributes.val) : (attributes.val ?? ''),
        ...(attributes.operator && attributes.operator !== 'equal' && FILTER_OPERATORS.has(attributes.operator) ? { operator: attributes.operator } : {})
      }))

      if (conditions.length) {
        columns.push({ colId, customFilters: { ...(isTrue(custom.attributes.and) ? { and: 1 as const } : {}), customFilters: conditions.slice(0, 2) } })
      }
    } else {
      dropped = true
    }
  }

  return { filter: { ref: withSheet(ref), ...(columns.length ? { filterColumns: columns } : {}) }, dropped }
}

/** A filter as an `<autoFilter>` element (its conditions relative to its first column). */
export function filterXml(filter: UAutoFilter): string {
  const columns = (filter.filterColumns ?? []).map((column) => {
    const colId = column.colId - filter.ref.startColumn
    let inner = ''

    if (column.filters) {
      const values = (column.filters.filters ?? []).map((value) => `<filter val="${encodeXml(String(value))}"/>`).join('')
      inner = `<filters${column.filters.blank ? ' blank="1"' : ''}>${values}</filters>`
    } else if (column.customFilters) {
      const conditions = column.customFilters.customFilters.map((condition) => `<customFilter${condition.operator && condition.operator !== 'equal' ? ` operator="${condition.operator}"` : ''} val="${encodeXml(String(condition.val))}"/>`).join('')
      inner = `<customFilters${column.customFilters.and ? ' and="1"' : ''}>${conditions}</customFilters>`
    }

    return inner && colId >= 0 ? `<filterColumn colId="${colId}">${inner}</filterColumn>` : ''
  })
  const body = columns.join('')

  return `<autoFilter ref="${rangeName(filter.ref)}"${body ? `>${body}</autoFilter>` : '/>'}`
}

export interface UConditionalRule {
  cfId: string
  ranges: CellRange[]
  stopIfTrue: boolean
  rule: Record<string, unknown> & { type: string }
}

const TEXT_OPERATORS = new Set(['containsText', 'notContainsText', 'beginsWith', 'endsWith', 'containsBlanks', 'notContainsBlanks', 'containsErrors', 'notContainsErrors'])
const NUMBER_OPERATORS = new Set(['equal', 'notEqual', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual', 'between', 'notBetween'])
const COMPARE: Record<string, string> = { equal: '=', notEqual: '<>', greaterThan: '>', greaterThanOrEqual: '>=', lessThan: '<', lessThanOrEqual: '<=' }
const VALUE_TYPES = new Set(['num', 'min', 'max', 'percent', 'percentile', 'formula'])

/** A highlight's format (a differential style: what it changes) as Univer's style fields. */
function highlightStyle(style: Partial<Style> | undefined, palette: Palette): UStyle {
  const out: UStyle = { ...fontStyle(style?.font, { name: '', size: 0, color: null }, palette) }
  delete out.ff
  delete out.fs
  const fill = style?.fill

  if (fill?.type === 'pattern') {
    // A format's solid fill keeps its colour as the background colour.
    const color = resolveColor((fill.bgColor ?? fill.fgColor) as ExcelColor | undefined, palette)

    if (color) {
      out.bg = { rgb: color }
    }
  }

  return out
}

const valueConfig = (cfvo: { type?: string; value?: unknown } | undefined, fallback: string) => {
  const type = cfvo?.type === 'autoMin' ? 'min' : cfvo?.type === 'autoMax' ? 'max' : (cfvo?.type ?? fallback)
  const value = cfvo?.value

  return {
    type: VALUE_TYPES.has(type) ? type : fallback,
    ...(value !== undefined && value !== null ? { value: type === 'formula' ? formulaFromExcel(String(value)) : NUMBER.test(String(value)) ? Number(value) : String(value) } : {})
  }
}

/** The text a text rule looks for: the file's `text` attribute, else what its formula searches for. */
function ruleText(formulae: unknown[], attribute: string | undefined): string {
  if (attribute !== undefined) {
    return attribute
  }

  const formula = String(formulae[0] ?? '')
  const quoted = /"((?:[^"]|"")*)"/.exec(formula)

  return quoted ? quoted[1].replace(/""/g, '"') : ''
}

/** A formula rule that is one of Excel's text rules written out (as Herald writes them): its operator and text. */
function textRule(formula: string, corner: string): { operator: string; value: string } | null {
  const cell = corner.replace(/\$/g, '')
  const quoted = '"((?:[^"]|"")*)"'
  const patterns: [string, string][] = [
    ['containsText', `^NOT\\(ISERROR\\(SEARCH\\(${quoted},${cell}\\)\\)\\)$`],
    ['notContainsText', `^ISERROR\\(SEARCH\\(${quoted},${cell}\\)\\)$`],
    ['beginsWith', `^LEFT\\(${cell},LEN\\(${quoted}\\)\\)=${quoted}$`],
    ['endsWith', `^RIGHT\\(${cell},LEN\\(${quoted}\\)\\)=${quoted}$`],
    ['containsBlanks', `^LEN\\(TRIM\\(${cell}\\)\\)=0$`],
    ['notContainsBlanks', `^LEN\\(TRIM\\(${cell}\\)\\)>0$`],
    ['containsErrors', `^ISERROR\\(${cell}\\)$`],
    ['notContainsErrors', `^NOT\\(ISERROR\\(${cell}\\)\\)$`]
  ]

  for (const [operator, pattern] of patterns) {
    const match = new RegExp(pattern, 'i').exec(formula.replace(/^=/, '').trim())

    if (match && (match[2] === undefined || match[1] === match[2])) {
      return { operator, value: (match[1] ?? '').replace(/""/g, '"') }
    }
  }

  return null
}

/** A sheet's conditional formats as Univer's rules, highest priority first, and how many could not be mapped. */
export function conditionalFromExcel(formats: ConditionalFormattingOptions[], tail: string, palette: Palette): { rules: UConditionalRule[]; dropped: number } {
  const texts = new Map(elementsOf(tail, 'cfRule').map(({ attributes }) => [Number(attributes.priority), attributes.text]))
  const found: { priority: number; rule: UConditionalRule }[] = []
  let dropped = 0

  for (const format of formats ?? []) {
    const ranges = parseRanges(format.ref ?? '')
    const corner = ranges[0] ? cellName(ranges[0].startRow, ranges[0].startColumn) : 'A1'

    for (const raw of format.rules ?? []) {
      const source = raw as ConditionalFormattingRule & Record<string, unknown>
      const style = highlightStyle(source.style, palette)
      const formulae = (source.formulae ?? []) as unknown[]
      let rule: UConditionalRule['rule'] | null = null
      const type = String(source.type)
      const operator = String(source.operator ?? (type === 'containsText' ? 'containsText' : ''))

      const text = type === 'expression' && formulae[0] !== undefined ? textRule(String(formulae[0]), corner) : null

      if (text) {
        rule = { type: 'highlightCell', subType: 'text', ...text, style }
      } else if (type === 'expression' && formulae[0] !== undefined) {
        rule = { type: 'highlightCell', subType: 'formula', value: formulaFromExcel(String(formulae[0])), style }
      } else if (type === 'cellIs' && NUMBER_OPERATORS.has(operator)) {
        const values = formulae.map((entry) => String(entry))

        if (values.every((value) => NUMBER.test(value))) {
          const numbers = values.map(Number)
          rule = { type: 'highlightCell', subType: 'number', operator, value: operator === 'between' || operator === 'notBetween' ? [numbers[0], numbers[1] ?? numbers[0]] : numbers[0], style }
        } else if (COMPARE[operator] && values[0]) {
          rule = { type: 'highlightCell', subType: 'formula', value: `=${corner}${COMPARE[operator]}${formulaFromExcel(values[0]).slice(1)}`, style }
        } else if (values.length >= 2) {
          const [low, high] = values.map((value) => formulaFromExcel(value).slice(1))
          const inside = `AND(${corner}>=MIN(${low},${high}),${corner}<=MAX(${low},${high}))`
          rule = { type: 'highlightCell', subType: 'formula', value: operator === 'between' ? `=${inside}` : `=NOT(${inside})`, style }
        }
      } else if (TEXT_OPERATORS.has(type) || (type === 'containsText' && TEXT_OPERATORS.has(operator))) {
        const textOperator = TEXT_OPERATORS.has(type) && type !== 'containsText' ? type : operator
        rule = { type: 'highlightCell', subType: 'text', operator: textOperator, value: ruleText(formulae, texts.get(Number(source.priority))), style }
      } else if (type === 'timePeriod' && source.timePeriod) {
        rule = { type: 'highlightCell', subType: 'timePeriod', operator: source.timePeriod, style }
      } else if (type === 'top10') {
        rule = { type: 'highlightCell', subType: 'rank', isBottom: Boolean(source.bottom), isPercent: Boolean(source.percent), value: Number(source.rank ?? 10), style }
      } else if (type === 'aboveAverage') {
        rule = { type: 'highlightCell', subType: 'average', operator: source.aboveAverage === false ? 'lessThan' : 'greaterThan', style }
      } else if (type === 'duplicateValues' || type === 'uniqueValues') {
        rule = { type: 'highlightCell', subType: type, style }
      } else if (type === 'colorScale' && Array.isArray(source.cfvo) && Array.isArray(source.color)) {
        const colors = source.color as ExcelColor[]
        rule = { type: 'colorScale', config: (source.cfvo as { type?: string; value?: unknown }[]).map((cfvo, index) => ({ index, color: resolveColor(colors[index], palette) ?? '#ffffff', value: valueConfig(cfvo, 'num') })) }
      } else if (type === 'dataBar') {
        const cfvo = (source.cfvo ?? []) as { type?: string; value?: unknown }[]
        rule = {
          type: 'dataBar',
          isShowValue: source.showValue !== false,
          config: {
            min: valueConfig(cfvo[0], 'min'),
            max: valueConfig(cfvo[1], 'max'),
            isGradient: source.gradient !== false,
            positiveColor: resolveColor(source.color as ExcelColor, palette) ?? '#638ec6',
            nativeColor: resolveColor(source.negativeFillColor as ExcelColor, palette) ?? '#ff0000'
          }
        }
      } else if (type === 'iconSet' && source.iconSet && source.iconSet !== 'NoIcons') {
        const cfvo = (source.cfvo ?? []) as { type?: string; value?: unknown; gte?: boolean }[]
        const count = cfvo.length
        rule = {
          type: 'iconSet',
          isShowValue: source.showValue !== false,
          // Univer lists thresholds and icons from the top; the file from the bottom.
          config: cfvo
            .map((_, k) => {
              const entry = cfvo[count - 1 - k]

              return { operator: entry.gte === false ? 'greaterThan' : 'greaterThanOrEqual', value: valueConfig(entry, 'num'), iconType: source.iconSet, iconId: String(source.reverse ? count - 1 - k : k) }
            })
        }
      }

      if (rule) {
        found.push({ priority: Number(source.priority ?? found.length + 1), rule: { cfId: ruleId('cf'), ranges: ranges.map(withSheet), stopIfTrue: Boolean(source.stopIfTrue), rule } })
      } else {
        dropped++
      }
    }
  }

  return { rules: found.sort((a, b) => a.priority - b.priority).map((entry) => entry.rule), dropped }
}

const quoteText = (text: string): string => `"${text.replace(/"/g, '""')}"`

/** The formula Excel evaluates for a text rule, at the range's first cell. */
function textFormula(operator: string, text: string, corner: string): string | null {
  const quoted = quoteText(text)

  switch (operator) {
    case 'containsText':
      return `NOT(ISERROR(SEARCH(${quoted},${corner})))`
    case 'notContainsText':
      return `ISERROR(SEARCH(${quoted},${corner}))`
    case 'beginsWith':
      return `LEFT(${corner},LEN(${quoted}))=${quoted}`
    case 'endsWith':
      return `RIGHT(${corner},LEN(${quoted}))=${quoted}`
    case 'containsBlanks':
      return `LEN(TRIM(${corner}))=0`
    case 'notContainsBlanks':
      return `LEN(TRIM(${corner}))>0`
    case 'containsErrors':
      return `ISERROR(${corner})`
    case 'notContainsErrors':
      return `NOT(ISERROR(${corner}))`
    case 'equal':
      return `${corner}=${quoted}`
    case 'notEqual':
      return `${corner}<>${quoted}`
    default:
      return null
  }
}

/** A highlight's Univer style as the differential style a file keeps. */
function excelHighlight(style: UStyle | undefined): Partial<Style> {
  const out: Partial<Style> = {}

  if (!style) {
    return out
  }

  const font = excelFont(style, { name: '', size: 0, color: null })
  delete font.name
  delete font.size

  if (Object.keys(font).length) {
    out.font = font
  }

  const bg = argbOf(style.bg?.rgb)

  if (bg) {
    out.fill = { type: 'pattern', pattern: 'solid', bgColor: { argb: bg }, fgColor: { argb: bg } }
  }

  return out
}

const cfvoOf = (config: { type?: string; value?: unknown } | undefined, unitId: string) => {
  const type = config?.type ?? 'num'
  const value = config?.value

  return { type, ...(value !== undefined && value !== '' && type !== 'min' && type !== 'max' ? { value: type === 'formula' ? formulaToExcel(String(value), unitId) : value } : {}) } as { type: 'num'; value?: number }
}

/** Univer's rules for one sheet as ExcelJS conditional formats, with what the file cannot keep. */
export function conditionalToExcel(rules: UConditionalRule[], unitId: string): { formats: ConditionalFormattingOptions[]; losses: string[] } {
  const formats: ConditionalFormattingOptions[] = []
  const losses = new Set<string>()

  rules.forEach((entry, index) => {
    const ranges = (entry.ranges ?? []).filter((range) => range && range.startRow >= 0)

    if (!ranges.length) {
      return
    }

    const ref = sqref(ranges)
    const corner = cellName(ranges[0].startRow, ranges[0].startColumn)
    const rule = entry.rule
    const style = excelHighlight(rule.style as UStyle | undefined)
    const base = { priority: index + 1, ...(entry.stopIfTrue ? { stopIfTrue: true } : {}) }
    let made: Record<string, unknown> | null = null

    if (rule.type === 'highlightCell') {
      const subType = String(rule.subType)
      const operator = String(rule.operator ?? '')

      if (subType === 'number' && NUMBER_OPERATORS.has(operator)) {
        const values = (Array.isArray(rule.value) ? rule.value : [rule.value ?? 0]).map(String)
        made = { type: 'cellIs', operator, formulae: operator === 'between' || operator === 'notBetween' ? [values[0], values[1] ?? values[0]] : [values[0]] }
      } else if (subType === 'formula' && typeof rule.value === 'string') {
        made = { type: 'expression', formulae: [formulaToExcel(rule.value, unitId)] }
      } else if (subType === 'text') {
        const formula = textFormula(operator, String(rule.value ?? ''), corner)
        made = formula ? { type: 'expression', formulae: [formula] } : null
      } else if (subType === 'timePeriod') {
        made = { type: 'timePeriod', timePeriod: operator }
      } else if (subType === 'rank') {
        made = { type: 'top10', rank: Number(rule.value ?? 10), percent: Boolean(rule.isPercent), bottom: Boolean(rule.isBottom) }
      } else if (subType === 'average') {
        made = { type: 'aboveAverage', aboveAverage: operator === 'greaterThan' || operator === 'greaterThanOrEqual' }

        if (operator.endsWith('OrEqual') || operator === 'equal' || operator === 'notEqual') {
          losses.add('Highlights for values equal to the average are saved as above or below the average.')
        }
      } else if (subType === 'duplicateValues' || subType === 'uniqueValues') {
        const absolute = ranges.map((range) => rangeName(range).replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')).join(',')
        made = { type: 'expression', formulae: [`COUNTIF(${absolute},${corner})${subType === 'duplicateValues' ? '>1' : '=1'}`] }
      }

      if (made) {
        made.style = style
      }
    } else if (rule.type === 'colorScale' && Array.isArray(rule.config)) {
      const config = (rule.config as { index: number; color: string; value: { type?: string; value?: unknown } }[]).slice().sort((a, b) => a.index - b.index)
      made = { type: 'colorScale', cfvo: config.map((item) => cfvoOf(item.value, unitId)), color: config.map((item) => ({ argb: argbOf(item.color) ?? 'FFFFFFFF' })) }
    } else if (rule.type === 'dataBar' && rule.config) {
      const config = rule.config as { min: { type?: string; value?: unknown }; max: { type?: string; value?: unknown }; isGradient?: boolean; positiveColor?: string }
      made = { type: 'dataBar', cfvo: [cfvoOf(config.min, unitId), cfvoOf(config.max, unitId)], color: { argb: argbOf(config.positiveColor) ?? 'FF638EC6' }, gradient: config.isGradient !== false, showValue: rule.isShowValue !== false }
    } else if (rule.type === 'iconSet' && Array.isArray(rule.config)) {
      const config = rule.config as { operator: string; value: { type?: string; value?: unknown }; iconType: string; iconId: string }[]
      const iconSet = config[0]?.iconType
      const count = config.length
      const reverse = count > 1 && config[0].iconId !== '0'
      made = iconSet && iconSet !== 'EMPTY_ICON_TYPE' && !iconSet.startsWith('_')
        ? {
            type: 'iconSet',
            iconSet,
            showValue: rule.isShowValue !== false,
            ...(reverse ? { reverse: true } : {}),
            cfvo: config.map((_, k) => {
              const item = config[count - 1 - k]

              return k === 0 ? { type: 'percent', value: 0 } : { ...cfvoOf(item.value, unitId), ...(item.operator === 'greaterThan' ? { gte: false } : {}) }
            })
          }
        : null

      if (config.some((item) => item.iconType !== iconSet)) {
        losses.add('Icon sets that mix icons from several sets are saved with the first set’s icons.')
      }
    }

    if (made) {
      formats.push({ ref, rules: [{ ...base, ...made } as unknown as ConditionalFormattingRule] })
    } else {
      losses.add('A conditional format Excel has no equivalent for is not saved.')
    }
  })

  return { formats, losses: [...losses] }
}

export interface UDefinedName {
  id: string
  name: string
  formulaOrRefString: string
  comment?: string
  localSheetId?: string
  hidden?: boolean
}

export const WORKBOOK_SCOPE = 'AllDefaultWorkbook'

const NAME_START = /^[\p{L}\p{Nl}_\\]/u
const NAME_OTHER = /[^\p{L}\p{M}\p{Nl}\p{Nd}\p{Pc}\\.?]/gu

/** Why Excel does not take `name` as a defined name (as ECMA-376 has names), or null when it does. */
export function nameProblem(name: string): string | null {
  if (!name) {
    return 'Give the name'
  }

  const shown = name.length > 40 ? `${name.slice(0, 40)}…` : name

  if (name.length > 255) {
    return `“${shown}” is ${name.length} characters long; a name has at most 255`
  }

  if (!NAME_START.test(name)) {
    return `“${shown}” cannot be a name: a name starts with a letter, an underscore (_) or a backslash (\\)`
  }

  const others = [...new Set(name.slice(1).match(NAME_OTHER) ?? [])]

  if (others.length) {
    return `“${shown}” cannot be a name: it has ${others.map((char) => (char === ' ' ? 'a space' : `“${char}”`)).join(' and ')}, and after its first character a name has only letters, digits, periods, underscores, backslashes and question marks`
  }

  if (parseCell(name)) {
    return `“${name}” cannot be a name: it is a cell reference`
  }

  if (/^(R\d*C\d*|R\d*|C\d*)$/i.test(name)) {
    return /^[RC]$/i.test(name) ? `“${name}” cannot be a name: R and C stand for the current row and column` : `“${name}” cannot be a name: it is a cell reference in R1C1 style`
  }

  if (/^(TRUE|FALSE)$/i.test(name)) {
    return `“${name}” cannot be a name: it is a logical value`
  }

  return null
}

const isReference = (text: string): boolean => {
  const { ref } = splitSheet(text)

  return Boolean(parseRange(ref.replace(/\$/g, '')))
}

/** A file's defined names as Univer's, with names for print settings set aside (they belong to the page setup). */
export function definedNamesFromPackage(names: { name: string; formula: string; localSheetId?: number; hidden?: boolean; comment?: string }[], sheetIds: (string | null)[]): { names: Record<string, UDefinedName>; print: string[] } {
  const found: Record<string, UDefinedName> = {}
  const print: string[] = []

  for (const entry of names) {
    if (/^_xlnm\./i.test(entry.name)) {
      if (!/^_xlnm\._FilterDatabase$/i.test(entry.name)) {
        print.push(entry.name.replace(/^_xlnm\./i, ''))
      }

      continue
    }

    if (/^_xl(fn|ws|udf)\./i.test(entry.name)) {
      continue
    }

    const scope = entry.localSheetId !== undefined ? sheetIds[entry.localSheetId] : WORKBOOK_SCOPE

    if (!scope) {
      continue
    }

    const id = ruleId('name')
    const text = entry.formula.trim()
    found[id] = {
      id,
      name: entry.name,
      formulaOrRefString: isReference(text) ? text : formulaFromExcel(text),
      localSheetId: scope,
      ...(entry.hidden ? { hidden: true } : {}),
      ...(entry.comment ? { comment: entry.comment } : {})
    }
  }

  return { names: found, print }
}

/** Univer's defined names as a `<definedNames>` element for workbook.xml; names Excel would not open the file with are left out, in `losses`. */
export function definedNamesXml(names: Record<string, UDefinedName> | null, sheetOrder: string[], unitId: string, losses?: Set<string>): string {
  const seen = new Set<string>()
  const entries: string[] = []

  for (const entry of Object.values(names ?? {})) {
    if (!entry?.name || !entry.formulaOrRefString) {
      continue
    }

    const scoped = Boolean(entry.localSheetId) && entry.localSheetId !== WORKBOOK_SCOPE
    const local = scoped ? sheetOrder.indexOf(entry.localSheetId!) : -1
    const key = `${local}\u0000${entry.name.toLowerCase()}`

    // A name of a sheet that is gone goes with it.
    if (scoped && local < 0) {
      continue
    }

    if (nameProblem(entry.name) || seen.has(key)) {
      losses?.add(seen.has(key) ? 'Two names spelled alike for the same sheet or the whole workbook are saved as one.' : `The name “${entry.name}” is not saved: Excel does not allow it.`)
      continue
    }

    seen.add(key)
    const formula = entry.formulaOrRefString.startsWith('=') ? formulaToExcel(entry.formulaOrRefString, unitId) : entry.formulaOrRefString
    entries.push(`<definedName name="${attributeXml(entry.name)}"${local >= 0 ? ` localSheetId="${local}"` : ''}${entry.hidden ? ' hidden="1"' : ''}${entry.comment ? ` comment="${attributeXml(entry.comment)}"` : ''}>${encodeXml(formula)}</definedName>`)
  }

  return entries.length ? `<definedNames>${entries.join('')}</definedNames>` : ''
}

export interface SheetLink {
  row: number
  column: number
  /** An address (https:, mailto:, file:) or a place in the workbook ("'Sheet 2'!A1"). */
  target: string
  internal: boolean
  tooltip?: string
}

/** A sheet's links from its `<hyperlinks>`, with addresses from its relationships. */
export function linksFromXml(tail: string, related: { id?: string; type: string; target: string }[]): SheetLink[] {
  const links: SheetLink[] = []

  for (const { attributes } of elementsOf(firstElement(tail, 'hyperlinks')?.inner ?? '', 'hyperlink')) {
    const range = parseRange(attributes.ref ?? '')
    const external = attributes['r:id'] ? related.find((rel) => rel.id === attributes['r:id'])?.target : undefined
    const location = attributes.location ? decodeXml(attributes.location).replace(/^#/, '') : undefined
    const target = external ? `${external}${location ? `#${location}` : ''}` : location

    if (!range || !target) {
      continue
    }

    links.push({ row: range.startRow, column: range.startColumn, target, internal: !external, ...(attributes.tooltip ? { tooltip: attributes.tooltip } : {}) })
  }

  return links
}

/** Univer's address for a place in the workbook ("#gid=<sheet id>&range=A1"), from the file's ("'Sheet 2'!A1"). */
export function univerLinkPayload(link: SheetLink, sheetIdByName: Map<string, string>): string {
  if (!link.internal) {
    return link.target
  }

  const { sheet, ref } = splitSheet(link.target)
  const sheetId = sheet ? sheetIdByName.get(sheet) : undefined

  return sheetId ? `#gid=${sheetId}${ref ? `&range=${ref.replace(/\$/g, '')}` : ''}` : `#rangeid=${encodeURIComponent(link.target)}`
}

/** A Univer link address as the file's: a web address, or a place ("'Sheet 2'!A1"). */
export function fileLinkTarget(payload: string, sheetNameById: Map<string, string>): { target: string; internal: boolean } | null {
  if (!payload) {
    return null
  }

  if (!payload.startsWith('#')) {
    return { target: payload, internal: false }
  }

  const params = new URLSearchParams(payload.slice(1))
  const name = sheetNameById.get(params.get('gid') ?? '')
  const range = params.get('range')

  if (name) {
    return { target: `${name.includes(' ') || /[^\w.]/.test(name) ? `'${name.replace(/'/g, "''")}'` : name}!${range || 'A1'}`, internal: true }
  }

  const named = params.get('rangeid')

  return named ? { target: decodeURIComponent(named), internal: true } : null
}

/** A sheet's links as a `<hyperlinks>` element; `relate` gives the relationship id for an address. */
export function linksXml(links: SheetLink[], relate: (target: string) => string): string {
  if (!links.length) {
    return ''
  }

  const entries = links.map((link) => {
    const ref = cellName(link.row, link.column)
    const tooltip = link.tooltip ? ` tooltip="${encodeXml(link.tooltip)}"` : ''

    return link.internal ? `<hyperlink ref="${ref}" location="${encodeXml(link.target)}"${tooltip}/>` : `<hyperlink ref="${ref}" r:id="${relate(link.target)}"${tooltip}/>`
  })

  return `<hyperlinks>${entries.join('')}</hyperlinks>`
}
