import { columnIndex } from '../../../../shared/office/xlsx/address.ts'
import { personIdOf } from '../../../../shared/office/xlsx/comments/model.ts'
import type { CommandSource } from '../../../store/os-commands.ts'
import { parseJsonArg } from '../agent-model.ts'
import { type CleanAction, cleanActionOf, dayOrderOf, type DepthEditOp } from './agent-model.ts'
import {
  addComment,
  changeCase,
  clearValidation,
  convertToDates,
  convertToNumbers,
  createName,
  deleteComment,
  deleteName,
  describeChart,
  fillDown,
  getValidation,
  goToName,
  highlightDuplicates,
  insertChart,
  listCharts,
  listComments,
  listNames,
  listNotes,
  listSummaries,
  moveChart,
  recommendCharts,
  refreshSummary,
  removeChart,
  removeDuplicates,
  removeNote,
  replyToComment,
  resolveComment,
  setNote,
  setValidation,
  type SheetsTarget,
  sortBy,
  splitText,
  summarize,
  trimText,
  updateChart,
  updateName
} from './model.ts'
import { previewRows } from './tools/summary.ts'
import { areaOf, valuesIn } from './tools/table.ts'
import { DATE_FORMATS, DATE_ORDERS, type DateOrder, DELIMITERS, TEXT_CASES, type TextCase } from './tools/text.ts'

/*
 * What Hermes's commands for charts, summaries, data tools, named ranges, validation, comments and
 * notes do in a workbook (agent.ts finds the workbook): each takes a command's arguments as they
 * come, lists and objects as JSON text (or as they are in a batch of edits), and says what it did.
 * sheets.clean and sheets.sort work through the same data tools.
 */

type Args = Record<string, unknown>

/** What a command did, said without the workbook's name ("inserted a column chart …"), and the data it answers with. */
export interface Done {
  said: string
  data: Record<string, unknown>
}

export interface DepthWork {
  /** It changes the workbook (unless it previews); else it only reads it. */
  change: boolean
  /** It shows something in the open workbook (the selection) rather than changing or reading it. */
  view?: boolean
  run: (on: SheetsTarget, args: Args, source?: CommandSource) => Promise<Done> | Done
}

/** Who signs the comments, replies and notes Hermes starts. */
export const HERMES_AUTHOR = { id: personIdOf('Hermes'), name: 'Hermes' }

const authorFor = (source?: CommandSource) => (source === 'agent' ? HERMES_AUTHOR : undefined)

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '')

/** An argument not given, or empty, as undefined: the tools take that as left out. */
const given = (value: unknown): unknown => (value === null || (typeof value === 'string' && !value.trim()) ? undefined : value)

/** A yes or no as a command or a batch gives it; undefined when it is not given. */
const yes = (value: unknown): boolean | undefined => (value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined)

/** A list or object argument: JSON text parsed, anything else as it is. */
const json = (value: unknown, name: string): unknown => given(parseJsonArg(value, name))

/** A number given as text ("2") as a number, for arguments that take an id or a number. */
const numbered = (value: unknown): unknown => (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value)

/** "none" takes a setting off; the tools take empty text for that. */
const orNone = (value: unknown): unknown => (typeof value === 'string' && value.trim().toLowerCase() === 'none' ? '' : value)

const count = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** A range with its sheet, unless it names one already. */
const placed = (sheet: string, range: string): string => (range.includes('!') ? range : `${sheet}!${range}`)

/** A list of columns or fields: a JSON list, or text with commas between; numbers given as text are numbers. */
function listArg(value: unknown, name: string): unknown[] | undefined {
  const parsed = json(value, name)
  const list = Array.isArray(parsed) ? parsed : parsed === undefined ? [] : String(parsed).split(',')
  const items = list.map((item) => (typeof item === 'string' ? item.trim() : item)).filter((item) => item !== '' && item !== null && item !== undefined)

  return items.length ? items.map(numbered) : undefined
}

// Charts.

/** A chart's settings as insertChart and updateChart take them; "none" takes a title or the categories off. */
const chartSettings = (args: Args): Args => ({
  kind: given(args.kind),
  title: orNone(args.title),
  series: json(args.series, 'series'),
  categories: orNone(args.categories),
  legend: given(args.legend),
  labels: given(args.labels),
  axes: json(args.axes, 'axes'),
  stacking: given(args.stacking),
  palette: paletteArg(args.palette),
  hole: given(args.hole)
})

