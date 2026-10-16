import { describe, expect, it, vi } from 'vitest'
import { normaliseUtterance } from './intents.ts'
import { spokenMath } from './math.ts'

// A slice of the engine's vocabulary and places, so the grammar is tested apart from the engine.
vi.mock('../../features/calc/engine/vocabulary.ts', () => ({
  UNIT_WORDS: new Set(['km', 'kilometres', 'kilometers', 'mile', 'miles', 'mi', 'm', 'metres', 'cm', 'centimetres', 'inch', 'inches', 'in', 'foot', 'feet', 'ft', 'litre', 'litres', 'liter', 'l', 'cup', 'cups', 'ml', 'kg', 'kilos', 'pound', 'pounds', 'lb', 'ounces', 'oz', 'degrees', 'fahrenheit', 'celsius', '°f', '°c', 'hour', 'hours', 'minute', 'minutes', 'second', 'seconds', 'day', 'days', 'week', 'weeks', 'year', 'years', 'gb', 'mb', 'gigabyte', 'megabytes', 'square feet', 'mph', 'km/h', 'a', 'am']),
  LENGTH_WORDS: new Set(['km', 'kilometres', 'kilometers', 'mile', 'miles', 'mi', 'm', 'metres', 'cm', 'centimetres', 'inch', 'inches', 'in', 'foot', 'feet', 'ft']),
  CURRENCY_WORDS: new Set(['usd', 'eur', 'brl', 'gbp', 'jpy', 'dollar', 'dollars', 'euro', 'euros', 'pound', 'pounds', 'yen', 'reais', 'us dollars', 'us']),
  MATH_WORDS: new Set(['sqrt', 'square root', 'sin', 'log', 'pi', 'plus', 'minus', 'times', 'divided by', 'percent', 'of', 'total'])
}))
vi.mock('../../features/calc/engine/zones.ts', () => ({
  zoneNames: () => ['tokyo', 'sydney', 'new york', 'london', 'los angeles', 'paris', 'utc', 'est', 'pst', 'sao paulo', 'in'],
  findZone: () => null,
  evaluateZoneLine: () => null
}))

/** As the voice fast path hands it over. */
const math = (said: string) => spokenMath(normaliseUtterance(said))

