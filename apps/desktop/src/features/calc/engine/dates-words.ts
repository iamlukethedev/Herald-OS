/*
 * The words dates and times are written in: month and weekday names, small numbers in words,
 * durations ("1 year 2 months", "a fortnight", "an hour and a half") and times of day ("9:30 am",
 * "21:15", "noon"). The readers take lower-case text; the words are English, the decimal mark the
 * locale's.
 */

export type CalendarUnit = 'year' | 'month' | 'week' | 'day'
export type ClockUnit = 'hour' | 'minute' | 'second'
export type TimeUnit = CalendarUnit | ClockUnit

/** What a count of time is asked in: a unit, or weekdays only ("business days"). */
export type CountUnit = TimeUnit | 'business'

/** One piece of a written duration: 3 weeks, 1.5 hours, 10 business days. */
export interface DurationPart {
  amount: number
  unit: TimeUnit
  business?: boolean
}

/** A time of day. */
export interface Clock {
  hour: number
  minute: number
  second: number
}

function wordMap(groups: [number, string][]): ReadonlyMap<string, number> {
  const map = new Map<string, number>()
  for (const [value, words] of groups) for (const word of words.split(' ')) map.set(word, value)

  return map
}

/** Month names and abbreviations: 1–12. */
export const MONTH_WORDS = wordMap([
  [1, 'jan january'],
  [2, 'feb february'],
  [3, 'mar march'],
  [4, 'apr april'],
  [5, 'may'],
  [6, 'jun june'],
  [7, 'jul july'],
  [8, 'aug august'],
  [9, 'sep sept september'],
  [10, 'oct october'],
  [11, 'nov november'],
  [12, 'dec december']
])

/** Weekday names and abbreviations: ISO 1 (Monday) … 7 (Sunday). */
export const WEEKDAY_WORDS = wordMap([
  [1, 'mon monday'],
  [2, 'tue tues tuesday'],
  [3, 'wed weds wednesday'],
  [4, 'thu thur thurs thursday'],
  [5, 'fri friday'],
  [6, 'sat saturday'],
  [7, 'sun sunday']
])

/** English month names for messages. */
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const SMALL_NUMBERS = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ')
const TENS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ')
const MULTIPLES = new Map([
  ['couple', 2],
  ['dozen', 12],
  ['hundred', 100]
])

/**
 * A number in figures: "3", "1.5", "1,000". A lone mark is a decimal point unless it is not the
 * locale's and three digits follow it ("1,000" in English, "1.000" in German).
 */
export function readNumber(text: string, decimal: string): number | null {
  if (!/^\d+(?:[.,]\d+)*$/.test(text)) return null
  const marks = text.match(/[.,]/g) ?? []
  if (marks.length === 0) return Number(text)
  const lastMark = marks[marks.length - 1]
  if (marks.length > 1 && marks.every((mark) => mark === lastMark)) return /^\d{1,3}(?:[.,]\d{3})+$/.test(text) ? Number(text.replace(/[.,]/g, '')) : null
  const last = text.lastIndexOf(lastMark)
  const head = text.slice(0, last).replace(/[.,]/g, '')
  const tail = text.slice(last + 1)
  if (marks.length === 1 && lastMark !== decimal && tail.length === 3) return Number(head + tail)

  return Number(`${head}.${tail}`)
}

function readSpelled(words: readonly string[], index: number): { value: number; next: number } | null {
  const [first, second] = words[index].split('-')
  const small = SMALL_NUMBERS.indexOf(first)
  if (small >= 0 && second === undefined) return { value: small, next: index + 1 }
  const tens = TENS.indexOf(first)
  if (tens < 0) return null
  const base = (tens + 2) * 10
  if (second !== undefined) {
    const ones = SMALL_NUMBERS.indexOf(second)

    return ones >= 1 && ones <= 9 ? { value: base + ones, next: index + 1 } : null
  }
  const ones = SMALL_NUMBERS.indexOf(words[index + 1] ?? '')

  return ones >= 1 && ones <= 9 ? { value: base + ones, next: index + 2 } : { value: base, next: index + 1 }
}

