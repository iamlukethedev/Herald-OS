import { evaluateLines } from './document.ts'
import { formatValue as formatCalcValue } from './format.ts'
import { compile } from './functions.ts'
import { loadMath } from './math.ts'
import type { CalcContext, CalcValue, CompiledFunction, DocumentResult, EvalResult, FormatOptions, PlotFunction } from './types.ts'
import { findZone } from './zones.ts'

/*
 * Herald Calc's exact engine: math.js (its own chunk, loaded on first use) for exact numbers,
 * units and functions, with Herald's own parser for the sentence forms on top. Every caller goes
 * through these functions.
 */

export type { CalcContext, CalcValue, CompiledFunction, DocumentResult, EvalResult, FormatOptions, LineResult, PlotFunction } from './types.ts'

const UNAVAILABLE = "The calculator couldn't start; try again in a moment"
const NO_MATH = 'There is no math in that to work out'
/** A number as written ("5", "-2.5", "1,200"), which a unit follows without brackets. */
const PLAIN_NUMBER = /^[-+−]?[\d.,'’\s]+$/u

/** Load math.js once; the calls below wait for it themselves. */
export async function loadEngine(): Promise<void> {
  try {
    await loadMath()
  } catch {
    // The calls below load it again and explain when they cannot.
  }
}

/** Every line of a note, each with its result; names assigned on a line count on the lines after it. */
export async function evaluateDocument(text: string, context: CalcContext): Promise<DocumentResult> {
  try {
    return evaluateLines(text, context, await loadMath())
  } catch {
    return {
      lines: text.split(/\r\n|\r|\n/).map((source, index) => (source.trim() ? { index, kind: 'error', source, error: UNAVAILABLE } : { index, kind: 'blank', source })),
      total: null,
      totalDisplay: null,
      usesRates: false,
      functions: [],
      locale: context.locale
    }
  }
}

/** One sentence or expression (or several lines, read as a note): the value, its units and the working. Never throws. */
export async function evaluate(text: string, context: CalcContext): Promise<EvalResult> {
  try {
    return toResult(text, evaluateLines(text, context, await loadMath()), context.locale)
  } catch {
    return { ok: false, input: text, steps: [], error: UNAVAILABLE }
  }
}

function toResult(input: string, document: DocumentResult, locale: string | undefined): EvalResult {
  const spoken = (value?: CalcValue): string | undefined => (value ? formatCalcValue(value, { locale, units: 'long' }) : undefined)
  const filled = document.lines.filter(line => line.kind !== 'blank')

  if (filled.length > 1) {
    const last = document.lines.filter(line => line.kind === 'value').at(-1)
    const error = filled.find(line => line.kind === 'error')?.error

    return {
      ok: Boolean(last),
      input,
      value: last?.value,
      display: last?.display,
      spoken: spoken(last?.value),
      steps: last?.steps ?? [],
      error: last ? undefined : (error ?? NO_MATH),
      usesRates: document.usesRates || undefined,
      lines: document.lines
    }
  }

  const line = filled[0]

  switch (line?.kind) {
    case 'value':
      return { ok: true, input, value: line.value, display: line.display, spoken: spoken(line.value), steps: line.steps ?? [], usesRates: line.usesRates }
    case 'function':
    case 'plot':
      return { ok: true, input, display: line.plot ? plotText(line.plot) : line.plotSource, steps: [], lines: document.lines }
    case 'error':
      return { ok: false, input, steps: [], error: line.error }
    default:
      return { ok: false, input, steps: [], error: NO_MATH }
  }
}

function plotText(plot: PlotFunction): string {
  return !plot.name || plot.name === 'y' ? `y = ${plot.expression}` : `${plot.name}(${plot.variable}) = ${plot.expression}`
}

/**
 * `amount` from one unit, currency or time zone to another: a number ("5", "1/2") takes `from` as its
 * unit or currency, a time of day ("9am") as its place, and an amount that names its own units or
 * place ("5 ft 3 in", "9am Sydney") keeps them. Never throws.
 */
export async function convert(amount: string, from: string, to: string, context: CalcContext): Promise<EvalResult> {
  const quantity = amount.trim()
  const source = from.trim()
  const target = to.trim()
  const alone = await evaluate(quantity, context)
  const kind = alone.ok ? alone.value?.kind : undefined

  if (kind === 'number') {
    // Without a unit it converts with "to": "12 in cm" would read the plain number as inches.
    return evaluate(source ? `${PLAIN_NUMBER.test(quantity) ? quantity : `(${quantity})`} ${source} in ${target}` : `${quantity} to ${target}`, context)
  }

  if (kind === 'time' && source) {
    const placed = await evaluate(`${quantity} ${source} in ${target}`, context)

    // A time with its own place ("9am Sydney") or "now" reads the extra place as a label, so only an answer in the target zone counts; an unknown place keeps its error.
    if (placed.ok ? placed.value?.zone === findZone(target) : !findZone(source)) {
      return placed
    }
  }

  return evaluate(kind || !source ? `${quantity} in ${target}` : `${quantity} ${source} in ${target}`, context)
}

/** A function of `variable` (x when left out) to draw, fast enough to call thousands of times a frame; throws when it does not read. */
export async function compileFunction(expression: string, options: { variable?: string; scope?: Record<string, number> } = {}): Promise<CompiledFunction> {
  let engine: Awaited<ReturnType<typeof loadMath>>

  try {
    engine = await loadMath()
  } catch {
    throw new Error(UNAVAILABLE)
  }

  return compile(engine, expression, options.variable ?? 'x', options.scope ?? {})
}

/** A value as the notepad shows it, or in words to speak. Needs no math.js. */
export function formatValue(value: CalcValue, options: FormatOptions = {}): string {
  return formatCalcValue(value, options)
}