describe('spoken math', () => {
  it.each([
    ['whats 15% of 340', '15% of 340'],
    ["What's 15% of 340?", '15% of 340'],
    ['what is 15 percent of 340', '15% of 340'],
    ['what is fifteen per cent of three hundred and forty', '15% of 340'],
    ['what is 2 plus 2', '2 + 2'],
    ['two plus two', '2 + 2'],
    ['what is 2 + 2', '2 + 2'],
    ['whats 2+2', '2 + 2'],
    ['calculate 12 times 7', '12 * 7'],
    ['work out 144 divided by 12', '144 / 12'],
    ['compute 10 over 4', '10 / 4'],
    ['whats 7 x 6', '7 * 6'],
    ['what is 100 take away 37', '100 - 37'],
    ['what is 10 minus 20', '10 - 20'],
    ['what is minus 5 plus 3', '-5 + 3'],
    ['what is 2 to the power of 10', '2^10'],
    ['what is nine squared plus three cubed', '9^2 + 3^3'],
    ['what is the square root of 144', 'sqrt(144)'],
    ['whats pi times 2', 'pi * 2'],
    ['whats one point five times four', '1.5 * 4'],
    ['what is three point one four times two', '3.14 * 2'],
    ['what is a hundred divided by 8', '100 / 8'],
    ['what is a million divided by twelve', '1000000 / 12'],
    ['what is two thousand four hundred plus 180 split three ways', '2400 + 180 split 3 ways'],
    ['whats 2,400 + 180 split 3 ways', '2,400 + 180 split 3 ways'],
    ['what is 1200 split between 4 people', '1200 split 4 ways'],
    ['what is twelve hundred times 12', '1200 * 12'],
    ['what is two and a half times 4', '2.5 * 4'],
    ['what is 2.5 million times 3', '2500000 * 3'],
    ['whats half of 340', '50% of 340'],
    ['what is a third of 90', '90 / 3'],
    ['whats three quarters of 200', '75% of 200'],
    ['whats 84.50 plus 15%', '84.50 + 15%'],
    ['what is 20% off 80', '20% off 80'],
    ['what is 80 minus 15 percent', '80 - 15%'],
    ['what does 2 plus 2 equal', '2 + 2'],
    ['tell me what 15% of 340 is', '15% of 340'],
    ['add 15% to 80', '80 + 15%'],
    ['add 5 and 3', '5 + 3'],
    ['subtract 15 from 100', '100 - 15'],
    ['take 5 away from 12', '12 - 5'],
    ['multiply 6 by 7', '6 * 7'],
    ['divide 100 by 3', '100 / 3'],
    ['(3 + 4) * 2', '(3 + 4) * 2'],
    ['sqrt(16) + 1', 'sqrt(16) + 1'],
    ['what is the log of 100', 'log(100)']
  ])('reads %j as %j', (said, sentence) => {
    expect(math(said)).toBe(sentence)
  })

  it.each([
    ['how many miles is 10 km', '10 km in miles'],
    ['how many miles are in 10 kilometres', '10 kilometres in miles'],
    ['how many cups in a litre', '1 litre in cups'],
    ['how many cups are there in a litre', '1 litre in cups'],
    ['how many seconds in an hour', '1 hour in seconds'],
    ['how many inches in a foot', '1 foot in inches'],
    ['convert 100 dollars to euros', '100 dollars in euros'],
    ['how much is 100 dollars in euros', '100 dollars in euros'],
    ['how much is a dollar in yen', '1 dollar in yen'],
    ['how many euros is 100 dollars', '100 dollars in euros'],
    ['whats $100 in euros', '$100 in euros'],
    ['what is 100 usd in brl', '100 usd in brl'],
    ['convert 100 us dollars to euros', '100 us dollars in euros'],
    ['what is 5 feet 3 inches in cm', '5 feet 3 inches in cm'],
    ['whats 350 degrees fahrenheit in celsius', '350 degrees fahrenheit in celsius'],
    ['what is 10km in miles', '10 km in miles'],
    ['whats half a litre in cups', '0.5 litre in cups'],
    ['whats 15% of 100 dollars in euros', '15% of 100 dollars in euros'],
    ['what is 60 mph in km/h', '60 mph in km/h'],
    ['what is 3 weeks in days', '3 weeks in days'],
    ['whats 12 in cm', '12 inches in cm'],
    ['what is twelve in centimetres', '12 inches in centimetres'],
    ['what is minus 3 in cm', '-3 inches in cm'],
    ['whats 5 feet 10 in cm', '5 feet 10 inches in cm'],
    ['what is 6 ft 2 in metres', '6 ft 2 inches in metres']
  ])('converts %j as %j', (said, sentence) => {
    expect(math(said)).toBe(sentence)
  })

  it.each([
    ['what time is it in tokyo', 'time in tokyo'],
    ['Hey Hermes, what time is it in Tokyo right now?', 'time in tokyo'],
    ['whats the time in new york', 'time in new york'],
    ['whats the current time in sao paulo', 'time in sao paulo'],
    ['whats 9am sydney in new york', '9am sydney in new york'],
    ['what is 9 a.m. Sydney time in New York', '9am sydney in new york'],
    ['what time is 3pm london in tokyo', '3pm london in tokyo'],
    ['convert 3:30 pm london to tokyo', '3:30pm london in tokyo'],
    ['what is nine thirty am in sydney in los angeles', '9:30am sydney in los angeles'],
    ['whats noon est in london', '12pm est in london'],
    ['whats 3pm in tokyo', '3pm in tokyo'],
    ['what is 14:30 utc in sydney', '14:30 utc in sydney']
  ])('reads the time %j as %j', (said, sentence) => {
    expect(math(said)).toBe(sentence)
  })

  it.each([
    ['how many days until december 25th', 'days until december 25'],
    ['how many days until the 25th of december', 'days until december 25'],
    ['how many days are left until december 31', 'days until december 31'],
    ['how many days until dec twenty fifth', 'days until dec 25'],
    ['how many weeks until next friday', 'weeks until next friday'],
    ['how many days since january 1st 2026', 'days since january 1 2026'],
    ['how many days between march 3 and june 9', 'march 3 to june 9 in days'],
    ['days until dec 25', 'days until dec 25'],
    ['what date is 90 days from today', '90 days from today'],
    ['whats three weeks from tomorrow', '3 weeks from tomorrow'],
    ['what was the date 100 days ago', '100 days ago'],
    ['whats the date in 3 weeks', '3 weeks from today'],
    ['what day is a week before december 25', '1 week before december 25']
  ])('reads the date %j as %j', (said, sentence) => {
    expect(math(said)).toBe(sentence)
  })

  it.each([
    // Personal or about something only Hermes can see.
    'whats 15% of my rent',
    'how much should i tip',
    'how much should i tip on my dinner',
    'whats the total of my invoices',
    'whats a third of my salary',
    'what is 15% of us',
    'how many days until my birthday',
    'how many days are left until christmas eve',
    'how many miles is it to london',
    // Reasoning.
    'why is 0.1 plus 0.2 not 0.3 in javascript',
    'explain compound interest',
    'what is the time difference between sydney and london',
    'whats 2 plus 2 and why',
    'is 15% of 340 better than 50',
    // Not a sum, or not a whole one.
    'what is 15',
    'fifteen',
    'what is 10 km',
    'whats 100 in euros',
    'whats 12 in kg',
    'what is 2 times 6 in cm',
    'what is 5 plus',
    'what is plus 5',
    'twelve fifty',
    'nineteen eighty four',
    'what is 20% of 80 and 30% of 90',
    'what time is it',
    'what time is it in my hotel',
    'how many smoots in a mile',
    'whats 9.30 sydney in tokyo',
    // Other requests that hold numbers or math-like words.
    'open missions',
    'set the volume to 50',
    'go to slide 3',
    'how much battery is left',
    'how many tokens have i used',
    'sum the march sales',
    'calculate the total',
    'add a column for tax',
    'add milk to the list',
    'add the meeting notes to my memory',
    'whats the weather in london',
    'remind me in 20 minutes',
    // Too long to be a quick sum.
    'what is one plus two plus three plus four plus five plus six plus seven plus eight'
  ])('leaves %j to Hermes', said => {
    expect(math(said)).toBeNull()
  })
})
