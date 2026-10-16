import { CALC_HISTORY_MAX, CALC_KEYPADS, type CalcSource } from '../../shared/calc.ts'
import { calcContext } from '../features/calc/context.ts'
import type { CalcContext, EvalResult, LineResult } from '../features/calc/engine/index.ts'
import type { FunctionSummary } from '../features/calc/graph/sampling.ts'
import type { GraphRequest, GraphSeries, SheetPlotRef } from '../features/calc/graph/types.ts'
import { searchHistory } from '../features/calc/history/search.ts'
import { recordCalc } from '../features/calc/history/store.ts'
import { openCalc } from '../features/calc/open.ts'
import { CALC_VIEWS, type CalcRequest, type CalcView } from '../features/calc/requests.ts'
import { type CommandContext, type CommandResult, fail, ok, type OsCommand } from '../store/os-commands.ts'

/*
 * Herald Calc for voice, Hermes (the bridge's calc tool), the command bar and `herald-os calc`:
 * exact answers with their working, what a graph shows in numbers, and the history, which these
 * commands only read. The engine and the graph helpers load when one of them first runs.
 */

const engine = () => import('../features/calc/engine/index.ts')
const graphs = () => import('../features/calc/graph/sampling.ts')
const sheets = () => import('../features/calc/graph/sheets-source.ts')

const HISTORY_LIMIT = 10
const HISTORY_LIMIT_MAX = 50
const PLOT_FROM = -10
const PLOT_TO = 10
/** More functions than this in one call are a list, not a graph. */
const PLOT_MAX = 8

const listed = (parts: readonly string[]): string => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? ''))
const either = (parts: readonly string[]): string => `${parts.slice(0, -1).join(', ')} or ${parts.at(-1)}`
/** A list cut to a few, saying how many more there are. */
const some = (parts: readonly string[], max = 5): string => (parts.length > max ? `${parts.slice(0, max).join(', ')} and ${parts.length - max} more` : listed(parts))
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
const clip = (text: string, max = 80): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
/** Where a graph crosses or turns, to a few figures. */
const rough = (value: number): string => (Number.isFinite(value) ? String(Number(value.toPrecision(4)) || 0) : String(value))
/** A sheet's numbers, without a float's last-digit noise. */
const exact = (value: number | null): string => (value === null ? 'none' : String(Number(value.toPrecision(12))))

function defined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T
}

/** An optional choice, checked here because an `enum` would give it a default: undefined when not given, null when it is none of them. */
function choice<T extends string>(value: unknown, options: readonly T[]): T | null | undefined {
  if (value === undefined) {
    return undefined
  }

  const wanted = String(value).trim().toLowerCase()

  return options.find(option => option === wanted) ?? null
}

function remember(input: string, result: string, context: CommandContext): void {
  const source: CalcSource = context.source === 'voice' ? 'voice' : context.source === 'agent' ? 'hermes' : 'command'

  recordCalc({ input, result, source, context: source === 'hermes' ? 'Hermes' : source === 'voice' ? 'Voice' : '' })
}

const writesPoint = (locale: string | undefined): boolean => new Intl.NumberFormat(locale).format(1.5) === '1.5'

/**
 * The voice grammar writes numbers the English way ("1.5"), so spoken math is read in English of
 * the person's region where that writes them so too ("dollars" stays the region's), else en-US.
 */
async function contextFor(text: string, context: CommandContext): Promise<CalcContext> {
  const calc = await calcContext(text)

  if (context.source !== 'voice' || writesPoint(calc.locale)) {
    return calc
  }

  const region = new Intl.Locale(calc.locale ?? new Intl.NumberFormat().resolvedOptions().locale).maximize().region
  const english = region && writesPoint(`en-${region}`) ? `en-${region}` : 'en-US'

  return { ...calc, locale: english }
}

const SPOKEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsqrt\(([^()]*)\)/g, 'the square root of $1'],
  [/\bcbrt\(([^()]*)\)/g, 'the cube root of $1'],
  [/\^2\b/g, ' squared'],
  [/\^3\b/g, ' cubed'],
  [/\^/g, ' to the power of '],
  [/ \* /g, ' times '],
  [/ \/ /g, ' divided by '],
  [/ \+ /g, ' plus '],
  [/ - /g, ' minus ']
]

/** A sum in words to speak: "2 * 3" is "2 times 3". */
function speakable(text: string): string {
  return oneLine(SPOKEN.reduce((words, [pattern, said]) => words.replace(pattern, said), oneLine(text)))
}