/** Colours in turn: a JSON list, or comma-separated; workbook for the workbook theme's. */
function paletteArg(value: unknown): unknown {
  const parsed = json(value, 'palette')
  const colors = typeof parsed === 'string' ? parsed.split(',').map((color) => color.trim()).filter(Boolean) : parsed

  return Array.isArray(colors) && colors.length === 1 && String(colors[0]).trim().toLowerCase() === 'workbook' ? 'workbook' : colors
}

/** A chart's size in pixels from width and height; one alone keeps the other. */
function sizeArg(args: Args): { width?: unknown; height?: unknown } | undefined {
  const width = given(args.width)
  const height = given(args.height)

  return width === undefined && height === undefined ? undefined : { ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) }
}

const chartName = (kind: string, title: string): string => `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind} chart${title ? ` “${title}”` : ''}`

// Summaries.

/** The sheet whose summaries a refresh means when none is named: the one in front if it has any, else the only sheet that has. */
function summarySheet(on: SheetsTarget): string {
  const front = on.workbook.getActiveSheet()
  const sheets = on.workbook.getSheets().filter((sheet) => listSummaries(on, { sheet: sheet.getSheetName() }).summaries.length)

  if (sheets.length > 1 && !sheets.some((sheet) => sheet.getSheetId() === front.getSheetId())) {
    throw new Error(`There are summaries on ${sheets.map((sheet) => sheet.getSheetName()).join(', ')}: say which sheet`)
  }

  return (sheets.length === 1 && sheets[0].getSheetId() !== front.getSheetId() ? sheets[0] : front).getSheetName()
}

// Data tools.

/** A delimiter as a command gives it: comma (the default), semicolon, tab, space or pipe, or the text to split at. */
function delimiterArg(value: unknown): { delimiter: string; other?: string } {
  const delimiter = typeof value === 'string' ? value : ''
  const name = delimiter.trim().toLowerCase()

  if (!delimiter) {
    return { delimiter: 'comma' }
  }

  return Object.hasOwn(DELIMITERS, name) ? { delimiter: name } : { delimiter: 'other', other: name === 'pipe' ? '|' : delimiter }
}

function caseArg(value: unknown, fallback?: TextCase): TextCase {
  const to = (text(value).toLowerCase() || fallback || '') as TextCase

  if (!TEXT_CASES.includes(to)) {
    throw new Error(`case is ${TEXT_CASES.join(', ')}${to ? `, not “${to}”` : ''}`)
  }

  return to
}

const ORDER_WORDS: Record<DateOrder, string> = { DMY: 'day first', MDY: 'month first', YMD: 'year first' }

/** Day and month first as the person's locale writes dates. */
function localOrder(): 'dmy' | 'mdy' {
  const parts = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(new Date(2001, 1, 3))

  return parts.findIndex((part) => part.type === 'month') < parts.findIndex((part) => part.type === 'day') ? 'mdy' : 'dmy'
}

/** How a range's dates written in numbers go: as given (dmy, mdy or ymd); else as the data shows (a first number over 12 is a day), else the person's locale. */
function dateOrderArg(on: SheetsTarget, args: Args): DateOrder {
  const order = text(args.order).toUpperCase() as DateOrder

  if (DATE_ORDERS.includes(order)) {
    return order
  }

  const area = areaOf(on.workbook, args.range, args.sheet)

  return dayOrderOf(valuesIn(area.range.getCellDatas()), localOrder()).toUpperCase() as DateOrder
}

function dateFormatArg(value: unknown): string | undefined {
  const format = text(value)

  if (format && !/[dmy]/i.test(format)) {
    throw new Error(`dateFormat is a date format like ${DATE_FORMATS.join(', ')}; not “${format}”`)
  }

  return format || undefined
}

