import { describe, expect, it } from 'vitest'
import type { CalcHistoryEntry } from '../../../../shared/calc.ts'
import { firstDayOfWeek, parseHistoryQuery, searchHistory, stem } from './search.ts'

/** Local time, so the days hold in any time zone: October 2026 unless `month` says otherwise. */
const on = (day: number, hour = 12, month = 9, year = 2026) => new Date(year, month, day, hour).getTime()

/** Wednesday 14 October 2026, 3 pm. */
const NOW = on(14, 15)

let ids = 0

const entry = (input: string, result: string, more: Partial<CalcHistoryEntry> = {}): CalcHistoryEntry => ({ id: `e${++ids}`, at: on(14, 9), input, result, source: 'notes', ...more })

const MORTGAGE = entry('450,000 at 6% over 30 years', '$2,697.98', { context: 'Mortgage · monthly', at: on(14, 9) })
const COFFEES = entry('3 coffees × 4.50', '$13.50', { context: 'Café', at: on(13, 8), source: 'voice' })
const TIP = entry('20% of 84.50', '16.90', { at: on(13, 10), source: 'keypad' })
const BILLS = entry('rent + bills', '$2,140', { context: 'Budget · October', at: on(12, 9) })
const REFINANCE = entry('mortgages compared: 5.5% vs 6%', '$184.20 a month', { context: 'Refinance', at: on(7, 9) })
const CHRISTMAS = entry('days until Christmas', '72 days', { at: on(1, 9), source: 'command' })
const MILES = entry('12 km in miles', '7.46 mi', { at: on(20, 9, 8), source: 'hermes' })
const YEARLY = entry('1,200 × 12', '14,400', { context: 'Rent · yearly', at: on(10, 9, 0) })
const GST = entry('GST on 1,250', '125', { context: 'Taxes', at: on(5, 9, 11, 2025) })

const HISTORY = [MORTGAGE, COFFEES, TIP, BILLS, REFINANCE, CHRISTMAS, MILES, YEARLY, GST].sort((a, b) => b.at - a.at)

const find = (query: string, entries: readonly CalcHistoryEntry[] = HISTORY, limit?: number) => searchHistory(entries, query, limit, { now: NOW, locale: 'en-GB' })

