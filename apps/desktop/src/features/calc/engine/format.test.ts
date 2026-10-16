import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatValue } from './index.ts'
import type { CalcValue } from './types.ts'

function value(kind: CalcValue['kind'], exact: string, extra: Partial<CalcValue> = {}): CalcValue {
  return { kind, exact, number: Number(exact), ...extra }
}

describe('formatValue for numbers', () => {
  it('shows exact short decimals in full and grouped', () => {
    expect(formatValue(value('number', '0.3'))).toMatch(/^0[.,]3$/)
    expect(formatValue(value('number', '97.175'), { locale: 'en-US' })).toBe('97.175')
    expect(formatValue(value('number', '1234567.891'), { locale: 'en-US' })).toBe('1,234,567.891')
    expect(formatValue(value('number', '-1234.5'), { locale: 'en-US' })).toBe('-1,234.5')
  })

  it('shows a value that never ends to ten significant digits, or as many as asked', () => {
    const third = value('number', '0.3333333333333333333333333333333333333333333333333333333333333333', { fraction: '1/3' })

    expect(formatValue(third, { locale: 'en-US' })).toBe('0.3333333333')
    expect(formatValue(third, { locale: 'en-US', digits: 4 })).toBe('0.3333')
    expect(formatValue(value('number', '33.33333333333333333333333333333333333333333333333333333333333333', { fraction: '100/3' }), { locale: 'en-US' })).toBe('33.33333333')
  })

  it('keeps every digit of an integer, until it is enormous', () => {
    expect(formatValue(value('number', '1267650600228229401496703205376'), { locale: 'en-US' })).toBe('1,267,650,600,228,229,401,496,703,205,376')
    expect(formatValue(value('number', `1${'0'.repeat(150)}`), { locale: 'en-US' })).toBe('1e150')
  })

  it('writes tiny numbers in scientific notation', () => {
    expect(formatValue(value('number', '0.00000001234'), { locale: 'en-US' })).toBe('1.234e-8')
    expect(formatValue(value('number', '0.000001'), { locale: 'en-US' })).toBe('0.000001')
  })

  it('leaves what is not a number as it is', () => {
    expect(formatValue(value('number', 'NaN'))).toBe('NaN')
  })
})

describe('formatValue for percentages and money', () => {
  it('writes percentages', () => {
    expect(formatValue(value('percent', '25'), { locale: 'en-US' })).toBe('25%')
    expect(formatValue(value('percent', '12.5'), { locale: 'de-DE' })).toBe('12,5\u00a0%')
  })

  it('writes money at its minor units', () => {
    expect(formatValue(value('currency', '1234.5', { unit: 'USD' }), { locale: 'en-US' })).toBe('$1,234.50')
    expect(formatValue(value('currency', '1234.5', { unit: 'JPY' }), { locale: 'en-US' })).toBe('¥1,235')
    expect(formatValue(value('currency', '1234.5', { unit: 'EUR' }), { locale: 'de-DE' })).toBe('1.234,50\u00a0€')
    expect(formatValue(value('currency', '-5', { unit: 'USD' }), { locale: 'en-US' })).toBe('-$5.00')
    expect(formatValue(value('currency', '-0.001', { unit: 'USD' }), { locale: 'en-US' })).toBe('$0.00')
    expect(formatValue(value('currency', '100', { unit: 'USD' }), { locale: 'en-AU' })).toBe('USD\u00a0100.00')
    expect(formatValue(value('currency', '100', { unit: 'AUD' }), { locale: 'en-AU' })).toBe('$100.00')
  })

  it('keeps every digit of a big amount', () => {
    expect(formatValue(value('currency', '123456789012345678901.5', { unit: 'USD' }), { locale: 'en-US' })).toBe('$123,456,789,012,345,678,901.50')
  })

  it('speaks money in words', () => {
    expect(formatValue(value('currency', '100', { unit: 'USD' }), { locale: 'en-US', units: 'long' })).toBe('100 US dollars')
    expect(formatValue(value('currency', '16.9', { unit: 'USD' }), { locale: 'en-US', units: 'long' })).toBe('16.90 US dollars')
  })
})

