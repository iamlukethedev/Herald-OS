import { describe, expect, it } from 'vitest'
import { addDecimals, negateDecimal, normalizeEntry, parseDecimal } from './decimal.ts'
import { formatEntry, formatNumber, groupInteger, numberSymbols } from './format.ts'

const MINUS = '\u2212'

describe('formatNumber', () => {
  it('groups and marks decimals the locale’s way', () => {
    expect(formatNumber('1234567.891', { locale: 'en-US' })).toBe('1,234,567.891')
    expect(formatNumber('1234567.891', { locale: 'de-DE' })).toBe('1.234.567,891')
    expect(formatNumber('12345678', { locale: 'en-IN' })).toBe('1,23,45,678')
    expect(formatNumber('1234', { locale: 'es-ES' })).toBe('1234')
  })

  it('writes small, negative and zero values plainly', () => {
    expect(formatNumber('0.1', { locale: 'en-US' })).toBe('0.1')
    expect(formatNumber('0.3', { locale: 'en-US' })).toBe('0.3')
    expect(formatNumber('-5', { locale: 'en-US' })).toBe(`${MINUS}5`)
    expect(formatNumber('-0', { locale: 'en-US' })).toBe('0')
    expect(formatNumber('100', { locale: 'en-US' })).toBe('100')
    expect(formatNumber('0.000001234', { locale: 'en-US' })).toBe('0.000001234')
  })

  it('rounds what does not fit in sixteen digits', () => {
    expect(formatNumber('0.3333333333333333333333', { locale: 'en-US' })).toBe('0.333333333333333')
    expect(formatNumber('2.71828182845904523536', { locale: 'en-US' })).toBe('2.718281828459045')
    expect(formatNumber('9.9999999999999999', { locale: 'en-US' })).toBe('10')
    expect(formatNumber('3.14159265358979323846', { locale: 'en-US', digits: 12 })).toBe('3.14159265359')
  })

  it('switches to scientific notation for very large and very small values', () => {
    expect(formatNumber('99999999999999999', { locale: 'en-US' })).toBe('1e17')
    expect(formatNumber('12345678901234567890', { locale: 'en-US' })).toBe('1.234567890123e19')
    expect(formatNumber('0.00000001234', { locale: 'en-US' })).toBe(`1.234e${MINUS}8`)
    expect(formatNumber('6.02214076e23', { locale: 'en-US' })).toBe('6.02214076e23')
    expect(formatNumber('6.62607015e-34', { locale: 'de-DE' })).toBe(`6,62607015e${MINUS}34`)
  })

  it('names infinity and passes anything else through', () => {
    expect(formatNumber('Infinity')).toBe('∞')
    expect(formatNumber('-Infinity')).toBe(`${MINUS}∞`)
    expect(formatNumber('abc')).toBe('abc')
    expect(formatNumber('constructor')).toBe('constructor')
  })
})

describe('formatEntry', () => {
  it('keeps the entry as typed, grouped', () => {
    expect(formatEntry('1234.50', 'en-US')).toBe('1,234.50')
    expect(formatEntry('0.', 'en-US')).toBe('0.')
    expect(formatEntry('-0', 'en-US')).toBe(`${MINUS}0`)
    expect(formatEntry('6.02e-', 'en-US')).toBe(`6.02e${MINUS}`)
    expect(formatEntry('6.02e23', 'en-US')).toBe('6.02e23')
    expect(formatEntry('1234.5', 'de-DE')).toBe('1.234,5')
  })
})

describe('locale symbols', () => {
  it('reads the group and decimal marks', () => {
    expect(numberSymbols('de-DE')).toEqual({ group: '.', decimal: ',' })
    expect(numberSymbols('en-US')).toEqual({ group: ',', decimal: '.' })
    expect(groupInteger('12345', 'es-ES')).toBe('12.345')
    expect(numberSymbols('not a locale!').decimal).toMatch(/^[.,]$/)
  })
})

describe('exact decimals', () => {
  it('adds without floating point', () => {
    expect(addDecimals('0.1', '0.2')).toBe('0.3')
    expect(addDecimals('1', '-1')).toBe('0')
    expect(addDecimals('1.5e3', '0.25')).toBe('1500.25')
    expect(addDecimals('-0.5', '0.25')).toBe('-0.25')
    expect(addDecimals('1e-3', '1')).toBe('1.001')
    expect(addDecimals('abc', '1')).toBeNull()
  })

  it('negates and normalizes', () => {
    expect(negateDecimal('5')).toBe('-5')
    expect(negateDecimal('-5')).toBe('5')
    expect(negateDecimal('0')).toBe('0')
    expect(normalizeEntry('12.')).toBe('12')
    expect(normalizeEntry('6.02e')).toBe('6.02')
    expect(normalizeEntry('6.02e-')).toBe('6.02')
    expect(normalizeEntry('-0')).toBe('0')
    expect(normalizeEntry('0.00')).toBe('0')
    expect(normalizeEntry('-')).toBe('0')
    expect(normalizeEntry('0.50')).toBe('0.50')
    expect(parseDecimal('6.02e23')).toEqual({ units: 602n * 10n ** 21n, scale: 0 })
    expect(parseDecimal('-1.25')).toEqual({ units: -125n, scale: 2 })
  })
})
