import { describe, expect, it, vi } from 'vitest'
import type { CalcRates } from '../../../../shared/calc.ts'
import { evaluate, evaluateDocument } from './index.ts'
import type { CalcContext, DocumentResult, LineResult } from './types.ts'

// The dates and zones readers belong to another part; here they only know one phrase, a duration.
vi.mock('./dates.ts', () => ({
  evaluateDateLine: (text: string) =>
    text === 'trip length' ? { value: { kind: 'duration', exact: '98', number: 98, unit: 'day' }, display: '98 days', steps: ['Oct 16 → Jan 22', '= 98 days'] } : null,
  parseDate: () => null
}))

vi.mock('./zones.ts', () => ({ evaluateZoneLine: () => null, findZone: () => null, zoneNames: () => [] }))

const RATES: CalcRates = { base: 'EUR', date: '2026-10-15', fetchedAt: 0, rates: { EUR: 1, USD: 1.25, GBP: 0.8 } }

function context(rates: CalcRates | null = null, locale = 'en-US'): CalcContext {
  return { locale, now: Date.UTC(2026, 9, 16, 2), zone: 'Australia/Sydney', rates }
}

async function note(text: string, rates: CalcRates | null = null): Promise<DocumentResult> {
  return evaluateDocument(text, context(rates))
}

function spans(line: LineResult): string[] {
  return (line.tokens ?? []).map(token => `${line.source.slice(token.from, token.to)}:${token.type}`)
}

describe('lines of a note', () => {
  it('tells blank lines, headings and comments apart', async () => {
    const { lines } = await note('# Budget\n\n// rough numbers\n1 + 1')

    expect(lines.map(line => line.kind)).toEqual(['heading', 'blank', 'comment', 'value'])
    expect(lines[0].label).toBe('Budget')
    expect(lines[2].label).toBe('rough numbers')
    expect(lines[3].display).toBe('2')
  })

  it('reads plain words as a comment, not an error', async () => {
    const { lines } = await note('Buy milk\nCall mum at the office\nNotes for the trip')

    expect(lines.every(line => line.kind === 'comment')).toBe(true)
    expect(lines[0].label).toBe('Buy milk')
    expect(lines[0].error).toBeUndefined()
  })

  it('gives a line that tries to be math a gentle error', async () => {
    const { lines } = await note('5 km + 3 kg\ntax * 100\n2 +')

    expect(lines.map(line => line.kind)).toEqual(['error', 'error', 'error'])
    expect(lines[0].error).toBe("A length and a mass don't add up")
    expect(lines[1].error).toMatch(/“tax” has no value yet/)
  })

  it('reads a word after a number that names nothing as what it counts', async () => {
    const { lines } = await note('4 nights * $189\n3 coffees + 2 coffees\ntax * 100', RATES)

    expect(lines[0]).toMatchObject({ kind: 'value', display: '$756.00' })
    expect(spans(lines[0])).toContain('nights:label')
    expect(lines[1]).toMatchObject({ kind: 'value', display: '5' })
    expect(lines[2].error).toMatch(/“tax” has no value yet/)
  })

  it('lets a label name its value for the lines after it', async () => {
    const { lines } = await note('Hotel: 4 nights * 189\nFood: 35 * 6\nhotel + food\nkm: 5\nkm + 1')

    expect(lines[2]).toMatchObject({ kind: 'value', display: '966' })
    expect(lines[4].kind).not.toBe('value')
  })

  it('drops a trailing comment', async () => {
    const [line] = (await note('84.50 + 15% // with the tip')).lines

    expect(line).toMatchObject({ kind: 'value', display: '97.175' })
    expect(spans(line)).toContain('// with the tip:comment')
  })
})

describe('labels', () => {
  it('reads the words before a colon', async () => {
    const [line] = (await note('Rent: 1,200')).lines

    expect(line).toMatchObject({ kind: 'value', label: 'Rent', display: '1,200' })
  })

  it('reads plain words before a number and after a value', async () => {
    const { lines } = await note('Groceries 84.50\n$24 lunch with Sam\n3 apples\nCoffee with Sam $4.50')

    expect(lines.map(line => [line.label, line.display])).toEqual([
      ['Groceries', '84.5'],
      ['lunch with Sam', '$24.00'],
      ['apples', '3'],
      ['Coffee with Sam', '$4.50']
    ])
    expect(spans(lines[1])).toEqual(['$:currency', '24:number', 'lunch with Sam:label'])
  })

  it('treats a lone label as a comment, unless it says total', async () => {
    const { lines } = await note('Rent:\n5\nTotal:')

    expect(lines[0]).toMatchObject({ kind: 'comment', label: 'Rent' })
    expect(lines[2]).toMatchObject({ kind: 'value', label: 'Total', display: '5' })
  })
})