describe('formatValue for units and durations', () => {
  it('rounds units sensibly and writes their symbols', () => {
    expect(formatValue(value('unit', '3.106855961186669848087170921816591107929690606855961186669848087', { unit: 'mi' }), { locale: 'en-US' })).toBe('3.1069 mi')
    expect(formatValue(value('unit', '176.6666666666666666666666666666666666666666666666666666666666667', { unit: 'degC' }), { locale: 'en-US' })).toBe('176.67 °C')
    expect(formatValue(value('unit', '101.6', { unit: 'cm' }), { locale: 'en-US' })).toBe('101.6 cm')
    expect(formatValue(value('unit', '30', { unit: 'deg' }))).toBe('30°')
    expect(formatValue(value('unit', '9.81', { unit: 'm/s^2' }))).toBe('9.81 m/s²')
    expect(formatValue(value('unit', '5', { unit: 'kg m/s^2' }))).toBe('5 kg·m/s²')
  })

  it('speaks units in words', () => {
    expect(formatValue(value('unit', '6.21371192', { unit: 'mi' }), { locale: 'en-US', units: 'long' })).toBe('6.21 miles')
    expect(formatValue(value('unit', '176.666666666', { unit: 'degC' }), { locale: 'en-US', units: 'long' })).toBe('176.67 degrees Celsius')
    expect(formatValue(value('unit', '50', { unit: 'km/h' }), { locale: 'en-US', units: 'long' })).toBe('50 kilometers per hour')
    expect(formatValue(value('unit', '3', { unit: 'nmi' }), { locale: 'en-US', units: 'long' })).toBe('3 nautical miles')
    expect(formatValue(value('unit', '2', { unit: 'm^3' }), { locale: 'en-US', units: 'long' })).toBe('2 cubic meters')
    expect(formatValue(value('unit', '2', { unit: 'm^3' }), { locale: 'en-GB', units: 'long' })).toBe('2 cubic metres')
  })

  it('writes durations', () => {
    expect(formatValue(value('duration', '98', { unit: 'day' }))).toBe('98 days')
    expect(formatValue(value('duration', '98', { unit: 'day' }), { units: 'long' })).toBe('98 days')
    expect(formatValue(value('duration', '1', { unit: 'day' }), { locale: 'en-US' })).toBe('1 day')
    expect(formatValue(value('duration', '200', { unit: 'minute' }), { locale: 'en-US' })).toBe('200 min')
    expect(formatValue(value('duration', '200', { unit: 'minute' }), { locale: 'en-US', units: 'long' })).toBe('200 minutes')
    expect(formatValue(value('duration', '1', { unit: 'hour' }), { locale: 'en-US', units: 'long' })).toBe('1 hour')
    expect(formatValue(value('duration', '3', { unit: 'weeks' }), { locale: 'en-US' })).toBe('3 weeks')
  })
})

describe('formatValue for dates, times and the rest', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-16T02:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes dates, with the year only when it is not this one', () => {
    expect(formatValue(value('date', '2026-12-25'), { locale: 'en-US' })).toBe('Fri, Dec 25')
    expect(formatValue(value('date', '2026-12-25'), { locale: 'en-US', units: 'long' })).toBe('Friday, December 25')
    expect(formatValue(value('date', '2027-01-01'), { locale: 'en-US' })).toBe('Fri, Jan 1, 2027')
  })

  it('writes times in their zone', () => {
    const time = value('time', '2026-10-16T18:00:00-04:00', { zone: 'America/New_York' })

    expect(formatValue(time, { locale: 'en-US' })).toBe('6:00 PM New York')
    expect(formatValue(time, { locale: 'en-US', units: 'long' })).toBe('6:00 PM in New York')
  })

  it('passes booleans and text through, and never throws', () => {
    expect(formatValue(value('boolean', 'true'))).toBe('true')
    expect(formatValue(value('text', 'hello'))).toBe('hello')
    expect(() => formatValue(value('currency', 'abc', { unit: '??' }))).not.toThrow()
    expect(() => formatValue(value('time', 'not a time', { zone: 'Nowhere/Land' }))).not.toThrow()
    expect(() => formatValue(value('unit', '1', { unit: '' }), { units: 'long', locale: 'zz-ZZ' })).not.toThrow()
  })
})
