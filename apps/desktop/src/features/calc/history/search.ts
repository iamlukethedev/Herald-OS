import type { CalcHistoryEntry, CalcSource } from '../../../../shared/calc.ts'

/*
 * Finding a past calculation by the words a person remembers it by: "that mortgage thing", "the
 * coffees yesterday", "450000". Filler words drop out; words match by a light stem, by how they
 * start, or with a small typo when they are long; numbers match by their digits whatever separates
 * them; time words narrow the days searched. An entry matching every word ranks first, the note's
 * words and what was asked weigh more than the answer, and the newer of two equals goes first.
 */

export interface HistorySearchOptions {
  /** Now, epoch ms, which "today" and "last week" count from; tests fix it. */
  now?: number
  /** BCP 47 locale, for the day its weeks start on; the system's when left out. */
  locale?: string
}

/** From (inclusive) and to (exclusive), epoch ms. */
export type HistorySpan = readonly [start: number, end: number]

/** A word, as typed and as stemmed, or a number as its digits (more than one way for "450k"). */
export type HistoryTerm = { kind: 'word'; raw: string; stem: string } | { kind: 'number'; digits: readonly string[] }

export interface HistoryQuery {
  terms: HistoryTerm[]
  /** Time words found: an entry has to fall in one of these. */
  spans: HistorySpan[]
}

interface Field {
  words: string[]
  stems: string[]
  numbers: string[]
  weight: number
}

const WEIGHT = { context: 3, input: 2.5, result: 1.5, source: 1 }

const QUALITY = { exact: 1, prefix: 0.75, digitsPrefix: 0.7, typo: 0.5 }

const FILLER = new Set(
  [
    'a an the that this these those it its i im ive me my mine we our us you your',
    'thing things stuff one ones something some any',
    'calculation calculations calc calcs math maths number numbers figure figures answer result',
    'did do does done doing was were is are be been had have has',
    'about for with of on in at to from by and or as per',
    'what which when where how much many',
    'find show search look looking get got remember again earlier before ago recent recently last latest',
    'worked work out figured calculated calculate computed compute made make',
    'please can could would just like kind sort there then so'
  ]
    .join(' ')
    .split(' ')
)

const midnight = (t: number, days = 0): number => {
  const date = new Date(t)

  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime()
}

const monthStart = (t: number, months = 0): number => {
  const date = new Date(t)

  return new Date(date.getFullYear(), date.getMonth() + months, 1).getTime()
}

const yearStart = (t: number, years = 0): number => new Date(new Date(t).getFullYear() + years, 0, 1).getTime()

/** Midnight of the day `t`'s week starts on (`firstDay` 0 is Sunday), `weeks` later. */
const weekStart = (t: number, firstDay: number, weeks = 0): number => midnight(t, weeks * 7 - ((new Date(t).getDay() - firstDay + 7) % 7))

type SpanOf = (now: number, firstDay: number) => HistorySpan

const today: SpanOf = now => [midnight(now), midnight(now, 1)]
const yesterday: SpanOf = now => [midnight(now, -1), midnight(now)]
const lastWeek: SpanOf = (now, firstDay) => [weekStart(now, firstDay, -1), weekStart(now, firstDay)]
const lastMonth: SpanOf = now => [monthStart(now, -1), monthStart(now)]

// Maps rather than objects: any word can be looked up, "constructor" and "toString" too.
const TIME_WORDS = new Map<string, SpanOf>([
  ['today', today],
  ['tonight', today],
  ['yesterday', yesterday]
])

const TIME_PAIRS = new Map<string, SpanOf>([
  ['this morning', today],
  ['this afternoon', today],
  ['this evening', today],
  ['last night', yesterday],
  ['this week', (now, firstDay) => [weekStart(now, firstDay), weekStart(now, firstDay, 1)]],
  ['last week', lastWeek],
  ['previous week', lastWeek],
  ['this month', now => [monthStart(now), monthStart(now, 1)]],
  ['last month', lastMonth],
  ['previous month', lastMonth],
  ['this year', now => [yearStart(now), yearStart(now, 1)]],
  ['last year', now => [yearStart(now, -1), yearStart(now)]]
])

/** Symbols and codes an answer shows, as the words a person searches with. */
const SYMBOL_WORDS = new Map([
  ['$', 'dollar'],
  ['€', 'euro'],
  ['£', 'pound'],
  ['¥', 'yen'],
  ['₹', 'rupee'],
  ['%', 'percent'],
  ['°', 'degree']
])
const CODE_WORDS = new Map([
  ['usd', 'dollar'],
  ['aud', 'dollar'],
  ['cad', 'dollar'],
  ['nzd', 'dollar'],
  ['hkd', 'dollar'],
  ['sgd', 'dollar'],
  ['eur', 'euro'],
  ['gbp', 'pound'],
  ['jpy', 'yen'],
  ['inr', 'rupee']
])