/** What Herald says: the question and its answer ("15% of 340 is 51"), short enough to hear. */
function spokenAnswer(asked: string, result: EvalResult): string {
  const value = result.spoken || result.display || ''
  const counted = /^(?:days|weeks|months|years|hours|minutes) (until|since) (.+)$/i.exec(asked)

  if (result.value?.kind === 'time') {
    // The engine names the place itself when it can ("10:00 am in Tokyo").
    const place = /^(?:time|now) in (.+)$/i.exec(asked)
    const where = place && !/\sin\s/i.test(value) ? ` in ${place[1]}` : ''

    return `${place ? "It's" : "That's"} ${value}${where}`
  }

  if (counted) {
    return `${value} ${counted[1]} ${counted[2]}`
  }

  // "10 km in miles is 6.21 miles" says the target twice: "10 km is 6.21 miles".
  const conversion = /^(.+)\s+(?:in|into|to|as)\s+\S.{0,30}$/i.exec(asked)
  const words = speakable(conversion && (result.value?.kind === 'unit' || result.value?.kind === 'currency') ? conversion[1] : asked)

  return words.split(' ').length > 12 ? value : `${words} is ${value}`
}

const lineData = (line: LineResult) => defined({ index: line.index, source: line.source, display: line.display, error: line.display === undefined ? line.error : undefined })

/** A calculation's answer for every caller: one line, the words to speak, and the value with its working for Hermes. */
function answer(result: EvalResult, asked: string, context: CommandContext, ratesDate: string | null): CommandResult {
  if (!result.ok || !result.value || result.display === undefined) {
    return fail(result.error || `Herald Calc could not work out "${clip(oneLine(asked))}"`)
  }

  const input = result.input || asked
  const several = result.lines && result.lines.length > 1 ? result.lines.filter(line => line.display !== undefined || line.error !== undefined) : undefined
  const last = several?.findLast(line => line.display !== undefined)
  const shown = clip(oneLine(last ? last.source : input))
  const unanswered = several?.filter(line => line.display === undefined).length ?? 0
  const rates = result.usesRates && ratesDate ? ` (ECB reference rates of ${ratesDate})` : ''
  const missing = unanswered ? `; ${unanswered} ${unanswered === 1 ? 'line has' : 'lines have'} no answer` : ''

  remember(input, result.display, context)

  return ok(`${shown} = ${result.display}${rates}${missing}`, {
    spoken: spokenAnswer(shown, result),
    data: defined({
      input,
      display: result.display,
      value: result.value.exact,
      kind: result.value.kind,
      unit: result.value.unit,
      fraction: result.value.fraction,
      zone: result.value.zone,
      steps: result.steps,
      ratesDate: result.usesRates ? (ratesDate ?? undefined) : undefined,
      lines: several?.map(lineData)
    })
  })
}

/** "y = x^2", "f(t) = t^2", "sin(x)": the right-hand side to compile and its variable. */
function functionOf(entry: string): { expression: string; variable: string } {
  const named = /^[a-z]\w*\s*(?:\(\s*([a-z])\s*\))?\s*=(?!=)\s*(.+)$/i.exec(entry)

  return named ? { expression: named[2].trim(), variable: named[1] ?? 'x' } : { expression: entry, variable: 'x' }
}

function describeFunction(expression: string, summary: FunctionSummary): string {
  const range = `x from ${rough(summary.xMin)} to ${rough(summary.xMax)}`

  if (summary.yMin === null || summary.yMax === null) {
    return `${expression} has no value for ${range}`
  }

  const maxima = summary.extrema.filter(point => point.kind === 'max').map(point => `(${rough(point.x)}, ${rough(point.y)})`)
  const minima = summary.extrema.filter(point => point.kind === 'min').map(point => `(${rough(point.x)}, ${rough(point.y)})`)
  const parts = [`y runs from ${rough(summary.yMin)} to ${rough(summary.yMax)}`, summary.zeros.length ? `it crosses zero at x = ${some(summary.zeros.map(rough))}` : 'it never crosses zero']

  if (maxima.length) {
    parts.push(`${maxima.length === 1 ? 'a local maximum' : 'local maxima'} at ${some(maxima)}`)
  }

  if (minima.length) {
    parts.push(`${minima.length === 1 ? 'a local minimum' : 'local minima'} at ${some(minima)}`)
  }

  if (summary.asymptotes.length) {
    parts.push(`${summary.asymptotes.length === 1 ? 'a vertical asymptote' : 'vertical asymptotes'} at x = ${some(summary.asymptotes.map(rough))}`)
  }

  if (summary.gaps.length) {
    parts.push(`no value for x ${some(summary.gaps.map(([from, to]) => `from ${rough(from)} to ${rough(to)}`))}`)
  }

  return `${expression}, ${range}: ${parts.join('; ')}`
}

