import { describe, expect, it, vi } from 'vitest'
import type { CalcRates } from '../../../../shared/calc.ts'
import { evaluateDocument } from './index.ts'
import { toSheetRows } from './sheets.ts'
import type { DocumentResult, LineResult } from './types.ts'

vi.mock('./dates.ts', () => ({ evaluateDateLine: () => null, parseDate: () => null }))
vi.mock('./zones.ts', () => ({ evaluateZoneLine: () => null, findZone: () => null, zoneNames: () => [] }))

const RATES: CalcRates = { base: 'EUR', date: '2026-10-15', fetchedAt: 0, rates: { EUR: 1, USD: 1.25, BRL: 6.25 } }

async function rows(text: string, locale = 'en-US') {
  return toSheetRows(await evaluateDocument(text, { locale, now: Date.UTC(2026, 9, 16, 2), zone: 'UTC', rates: RATES }))
}

function documentOf(lines: LineResult[]): DocumentResult {
  return { lines, total: null, totalDisplay: null, usesRates: false, functions: [] }
}

describe('toSheetRows', () => {
  it('puts line N in row N, values and labels side by side', async () => {
    const sheet = await rows('# Trip\nFlights: 1,200\nHotel: 800\nsum\n\n// notes')

    expect(sheet).toEqual([
      { value: null, label: 'Trip', heading: true },
      { value: 1200, label: 'Flights' },
      { value: 800, label: 'Hotel' },
      { value: '=SUM(A2:A3)', label: 'Total' },
      { value: null, label: '' },
      { value: null, label: 'notes' }
    ])
  })

  it('refers to the rows that names and prev came from', async () => {
    const sheet = await rows('budget = 1,600\nbudget * 12\nprev / 4\nmonthly rent = 1,200\nmonthly rent * 12')

    expect(sheet.map(row => row.value)).toEqual([1600, '=A1*12', '=A2/4', 1200, '=A4*12'])
    expect(sheet[0].label).toBe('budget')
    expect(sheet[1].label).toBe('budget * 12')
  })

  it('refers to rows a label named, and sums money with plain numbers', async () => {
    const sheet = await rows('flights = $1,240\nhotel: 4 nights * $189\nfood = 35 * 6\nflights + hotel + food\nsum')

    expect(sheet.map(row => row.value)).toEqual([1240, 756, '=35*6', '=A1+A2+A3', '=SUM(A1:A4)'])
    expect(sheet[1].label).toBe('hotel')
    expect(sheet[4].format).toBe('[$$]#,##0.00')
  })

  it('writes percentage forms as Sheets understands them', async () => {
    const sheet = await rows('84.50 + 15%\n20% of 84.50\n15% off 60\n84.50 - 15%\nwhat % of 80 is 20\n20 is 25% of what\n% change from 50 to 75\nincrease 50 by 10%\n15%')

    expect(sheet.map(row => row.value)).toEqual(['=84.5*(1+15%)', '=20%*84.5', '=60*(1-15%)', '=84.5*(1-15%)', '=20/80', '=20/25%', '=(75-50)/50', '=50*(1+10%)', 0.15])
    expect(sheet[4].format).toBe('0.00%')
    expect(sheet[6].format).toBe('0.00%')
    expect(sheet[8].format).toBe('0.00%')
  })

  it('treats a named percentage as one later', async () => {
    const sheet = await rows('tip = 15%\n84.50 + tip\n200 * tip')

    expect(sheet.map(row => row.value)).toEqual([0.15, '=84.5*(1+A1)', '=200*A1'])
  })

  it('writes splits with the sum in brackets', async () => {
    const sheet = await rows('2,400 + 180 split 3 ways\nsplit 2,580 between 4 people')

    expect(sheet.map(row => row.value)).toEqual(['=(2400+180)/3', '=2580/4'])
  })

  it('maps functions and constants onto Sheets functions', async () => {
    const sheet = await rows('sqrt(16) + abs(-2)\nln(10)\nlog(100)\nsin(30°)\npi * 2\nround(2.345, 2)\n10 mod 3\n5!\nmax(1, 2) ^ 2')

    expect(sheet.map(row => row.value)).toEqual(['=SQRT(16)+ABS(-2)', '=LN(10)', '=LOG10(100)', '=SIN(RADIANS(30))', '=PI()*2', '=ROUND(2.345,2)', '=MOD(10,3)', '=FACT(5)', '=MAX(1,2)^2'])
  })

  it('sums and averages with a formula only when the rows add up', async () => {
    const sheet = await rows('2\n4\naverage\n\n5 km\n300 m\nsum')

    expect(sheet[2].value).toBe('=AVERAGE(A1:A2)')
    expect(sheet[6]).toEqual({ value: 5.3, label: 'Total (km)' })
  })

  it('formats money and keeps one currency in formulas', async () => {
    const sheet = await rows('$1,200 * 12\nrent = $1,200\nrent * 12\n¥1000 + ¥5')

    expect(sheet[0]).toEqual({ value: '=1200*12', label: '$1,200 * 12', format: '[$$]#,##0.00' })
    expect(sheet[2]).toMatchObject({ value: '=A2*12', format: '[$$]#,##0.00' })
    expect(sheet[3].format).toBe('[$¥]#,##0')
  })

  it('puts the value where a line does not map: conversions, units and rates', async () => {
    const sheet = await rows('5 km in mi\n100 USD in BRL\n3 hours 20 minutes in minutes')

    expect(sheet[0].value).toBeCloseTo(3.1068559612, 9)
    expect(sheet[0].label).toBe('5 km in mi (mi)')
    expect(sheet[1]).toEqual({ value: 500, label: '100 USD in BRL', format: '[$R$]#,##0.00' })
    expect(sheet[2]).toEqual({ value: 200, label: '3 hours 20 minutes in minutes (minutes)' })
  })

  it('reads the note’s numbers in its locale', async () => {
    const sheet = await rows('2.400,50 * 2\nmax(2,5; 3)', 'de-DE')

    expect(sheet.map(row => row.value)).toEqual(['=2400.5*2', '=MAX(2.5,3)'])
  })

  it('labels a line with its trailing comment', async () => {
    const sheet = await rows('84.50 + 15% // with the tip')

    expect(sheet[0]).toEqual({ value: '=84.5*(1+15%)', label: 'with the tip' })
  })

  it('writes dates and times as text and durations as numbers', () => {
    const sheet = toSheetRows(
      documentOf([
        { index: 0, kind: 'value', source: 'Dec 25', value: { kind: 'date', exact: '2026-12-25', number: Date.UTC(2026, 11, 25) }, display: 'Fri, Dec 25' },
        { index: 1, kind: 'value', source: 'trip = days until Dec 25', name: 'trip', label: 'trip', value: { kind: 'duration', exact: '70', number: 70, unit: 'day' }, display: '70 days' },
        { index: 2, kind: 'function', source: 'y = x^2', plot: { name: 'y', expression: 'x^2', variable: 'x', index: 2 } },
        { index: 3, kind: 'error', source: '5 km + 3 kg', error: "A length and a mass don't add up" }
      ])
    )

    expect(sheet).toEqual([
      { value: 'Fri, Dec 25', label: 'Dec 25' },
      { value: 70, label: 'trip (days)' },
      { value: null, label: 'y = x^2' },
      { value: null, label: '5 km + 3 kg' }
    ])
  })
})