/** Sort keys: a JSON list of {column, ascending}, or text like "Region, Amount desc". */
function keysArg(value: unknown): unknown {
  const parsed = json(value, 'keys')

  if (typeof parsed !== 'string') {
    return parsed
  }

  return parsed
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
    .map((key) => {
      const order = /^(.*?)\s+(asc|ascending|desc|descending)$/i.exec(key)

      return { column: numbered(order ? order[1] : key), ascending: !order || order[2].toLowerCase().startsWith('asc') }
    })
}

/**
 * Whether a range's first row is its header row, for sheets.sort and sheets.clean: as given; else
 * when a column is named by a header rather than by a letter or a number inside the range.
 */
function headerArg(on: SheetsTarget, range: string, sheet: unknown, header: unknown, columns: unknown[] | undefined): boolean {
  const told = yes(header)

  if (told !== undefined) {
    return told
  }

  if (!columns?.length) {
    return false
  }

  const { cells } = areaOf(on.workbook, range, sheet)

  return columns.some((column) => {
    const name = String(column ?? '').trim()
    const letter = /^[A-Za-z]{1,3}$/.test(name) && columnIndex(name) >= cells.startColumn && columnIndex(name) <= cells.endColumn

    return typeof column !== 'number' && name !== '' && !/^\d+$/.test(name) && !letter
  })
}

// Validation.

const RULE_NAMES: Record<string, string> = { list: 'a dropdown list', whole: 'a whole-number rule', decimal: 'a number rule', date: 'a date rule', textLength: 'a text-length rule', custom: 'a custom formula rule', any: 'an input message' }

/** An input message: {title, message}, or its message alone as text. */
function inputArg(value: unknown): unknown {
  const parsed = json(value, 'input')

  return typeof parsed === 'string' ? { message: parsed } : parsed
}

/** An error alert: {style, title, message}, or none (style none, or false) for none. */
function alertArg(value: unknown): unknown {
  const parsed = json(value, 'alert')
  const style = parsed && typeof parsed === 'object' ? (parsed as Args).style : parsed

  return parsed === false || ['none', 'false'].includes(String(style ?? '').trim().toLowerCase()) ? false : parsed
}

// The commands.