function seriesData(series: GraphSeries) {
  const values = series.points.map(([, y]) => y)
  const sum = values.reduce((total, value) => total + value, 0)

  return {
    label: series.label,
    count: values.length,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    sum,
    mean: values.length ? sum / values.length : null,
    first: values[0] ?? null,
    last: values.at(-1) ?? null
  }
}

function describeSeries(stats: ReturnType<typeof seriesData>): string {
  if (stats.count === 0) {
    return `${stats.label} has no numbers`
  }

  return `${stats.label}: ${stats.count} ${stats.count === 1 ? 'number' : 'numbers'} from ${exact(stats.min)} to ${exact(stats.max)}, sum ${exact(stats.sum)}, mean ${exact(stats.mean)}, first ${exact(stats.first)}, last ${exact(stats.last)}`
}

/** What opening Herald Calc on `request` did, as a line and as words to speak. */
function opening(request: Omit<CalcRequest, 'at'>): [string, string] {
  if (request.text) {
    return ['Started a new note in Herald Calc', 'Starting a new note in Herald Calc.']
  }

  if (request.keypad) {
    return [`Opened the ${request.keypad} keypad in Herald Calc`, `Opening the ${request.keypad} calculator.`]
  }

  switch (request.view) {
    case 'graph':
      return ['Opened the graph in Herald Calc', 'Opening the graphing calculator.']
    case 'history':
      return ['Opened the calculation history in Herald Calc', 'Here are your calculations.']
    case 'keypad':
      return ['Opened the keypad in Herald Calc', 'Opening the calculator.']
    case 'notes':
      return ['Opened the notes in Herald Calc', 'Opening Herald Calc.']
    default:
      return ['Opened Herald Calc', 'Opening Herald Calc.']
  }
}

