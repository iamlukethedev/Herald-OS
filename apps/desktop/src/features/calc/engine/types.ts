import type { CalcRates } from '../../../../shared/calc.ts'

/*
 * The engine's public shapes: what the notepad, the keypads, the graphs, the commands, voice and
 * Hermes's calc tool all read. Pure data; nothing here loads math.js.
 */

export type CalcKind = 'number' | 'percent' | 'unit' | 'currency' | 'date' | 'time' | 'duration' | 'boolean' | 'text'

/** One value as the engine hands it on: exact where it can be, with a float for drawing. */
export interface CalcValue {
  kind: CalcKind
  /**
   * The exact value as a plain decimal string ("0.3", "-1267650600228229401496703205376"); a
   * rational that never ends is cut at the engine's precision and carries `fraction` too.
   * percent: the percentage ("15" for 15%). unit, currency, duration: the magnitude in `unit`.
   * date: YYYY-MM-DD. time: ISO 8601 with its offset. boolean: "true" or "false". text: the text.
   */
  exact: string
  /** The same value as a float for graphs, sorting and Sheets; dates and times as epoch ms; NaN for text. */
  number: number
  /** The engine's unit ("km", "mi", "degC", "kg", "GB", "km/h"), the currency's ISO code ("USD"), or a duration's unit ("day"). */
  unit?: string
  /** A short exact fraction when the value is rational and no short decimal ("1/3", "-7/12"). */
  fraction?: string
  /** Times: the IANA zone they are shown in. */
  zone?: string
}

export interface CalcContext {
  /** BCP 47 locale for reading and writing numbers ("en-AU", "de-DE", "pt-BR"); undefined is the system's. */
  locale?: string
  /** Now, epoch ms; tests fix it. */
  now: number
  /** The person's IANA time zone ("Australia/Sydney"). */
  zone: string
  /** The currency rates, or null when Herald has none. */
  rates: CalcRates | null
}

export type LineKind = 'blank' | 'comment' | 'heading' | 'value' | 'function' | 'plot' | 'error'

export type TokenType = 'number' | 'unit' | 'currency' | 'operator' | 'keyword' | 'variable' | 'function' | 'comment' | 'heading' | 'label' | 'date'

/** Characters `from` (inclusive) to `to` (exclusive) of a line, for highlighting. */
export interface TokenSpan {
  from: number
  to: number
  type: TokenType
}

export interface PlotFunction {
  /** What the line names it: "y", "f"; empty for "plot sin(x)". */
  name: string
  /** The right-hand side as math.js reads it: "sin(x) * x". */
  expression: string
  /** The variable it is drawn over: "x". */
  variable: string
  /** The line it came from. */
  index: number
}

export interface LineResult {
  /** 0-based index of the line in the document. */
  index: number
  kind: LineKind
  /** The line as written. */
  source: string
  /** A heading's or comment's text; for values, the label before a colon or the name assigned ("Rent", "budget"). */
  label?: string
  /** The variable this line assigns ("budget = 1,200"). */
  name?: string
  value?: CalcValue
  /** The value as the notepad shows it, in the locale: "97.175", "3.1069 mi", "$1,234.50", "Fri, Dec 25", "98 days". */
  display?: string
  /** The working, one step a line: "20% of 84.50 = 0.2 × 84.50", "= 16.90". */
  steps?: string[]
  /** A gentle explanation when the line has no value: "A length and a mass don't add up". */
  error?: string
  /** kind function, or kind plot with a function: what to draw. */
  plot?: PlotFunction
  /** kind plot naming something else to draw, as written ("column B of Budget.xlsx"). */
  plotSource?: string
  tokens?: TokenSpan[]
  /** The line used currency rates. */
  usesRates?: boolean
}

export interface DocumentResult {
  lines: LineResult[]
  /** The running total the footer shows: every value line that adds up; null when none or they mix kinds that do not add. */
  total: CalcValue | null
  totalDisplay: string | null
  /** Some line used currency rates, so the footer says which day's. */
  usesRates: boolean
  /** Every function to draw, in line order. */
  functions: PlotFunction[]
  /** The locale the note was read in, so its lines read the same again (Copy to Sheets). */
  locale?: string
}

export interface EvalResult {
  ok: boolean
  /** The input as given. */
  input: string
  value?: CalcValue
  display?: string
  /** The value in words fit to speak: "6.21 miles", "16.90 US dollars", "Friday, December 25". */
  spoken?: string
  steps: string[]
  error?: string
  usesRates?: boolean
  /** A multi-line input: every line; `value` and `display` are then the last value's. */
  lines?: LineResult[]
}

export interface FormatOptions {
  locale?: string
  /** Unit symbols ("mi", "°C") or names to speak ("miles", "degrees Celsius"). */
  units?: 'short' | 'long'
  /** Most significant digits for a value that does not end; 10 when left out. */
  digits?: number
}

/** A function of one variable to draw: NaN where it has no value. */
export type CompiledFunction = (x: number) => number