const SOURCE_WORDS = new Map<CalcSource, string[]>([
  ['notes', ['note', 'notes', 'notepad']],
  ['keypad', ['keypad', 'keyboard']],
  ['voice', ['voice', 'said', 'spoken']],
  ['hermes', ['hermes']],
  ['command', ['command']]
])

/** Digits with what may group or split them: 450,000 · 84.50 · 1'000 · 1 000 000. */
const NUMBER = /\d+(?:[.,'’_\u00a0\u202f]\d+| \d{3}(?!\d))*/gu
/** Thousands and millions said short: 450k, 1.2m. */
const SCALED = /(\d+(?:[.,]\d+)?) ?([km])(?!\p{L})/gu
const LETTERS = /\p{L}+/gu
/** A query's words and numbers in order. */
const QUERY_TOKEN = new RegExp(`${SCALED.source}|(${NUMBER.source})|(\\p{L}+)`, 'gu')

/** Lowercase, accents off, possessives and apostrophes inside words gone: "Sam's Café" -> "sam cafe". */
function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/(\p{L})['’]s(?!\p{L})/gu, '$1')
    .replace(/(\p{L})['’](?=\p{L})/gu, '$1')
}

const digitsOf = (text: string): string => text.replace(/\D+/g, '')

const scaledDigits = (number: string, suffix: string): string => String(Math.round(Number(number.replace(',', '.')) * (suffix === 'k' ? 1e3 : 1e6)))

/** A double consonant left by a dropped ending, made single: "plann" -> "plan", but "bill" stays. */
const undouble = (word: string): string => (/([b-df-hj-km-np-rtv-z])\1$/.test(word) && !/(ll|ss|zz)$/.test(word) ? word.slice(0, -1) : word)

/** A light stem, the same for a word's plural and simple forms: mortgages, mortgage -> mortgag; coffees, coffee -> coffe. */
export function stem(word: string): string {
  let out = word

  if (out.length > 4 && out.endsWith('ies')) {
    out = `${out.slice(0, -3)}y`
  } else if (out.length > 4 && /(ss|x|z|ch|sh)es$/.test(out)) {
    out = out.slice(0, -2)
  } else if (out.length > 3 && out.endsWith('s') && !/(ss|us|is)$/.test(out)) {
    out = out.slice(0, -1)
  }

  if (out.length > 5 && out.endsWith('ing')) {
    out = undouble(out.slice(0, -3))
  } else if (out.length > 4 && out.endsWith('ed')) {
    out = undouble(out.slice(0, -2))
  }

  return out.length > 3 && out.endsWith('e') ? out.slice(0, -1) : out
}

function fieldOf(text: string, weight: number, extra: readonly string[] = []): Field {
  const folded = fold(text)
  const numbers = [...(folded.match(NUMBER) ?? []).map(digitsOf), ...[...folded.matchAll(SCALED)].map(([, number, suffix]) => scaledDigits(number, suffix))]
  const words = [...(folded.replace(NUMBER, ' ').match(LETTERS) ?? []), ...extra]

  for (const [symbol, word] of SYMBOL_WORDS) {
    if (folded.includes(symbol)) {
      words.push(word)
    }
  }

  for (const word of [...words]) {
    const named = CODE_WORDS.get(word)

    if (named) {
      words.push(named)
    }
  }

  return { words, stems: words.map(stem), numbers, weight }
}

const indexes = new WeakMap<CalcHistoryEntry, Field[]>()

function fieldsOf(entry: CalcHistoryEntry): Field[] {
  let fields = indexes.get(entry)

  if (!fields) {
    fields = [fieldOf(entry.context ?? '', WEIGHT.context), fieldOf(entry.input, WEIGHT.input), fieldOf(entry.result, WEIGHT.result), fieldOf('', WEIGHT.source, SOURCE_WORDS.get(entry.source) ?? [])]
    indexes.set(entry, fields)
  }

  return fields
}

/** The day a week starts on in `locale`, 0 for Sunday; Monday when the platform does not say. */
export function firstDayOfWeek(locale?: string): number {
  type WeekInfo = { firstDay?: number }

  try {
    const info = new Intl.Locale(locale || new Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo }
    const firstDay = (typeof info.getWeekInfo === 'function' ? info.getWeekInfo() : info.weekInfo)?.firstDay

    return typeof firstDay === 'number' && firstDay >= 1 && firstDay <= 7 ? firstDay % 7 : 1
  } catch {
    return 1
  }
}

type Token = { kind: 'word'; text: string } | { kind: 'number'; digits: string[] }

function tokensOf(query: string): Token[] {
  const tokens: Token[] = []

  for (const match of fold(query).matchAll(QUERY_TOKEN)) {
    const [, scaled, suffix, number, word] = match

    if (scaled) {
      tokens.push({ kind: 'number', digits: [scaledDigits(scaled, suffix)] })
    } else if (number) {
      tokens.push({ kind: 'number', digits: [digitsOf(number)] })
    } else if (word) {
      tokens.push({ kind: 'word', text: word })
    }
  }

  return tokens
}

/** The words worth matching and the days asked about, from what the person typed. */
export function parseHistoryQuery(query: string, options: HistorySearchOptions = {}): HistoryQuery {
  const now = options.now ?? Date.now()
  const firstDay = firstDayOfWeek(options.locale)
  const tokens = tokensOf(query)
  const terms: HistoryTerm[] = []
  const spans: HistorySpan[] = []
  const seen = new Set<string>()

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]

    if (token.kind === 'number') {
      const key = `#${token.digits.join('|')}`

      if (!seen.has(key)) {
        seen.add(key)
        terms.push({ kind: 'number', digits: token.digits })
      }

      continue
    }

    const next = tokens[i + 1]
    const pair = next?.kind === 'word' ? TIME_PAIRS.get(`${token.text} ${next.text}`) : undefined
    const single = TIME_WORDS.get(token.text)

    if (pair) {
      spans.push(pair(now, firstDay))
      i++

      continue
    }

    if (single) {
      spans.push(single(now, firstDay))

      continue
    }

    if (FILLER.has(token.text) || seen.has(token.text)) {
      continue
    }

    seen.add(token.text)
    terms.push({ kind: 'word', raw: token.text, stem: stem(token.text) })
  }

  return { terms, spans }
}

/** Whether `a` and `b` are at most `max` edits apart, a swap of two neighbours counting as one. */
function near(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) {
    return false
  }

  let before: number[] = []
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)

  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let lowest = i

    for (let j = 1; j <= b.length; j++) {
      let cost = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cost = Math.min(cost, before[j - 2] + 1)
      }

      current.push(cost)
      lowest = Math.min(lowest, cost)
    }

    if (lowest > max) {
      return false
    }

    before = previous
    previous = current
  }

  return previous[b.length] <= max
}

