import { CURRENCY_WORDS, LENGTH_WORDS, MATH_WORDS, UNIT_WORDS } from '../../features/calc/engine/vocabulary.ts'
import { knownZoneNames } from '../../features/calc/engine/zones-names.ts'

/*
 * Simple spoken math for the voice fast path: "whats 15% of 340", "how many miles is 10 km" and
 * "what time is it in tokyo" become sentences Herald Calc's engine reads ("15% of 340", "10 km in
 * miles", "time in tokyo"), so Herald answers at once. Every word has to be a number, an
 * operator, a unit or currency the engine knows, a place or a date; anything else ("my rent",
 * "should I tip", "why") is Hermes's. Pure, and the vocabulary never loads math.js.
 */

/** Longer than this is a request, not a sum. */
const MAX_WORDS = 16

/** Asking for thought rather than a number. */
const REASONING = /\b(?:why|how come|explain|should|would|could|think|best|better|worth|recommend|means?|prove|compare|difference|not)\b/

/** Said around a sum without changing it. */
const FILLERS = new Set(['the', 'um', 'uh', 'er', 'erm', 'hmm', 'exactly'])

const ONES: ReadonlyMap<string, number> = new Map(Object.entries({ zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 }))
const TENS: ReadonlyMap<string, number> = new Map(Object.entries({ twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }))
/** Each as a power of ten. */
const SCALES: ReadonlyMap<string, number> = new Map(Object.entries({ thousand: 3, million: 6, billion: 9, trillion: 12 }))
/** "a half", "three quarters": the denominator each names. */
const PARTS: ReadonlyMap<string, number> = new Map(Object.entries({ half: 2, halves: 2, third: 3, thirds: 3, quarter: 4, quarters: 4, fourth: 4, fourths: 4, fifth: 5, fifths: 5, tenth: 10, tenths: 10 }))
const ORDINALS: ReadonlyMap<string, number> = new Map(Object.entries({ first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 }))

/** Spoken operators as the engine writes them, longest first; "the" is gone by now ("to the power of" is "to power of"). */
const OPERATORS: ReadonlyArray<readonly [readonly string[], string]> = [
  [['raised', 'to', 'power', 'of'], '^'],
  [['to', 'power', 'of'], '^'],
  [['raised', 'to'], '^'],
  [['to', 'power'], '^'],
  [['multiplied', 'by'], '*'],
  [['divided', 'by'], '/'],
  [['take', 'away'], '-'],
  [['plus'], '+'],
  [['+'], '+'],
  [['minus'], '-'],
  [['-'], '-'],
  [['less'], '-'],
  [['times'], '*'],
  [['x'], '*'],
  [['*'], '*'],
  [['over'], '/'],
  [['/'], '/'],
  [['^'], '^'],
  [['mod'], 'mod'],
  [['modulo'], 'mod']
]

/** Functions read whatever the engine's vocabulary says, by the name math.js calls them. */
const FUNCTIONS: ReadonlyMap<string, string> = new Map(Object.entries({ sqrt: 'sqrt', cbrt: 'cbrt', sin: 'sin', cos: 'cos', tan: 'tan', sine: 'sin', cosine: 'cos', tangent: 'tan' }))

/** "add 5 and 3", "subtract 5 from 12": the word that joins the two numbers. */
const VERBS: ReadonlyMap<string, readonly string[]> = new Map([
  ['add', ['and', 'to']],
  ['subtract', ['from']],
  ['take', ['from']],
  ['multiply', ['by']],
  ['divide', ['by']]
])

/**
 * Words the grammar reads itself, never as a unit, a currency or a place even when the engine
 * knows them ("in" for inches, "a" for ares, "am" for attometres), and words about the person.
 */
