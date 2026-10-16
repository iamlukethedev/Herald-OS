import { finish, instantAnswer } from './dates-answers.ts'
import { HOUR_MS, offsetAt } from './dates-calendar.ts'
import { formatAmount, formatOffset } from './dates-format.ts'
import { createReader, nowMoment, readMoment, zoneOf, type Reader } from './dates-moments.ts'
import { CLOCK_SEARCH, cleanLine, readClock, readCountUnit, readDuration } from './dates-words.ts'
import { readSentence, type TimeAnswer, type TimeContext, type TimeOutcome } from './dates.ts'
import { CURRENCY_WORDS, UNIT_WORDS } from './vocabulary.ts'
import { knownZoneNames, lookupZone } from './zones-names.ts'

/*
 * Times of day across time zones: "9am Sydney in New York", "now in Tokyo". The platform's Intl
 * zone data only; nothing is fetched.
 */

const NOW = "(?:what time is it|what's the time|whats the time|what is the time|the time|time|now|right now|current time|the current time|current local time)(?: now)?"
const NOW_HERE = new RegExp(`^(?:${NOW}|local time|my time)$`)
const NOW_THERE = new RegExp(`^${NOW} (?:in|at) (.+)$`)
const ZONE_NOW = /^(?:the )?(.+?) (?:time|now|time now)$/
const DIFFERENCE = /^(?:what(?:'s| is) )?(?:the )?time difference (?:between (.+) and (.+)|(?:from )?(.+) (?:to|and) (.+))$/
const CONVERSION = / (in|to|into|as) /g

function title(text: string): string {
  return text.replace(/(^|\s)(\S)/g, (_, space: string, letter: string) => space + letter.toUpperCase())
}

/** "time difference between Sydney and London": today's offsets apart, and which is ahead. */
function timeDifference(r: Reader, line: string): TimeAnswer | null {
  const match = DIFFERENCE.exec(line)
  const first = match ? zoneOf(r, match[1] ?? match[3]) : null
  const second = match ? zoneOf(r, match[2] ?? match[4]) : null
  if (!first || !second) return null
  const firstOffset = offsetAt(r.now, first.zone)
  const secondOffset = offsetAt(r.now, second.zone)
  const hours = Math.abs(secondOffset - firstOffset) / HOUR_MS
  const display = formatAmount(hours, 'hour', r.locale)
  const ahead = secondOffset > firstOffset ? `${second.label} ahead` : secondOffset < firstOffset ? `${first.label} ahead` : 'the same time'

  return {
    value: { kind: 'duration', exact: String(hours), number: hours, unit: 'hour' },
    display,
    steps: [`${first.label} is ${formatOffset(firstOffset)} and ${second.label} is ${formatOffset(secondOffset)} now`, `= ${display}, ${ahead}`]
  }
}

function conversionText(line: string): string {
  return line.replace(/^(?:what(?:'s| is)|whats|what time is|when is|convert) /, '')
}

/** "9am Sydney in New York", "3pm London to Tokyo", "in 2 hours in Tokyo". */
function convert(r: Reader, line: string): TimeAnswer | null {
  const text = conversionText(line)
  for (const match of [...text.matchAll(CONVERSION)].reverse()) {
    const target = zoneOf(r, text.slice(match.index + match[0].length))
    const moment = target ? readMoment(r, text.slice(0, match.index)) : null
    if (target && moment?.type === 'instant') return finish(instantAnswer(r, moment, target))
  }

  return null
}

/** The message for words in a place's spot that name no zone, unit, currency, date or duration ("Gotham"); else null. */
function unknownPlace(r: Reader, text: string): string | null {
  if (!/^[a-z][a-z ]{2,}$/.test(text) || text.split(' ').length > 4 || readCountUnit(text) || UNIT_WORDS.has(text) || CURRENCY_WORDS.has(text) || readMoment(r, text) || readDuration(text, r.decimal)) return null

  return `I don't know the time zone of “${title(text)}”.`
}

/**
 * A conversion that reads but for one place: "9am in Gotham", "9am Gotham in London". A known
 * place followed by more words ("in New York meeting") is no error: the engine reads those words
 * as a label.
 */
function unknownZone(r: Reader, line: string): string | null {
  const text = conversionText(line)
  for (const match of [...text.matchAll(CONVERSION)].reverse()) {
    const source = text.slice(0, match.index)
    const place = text.slice(match.index + match[0].length)
    if (zoneOf(r, place)) {
      const clock = [...source.matchAll(CLOCK_SEARCH)].find((found) => found.index === 0 && readClock(found[0]))
      const rest = clock ? source.slice(clock[0].length).trim().replace(/ time$/, '') : ''
      const unknown = rest && !rest.includes(' ') ? unknownPlace(r, rest) : null
      if (unknown) return unknown
    } else {
      const words = place.split(' ')
      const knownStart = words.some((_, count) => count > 0 && zoneOf(r, words.slice(0, count).join(' ')))
      const moment = knownStart ? null : readMoment(r, source)
      const unknown = moment?.type === 'instant' && moment.clocked ? unknownPlace(r, place) : null
      if (unknown) return unknown
    }
  }

  return null
}

/** A line about times of day or zones: the answer, a gentle error, or null when it names no time. */
export function evaluateZoneLine(text: string, context: TimeContext): TimeOutcome {
  try {
    const r = createReader(context)
    const line = cleanLine(text)
    if (r.variables.has(line)) return null
    if (NOW_HERE.test(line)) return finish(instantAnswer(r, nowMoment(r)))
    const there = NOW_THERE.exec(line) ?? ZONE_NOW.exec(line)
    const zone = there ? zoneOf(r, there[1]) : null
    if (zone) return finish(instantAnswer(r, nowMoment(r), zone))
    const converted = timeDifference(r, line) ?? convert(r, line)
    if (converted) return converted
    const answer = readSentence(r, line)
    if (answer) return answer.clocked ? finish(answer) : null
    const unknown = unknownZone(r, line) ?? (r.issue && [...line.matchAll(CLOCK_SEARCH)].some((match) => readClock(match[0])) ? r.issue : null)

    return unknown ? { error: unknown } : null
  } catch {
    return null
  }
}

/** The IANA zone a place or abbreviation names ("Sydney", "new york", "PST", "UTC+3", "Europe/Paris"), or null. */
export function findZone(name: string): string | null {
  try {
    return lookupZone(name)?.zone ?? null
  } catch {
    return null
  }
}

/** Every place and abbreviation findZone knows, lower-case, for the voice grammar. */
export function zoneNames(): readonly string[] {
  try {
    return knownZoneNames()
  } catch {
    return []
  }
}