/** Typos forgiven in a word this long: none under five letters, one, then two from eight. */
const typosFor = (word: string): number => (word.length >= 8 ? 2 : word.length >= 5 ? 1 : 0)

function wordQuality(term: Extract<HistoryTerm, { kind: 'word' }>, field: Field): number {
  const typos = typosFor(term.raw)
  let best = 0

  for (let i = 0; i < field.words.length; i++) {
    const word = field.words[i]
    const wordStem = field.stems[i]

    if (word === term.raw || wordStem === term.stem) {
      return QUALITY.exact
    }

    if (word.startsWith(term.raw)) {
      best = Math.max(best, QUALITY.prefix)
    } else if (best < QUALITY.typo && typos && wordStem.length >= 4 && (near(term.stem, wordStem, typos) || near(term.raw, word, typos))) {
      best = QUALITY.typo
    }
  }

  return best
}

function numberQuality(term: Extract<HistoryTerm, { kind: 'number' }>, field: Field): number {
  let best = 0

  for (const digits of term.digits) {
    for (const number of field.numbers) {
      if (number === digits) {
        return QUALITY.exact
      }

      if (number.startsWith(digits)) {
        best = Math.max(best, QUALITY.digitsPrefix)
      }
    }
  }

  return best
}

interface Scored {
  entry: CalcHistoryEntry
  matched: number
  score: number
  order: number
}

function scoreOf(entry: CalcHistoryEntry, terms: readonly HistoryTerm[], order: number): Scored {
  const fields = fieldsOf(entry)
  let matched = 0
  let score = 0

  for (const term of terms) {
    let best = 0

    for (const field of fields) {
      best = Math.max(best, field.weight * (term.kind === 'word' ? wordQuality(term, field) : numberQuality(term, field)))
    }

    if (best > 0) {
      matched++
      score += best
    }
  }

  return { entry, matched, score, order }
}

const newestFirst = (a: { entry: CalcHistoryEntry; order: number }, b: { entry: CalcHistoryEntry; order: number }): number => b.entry.at - a.entry.at || a.order - b.order

/** Entries that match the words ("that mortgage thing"), best first; everything, newest first, for an empty query. */
export function searchHistory(entries: readonly CalcHistoryEntry[], query: string, limit = 50, options: HistorySearchOptions = {}): CalcHistoryEntry[] {
  const max = Math.max(0, Math.floor(limit))
  const { terms, spans } = parseHistoryQuery(query, options)
  const inSpan = (entry: CalcHistoryEntry) => !spans.length || spans.some(([start, end]) => entry.at >= start && entry.at < end)
  const candidates = entries.map((entry, order) => ({ entry, order })).filter(({ entry }) => inSpan(entry))

  if (!terms.length) {
    return candidates
      .sort(newestFirst)
      .slice(0, max)
      .map(({ entry }) => entry)
  }

  return candidates
    .map(({ entry, order }) => scoreOf(entry, terms, order))
    .filter(scored => scored.matched > 0)
    .sort((a, b) => Number(b.matched === terms.length) - Number(a.matched === terms.length) || b.matched - a.matched || b.score - a.score || newestFirst(a, b))
    .slice(0, max)
    .map(({ entry }) => entry)
}