const RESERVED = new Set([
  ...['a', 'an', 'and', 'are', 'as', 'at', 'by', 'from', 'in', 'into', 'is', 'it', 'its', 'of', 'off', 'on', 'or', 'over', 'per', 'point', 'than', 'to', 'x', 'am', 'pm'],
  ...['plus', 'minus', 'times', 'less', 'squared', 'cubed', 'percent', 'cent', 'split', 'ways', 'between', 'among', 'half', 'root', 'square', 'cube', 'power', 'raised', 'multiplied', 'divided', 'take', 'away', 'mod', 'modulo'],
  ...['what', 'whats', 'how', 'many', 'much', 'when', 'where', 'which', 'who'],
  ...['i', 'im', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours', 'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them', 'their', 'this', 'that', 'these', 'those', 'here', 'there']
])

const MONTHS = new Set(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec'])
const WEEKDAYS = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])
/** What "how many days until …" counts in. */
const DURATIONS = new Set(['day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'hour', 'hours', 'minute', 'minutes'])

/** Leading questions around a sum, longest first. */
const LEADS: ReadonlyArray<readonly string[]> = [
  ['what', 'is'],
  ['whats'],
  ['what', 'are'],
  ['what', 'does'],
  ['what', 'do'],
  ['how', 'much', 'is'],
  ['how', 'much', 'are'],
  ['how', 'much'],
  ['calculate'],
  ['compute'],
  ['work', 'out'],
  ['figure', 'out'],
  ['convert'],
  ['tell', 'me', 'what'],
  ['tell', 'me']
]
const ENDINGS: ReadonlyArray<readonly string[]> = [['is', 'equal', 'to'], ['equal', 'to'], ['equals'], ['equal'], ['is'], ['are'], ['makes'], ['make'], ['comes', 'to'], ['come', 'to'], ['=']]
const CONVERSIONS = new Set(['in', 'to', 'into', 'as'])
/** "right now"; the utterance arrives without a last "now", so "right" can be left alone. */
const NOW: ReadonlyArray<readonly string[]> = [['right', 'now'], ['now'], ['right']]
const UNTIL = new Set(['until', 'till', 'til', 'to', 'before'])
const OFFSET_LEADS: ReadonlyArray<readonly string[]> = [
  ['what', 'date', 'will', 'it', 'be'],
  ['what', 'day', 'will', 'it', 'be'],
  ['what', 'date', 'is', 'it'],
  ['what', 'day', 'is', 'it'],
  ['what', 'date', 'was', 'it'],
  ['what', 'day', 'was', 'it'],
  ['what', 'was', 'date'],
  ['what', 'is', 'date'],
  ['whats', 'date'],
  ['what', 'date', 'is'],
  ['what', 'day', 'is'],
  ['what', 'date', 'was'],
  ['what', 'day', 'was'],
  ['what', 'is'],
  ['whats']
]

const DIGITS = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$|^-?\.\d+$/
const MONEY = /^[$€£¥₹](?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/
const PERCENT = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%$/
/** A number with a unit written onto it: "10km", "350°f". */
const GLUED = /^(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)([a-z°µ]\S*)$/

interface Found {
  text: string
  /** The index after the words read. */
  next: number
}

interface Operand extends Found {
  /** "15%", which "of" and "off" may follow. */
  percent: boolean
  /** It has a unit or a currency, so it converts. */
  measured: boolean
}

interface Part {
  numerator: number
  denominator: number
  next: number
}

interface Parse {
  words: readonly string[]
  /** Operations read so far: a sum needs one. */
  operations: number
}

type PhraseIndex = ReadonlyMap<string, readonly (readonly string[])[]>

/**
 * The sentence Herald Calc's engine reads for a normalised utterance (lower case, apostrophes
 * dropped: "whats 15% of 340" is "15% of 340"), or null when it is not clearly simple math.
 */
export function spokenMath(utterance: string): string | null {
  const said = utterance.trim().toLowerCase()

  if (!said || said.split(/\s+/).length > MAX_WORDS || REASONING.test(said)) {
    return null
  }

  const words = wordsOf(said)

  return words.length ? (zoneForm(words) ?? dateForm(words) ?? arithmeticForm(words)) : null
}

/** The utterance as words: "a.m." as "am", "twenty-five" as two words, the fillers gone. */
function wordsOf(said: string): string[] {
  return said
    .replace(/['’]/g, '')
    .replace(/(^|[\s\d])([ap])\.\s?m\b\.?/g, '$1$2m')
    .replace(/([a-z])-(?=[a-z])/g, '$1 ')
    .split(/\s+/)
    .map(word => word.replace(/^[,?!]+|[,?!]+$/g, ''))
    .filter(word => word !== '' && !FILLERS.has(word))
}

const numberWord = (word: string): boolean => ONES.has(word) || TENS.has(word) || SCALES.has(word) || word === 'hundred'

function indexPhrases(phrases: Iterable<string>): PhraseIndex {
  const index = new Map<string, string[][]>()

  for (const phrase of phrases) {
    const words = phrase.toLowerCase().split(/\s+/).filter(Boolean)

    // A lone grammar word stays the grammar's: "in" is never a unit word here.
    if (words.length === 0 || (words.length === 1 && (RESERVED.has(words[0]) || numberWord(words[0])))) {
      continue
    }

    const list = index.get(words[0])

    if (list) {
      list.push(words)
    } else {
      index.set(words[0], [words])
    }
  }

  for (const list of index.values()) {
    list.sort((a, b) => b.length - a.length)
  }

  return index
}

/** How many words from `at` make the longest phrase of `index`; 0 when none starts there. */
function phraseAt(index: PhraseIndex, words: readonly string[], at: number): number {
  for (const phrase of index.get(words[at] ?? '') ?? []) {
    if (phrase.every((word, offset) => words[at + offset] === word)) {
      return phrase.length
    }
  }

  return 0
}

let units: { key: string; index: PhraseIndex } | null = null
let zones: { names: readonly string[]; index: PhraseIndex } | null = null

function unitIndex(): PhraseIndex {
  const key = `${UNIT_WORDS.size}:${CURRENCY_WORDS.size}`

  if (units?.key !== key) {
    units = { key, index: indexPhrases([...UNIT_WORDS, ...CURRENCY_WORDS]) }
  }

  return units.index
}

/** Every place and zone abbreviation Herald Calc knows; none where the platform lists no zones. */
function placeNames(): readonly string[] {
  try {
    return knownZoneNames()
  } catch {
    return []
  }
}

function zoneIndex(): PhraseIndex {
  const names = placeNames()

  if (!zones || (zones.names !== names && zones.names.length !== names.length)) {
    zones = { names, index: indexPhrases(names) }
  }

  return zones.index
}

/** The index after whichever of `options` starts at `at` (the first that does), or `at`. */
function skip(words: readonly string[], at: number, options: ReadonlyArray<readonly string[]>): number {
  for (const option of options) {
    if (option.every((word, offset) => words[at + offset] === word)) {
      return at + option.length
    }
  }

  return at
}

/* Times of day across zones: "what time is it in tokyo", "whats 9am sydney in new york". */

function zoneForm(words: readonly string[]): string | null {
  const zones = zoneIndex()

  if (zones.size === 0) {
    return null
  }

  const zoneAt = (at: number): Found | null => {
    const length = phraseAt(zones, words, at)

    if (length === 0) {
      return null
    }

    // "sydney time" is Sydney.
    return { text: words.slice(at, at + length).join(' '), next: words[at + length] === 'time' ? at + length + 1 : at + length }
  }

  let at = skip(words, skip(words, 0, [['what', 'is'], ['whats'], ['what'], ['tell', 'me', 'what'], ['tell', 'me']]), [['current'], ['local']])

  if (words[at] === 'time') {
    const after = skip(words, skip(words, at + 1, [['is', 'it'], ['it', 'is'], ['its']]), NOW)
    const zone = words[after] === 'in' ? zoneAt(after + 1) : null

    if (zone && skip(words, zone.next, NOW) === words.length) {
      return `time in ${zone.text}`
    }
  }

  at = skip(words, 0, [['what', 'time', 'is'], ['what', 'is'], ['whats'], ['convert']])
  const time = timeAt(words, at)

  if (!time) {
    return null
  }

  const from = zoneAt(time.next) ?? (words[time.next] === 'in' ? zoneAt(time.next + 1) : null)

  if (from && CONVERSIONS.has(words[from.next] ?? '')) {
    const to = zoneAt(from.next + 1)

    if (to && to.next === words.length) {
      return `${time.text} ${from.text} in ${to.text}`
    }
  }

  // "3pm in tokyo": from the person's own zone.
  const to = CONVERSIONS.has(words[time.next] ?? '') ? zoneAt(time.next + 1) : null

  return to && to.next === words.length ? `${time.text} in ${to.text}` : null
}

/** "9am", "9 am", "9:30 pm", "nine thirty am", "noon", "14:30": the time of day as the engine writes it. */
function timeAt(words: readonly string[], at: number): Found | null {
  const word = words[at] ?? ''

  if (word === 'noon' || word === 'midday') {
    return { text: '12pm', next: at + 1 }
  }

  if (word === 'midnight') {
    return { text: '12am', next: at + 1 }
  }

  const written = /^(\d{1,2})(?:([:.])(\d{2}))?(am|pm)?$/.exec(word)
  let hour: number
  let minutes = ''
  let half = written?.[4] ?? ''
  let next = at + 1

  if (written) {
    hour = Number(written[1])
    minutes = written[3] ?? ''
  } else {
    const said = ONES.get(word)

    if (said === undefined) {
      return null
    }

    hour = said
    const ten = TENS.get(words[next] ?? '')
    const teen = ONES.get(words[next] ?? '')
    const one = ONES.get(words[next + 1] ?? '') ?? 0
    const single = one > 0 && one < 10

    if (ten !== undefined && ten <= 50) {
      minutes = String(ten + (single ? one : 0))
      next += single ? 2 : 1
    } else if (teen !== undefined && teen > 9) {
      minutes = String(teen)
      next += 1
    } else if ((words[next] === 'oh' || words[next] === 'o') && single) {
      minutes = `0${one}`
      next += 2
    }
  }

  if (!half) {
    const after = skip(words, next, [['oclock'], ['o', 'clock']])

    if (words[after] === 'am' || words[after] === 'pm') {
      half = words[after]
      next = after + 1
    }
  }

  if (minutes && Number(minutes) > 59) {
    return null
  }

  if (half) {
    return hour >= 1 && hour <= 12 ? { text: `${hour}${minutes ? `:${minutes.padStart(2, '0')}` : ''}${half}`, next } : null
  }

  // Without am or pm only a 24-hour time with its colon counts: "9.30" is a number.
  return written?.[2] === ':' && hour <= 23 ? { text: `${hour}:${minutes}`, next } : null
}

/* Dates: "how many days until december 25th", "90 days from today". */

function dateForm(words: readonly string[]): string | null {
  return countedForm(words) ?? offsetForm(words)
}

/** "how many days until december 25th" is "days until december 25"; "between march 3 and june 9" is "march 3 to june 9 in days". */
function countedForm(words: readonly string[]): string | null {
  let at = skip(words, 0, [['how', 'many'], ['number', 'of']])
  const unit = words[at] ?? ''

  if (!DURATIONS.has(unit)) {
    return null
  }

  at = skip(words, at + 1, [['is', 'it'], ['are', 'there'], ['are', 'left'], ['is', 'there'], ['left'], ['has', 'it', 'been'], ['have', 'passed']])
  const link = words[at] ?? ''

  if (link === 'between' || link === 'from') {
    const start = dateAt(words, at + 1)
    const joined = start && (words[start.next] === 'and' || UNTIL.has(words[start.next] ?? ''))
    const end = start && joined ? dateAt(words, start.next + 1) : null

    return start && end && end.next === words.length ? `${start.text} to ${end.text} in ${unit}` : null
  }

  if (!UNTIL.has(link) && link !== 'since') {
    return null
  }

  const date = dateAt(words, at + 1)

  return date && date.next === words.length ? `${unit} ${link === 'since' ? 'since' : 'until'} ${date.text}` : null
}

/** "90 days from today", "a week from tomorrow", "100 days ago", "the date in 3 weeks". */
function offsetForm(words: readonly string[]): string | null {
  const at = skip(words, 0, OFFSET_LEADS)

  if (words[at] === 'in') {
    const amount = amountAt(words, at + 1)

    return amount && DURATIONS.has(words[amount.next] ?? '') && amount.next + 1 === words.length ? `${amount.text} ${words[amount.next]} from today` : null
  }

  const amount = amountAt(words, at)
  const unit = amount ? (words[amount.next] ?? '') : ''

  if (!amount || !DURATIONS.has(unit)) {
    return null
  }

  const link = words[amount.next + 1]

  if (link === 'ago') {
    return amount.next + 2 === words.length ? `${amount.text} ${unit} ago` : null
  }

  if (link !== 'from' && link !== 'after' && link !== 'before') {
    return null
  }

  const date = dateAt(words, amount.next + 2)

  return date && date.next === words.length ? `${amount.text} ${unit} ${link === 'before' ? 'before' : 'from'} ${date.text}` : null
}

/** A count of days or weeks: a number, or "a" for one. */
function amountAt(words: readonly string[], at: number): Found | null {
  if (words[at] === 'a' || words[at] === 'an') {
    return { text: '1', next: at + 1 }
  }

  const number = numberAt(words, at)

  return number && /^\d+(?:\.\d+)?$/.test(number.text.replace(/,/g, '')) ? number : null
}

/** "december 25", "25th of december", "dec 25 2026", "next friday", "today": the date as the engine reads it. */
function dateAt(words: readonly string[], at: number): Found | null {
  const word = words[at] ?? ''

  if (word === 'today' || word === 'tomorrow' || word === 'yesterday' || word === 'now') {
    return { text: word, next: at + 1 }
  }

  if ((word === 'next' || word === 'this' || word === 'last') && WEEKDAYS.has(words[at + 1] ?? '')) {
    return { text: `${word} ${words[at + 1]}`, next: at + 2 }
  }

  if (WEEKDAYS.has(word)) {
    return { text: word, next: at + 1 }
  }

  const named = MONTHS.has(word) ? dayAt(words, at + 1) : null

  if (named) {
    return withYear(`${word} ${named.day}`, words, named.next)
  }

  const day = dayAt(words, at)

  return day && words[day.next] === 'of' && MONTHS.has(words[day.next + 1] ?? '') ? withYear(`${words[day.next + 1]} ${day.day}`, words, day.next + 2) : null
}

function withYear(text: string, words: readonly string[], at: number): Found {
  return /^(?:19|20)\d{2}$/.test(words[at] ?? '') ? { text: `${text} ${words[at]}`, next: at + 1 } : { text, next: at }
}

/** A day of the month: "25", "25th", "twenty fifth", "twenty five", "first". */
function dayAt(words: readonly string[], at: number): { day: number; next: number } | null {
  const word = words[at] ?? ''
  const written = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(word)
  let day: number | undefined
  let next = at + 1

  if (written) {
    day = Number(written[1])
  } else if (word === 'twenty' || word === 'thirty') {
    const unit = ORDINALS.get(words[at + 1] ?? '') ?? ONES.get(words[at + 1] ?? '') ?? 0
    const single = unit > 0 && unit < 10

    day = (TENS.get(word) ?? 0) + (single ? unit : 0)
    next += single ? 1 : 0
  } else {
    day = ORDINALS.get(word) ?? ONES.get(word)
  }

  return day !== undefined && day >= 1 && day <= 31 ? { day, next } : null
}

/* Sums, percentages, units and currencies: "15% of 340", "10 km in miles", "2,400 + 180 split 3 ways". */

function arithmeticForm(words: readonly string[]): string | null {
  const tokens = trimmed(mathTokens(words))

  return howMany(tokens) ?? verbForm(tokens) ?? sum(tokens)
}

/** Words with their symbols apart ("2+2" is "2 + 2") and a number apart from the unit written on it ("10km"). */
function mathTokens(words: readonly string[]): string[] {
  const tokens: string[] = []

  for (const word of words) {
    const symbols = word.replace(/×/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-')
    // "km/h" is a unit; any other slash divides.
    const spaced = (/^[a-z°µ]+\/[a-z°µ]+$/.test(symbols) ? symbols : symbols.replace(/\//g, ' / '))
      .replace(/([+*^=()])/g, ' $1 ')
      .replace(/(\d)-(?=[\d.(])/g, '$1 - ')
      .replace(/(\d)x(?=\d)/g, '$1 x ')

    for (const piece of spaced.split(/\s+/)) {
      const glued = GLUED.exec(piece)

      if (glued && phraseAt(unitIndex(), [glued[2]], 0) === 1) {
        tokens.push(glued[1], glued[2])
      } else if (piece) {
        tokens.push(piece)
      }
    }
  }

  return tokens
}

/** The words without the question around them: "what is", "how much is", "calculate" before; "equal", "is" after. */
function trimmed(tokens: readonly string[]): string[] {
  const start = skip(tokens, skip(tokens, 0, LEADS), LEADS)
  let end = tokens.length

  for (const ending of ENDINGS) {
    if (end - ending.length > start && ending.every((word, offset) => tokens[end - ending.length + offset] === word)) {
      end -= ending.length
      break
    }
  }

  return tokens.slice(start, end)
}

/** "how many miles is 10 km" is "10 km in miles"; "how many cups in a litre" is "1 litre in cups". */
function howMany(tokens: readonly string[]): string | null {
  if (tokens[0] !== 'how' || tokens[1] !== 'many') {
    return null
  }

  const unit = unitAt(tokens, 2)

  if (!unit) {
    return null
  }

  const at = skip(tokens, unit.next, [['are', 'there', 'in'], ['is', 'there', 'in'], ['are', 'in'], ['is', 'in'], ['go', 'into'], ['go', 'in'], ['fit', 'into'], ['fit', 'in'], ['make', 'up'], ['makes'], ['make'], ['is'], ['are'], ['in']])
  const amount = expressionAt({ words: tokens, operations: 0 }, at)

  return amount && amount.measured && amount.next === tokens.length ? tidy(`${amount.text} in ${unit.text}`) : null
}

/** "add 5 and 3", "add 15% to 80", "subtract 5 from 12", "take 5 away from 12", "multiply 6 by 7", "divide 100 by 3". */
function verbForm(tokens: readonly string[]): string | null {
  const verb = tokens[0] ?? ''
  const joins = VERBS.get(verb)

  if (!joins) {
    return null
  }

  const parse: Parse = { words: tokens, operations: 1 }
  const left = expressionAt(parse, 1)

  if (!left) {
    return null
  }

  const at = verb === 'take' && tokens[left.next] === 'away' ? left.next + 1 : left.next
  const join = tokens[at] ?? ''
  const right = joins.includes(join) ? expressionAt(parse, at + 1) : null

  if (!right || right.next !== tokens.length) {
    return null
  }

  const [a, b] = [grouped(left.text), grouped(right.text)]

  if (verb === 'add') {
    return tidy(join === 'to' ? `${b} + ${a}` : `${a} + ${b}`)
  }

  if (verb === 'multiply' || verb === 'divide') {
    return tidy(`${a} ${verb === 'multiply' ? '*' : '/'} ${b}`)
  }

  return tidy(`${b} - ${a}`)
}

/** An expression, then perhaps a conversion and a split: the sentence, when it works something out. */
function sum(tokens: readonly string[]): string | null {
  const parse: Parse = { words: tokens, operations: 0 }
  const expression = expressionAt(parse, 0)

  if (!expression) {
    return null
  }

  const inches = parse.operations === 0 && DIGITS.test(expression.text) && inchesBefore(tokens, expression.next)
  let text = inches ? `${expression.text} inches` : expression.text
  let next = expression.next
  let converted = false
  let split = false

  while (next < tokens.length) {
    const into = tokens[next] === 'in' && tokens[next + 1] === 'to' ? next + 2 : next + 1
    const target = !converted && (expression.measured || inches) && CONVERSIONS.has(tokens[next]) ? unitAt(tokens, into) : null

    if (target) {
      text += ` in ${target.text}`
      next = target.next
      converted = true
      continue
    }

    const ways = split ? null : splitAt(tokens, next)

    if (!ways) {
      return null
    }

    text += ` split ${ways.text} ways`
    next = ways.next
    split = true
  }

  return parse.operations > 0 || converted || split ? tidy(text) : null
}

/** "split 3 ways", "split between 4 people", "shared among 4": how many ways. */
function splitAt(words: readonly string[], at: number): Found | null {
  const shared = skip(words, at, [['split', 'between'], ['split', 'among'], ['shared', 'between'], ['shared', 'among'], ['divided', 'between'], ['divided', 'among']])
  const start = shared > at ? shared : words[at] === 'split' ? at + 1 : at

  if (start === at) {
    return null
  }

  const count = numberAt(words, start)

  if (!count || !/^\d+$/.test(count.text)) {
    return null
  }

  const next = skip(words, count.next, shared > at ? [['people'], ['ways']] : [['ways'], ['way']])

  return next > count.next || shared > at ? { text: count.text, next } : null
}

function operatorAt(words: readonly string[], at: number): Found | null {
  for (const [said, symbol] of OPERATORS) {
    if (said.every((word, offset) => words[at + offset] === word)) {
      return { text: symbol, next: at + said.length }
    }
  }

  return null
}

/** Operands joined by operators ("2 + 3 * 4", "15% of 340", "5^2"), and whether any has a unit. */
function expressionAt(parse: Parse, at: number): (Found & { measured: boolean }) | null {
  const { words } = parse
  let left = operandAt(parse, at)

  if (!left) {
    return null
  }

  const pieces = [left.text]
  let next = left.next
  let measured = left.measured

  while (next < words.length) {
    const word = words[next]

    if (word === 'squared' || word === 'cubed') {
      pieces[pieces.length - 1] += word === 'squared' ? '^2' : '^3'
      parse.operations += 1
      next += 1
      continue
    }

    const operator = operatorAt(words, next)
    const link = operator?.text ?? ((word === 'of' || word === 'off') && left.percent ? word : null)

    if (!link) {
      break
    }

    const right = operandAt(parse, operator ? operator.next : next + 1)

    if (!right) {
      return null
    }

    pieces.push(link, right.text)
    parse.operations += 1
    measured ||= right.measured
    left = right
    next = right.next
  }

  return { text: pieces.join(' '), next, measured }
}

function operandAt(parse: Parse, at: number): Operand | null {
  const { words } = parse
  const word = words[at]

  if (word === undefined) {
    return null
  }

  if (word === 'minus' || word === 'negative' || word === '-') {
    const inner = operandAt(parse, at + 1)

    return inner && { ...inner, text: `-${inner.text}` }
  }

  if (word === '(') {
    const inner = expressionAt(parse, at + 1)

    return inner && words[inner.next] === ')' ? { text: `(${inner.text})`, next: inner.next + 1, percent: false, measured: inner.measured } : null
  }

  if (word === 'pi') {
    return { text: 'pi', next: at + 1, percent: false, measured: false }
  }

  const call = functionAt(words, at)

  if (call) {
    const inner = operandAt(parse, call.next)

    if (!inner) {
      return null
    }

    parse.operations += 1

    return { text: `${call.name}(${bare(inner.text)})`, next: inner.next, percent: false, measured: inner.measured }
  }

  if (MONEY.test(word)) {
    const scale = SCALES.get(words[at + 1] ?? '')

    return { text: scale === undefined ? word : `${word[0]}${shifted(word.slice(1), scale)}`, next: at + (scale === undefined ? 1 : 2), percent: false, measured: true }
  }

  if (PERCENT.test(word)) {
    return { text: word, next: at + 1, percent: true, measured: false }
  }

  const part = partAt(words, at)

  if (part) {
    return partOperand(parse, part)
  }

  // "a litre", "an hour"; "a hundred" is a number.
  const one = word === 'a' || word === 'an' ? unitAt(words, at + 1) : null

  if (one) {
    return { text: `1 ${one.text}`, next: one.next, percent: false, measured: true }
  }

  const number = numberAt(words, at)

  if (!number) {
    return null
  }

  const percent = words[number.next] === '%' || words[number.next] === 'percent' ? 1 : words[number.next] === 'per' && words[number.next + 1] === 'cent' ? 2 : 0

  return percent ? { text: `${number.text}%`, next: number.next + percent, percent: true, measured: false } : quantity(words, number)
}

/** "half of 80" is 50% of 80, "a third of 90" is 90 / 3, "half a litre" is 0.5 litre, "three quarters" is 0.75. */
function partOperand(parse: Parse, part: Part): Operand | null {
  const { words } = parse
  const share = fractionText(part.numerator, part.denominator)

  if (words[part.next] === 'of') {
    const whole = operandAt(parse, part.next + 1)

    if (!whole) {
      return null
    }

    parse.operations += 1
    const percent = (part.numerator * 100) / part.denominator
    const text = Number.isInteger(percent) ? `${percent}% of ${whole.text}` : `${whole.text}${part.numerator === 1 ? '' : ` * ${part.numerator}`} / ${part.denominator}`

    return { text, next: whole.next, percent: false, measured: whole.measured }
  }

  const unit = unitAt(words, part.next) ?? (words[part.next] === 'a' || words[part.next] === 'an' ? unitAt(words, part.next + 1) : null)

  return unit ? { text: `${share} ${unit.text}`, next: unit.next, percent: false, measured: true } : { text: share, next: part.next, percent: false, measured: false }
}

/** A number and its units: "10 km", "100 dollars", "5 feet 3 inches", and the "5 feet 10" of "5 feet 10 in cm" in inches. */
function quantity(words: readonly string[], number: Found): Operand {
  const pieces = [number.text]
  let next = number.next
  let unit = unitAt(words, next)

  while (unit) {
    pieces.push(unit.text)
    next = unit.next
    const more = numberAt(words, next)
    const after = more ? unitAt(words, more.next) : null

    if (more && LENGTH_WORDS.has(unit.text) && inchesBefore(words, more.next)) {
      pieces.push(more.text, 'inches')
      next = more.next
      break
    }

    if (!more || !after) {
      break
    }

    pieces.push(more.text)
    unit = after
  }

  return { text: pieces.join(' '), next, percent: false, measured: pieces.length > 1 }
}

/** Whether "in" and a length start at `at`, where the engine reads a plain number just before as inches ("12 in cm"). */
function inchesBefore(words: readonly string[], at: number): boolean {
  return words[at] === 'in' && LENGTH_WORDS.has(unitAt(words, at + 1)?.text ?? '')
}

/** A unit or currency from `at`, in one or several words the engine reads ("km", "us dollars", "degrees fahrenheit", "km per hour"). */
function unitAt(words: readonly string[], at: number): Found | null {
  const index = unitIndex()
  let next = at
  let length = phraseAt(index, words, next)

  while (length > 0) {
    next += length
    length = phraseAt(index, words, next)

    if (length === 0 && words[next] === 'per') {
      length = phraseAt(index, words, next + 1)
      next += length > 0 ? 1 : 0
    }
  }

  return next > at ? { text: words.slice(at, next).join(' '), next } : null
}

/** "square root of", "cube root of", "sqrt", or a function the engine reads ("sin", "log"), with "of" or not: what to call. */
function functionAt(words: readonly string[], at: number): { name: string; next: number } | null {
  const word = words[at] ?? ''
  let name: string | undefined
  let next = at + 1

  if ((word === 'square' || word === 'cube') && words[at + 1] === 'root') {
    name = word === 'square' ? 'sqrt' : 'cbrt'
    next = at + 2
  } else if (FUNCTIONS.has(word)) {
    name = FUNCTIONS.get(word)
  } else if (word.length > 1 && /^[a-z]+$/.test(word) && MATH_WORDS.has(word) && !RESERVED.has(word) && !numberWord(word)) {
    name = word
  }

  return name ? { name, next: words[next] === 'of' ? next + 1 : next } : null
}

/** A whole number in words ("three hundred and forty", "a million", "twelve hundred") from `at`. */
function wholeAt(words: readonly string[], at: number): { value: number; next: number } | null {
  let total = 0
  let group = 0
  let last: 'one' | 'ten' | 'hundred' | 'scale' | null = null
  let smallest = Infinity
  let i = at

  if ((words[i] === 'a' || words[i] === 'an') && (words[i + 1] === 'hundred' || SCALES.has(words[i + 1] ?? ''))) {
    group = 1
    last = 'one'
    i += 1
  }

  for (; i < words.length; i++) {
    const word = words[i]
    const one = ONES.get(word)
    const ten = TENS.get(word)
    const scale = SCALES.get(word)

    if (one !== undefined) {
      if (last === 'one' || (last === 'ten' && (one === 0 || one > 9))) {
        break
      }

      group += one
      last = 'one'
    } else if (ten !== undefined) {
      if (last === 'one' || last === 'ten') {
        break
      }

      group += ten
      last = 'ten'
    } else if (word === 'hundred') {
      if ((last !== 'one' && last !== 'ten') || group >= 100) {
        break
      }

      group *= 100
      last = 'hundred'
    } else if (scale !== undefined) {
      if (last === null || last === 'scale' || scale >= smallest) {
        break
      }

      total += group * 10 ** scale
      group = 0
      smallest = scale
      last = 'scale'
    } else if (word !== 'and' || (last !== 'hundred' && last !== 'scale') || !(ONES.has(words[i + 1] ?? '') || TENS.has(words[i + 1] ?? ''))) {
      // "three hundred and forty" reads on past its "and"; anything else ends the number.
      break
    }
  }

  return last === null ? null : { value: total + group, next: i }
}

/** The digits after "point": "five" is 5, "one four" is 14, "twenty five" is 25. */
function decimalsAt(words: readonly string[], at: number): { digits: string; next: number } | null {
  const ten = TENS.get(words[at] ?? '')
  const teen = ONES.get(words[at] ?? '')

  if (ten !== undefined) {
    const one = ONES.get(words[at + 1] ?? '')

    return one !== undefined && one > 0 && one < 10 ? { digits: String(ten + one), next: at + 2 } : { digits: String(ten), next: at + 1 }
  }

  if (teen !== undefined && teen > 9) {
    return { digits: String(teen), next: at + 1 }
  }

  if (/^\d+$/.test(words[at] ?? '')) {
    return { digits: words[at], next: at + 1 }
  }

  let digits = ''
  let i = at

  for (; i < words.length; i++) {
    const one = words[i] === 'oh' ? 0 : ONES.get(words[i])

    if (one === undefined || one > 9) {
      break
    }

    digits += String(one)
  }

  return digits ? { digits, next: i } : null
}

/** A number in digits or words from `at` ("2,400", "three hundred and forty", "one point five", "two and a half million"). */
function numberAt(words: readonly string[], at: number): Found | null {
  const word = words[at] ?? ''
  let text: string
  let next: number

  if (DIGITS.test(word)) {
    text = word
    next = at + 1
  } else if (word === 'point') {
    text = '0'
    next = at
  } else {
    const whole = wholeAt(words, at)

    if (!whole) {
      return null
    }

    text = String(whole.value)
    next = whole.next
  }

  if (words[next] === 'point' && !text.includes('.')) {
    const decimals = decimalsAt(words, next + 1)

    if (!decimals) {
      return null
    }

    text = `${text.replace(/,/g, '')}.${decimals.digits}`
    next = decimals.next
  } else if (words[next] === 'and' && !text.includes('.')) {
    // "two and a half".
    const part = partAt(words, next + 1)

    if (part) {
      const whole = Number(text.replace(/,/g, ''))

      text = fractionText(whole * part.denominator + part.numerator, part.denominator)
      next = part.next
    }
  }

  const scale = SCALES.get(words[next] ?? '')

  if (scale !== undefined && !text.startsWith('(')) {
    text = shifted(text, scale)
    next += 1
  }

  return { text, next }
}

/** "a half", "half", "three quarters", "two thirds" from `at`. */
function partAt(words: readonly string[], at: number): Part | null {
  const counted = ONES.get(words[at] ?? '')
  const start = words[at] === 'a' || words[at] === 'an' || (counted !== undefined && counted > 0) ? at + 1 : at
  const denominator = PARTS.get(words[start] ?? '')

  if (denominator === undefined) {
    return null
  }

  return { numerator: start > at && counted !== undefined ? counted : 1, denominator, next: start + 1 }
}

/** n/d as a plain decimal when it ends ("0.75"), else as a fraction in brackets ("(1/3)"). */
function fractionText(numerator: number, denominator: number): string {
  let rest = denominator

  while (rest % 2 === 0) {
    rest /= 2
  }

  while (rest % 5 === 0) {
    rest /= 5
  }

  return rest === 1 ? String(numerator / denominator) : `(${numerator}/${denominator})`
}

/** A plain decimal times ten to the power `places`: ("2.5", 6) is "2500000". */
function shifted(decimal: string, places: number): string {
  const [whole, fraction = ''] = decimal.replace(/,/g, '').split('.')
  const digits = whole + fraction.padEnd(places, '0')
  const point = whole.length + places
  const text = digits.length > point ? `${digits.slice(0, point)}.${digits.slice(point)}` : digits

  return text.replace(/^(-?)0+(?=\d)/, '$1')
}

/** The text without one pair of brackets round all of it. */
function bare(text: string): string {
  if (!text.startsWith('(') || !text.endsWith(')')) {
    return text
  }

  let depth = 0

  for (let i = 0; i < text.length - 1; i++) {
    depth += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0

    if (depth === 0) {
      return text
    }
  }

  return text.slice(1, -1)
}

/** Brackets round a sum that holds an operator, so another can follow it. */
const grouped = (text: string): string => (/ (?:[-+*/^]|mod|of|off) /.test(text) ? `(${text})` : text)

const tidy = (text: string): string => text.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s*\^\s*/g, '^')