export const DEPTH = {
  insertChart: {
    change: true,
    run: async (on, args) => {
      const { chart: id } = await insertChart(on, { ...chartSettings(args), range: args.range, at: given(args.at), size: sizeArg(args), sheet: given(args.sheet) })
      const chart = describeChart(on, { chart: id })

      return { said: `inserted ${chartName(chart.kind, chart.title)} (${chart.chart}) of ${count(chart.series.length, 'series', 'series')} at ${chart.sheet}!${chart.at}`, data: { ...chart } }
    }
  },
  listCharts: {
    change: false,
    run: (on, args) => {
      const charts = listCharts(on, { sheet: given(args.sheet) })

      return { said: `${charts.length ? count(charts.length, 'chart') : 'no charts'}${given(args.sheet) ? ` on ${text(args.sheet)}` : ''}`, data: { charts } }
    }
  },
  describeChart: {
    change: false,
    run: (on, args) => {
      const chart = describeChart(on, { chart: numbered(args.chart) })

      return { said: `${chart.chart} is ${chartName(chart.kind, chart.title)} of ${count(chart.series.length, 'series', 'series')} at ${chart.sheet}!${chart.at}`, data: { ...chart } }
    }
  },
  updateChart: {
    change: true,
    run: async (on, args) => {
      const id = numbered(args.chart)
      const before = JSON.stringify(describeChart(on, { chart: id }))
      const chart = await updateChart(on, { chart: id, ...chartSettings(args), range: given(args.range) })

      return { said: JSON.stringify(chart) === before ? `${chart.chart} is already as asked` : `changed ${chart.chart}: now ${chartName(chart.kind, chart.title)} of ${count(chart.series.length, 'series', 'series')}`, data: { ...chart } }
    }
  },
  moveChart: {
    change: true,
    run: async (on, args) => {
      const moved = await moveChart(on, { chart: numbered(args.chart), at: given(args.at), size: sizeArg(args) })

      return { said: `moved ${moved.chart} to ${moved.sheet}!${moved.at}, ${moved.size.width}×${moved.size.height} pixels`, data: moved }
    }
  },
  removeChart: {
    change: true,
    run: async (on, args) => {
      const id = numbered(args.chart)
      const chart = describeChart(on, { chart: id })
      const removed = await removeChart(on, { chart: id })

      return { said: `removed ${removed.chart} (${chartName(chart.kind, chart.title)}) from ${removed.sheet}`, data: removed }
    }
  },
  recommendCharts: {
    change: false,
    run: (on, args) => {
      const recommendations = recommendCharts(on, { range: args.range, sheet: given(args.sheet) })
      const [best, ...rest] = recommendations

      return { said: best ? `${text(args.range)} suits ${chartName(best.kind, '')} best${rest.length ? `, then ${rest.map((entry) => entry.kind).join(', ')}` : ''}` : `no chart suits ${text(args.range)}`, data: { recommendations } }
    }
  },
  summarize: {
    change: true,
    run: async (on, args) => {
      const values = listArg(args.valueFields, 'valueFields')
      const result = await summarize(on, {
        source: args.range,
        rows: listArg(args.rowFields, 'rowFields'),
        columns: listArg(args.columnFields, 'columnFields'),
        values,
        filters: json(args.filters, 'filters'),
        destination: given(args.destination),
        preview: yes(args.preview),
        sheet: given(args.sheet)
      })
      const shape = `${result.values.join(', ')} for ${count(result.rows, 'row label')}${result.columns ? ` and ${count(result.columns, 'column label')}` : ''}`
      const where = `${result.newSheet ? 'a new sheet, ' : ''}${result.sheet}!${result.range}`

      return result.preview ? { said: `a summary of ${result.source} would take ${where}: ${shape} (nothing changed)`, data: { ...result, shape: previewRows(result) } } : { said: `summarized ${result.source} as ${result.id} at ${where}: ${shape}`, data: { ...result } }
    }
  },
  refreshSummary: {
    change: true,
    run: async (on, args) => {
      const result = await refreshSummary(on, { sheet: given(args.sheet) ?? summarySheet(on), summary: numbered(given(args.summary)) })

      return { said: `refreshed ${result.summaries.map((summary) => `${summary.id} (${count(summary.rows, 'row label')}, ${summary.before} before)`).join(', ')} on ${result.sheet}`, data: result }
    }
  },
  listSummaries: {
    change: false,
    run: (on, args) => {
      const sheets = given(args.sheet) === undefined ? on.workbook.getSheets().map((sheet) => sheet.getSheetName()) : [args.sheet]
      const summaries = sheets.flatMap((sheet) => {
        const listed = listSummaries(on, { sheet })

        return listed.summaries.map((summary) => ({ sheet: listed.sheet, ...summary }))
      })

      return { said: summaries.length ? count(summaries.length, 'summary', 'summaries') : 'no summaries', data: { summaries } }
    }
  },
  removeDuplicates: {
    change: true,
    run: async (on, args) => {
      const result = await removeDuplicates(on, { range: args.range, columns: listArg(args.by, 'by'), header: yes(args.header), preview: yes(args.preview), sheet: given(args.sheet) })
      const where = `${result.sheet}!${result.range}`

      if (result.preview || !result.duplicates) {
        return { said: `${result.duplicates ? count(result.duplicates, 'row repeats', 'rows repeat') : 'no row repeats'} an earlier one in ${where}${result.preview ? ' (nothing changed)' : ''}`, data: { ...result } }
      }

      return { said: `removed ${count(result.duplicates, 'duplicate row')} from ${where}, keeping ${count(result.kept, 'row')}`, data: { ...result } }
    }
  },
  splitText: {
    change: true,
    run: async (on, args) => {
      const result = await splitText(on, { range: args.range, ...delimiterArg(args.delimiter), consecutive: yes(args.consecutive), destination: given(args.destination), overwrite: yes(args.overwrite), header: yes(args.header), preview: yes(args.preview), sheet: given(args.sheet) })
      const parts = `${count(result.columns, 'column')} at ${result.sheet}!${result.destination}`

      if (!result.rows) {
        return { said: `nothing in ${result.range} splits at that delimiter`, data: { ...result } }
      }

      return { said: result.changed ? `split ${count(result.rows, 'cell')} of ${result.range} into ${parts}` : `${count(result.rows, 'cell')} of ${result.range} would split into ${parts}${result.overwrites ? `, writing over ${count(result.overwrites, 'cell')} with data` : ''} (nothing changed)`, data: { ...result } }
    }
  },
  trimText: {
    change: true,
    run: async (on, args) => {
      const result = await trimText(on, { range: args.range, sheet: given(args.sheet) })
      const where = `${result.sheet}!${result.range}`

      return { said: result.changed ? `trimmed ${count(result.changed, 'cell')} of ${where}` : `the text in ${where} has nothing to trim`, data: result }
    }
  },
  changeCase: {
    change: true,
    run: async (on, args) => {
      const result = await changeCase(on, { range: args.range, to: caseArg(args.case), sheet: given(args.sheet) })
      const where = `${result.sheet}!${result.range}`

      return { said: result.changed ? `put ${count(result.changed, 'cell')} of ${where} in ${result.to} case` : `the text in ${where} is in ${result.to} case already`, data: result }
    }
  },
  convertToNumbers: {
    change: true,
    run: async (on, args) => {
      const result = await convertToNumbers(on, { range: args.range, preview: yes(args.preview), sheet: given(args.sheet) })
      const where = `${result.sheet}!${result.range}`
      const failed = result.failed ? `; ${count(result.failed, 'text cell does', 'text cells do')} not read as a number (${result.notConverted.slice(0, 5).map((entry) => entry.cell).join(', ')})` : ''

      return { said: `${result.preview ? `${count(result.converted, 'cell')} of ${where} would become numbers` : result.converted ? `turned ${count(result.converted, 'cell')} of ${where} into numbers` : `no text in ${where} reads as a number`}${failed}${result.preview ? ' (nothing changed)' : ''}`, data: { ...result } }
    }
  },
  convertToDates: {
    change: true,
    run: async (on, args) => {
      const result = await convertToDates(on, { range: args.range, order: dateOrderArg(on, args), format: dateFormatArg(args.dateFormat), preview: yes(args.preview), sheet: given(args.sheet) })
      const where = `${result.sheet}!${result.range}`
      const failed = result.failed ? `; ${count(result.failed, 'text cell does', 'text cells do')} not read as a date (${result.notConverted.slice(0, 5).map((entry) => entry.cell).join(', ')})` : ''

      return { said: `${result.preview ? `${count(result.converted, 'cell')} of ${where} would become dates` : result.converted ? `turned ${count(result.converted, 'cell')} of ${where} into dates` : `no text in ${where} reads as a date`}, read ${ORDER_WORDS[result.order]}${failed}${result.preview ? ' (nothing changed)' : ''}`, data: { ...result } }
    }
  },
  fillDown: {
    change: true,
    run: async (on, args) => {
      const result = await fillDown(on, { range: args.range, sheet: given(args.sheet) })
      const where = `${result.sheet}!${result.range}`

      return { said: result.filled ? `filled ${count(result.filled, 'empty cell')} of ${where} from the cells above` : `${where} has no empty cell under a value`, data: result }
    }
  },
  highlightDuplicates: {
    change: true,
    run: async (on, args) => {
      const result = await highlightDuplicates(on, { range: args.range, color: given(args.color), clear: yes(args.clear), sheet: given(args.sheet) })
      const where = `${result.sheet}!${result.range}`

      if (yes(args.clear)) {
        return { said: result.cleared ? `took the duplicate highlight off ${where}` : `${where} has no duplicate highlight`, data: result }
      }

      return { said: `highlighted ${count(result.duplicates, 'cell')} of ${where} whose value repeats`, data: result }
    }
  },
  sortBy: {
    change: true,
    run: async (on, args) => {
      const result = await sortBy(on, { range: args.range, keys: keysArg(args.keys), header: yes(args.header), sheet: given(args.sheet) })

      return { said: `sorted ${result.sheet}!${result.range} by ${result.keys.map((key) => `${key.column} ${key.ascending ? 'ascending' : 'descending'}`).join(', then ')}${result.header ? ', under its header row' : ''}`, data: result }
    }
  },
  listNames: {
    change: false,
    run: (on) => {
      const names = listNames(on)

      return { said: names.length ? count(names.length, 'name') : 'no names', data: { names } }
    }
  },
  createName: {
    change: true,
    run: async (on, args) => {
      const made = await createName(on, { name: args.name, refersTo: args.refersTo, scope: given(args.scope), comment: given(args.comment) })

      return { said: `created the name ${made.name} for ${made.refersTo}${made.scope === 'workbook' ? '' : `, seen on ${made.scope}`}`, data: { ...made } }
    }
  },
  updateName: {
    change: true,
    run: async (on, args) => {
      const changed = await updateName(on, { name: args.name, newName: given(args.newName), refersTo: given(args.refersTo), comment: args.comment === undefined ? undefined : orNone(args.comment), scope: given(args.scope) })
      const renamed = changed.name.toLowerCase() !== text(args.name).toLowerCase() ? `renamed ${text(args.name)} ${changed.name}` : `changed the name ${changed.name}`

      return { said: `${renamed}: it stands for ${changed.refersTo}`, data: { ...changed } }
    }
  },
  deleteName: {
    change: true,
    run: async (on, args) => {
      const removed = await deleteName(on, { name: args.name, scope: given(args.scope) })

      return { said: `removed the name ${removed.name} (it stood for ${removed.refersTo}); formulas that use it show #NAME?`, data: { ...removed } }
    }
  },
  goToName: {
    change: false,
    view: true,
    run: (on, args) => {
      const found = goToName(on, { name: args.name, scope: given(args.scope) })

      return { said: `selected ${found.name}, ${found.sheet}!${found.range}`, data: found }
    }
  },
  setValidation: {
    change: true,
    run: async (on, args) => {
      const rule = json(args.rule, 'rule')
      const result = await setValidation(on, { range: args.range, rule, sheet: given(args.sheet), allowBlank: yes(args.allowBlank), dropdown: yes(args.dropdown), input: inputArg(args.input), error: alertArg(args.alert) })
      const type = String((rule as Args | undefined)?.type ?? '')

      return { said: `set ${RULE_NAMES[type] ?? 'a rule'} on ${placed(result.sheet, text(args.range))}`, data: result }
    }
  },
  getValidation: {
    change: false,
    run: (on, args) => {
      const result = getValidation(on, { range: args.range, sheet: given(args.sheet) })
      const where = placed(result.sheet, text(args.range))

      return { said: result.rules.length ? `${count(result.rules.length, 'rule covers', 'rules cover')} ${where}` : `no rule covers ${where}`, data: result }
    }
  },
  clearValidation: {
    change: true,
    run: async (on, args) => {
      const result = await clearValidation(on, { range: args.range, sheet: given(args.sheet) })
      const where = `${result.sheet}!${result.range}`

      return { said: result.cleared ? `took ${count(result.cleared, 'rule')} off ${where}` : `${where} has no rules to take off`, data: result }
    }
  },
  listComments: {
    change: false,
    run: (on, args) => {
      const comments = listComments(on, { sheet: given(args.sheet) })
      const resolved = comments.filter((comment) => comment.resolved).length

      return { said: comments.length ? `${count(comments.length, 'comment thread')}${resolved ? ` (${resolved} resolved)` : ''}` : 'no comments', data: { comments } }
    }
  },
  addComment: {
    change: true,
    run: async (on, args, source) => {
      const author = authorFor(source)
      const made = await addComment(on, { cell: args.cell, text: args.text, sheet: given(args.sheet) }, author)

      return { said: `added a comment to ${made.sheet}!${made.cell}${author ? ` as ${author.name}` : ''}`, data: { ...made, ...(author ? { author: author.name } : {}) } }
    }
  },
  replyToComment: {
    change: true,
    run: async (on, args, source) => {
      const author = authorFor(source)
      const made = await replyToComment(on, { cell: given(args.cell), id: given(args.commentId), text: args.text, sheet: given(args.sheet) }, author)

      return { said: `replied to the comment on ${made.sheet}!${made.cell}${author ? ` as ${author.name}` : ''}`, data: { ...made, ...(author ? { author: author.name } : {}) } }
    }
  },
  resolveComment: {
    change: true,
    run: async (on, args) => {
      const result = await resolveComment(on, { cell: given(args.cell), id: given(args.commentId), resolved: yes(args.resolved), sheet: given(args.sheet) })

      return { said: `${result.resolved ? 'resolved' : 'opened again'} the comment on ${result.sheet}!${result.cell}`, data: result }
    }
  },
  deleteComment: {
    change: true,
    run: async (on, args) => {
      const result = await deleteComment(on, { cell: given(args.cell), id: given(args.commentId), sheet: given(args.sheet) })

      return { said: result.deleted === 'thread' ? `deleted the comment on ${result.sheet}!${result.cell} with its replies` : `deleted a reply to the comment on ${result.sheet}!${result.cell}`, data: result }
    }
  },
  listNotes: {
    change: false,
    run: (on, args) => {
      const notes = listNotes(on, { sheet: given(args.sheet) })

      return { said: notes.length ? count(notes.length, 'note') : 'no notes', data: { notes } }
    }
  },
  setNote: {
    change: true,
    run: async (on, args, source) => {
      const note = await setNote(on, { cell: args.cell, text: args.text, sheet: given(args.sheet) }, authorFor(source))

      return { said: `wrote the note on ${note.sheet}!${note.cell}`, data: { ...note } }
    }
  },
  removeNote: {
    change: true,
    run: async (on, args) => {
      const removed = await removeNote(on, { cell: args.cell, sheet: given(args.sheet) })

      return { said: `removed the note on ${removed.sheet}!${removed.cell}`, data: removed }
    }
  }
} satisfies Record<string, DepthWork>

