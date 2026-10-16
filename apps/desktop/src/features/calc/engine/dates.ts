import { dateAnswer, finish, instantAnswer, spanAnswer, weekdayAnswer, type Answer, type SpanUnit } from './dates-answers.ts'
import { dateIn, isoDate } from './dates-calendar.ts'
import { createReader, momentDate, momentEpoch, nowMoment, readMoment, rollClock, todayMoment, type Moment, type Reader } from './dates-moments.ts'
import { WEEKDAY_WORDS, cleanLine, readCountUnit } from './dates-words.ts'
import type { CalcValue } from './types.ts'

/*
 * Dates and durations in a sentence: "days until Dec 25", "3 weeks from today", "Mar 3 to Jun 9
 * in days". Calendar arithmetic in the person's zone through Intl; pure and synchronous.
 */

export interface TimeContext {
  now: number
  zone: string
  locale?: string
  /** Values named on earlier lines ("deadline = Dec 25"). */
  variables?: Record<string, CalcValue>
}

export interface TimeAnswer {
  value: CalcValue
  display: string
  steps: string[]
}

export type TimeOutcome = TimeAnswer | { error: string } | null

const WHAT_DAY = /^(?:what|which) (?:day(?: of(?: the)? week)?|weekday)(?: (?:is|was|will|would|does|did))?(?: it)?(?: (.+?))?(?: (?:be|fall on|fall|land on|land))?$/
const DAY_OF_WEEK = /^(?:day of(?: the)? week|weekday)(?: (?:of|for|on))? (.+)$/
const TODAYS_DATE = /^(?:(?:what(?:'s| is)?|whats) (?:the |today's )?date(?: today| now)?|what date is it(?: today| now)?|(?:today's|todays) date)$/
const WHICH_DATE = /^(?:what|which) date (?:is|was|will be|would be) (.+?)(?: be)?$/
const COUNT_TO = /(?:^| )(until|till|til|'til|before|to|since)(?= )/g
const RANGE = /(?:^| )(to|until|till|through|thru|–)(?= )/g

/** Every way `pattern` (global, keyword in group 1) splits `text`: what is before, the keyword, what is after. */
function* splits(text: string, pattern: RegExp): Generator<[string, string, string]> {
  for (const match of text.matchAll(pattern)) yield [text.slice(0, match.index).trim(), match[1], text.slice(match.index + match[0].length).trim()]
}

function stripQuestion(line: string): string {
  return line
    .replace(/^(?:please )?(?:calculate|compute|work out|tell me|show me|find) /, '')
    .replace(/^(?:what(?:'s| is| was| will be)|whats|when(?:'s| is| was| will be)) /, '')
    .replace(/^how long ago (?:was|is|were) (.+)$/, 'time since $1')
    .replace(/^how many (.+?) ago (?:was|is|were) (.+)$/, '$1 since $2')
    .replace(/^how (?:long|much time)(?: (?:has it been|is it|was it|is there|is left|has passed|is))? (?=(?:until|till|til|since|between|from|before|to) )/, 'time ')
    .replace(/^how many /, '')
    .replace(/^(?:the )?number of /, '')
}

/** A closing "in days", "in weeks", "in hours": the unit the answer is asked in. */
function splitUnit(text: string): { body: string; unit: SpanUnit | null } {
  const match = /^(.+) (?:in|into|as) ([a-z ]+)$/.exec(text)
  const unit = match ? readCountUnit(match[2]) : null

  return match && unit ? { body: match[1], unit } : { body: text, unit: null }
}

/** The unit a phrase before "until", "between" or "from" asks for: null for none, undefined when it is no unit. */
function spanUnitOf(phrase: string): SpanUnit | null | undefined {
  const bare = phrase.replace(/ (?:left|remaining|to go)$/, '')
  if (!bare) return null
  if (bare === 'time' || bare === 'how long' || bare === 'how much time') return 'time'

  return readCountUnit(bare) ?? undefined
}

/** Two ends of a range; when `onward`, a yearly day or bare time at the far end is the next one after the start. */
function readPair(r: Reader, first: string, second: string, onward = true): [Moment, Moment] | null {
  const start = readMoment(r, first)
  if (!start) return null
  r.seek = onward ? { forward: true, from: momentDate(r, start) } : null
  const end = readMoment(r, second)
  r.seek = null
  if (!end) return null

  return [start, onward ? rollClock(r, end, true, momentEpoch(r, start)) : end]
}

/** "Between" reads both ways round: the pairing with the shorter gap ("Dec 20 and Jan 5" across New Year, "Jun 9 and Mar 3" within the year). */
function readBetween(r: Reader, first: string, second: string): [Moment, Moment] | null {
  const onward = readPair(r, first, second)
  const within = onward ? readPair(r, first, second, false) : null
  if (!onward || !within) return onward
  const gap = ([start, end]: [Moment, Moment]) => Math.abs(momentEpoch(r, end) - momentEpoch(r, start))

  return gap(within) < gap(onward) ? within : onward
}

function whatDay(r: Reader, line: string): Answer | null {
  const match = WHAT_DAY.exec(line) ?? DAY_OF_WEEK.exec(line)
  if (!match) return null
  const moment = match[1] ? readMoment(r, match[1]) : todayMoment(r)

  return moment ? weekdayAnswer(r, moment) : null
}

function whatDate(r: Reader, line: string): Answer | null {
  if (TODAYS_DATE.test(line)) return dateAnswer(r, todayMoment(r))
  const match = WHICH_DATE.exec(line)
  const moment = match ? readMoment(r, match[1]) : null

  return moment ? dateAnswer(r, { type: 'date', date: momentDate(r, moment), steps: moment.steps }) : null
}

/** "days until Dec 25", "weeks till Christmas", "time until 5pm", "days since Jan 1". */
function countTo(r: Reader, text: string, asked: SpanUnit | null): Answer | null {
  for (const [phrase, keyword, rest] of splits(text, COUNT_TO)) {
    const unit = spanUnitOf(phrase)
    if (unit === undefined || (unit === null && (keyword === 'before' || keyword === 'to'))) continue
    const forward = keyword !== 'since'
    r.seek = { forward, from: r.today }
    const target = readMoment(r, rest)
    r.seek = null
    if (!target) continue
    const wanted = asked ?? unit
    const fromNow = wanted === 'time' || wanted === 'hour' || wanted === 'minute' || wanted === 'second' || (wanted === null && target.type === 'instant')
    const base = fromNow ? nowMoment(r) : todayMoment(r)
    const far = rollClock(r, target, forward, r.now)

    return forward ? spanAnswer(r, base, far, wanted) : spanAnswer(r, far, base, wanted)
  }

  return null
}

/** "Mar 3 to Jun 9", "from today to Christmas", "weeks between Mar 3 and Jun 9", "9am to 5:30pm". */
function range(r: Reader, text: string, asked: SpanUnit | null): Answer | null {
  const between = /^(?:(.+?) )?between (.+)$/.exec(text)
  const betweenUnit = between ? spanUnitOf(between[1] ?? '') : undefined
  if (between && betweenUnit !== undefined) {
    for (const [first, , second] of splits(between[2], / (and)(?= )/g)) {
      const pair = readBetween(r, first, second)
      if (pair) return spanAnswer(r, pair[0], pair[1], asked ?? betweenUnit, true)
    }
  }
  const prefixed = /^(.+?) from (.+)$/.exec(text)
  const prefixUnit = prefixed ? spanUnitOf(prefixed[1]) : undefined
  const [unit, rest] = prefixed && prefixUnit !== undefined ? [prefixUnit, prefixed[2]] : [null, text.replace(/^from /, '')]
  for (const [first, , second] of splits(rest, RANGE)) {
    const pair = readPair(r, first, second)
    if (pair) return spanAnswer(r, pair[0], pair[1], asked ?? unit)
  }

  return null
}

/** "deadline - today", "Jun 9 - Mar 3"; two bare times of day ("5pm - 9am", "9am - 5pm") give the time between them. */
function difference(r: Reader, text: string, asked: SpanUnit | null): Answer | null {
  for (const [first, , second] of splits(text, / (-|minus) /g)) {
    const end = readMoment(r, first)
    const start = end ? readMoment(r, second) : null
    if (end && start) return spanAnswer(r, start, end, asked, isBareClock(start) && isBareClock(end))
  }

  return null
}

function isBareClock(moment: Moment): boolean {
  return moment.type === 'instant' && moment.clock !== undefined
}

function bare(r: Reader, text: string): Answer | null {
  if (WEEKDAY_WORDS.has(text) && !text.endsWith('day')) return null
  const moment = readMoment(r, text)
  if (!moment) return null

  return moment.type === 'date' ? dateAnswer(r, moment) : instantAnswer(r, moment)
}

/** The answer a cleaned line's date and time words give, or null; a line that is clearly a date but cannot be read leaves `r.issue`. */
export function readSentence(r: Reader, line: string): Answer | null {
  const answer = whatDay(r, line) ?? whatDate(r, line)
  if (answer) return answer
  const { body, unit } = splitUnit(stripQuestion(line))

  return countTo(r, body, unit) ?? range(r, body, unit) ?? difference(r, body, unit) ?? (unit ? null : bare(r, body))
}

/** A line about dates: the answer, a gentle error, or null when the line names no date at all. */
export function evaluateDateLine(text: string, context: TimeContext): TimeOutcome {
  try {
    const r = createReader(context)
    const line = cleanLine(text)
    if (r.variables.has(line)) return null
    const answer = readSentence(r, line)
    if (answer) return answer.clocked ? null : finish(answer)

    return r.issue ? { error: r.issue } : null
  } catch {
    return null
  }
}

/** A date the words name ("Dec 25", "25/12/2026", "2026-12-25", "today", "next Friday"): YYYY-MM-DD in the zone, or null. */
export function parseDate(text: string, context: TimeContext): string | null {
  try {
    const r = createReader(context)
    const moment = readMoment(r, cleanLine(text))
    if (!moment) return null

    return isoDate(moment.type === 'date' ? moment.date : dateIn(moment.epoch, r.zone))
  } catch {
    return null
  }
}