describe('names', () => {
  it('assigns names that later lines use, whatever their case', async () => {
    const { lines } = await note('budget = 1,200\nBudget * 12\nbudget')

    expect(lines[0]).toMatchObject({ kind: 'value', name: 'budget', label: 'budget', display: '1,200' })
    expect(lines[1].display).toBe('14,400')
    expect(lines[2].display).toBe('1,200')
  })

  it('reads names of several words', async () => {
    const { lines } = await note('monthly rent = 1,200\nmonthly rent * 12\nMonthly Rent / 4')

    expect(lines[0].name).toBe('monthly rent')
    expect(lines[1].display).toBe('14,400')
    expect(lines[2].display).toBe('300')
    expect(spans(lines[1])[0]).toBe('monthly rent:variable')
  })

  it('uses a new value from where it is assigned again', async () => {
    const { lines } = await note('rate = 2\nrate * 10\nrate = 3\nrate * 10')

    expect(lines[1].display).toBe('20')
    expect(lines[3].display).toBe('30')
  })

  it('reads prev and ans as the answer above', async () => {
    const { lines } = await note('10 * 12\nprev / 4\n\nans + 1')

    expect(lines[1].display).toBe('30')
    expect(lines[3].display).toBe('31')
  })

  it('says there is no answer above for a first prev', async () => {
    expect((await note('prev * 2')).lines[0].error).toMatch(/no answer above/)
  })

  it('refuses to rename what is built in', async () => {
    expect((await note('pi = 3')).lines[0]).toMatchObject({ kind: 'error', error: "“pi” is built in, so it can't be a name" })
  })

  it('asks for a value after the =', async () => {
    expect((await note('budget =')).lines[0].error).toBe('Give “budget” a value after the =')
  })

  it('keeps names of money and units', async () => {
    const { lines } = await note('fare = $3.50\nfare * 10\nrun = 5 km\nrun in mi')

    expect(lines[1].display).toBe('$35.00')
    expect(lines[3].display).toBe('3.1069 mi')
  })

  it('converts a name as it is, where a plain number before "in" would be inches', async () => {
    const { lines } = await note('x = 12\nx in cm\n12 in cm\nwidth = 5 ft\nwidth in cm\nhotel = $30\nhotel in EUR', RATES)

    expect(lines.map(line => line.display)).toEqual(['12', '12 cm', '30.48 cm', '5 ft', '152.4 cm', '$30.00', '€24.00'])
  })
})

describe('durations from the dates reader', () => {
  it('work in the arithmetic of later lines', async () => {
    const { lines } = await note('trip = trip length\ntrip in weeks\ntrip * 2\nprev / 7\ntrip + 2 days')

    expect(lines[0]).toMatchObject({ kind: 'value', display: '98 days', steps: ['Oct 16 → Jan 22', '= 98 days'] })
    expect(lines[0].value).toMatchObject({ kind: 'duration', unit: 'day' })
    expect(lines[1].value).toMatchObject({ kind: 'duration', exact: '14', unit: 'week' })
    expect(lines[1].display).toBe('14 weeks')
    expect(lines[2].display).toBe('196 days')
    expect(lines[3].display).toBe('28 days')
    expect(lines[4].display).toBe('100 days')
    expect(spans(lines[0]).slice(-1)[0]).toMatch(/:date$/)
  })
})