export const calcCommands: readonly OsCommand[] = [
  {
    id: 'calc.eval',
    title: 'Calculate',
    description:
      'Work a sum out exactly with Herald Calc, with the working: arithmetic, percentages ("20% of 84.50", "84.50 + 15%", "2,400 + 180 split 3 ways"), units ("5 km in miles", "350°F in C"), currencies ("100 USD in BRL", at the European Central Bank\'s reference rates of the day it names), dates ("days until Dec 25") and time zones ("9am Sydney in New York"). Several lines are read as a note, where a name given a value on one line counts on the lines after it. The answer has the value, as shown and exact, its unit and the steps.',
    tier: 'read',
    args: [
      {
        name: 'text',
        type: 'string',
        description: 'A sentence or expression, or several lines read as a note: 20% of 84.50, 5 km in miles, 100 USD in BRL, days until Dec 25, 9am Sydney in New York, budget = 1200 then budget * 12',
        required: true
      }
    ],
    run: async ({ text }, context) => {
      const asked = String(text)
      const [calc, reading] = await Promise.all([engine(), contextFor(asked, context)])

      return answer(await calc.evaluate(asked, reading), asked, context, reading.rates?.date ?? null)
    }
  },
  {
    id: 'calc.convert',
    title: 'Convert units or currencies',
    description:
      'Convert an amount exactly from one unit or currency to another with Herald Calc: lengths, areas, volumes, weights, temperatures, speeds, data sizes, times, and currencies at the European Central Bank\'s reference rates of the day it names. A time of day goes from one place\'s time to another\'s: 9am from Sydney to London.',
    tier: 'read',
    args: [
      { name: 'value', type: 'string', description: "The amount: '5', '2.5', a quantity like '5 ft 3 in', or a time of day like '9am'", required: true },
      { name: 'from', type: 'string', description: 'The unit, currency or place it is in: km, °F, USD, cups, Sydney', required: true },
      { name: 'to', type: 'string', description: 'The unit, currency or place to convert it to', required: true }
    ],
    run: async ({ value, from, to }, context) => {
      const asked = `${String(value)} ${String(from)} in ${String(to)}`
      const [calc, reading] = await Promise.all([engine(), contextFor(asked, context)])

      return answer(await calc.convert(String(value), String(from), String(to), reading), asked, context, reading.rates?.date ?? null)
    }
  },
  {
    id: 'calc.plot',
    title: 'Plot a graph',
    description:
      'What a graph shows, in numbers: for each function of x, where it crosses zero, its local maxima and minima, its vertical asymptotes, where it has no value and the range of y between from and to; for a sheet\'s cells, how many numbers there are, the smallest, the largest, their sum and mean. Shows the graph in Herald Calc unless show is false.',
    tier: 'act',
    args: [
      { name: 'expression', type: 'string', description: 'Functions of x, separated by ; or new lines: sin(x) * x; x^2' },
      { name: 'workbook', type: 'string', description: "A sheet's numbers to plot: the workbook, e.g. 'Budget.xlsx' (a file or an open workbook's name)" },
      { name: 'range', type: 'string', description: "The workbook's cells, e.g. 'B:B' or 'B2:B40'" },
      { name: 'sheet', type: 'string', description: 'The sheet, when the range does not name it' },
      { name: 'from', type: 'number', description: `Where x starts (${PLOT_FROM})` },
      { name: 'to', type: 'number', description: `Where x ends (${PLOT_TO})` },
      { name: 'show', type: 'boolean', description: 'Open the graph in Herald Calc (true, the default)' }
    ],
    run: async ({ expression, workbook, range, sheet, from, to, show }) => {
      const xMin = from === undefined ? PLOT_FROM : Number(from)
      const xMax = to === undefined ? PLOT_TO : Number(to)

      if (xMin >= xMax) {
        return fail('calc.plot: "from" must be less than "to"')
      }

      if ((workbook === undefined) !== (range === undefined)) {
        return fail('calc.plot: a sheet needs both its "workbook" and its "range" (Budget.xlsx and B:B)')
      }

      const graph = await graphs()
      const refs: SheetPlotRef[] = workbook === undefined ? [] : [defined({ workbook: String(workbook), range: String(range), sheet: sheet === undefined ? undefined : String(sheet) })]
      const functions: string[] = []

      for (const entry of expression === undefined ? [] : String(expression).split(/[;\n]+/)) {
        const text = entry.trim().replace(/^(?:plot|graph|draw)\s+/i, '')
        const ref = text ? graph.parseSheetPlot(text) : null

        if (ref) {
          refs.push(ref)
        } else if (text) {
          functions.push(text)
        }
      }

      if (!functions.length && !refs.length) {
        return fail('calc.plot needs a function of x (expression, e.g. "sin(x) * x") or a sheet\'s cells (workbook and range)')
      }

      if (functions.length > PLOT_MAX) {
        return fail(`calc.plot draws at most ${PLOT_MAX} functions at once`)
      }

      const drawn: Array<{ expression: string; summary: FunctionSummary }> = []

      if (functions.length) {
        const { compileFunction } = await engine()

        for (const entry of functions) {
          const { expression: body, variable } = functionOf(entry)

          try {
            drawn.push({ expression: entry, summary: graph.summarizeFunction(await compileFunction(body, { variable }), xMin, xMax) })
          } catch (error) {
            return fail(functions.length > 1 ? `${entry}: ${errorOf(error)}` : errorOf(error))
          }
        }
      }

      const series: GraphSeries[] = []

      if (refs.length) {
        const { readSheetSeries } = await sheets()

        for (const ref of refs) {
          try {
            series.push(await readSheetSeries(ref))
          } catch (error) {
            return fail(errorOf(error))
          }
        }
      }

      const stats = series.map(seriesData)
      const shown = show !== false

      if (shown) {
        // A sheet's x is the row's position, so its graph fits the points unless a range was asked for.
        const ranged = from !== undefined || to !== undefined || !series.length
        const plot: GraphRequest = { ...(functions.length ? { entries: functions } : {}), ...(series.length ? { series } : {}), ...(ranged ? { xMin, xMax } : {}) }

        openCalc({ view: 'graph', plot })
      }

      const summary = [...drawn.map(({ expression: entry, summary: numbers }) => describeFunction(entry, numbers)), ...stats.map(describeSeries)].join('. ')

      return ok(shown ? `${summary}. Showing it in Herald Calc` : summary, {
        spoken: shown ? 'Here is the graph in Herald Calc.' : summary,
        data: { functions: drawn.map(({ expression: entry, summary: numbers }) => ({ expression: entry, ...numbers })), series: stats, shown }
      })
    }
  },
  {
    id: 'calc.open',
    title: 'Open Herald Calc',
    description: 'Open Herald Calc, the sentence calculator: on its notes, a keypad (classic, scientific or programmer), the graph or the calculation history, or with a new note holding text.',
    tier: 'act',
    args: [
      { name: 'text', type: 'string', description: 'Start a new note with this' },
      { name: 'view', type: 'string', description: `What to show: ${either(CALC_VIEWS)}` },
      { name: 'keypad', type: 'string', description: `The keypad: ${either(CALC_KEYPADS)}` }
    ],
    phrases: [
      'open calculator',
      'open the calculator',
      'open a calculator',
      'open herald calc',
      'open calc',
      'show the calculator',
      'show calculator',
      { phrase: 'open the scientific calculator', args: { keypad: 'scientific' } },
      { phrase: 'open scientific calculator', args: { keypad: 'scientific' } },
      { phrase: 'open the programmer calculator', args: { keypad: 'programmer' } },
      { phrase: 'open the programmers calculator', args: { keypad: 'programmer' } },
      { phrase: 'open the graphing calculator', args: { view: 'graph' } },
      { phrase: 'show my calculations', args: { view: 'history' } },
      { phrase: 'show my calculation history', args: { view: 'history' } }
    ],
    run: ({ text, view, keypad }) => {
      const shownView = choice(view, CALC_VIEWS)
      const pad = choice(keypad, CALC_KEYPADS)

      if (shownView === null) {
        return fail(`calc.open: "view" must be ${either(CALC_VIEWS)}`)
      }

      if (pad === null) {
        return fail(`calc.open: "keypad" must be ${either(CALC_KEYPADS)}`)
      }

      const note = text === undefined ? undefined : String(text)
      const opened: CalcView | undefined = shownView ?? (pad ? 'keypad' : note ? 'notes' : undefined)
      const request: Omit<CalcRequest, 'at'> = { ...(opened ? { view: opened } : {}), ...(pad ? { keypad: pad } : {}), ...(note ? { text: note } : {}) }
      const [summary, spoken] = opening(request)

      openCalc(request)

      return ok(summary, { spoken })
    }
  },
  {
    id: 'calc.history',
    title: 'Find a past calculation',
    description: 'Find past calculations in Herald Calc\'s history by words ("that mortgage thing"), best match first, or the latest when no words are given; each with what was asked, the answer, when, and where it came from. Only reads it: clearing the history is the person\'s, in Herald Calc.',
    tier: 'read',
    args: [
      { name: 'query', type: 'string', description: 'Words to find it by: that mortgage thing' },
      { name: 'limit', type: 'number', description: `How many (${HISTORY_LIMIT}, at most ${HISTORY_LIMIT_MAX})` }
    ],
    phrases: [{ phrase: 'what was my last calculation', args: { limit: 1 } }, 'search my calculations for {query}'],
    run: async ({ query, limit }) => {
      const wanted = query === undefined ? '' : String(query)
      const count = Math.min(HISTORY_LIMIT_MAX, Math.max(1, Math.floor(limit === undefined ? HISTORY_LIMIT : Number(limit))))
      const found = searchHistory(await window.heraldOS.calc.history(CALC_HISTORY_MAX), wanted, count)
      const items = found.map(entry => ({ input: entry.input, result: entry.result, at: new Date(entry.at).toISOString(), source: entry.source, context: entry.context ?? '' }))
      const first = items[0]

      if (!first) {
        const none = wanted ? `No calculation matches "${clip(wanted, 60)}"` : 'No calculations yet'

        return ok(none, { items, data: { query: wanted, count: 0 } })
      }

      const lines = items.map(item => `${oneLine(item.input)} = ${item.result}`)
      const summary = items.length === 1 ? `${wanted ? 'The best match' : 'The last calculation'}: ${lines[0]}` : `${items.length} calculations${wanted ? ` matching "${clip(wanted, 60)}", best first` : ', newest first'}: ${some(lines, 3)}`
      const said = `${speakable(first.input)} is ${first.result}`
      const spoken = items.length === 1 && !wanted ? `Your last calculation: ${said}.` : `${wanted ? 'The best match' : 'The latest'}: ${said}.`

      return ok(summary, { spoken, items, data: { query: wanted, count: items.length } })
    }
  }
]