describe('searching the history', () => {
  it('gives everything, newest first, for an empty query, however the entries came', () => {
    expect(find('')).toEqual(HISTORY)
    expect(find('   ')).toEqual(HISTORY)
    expect(find('', [...HISTORY].reverse())).toEqual(HISTORY)
  })

  it('keeps to the limit', () => {
    expect(find('', HISTORY, 3)).toEqual([MORTGAGE, TIP, COFFEES])
    expect(find('mortgage', HISTORY, 1)).toEqual([MORTGAGE])
    expect(find('', HISTORY, 0)).toEqual([])
  })

  it('drops filler words, so a vague request still finds the thing', () => {
    expect(find('that mortgage thing')).toEqual([MORTGAGE, REFINANCE])
    expect(find('the coffee one')).toEqual([COFFEES])
    expect(find('what was my rent calculation about')).toEqual([YEARLY, BILLS])
  })

  it('reads only filler words as no words at all', () => {
    expect(find('that thing I did')).toEqual(HISTORY)
    expect(find('the calculation')).toEqual(HISTORY)
  })

  it('matches plurals and simple forms of a word alike', () => {
    expect(find('mortgages')).toEqual([MORTGAGE, REFINANCE])
    expect(find('coffees')).toEqual([COFFEES])
    expect(find('coffee')).toEqual([COFFEES])
    expect(find('tax')).toEqual([GST])
    expect(find('bill')).toEqual([BILLS])
  })

  it('matches the start of a word, for a search typed as it goes', () => {
    expect(find('mortg')).toEqual([MORTGAGE, REFINANCE])
    expect(find('chri')).toEqual([CHRISTMAS])
    expect(find('refi')).toEqual([REFINANCE])
  })

  it('forgives a small typo in a long word, not in a short one', () => {
    expect(find('mortage')).toEqual([MORTGAGE, REFINANCE])
    expect(find('morgage')).toEqual([MORTGAGE, REFINANCE])
    expect(find('mortgaeg')).toEqual([MORTGAGE, REFINANCE])
    expect(find('christmsa')).toEqual([CHRISTMAS])
    expect(find('rant')).toEqual([])
  })

  it('matches numbers by their digits, whatever separates them', () => {
    expect(find('450000')).toEqual([MORTGAGE])
    expect(find('450,000')).toEqual([MORTGAGE])
    expect(find('450 000')).toEqual([MORTGAGE])
    expect(find('2697.98')).toEqual([MORTGAGE])
    expect(find('2 697,98')).toEqual([MORTGAGE])
    expect(find('8450')).toEqual([TIP])
    expect(find('84.50')).toEqual([TIP])
  })

  it('matches how a number starts, below a whole number', () => {
    expect(find('16.9')).toEqual([TIP])
    expect(find('14')).toEqual([YEARLY])
    expect(find('12')).toEqual([MILES, YEARLY, GST])
  })

  it('reads thousands and millions said short, in the search and in the history', () => {
    const short = entry('90k deposit at 5%', '4,500')

    expect(find('450k')).toEqual([MORTGAGE])
    expect(find('0.45m')).toEqual([MORTGAGE])
    expect(find('90000', [short, MORTGAGE])).toEqual([short])
  })

  it('finds words the answer shows as symbols or codes', () => {
    expect(find('dollars')).toEqual([MORTGAGE, COFFEES, BILLS, REFINANCE])
    expect(find('percent')).toEqual([MORTGAGE, TIP, REFINANCE])
    expect(find('euros', [entry('100 EUR in USD', '$108.40')])).toHaveLength(1)
  })

  it('finds a calculation by where it came from', () => {
    expect(find('the hermes one')).toEqual([MILES])
    expect(find('voice coffee')).toEqual([COFFEES])
    expect(find('keypad')).toEqual([TIP])
  })

  it('ignores accents and possessives', () => {
    expect(find('cafe')).toEqual([COFFEES])
    expect(find('CAFÉ')).toEqual([COFFEES])
    expect(find("christmas's")).toEqual([CHRISTMAS])
  })

  it('weighs the note’s words and what was asked above the answer', () => {
    expect(find('rent')).toEqual([YEARLY, BILLS])

    const asked = entry('days until Christmas', '72 days', { at: on(2, 9) })
    const answered = entry('Dec 25 - today', '72 days', { at: on(3, 9) })

    expect(find('days', [answered, asked])).toEqual([asked, answered])
  })

  it('puts an entry matching every word above a closer match of fewer words', () => {
    const close = entry('fare home', '$18', { context: 'Airport', at: on(14, 10) })
    const every = entry('airpot parking', '$300', { at: on(2, 10) })

    expect(find('airport 30', [close, every])).toEqual([every, close])
    expect(find('rent yearly')).toEqual([YEARLY, BILLS])
    expect(find('mortgage monthly')).toEqual([MORTGAGE, REFINANCE])
  })

  it('lets recency break a tie', () => {
    const older = entry('2 coffees', '$9', { at: on(2, 9) })
    const newer = entry('2 coffees', '$9.50', { at: on(9, 9) })

    expect(find('coffees', [older, newer])).toEqual([newer, older])
  })

  it('reads time words as the days to search', () => {
    expect(find('today')).toEqual([MORTGAGE])
    expect(find('yesterday')).toEqual([TIP, COFFEES])
    expect(find('stuff from yesterday')).toEqual([TIP, COFFEES])
    expect(find('this week')).toEqual([MORTGAGE, TIP, COFFEES, BILLS])
    expect(find('last week')).toEqual([REFINANCE])
    expect(find('this month')).toEqual([MORTGAGE, TIP, COFFEES, BILLS, REFINANCE, CHRISTMAS])
    expect(find('last month')).toEqual([MILES])
    expect(find('this year')).toEqual(HISTORY.filter(found => found !== GST))
    expect(find('last year')).toEqual([GST])
  })

  it('searches words within those days', () => {
    expect(find('mortgage last week')).toEqual([REFINANCE])
    expect(find('the mortgage thing from today')).toEqual([MORTGAGE])
    expect(find('rent this week')).toEqual([BILLS])
    expect(find("yesterday's coffee")).toEqual([COFFEES])
    expect(find('coffee last month')).toEqual([])
  })

  it('counts days from the now it is given', () => {
    const earlier = { now: on(20, 18, 8), locale: 'en-GB' }

    expect(searchHistory(HISTORY, 'today', 50, earlier)).toEqual([MILES])
    expect(searchHistory(HISTORY, 'this month', 50, earlier)).toEqual([MILES])
    expect(searchHistory(HISTORY, 'last month', 50, earlier)).toEqual([])
  })

  it('finds nothing for words nothing has', () => {
    expect(find('pizza')).toEqual([])
    expect(find('99999')).toEqual([])
  })

  it('takes any word, even one an object has a property for', () => {
    const builder = entry('3 days × 450', '1,350', { context: 'Constructor · toString' })

    expect(find('constructor', [builder, MORTGAGE])).toEqual([builder])
    expect(find('toString valueOf __proto__ hasOwnProperty')).toEqual([])
    expect(find('tostring', [builder])).toEqual([builder])
  })
})

describe('reading a query', () => {
  it('keeps the words worth matching and the days asked about', () => {
    const query = parseHistoryQuery('that 450k mortgage thing from last week', { now: NOW, locale: 'en-GB' })

    expect(query.terms).toEqual([
      { kind: 'number', digits: ['450000'] },
      { kind: 'word', raw: 'mortgage', stem: 'mortgag' }
    ])
    expect(query.spans).toEqual([[on(5, 0), on(12, 0)]])
  })

  it('keeps a repeated word once', () => {
    expect(parseHistoryQuery('rent rent RENT').terms).toHaveLength(1)
  })
})

describe('the light stem', () => {
  it('is the same for a plural and its word', () => {
    for (const [plural, word] of [
      ['mortgages', 'mortgage'],
      ['coffees', 'coffee'],
      ['currencies', 'currency'],
      ['taxes', 'tax'],
      ['classes', 'class'],
      ['days', 'day'],
      ['miles', 'mile'],
      ['fees', 'fee'],
      ['buses', 'bus']
    ]) {
      expect(stem(plural)).toBe(stem(word))
    }
  })

  it('takes off -ing and -ed', () => {
    expect(stem('paying')).toBe('pay')
    expect(stem('planned')).toBe(stem('plan'))
    expect(stem('saved')).toBe(stem('save'))
    expect(stem('billing')).toBe('bill')
  })

  it('leaves short words alone', () => {
    expect(stem('gas')).toBe('gas')
    expect(stem('bus')).toBe('bus')
    expect(stem('is')).toBe('is')
  })
})

describe('the first day of the week', () => {
  it('is Monday where the platform does not say otherwise', () => {
    expect(firstDayOfWeek('en-GB')).toBe(1)
    expect(firstDayOfWeek('not a locale!')).toBe(1)
  })
})