describe('totals', () => {
  it('adds up the lines above to the last blank line or heading', async () => {
    const { lines } = await note('# Trip\nFlights: 1,200\nHotel: 800\nsum\n\nTaxi 40\nFood 60\ntotal')

    expect(lines[3]).toMatchObject({ kind: 'value', label: 'Total', display: '2,000' })
    expect(lines[3].steps).toEqual(['1,200 + 800 = 2,000'])
    expect(lines[7].display).toBe('100')
  })

  it('averages them', async () => {
    const { lines } = await note('2\n4\n9\naverage\navg\nmean')

    expect(lines[3]).toMatchObject({ label: 'Average', display: '5' })
    expect(lines[3].steps).toEqual(['2 + 4 + 9 = 15', '15 ÷ 3 = 5'])
    expect(lines[4].display).toBe('5')
  })

  it('does not count a total in the next one', async () => {
    const { lines } = await note('1\n2\nsum\n3\nsum')

    expect(lines[2].display).toBe('3')
    expect(lines[4].display).toBe('6')
  })

  it('adds money in the first currency', async () => {
    const { lines } = await note('$10\n€8\nsum', RATES)

    expect(lines[2].display).toBe('$20.00')
    expect(lines[2].usesRates).toBe(true)
  })

  it('keeps a running total of every value line', async () => {
    const document = await note('Rent: 1,200\nFood: 400\nsum\n\n84.50')

    expect(document.total).toMatchObject({ kind: 'number', exact: '1684.5' })
    expect(document.totalDisplay).toBe('1,684.5')
  })

  it('has no running total when kinds do not add', async () => {
    expect((await note('5 km\n3 kg')).total).toBeNull()
    expect((await note('5\n10%')).total).toBeNull()
    expect((await note('$5\n€5')).total).toBeNull()
    expect((await note('Buy milk')).total).toBeNull()
  })

  it('converts money to the first currency for the running total', async () => {
    const document = await note('$10\n€8', RATES)

    expect(document.totalDisplay).toBe('$20.00')
    expect(document.usesRates).toBe(true)
  })

  it('adds units in the first unit', async () => {
    expect((await note('5 km\n300 m')).totalDisplay).toBe('5.3 km')
  })
})

describe('graphs', () => {
  it('reads y = and f(x) = with x on the right as functions to draw', async () => {
    const document = await note('y = sin(x) * x\nf(x) = x^2 - 2\ng(t) = t^2')

    expect(document.lines[0]).toMatchObject({ kind: 'function', plot: { name: 'y', expression: 'sin(x) * x', variable: 'x', index: 0 } })
    expect(document.lines[1]).toMatchObject({ kind: 'function', plot: { name: 'f', expression: 'x^2 - 2', variable: 'x', index: 1 } })
    expect(document.lines[2].plot).toMatchObject({ name: 'g', expression: 't^2', variable: 't' })
    expect(document.functions.map(plot => plot.index)).toEqual([0, 1, 2])
  })

  it('reads y = 5, or x with a value, as an assignment', async () => {
    const { lines } = await note('y = 5\nx = 3\nz = x^2')

    expect(lines[0]).toMatchObject({ kind: 'value', name: 'y', display: '5' })
    expect(lines[2]).toMatchObject({ kind: 'value', display: '9' })
  })

  it('reads plot, graph and draw', async () => {
    const { lines } = await note('plot sin(x)\ngraph x^2\ndraw y = 2x + 1')

    expect(lines[0]).toMatchObject({ kind: 'plot', plot: { name: '', expression: 'sin(x)', variable: 'x' } })
    expect(lines[1].plot?.expression).toBe('x^2')
    expect(lines[2].plot).toMatchObject({ name: 'y', expression: '2 * x + 1' })
  })

  it('keeps what is not a function of x as something to draw from', async () => {
    const [line] = (await note('plot column B of Budget.xlsx')).lines

    expect(line).toMatchObject({ kind: 'plot', plotSource: 'column B of Budget.xlsx' })
    expect(line.plot).toBeUndefined()
  })

  it('draws with numbers named above', async () => {
    const document = await note('a = 2\nrate = 50%\ny = a x^2 + rate')

    expect(document.functions[0].expression).toBe('2 * x^2 + 0.5')
  })

  it('writes logs, degrees and roots for the drawing engine', async () => {
    const document = await note('y = ln(x) + log(x)\ny = sin(x°)\ny = √x + x²')

    expect(document.functions.map(plot => plot.expression)).toEqual(['ln(x) + log10(x)', 'sin(x * pi / 180)', 'sqrt(x) + x^2'])
  })

  it('says why a function cannot be drawn', async () => {
    const { lines } = await note('y = x + 5 km\ny = x + k')

    expect(lines[0]).toMatchObject({ kind: 'error', error: 'Graphs draw plain numbers, without units' })
    expect(lines[1].error).toMatch(/“k” has no value to draw with/)
  })
})