/** A count at `index`, in figures or words ("3", "1.5", "three", "twenty-one", "a", "a couple of", "half an"). */
function readCount(words: readonly string[], index: number, decimal: string): { value: number; next: number; article?: boolean } | null {
  const word = words[index]
  if (word === undefined) return null
  const figure = readNumber(word, decimal)
  if (figure !== null) return { value: figure, next: index + 1 }
  if (word === 'half' && (words[index + 1] === 'a' || words[index + 1] === 'an')) return { value: 0.5, next: index + 2 }
  const multipleAt = word === 'a' || word === 'an' || word === 'the' ? index + 1 : index
  const multiple = MULTIPLES.get(words[multipleAt])
  if (multiple) return { value: multiple, next: words[multipleAt + 1] === 'of' ? multipleAt + 2 : multipleAt + 1 }
  if (multipleAt > index) return { value: 1, next: index + 1, article: true }
  const spelled = readSpelled(words, index)
  if (spelled && words[spelled.next] === 'hundred') return { value: spelled.value * 100, next: spelled.next + 1 }

  return spelled
}

interface UnitWord {
  unit: TimeUnit
  factor: number
  plural: boolean
}

const UNIT_WORDS = new Map<string, UnitWord>()
for (const [unit, factor, singular, plural] of [
  ['year', 1, 'year', 'years yr yrs y'],
  ['year', 10, 'decade', 'decades'],
  ['year', 100, 'century', 'centuries'],
  ['month', 1, 'month', 'months mo mos mth mths'],
  ['week', 1, 'week', 'weeks wk wks w'],
  ['week', 2, 'fortnight', 'fortnights'],
  ['day', 1, 'day', 'days d'],
  ['hour', 1, 'hour', 'hours hr hrs h'],
  ['minute', 1, 'minute', 'minutes min mins'],
  ['second', 1, 'second', 'seconds sec secs s']
] as const) {
  for (const word of singular.split(' ')) UNIT_WORDS.set(word, { unit, factor, plural: false })
  for (const word of plural.split(' ')) UNIT_WORDS.set(word, { unit, factor, plural: true })
}

const BUSINESS_FIRST_WORDS = new Set(['business', 'working', 'work'])
const BUSINESS_WORDS = new Set(['workday', 'workdays', 'weekday', 'weekdays', 'businessday', 'businessdays'])

function readUnit(words: readonly string[], index: number): (UnitWord & { business: boolean; next: number }) | null {
  const word = words[index]
  if (word === undefined) return null
  const second = words[index + 1]
  if (BUSINESS_FIRST_WORDS.has(word) && (second === 'day' || second === 'days')) return { unit: 'day', factor: 1, plural: second === 'days', business: true, next: index + 2 }
  if (BUSINESS_WORDS.has(word)) return { unit: 'day', factor: 1, plural: word.endsWith('s'), business: true, next: index + 1 }
  const unit = UNIT_WORDS.get(word)

  return unit ? { ...unit, business: false, next: index + 1 } : null
}

function andAHalf(words: readonly string[], index: number): boolean {
  return words[index] === 'and' && words[index + 1] === 'a' && words[index + 2] === 'half'
}