export type DepthCommand = keyof typeof DEPTH

/** One edit of a batch that is a command of its own here: what it did, for the batch's answer. */
export async function editOn(on: SheetsTarget, edit: Args & { op: DepthEditOp }, source?: CommandSource): Promise<string> {
  const work: DepthWork = DEPTH[edit.op]

  return (await work.run(on, edit, source)).said
}

// sheets.clean and sheets.sort, on the data tools.

/** One of sheets.clean's cleanings, answered as sheets.clean answers: dedupe, trim, numbers, dates, split or case. */
export async function cleanOn(on: SheetsTarget, args: Args, range: string): Promise<{ sheet: string; range: string; action: CleanAction; changed: number; detail: string }> {
  const action = cleanActionOf(args.action)
  const sheet = given(args.sheet)

  if (action === 'dedupe') {
    const columns = listArg(args.by, 'by')
    const result = await removeDuplicates(on, { range, columns, header: headerArg(on, range, sheet, args.header, columns), sheet })

    return { sheet: result.sheet, range: result.range, action, changed: result.duplicates, detail: `${count(result.duplicates, 'duplicate row')} removed` }
  }

  if (action === 'split') {
    const result = await splitText(on, { range, ...delimiterArg(args.delimiter), overwrite: yes(args.overwrite), header: yes(args.header), sheet })

    return { sheet: result.sheet, range: result.destination, action, changed: result.changed ? result.rows : 0, detail: result.changed ? `split into ${result.columns} columns` : 'nothing to split' }
  }

  if (action === 'dates') {
    const result = await convertToDates(on, { range, order: dateOrderArg(on, { range, sheet, order: args.order }), format: dateFormatArg(args.dateFormat), sheet })

    return { sheet: result.sheet, range: result.range, action, changed: result.converted, detail: `${count(result.converted, 'date')} read ${ORDER_WORDS[result.order]}` }
  }

  const result = action === 'trim' ? await trimText(on, { range, sheet }) : action === 'numbers' ? await convertToNumbers(on, { range, sheet }) : await changeCase(on, { range, to: caseArg(args.case, 'title'), sheet })
  const changed = 'converted' in result ? result.converted : result.changed

  return { sheet: result.sheet, range: result.range, action, changed, detail: `${count(changed, 'cell')} changed` }
}

/** sheets.sort: one column, as sheets.sort answers. */
export async function sortOn(on: SheetsTarget, args: Args, range: string): Promise<{ sheet: string; range: string; column: string; ascending: boolean; header: boolean }> {
  const by = numbered(args.by)
  const ascending = args.ascending !== false && args.ascending !== 'false' && args.ascending !== 'descending'
  const sheet = given(args.sheet)
  const result = await sortBy(on, { range, keys: [{ column: by, ascending }], header: headerArg(on, range, sheet, args.header, [by]), sheet })

  return { sheet: result.sheet, range: result.range, column: result.keys[0].column, ascending, header: result.header }
}