describe('tokens', () => {
  it('marks numbers, units, keywords, functions, operators and names', async () => {
    const { lines } = await note('5 km in mi\nsqrt(16) + 2 * budget\n20% of 84.50\n$5 + 3 USD\n2 x 3')

    expect(spans(lines[0])).toEqual(['5:number', 'km:unit', 'in:keyword', 'mi:unit'])
    expect(spans(lines[1])).toEqual(['sqrt:function', '16:number', '+:operator', '2:number', '*:operator', 'budget:variable'])
    expect(spans(lines[2])).toEqual(['20:number', '%:operator', 'of:operator', '84.50:number'])
    expect(spans(lines[3])).toEqual(['$:currency', '5:number', '+:operator', '3:number', 'USD:currency'])
    expect(spans(lines[4])).toEqual(['2:number', 'x:operator', '3:number'])
  })

  it('marks "in" as a unit only where it is read as inches', async () => {
    const { lines } = await note('12 in cm\n100 in EUR\n$30 in EUR\n12 in in cm\n2 * 6 in cm\n5 ft 10 in cm\n12 in\n5 in hex', RATES)

    expect(spans(lines[0])).toEqual(['12:number', 'in:unit', 'cm:unit'])
    expect(spans(lines[1])).toEqual(['100:number', 'in:keyword', 'EUR:currency'])
    expect(spans(lines[2])).toEqual(['$:currency', '30:number', 'in:keyword', 'EUR:currency'])
    expect(spans(lines[3])).toEqual(['12:number', 'in:unit', 'in:keyword', 'cm:unit'])
    expect(spans(lines[4])).toEqual(['2:number', '*:operator', '6:number', 'in:keyword', 'cm:unit'])
    expect(spans(lines[5])).toEqual(['5:number', 'ft:unit', '10:number', 'in:unit', 'cm:unit'])
    expect(spans(lines[6])).toEqual(['12:number', 'in:unit'])
    expect(spans(lines[7])).toEqual(['5:number', 'in:unit', 'hex:label'])
  })

  it('marks labels, assignments, headings and comments', async () => {
    const { lines } = await note('Rent: 1,200\nbudget = 5\n# Title\n// aside\nsum')

    expect(spans(lines[0])).toEqual(['Rent::label', '1,200:number'])
    expect(spans(lines[1])).toEqual(['budget:variable', '=:operator', '5:number'])
    expect(spans(lines[2])).toEqual(['# Title:heading'])
    expect(spans(lines[3])).toEqual(['// aside:comment'])
    expect(spans(lines[4])).toEqual(['sum:keyword'])
  })
})

describe('evaluate() and evaluateDocument()', () => {
  it('reads several lines as a note and answers with the last value', async () => {
    const result = await evaluate('budget = 1200\nbudget * 12\n// done', context())

    expect(result).toMatchObject({ ok: true, display: '14,400' })
    expect(result.lines).toHaveLength(3)
    expect(result.value?.exact).toBe('14400')
  })

  it('answers a function line with what to draw', async () => {
    const result = await evaluate('f(x) = x^2 - 2', context())

    expect(result).toMatchObject({ ok: true, display: 'f(x) = x^2 - 2' })
    expect(result.lines?.[0].plot?.expression).toBe('x^2 - 2')
  })

  it('says when there is no math at all', async () => {
    expect(await evaluate('Buy milk', context())).toMatchObject({ ok: false, error: 'There is no math in that to work out' })
    expect(await evaluate('', context())).toMatchObject({ ok: false })
  })

  it('never throws, whatever the note holds', async () => {
    const text = ['', '))((', '= = =', '#', '//', 'sum', 'f(x) =', 'plot', 'y = ', '$', '5 km in', '\u202e1+1', '1'.repeat(5000), 'x'.repeat(300)].join('\n')
    const document = await evaluateDocument(text, context())

    expect(document.lines).toHaveLength(14)
    expect(document.lines.every(line => typeof line.kind === 'string')).toBe(true)
  })

  it('reports the locale it read the note in', async () => {
    expect((await evaluateDocument('1', context(null, 'de-DE'))).locale).toBe('de-DE')
  })

  it('works out a 200-line note quickly once loaded', async () => {
    const sample = ['# Section', 'Rent: 1,200', 'budget = 1,600', 'budget * 12', 'prev / 4', '84.50 + 15%', '5 km in mi', '$120 split 3 ways', 'sqrt(2) * pi', 'Buy milk', 'sum', '']
    const text = Array.from({ length: 200 }, (_, index) => sample[index % sample.length]).join('\n')

    await evaluateDocument(text, context())

    const started = performance.now()
    const document = await evaluateDocument(text, context())

    expect(document.lines).toHaveLength(200)
    expect(performance.now() - started).toBeLessThan(250)
  })
})