/** A duration in words ("3 weeks", "1 year, 2 months", "an hour and a half", "90 min", "10 business days"), or null. */
export function readDuration(text: string, decimal: string): DurationPart[] | null {
  const words = text
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/,(?=\s|$)/g, ' ')
    .split(' ')
    .filter(Boolean)
  const parts: DurationPart[] = []
  let index = 0
  while (index < words.length) {
    if (parts.length > 0 && (words[index] === 'and' || words[index] === '&')) {
      index++
      continue
    }
    const count = readCount(words, index, decimal)
    let value = count?.value ?? 1
    let next = count?.next ?? index
    if (andAHalf(words, next)) {
      value += 0.5
      next += 3
    }
    const unit = readUnit(words, next)
    if (!unit) return null
    if ((!count || count.article) && (unit.plural || parts.length > 0)) return null
    next = unit.next
    if (andAHalf(words, next)) {
      value += 0.5
      next += 3
    }
    parts.push(unit.business ? { amount: value * unit.factor, unit: unit.unit, business: true } : { amount: value * unit.factor, unit: unit.unit })
    index = next
  }

  return parts.length > 0 ? parts : null
}

/** The unit a count is asked in: "days", "weeks", "hrs", "business days", "nights"; null for anything else. */
export function readCountUnit(text: string): CountUnit | null {
  if (text === 'nights' || text === 'night') return 'day'
  const words = text.split(' ')
  const unit = readUnit(words, 0)
  if (!unit || unit.next !== words.length || unit.factor !== 1) return null

  return unit.business ? 'business' : unit.unit
}

const TWELVE_HOUR = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s?([ap])m$/
const TWENTY_FOUR_HOUR = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/
const OCLOCK = /^(\d{1,2})\s?o'?clock(?:\s?([ap])m)?$/

/** Where a time of day may stand in a line; readClock checks each match. */
export const CLOCK_SEARCH = /(?<![\w:.+-])(?:\d{1,2}(?::\d{2}){0,2}\s?[ap]m|\d{1,2}:\d{2}(?::\d{2})?|noon|midday|midnight|\d{1,2}\s?o'?clock(?:\s?[ap]m)?)(?![\w:])/g

function clockOf(hour: number, minute: number, second: number): Clock | null {
  return hour <= 23 && minute <= 59 && second <= 59 ? { hour, minute, second } : null
}

function twelveHour(hour: number, minute: number, second: number, half: string | undefined): Clock | null {
  if (half === undefined) return hour <= 12 ? clockOf(hour, minute, second) : null
  if (hour < 1 || hour > 12) return null

  return clockOf((hour % 12) + (half === 'p' ? 12 : 0), minute, second)
}

/** A time of day written alone ("9am", "9:30 pm", "21:15", "noon", "midnight", "9 o'clock"), or null. */
export function readClock(text: string): Clock | null {
  if (text === 'noon' || text === 'midday') return { hour: 12, minute: 0, second: 0 }
  if (text === 'midnight') return { hour: 0, minute: 0, second: 0 }
  let match = TWELVE_HOUR.exec(text)
  if (match) return twelveHour(Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0), match[4])
  match = OCLOCK.exec(text)
  if (match) return twelveHour(Number(match[1]), 0, 0, match[2])
  match = TWENTY_FOUR_HOUR.exec(text)

  return match ? clockOf(Number(match[1]), Number(match[2]), Number(match[3] ?? 0)) : null
}

/** A line as the readers want it: lower case, single spaces, plain quotes and dashes, no closing question mark. */
export function cleanLine(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/−/g, '-')
    .replace(/([ap])\.\s?m\.?(?![a-z])/g, '$1m')
    .replace(/(\d{1,2})\.(\d{2})\s?([ap]m)(?![a-z])/g, '$1:$2$3')
    .replace(/\b12\s+(noon|midnight)\b/g, '$1')
    .replace(/(\d{4}-\d{1,2}-\d{1,2})t(\d{1,2}:\d{2}(?::\d{2})?)(z|[+-]\d{2}:?\d{2})?(?![\w:])/g, (_, date: string, time: string, zone: string | undefined) => `${date} ${time}${zone === undefined ? '' : zone === 'z' ? ' utc' : ` utc${zone}`}`)
    .replace(/([ap]m|noon|midnight|\d:\d{2})-(?=\d|noon|midnight)/g, '$1 – ')
    .replace(/\s*[–—]\s*/g, ' – ')
    .replace(/[?!.\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}
