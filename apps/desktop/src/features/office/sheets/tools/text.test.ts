import { describe, expect, it } from 'vitest'
import { changeCaseOf, cleanText, dateSerial, parseDateText, parseNumberText, splitParts, typedPart } from './text.ts'

describe('cleaning and case', () => {
  it('trims, makes runs of spaces one, and takes out what prints nothing', () => {
    expect(cleanText('  Ada   Lovelace \t')).toBe('Ada Lovelace')
    expect(cleanText('Grace\u00a0Hopper\r\nand\u200b team\u0007')).toBe('Grace Hopper and team')
    expect(cleanText('\ufeffBOM')).toBe('BOM')
  })

  it('puts text in each case', () => {
    expect(changeCaseOf('mixed CASE text', 'upper')).toBe('MIXED CASE TEXT')
    expect(changeCaseOf('Mixed CASE', 'lower')).toBe('mixed case')
    expect(changeCaseOf("o'NEIL from new-york, 2nd floor", 'title')).toBe("O'neil From New-York, 2nd Floor")
    expect(changeCaseOf('FIRST ONE. second one!  third? yes', 'sentence')).toBe('First one. Second one!  Third? Yes')
  })
})

describe('numbers written as text', () => {
  it('reads separators, symbols, percentages and negatives, with the format that shows them so', () => {
    expect(parseNumberText('1,234.50')).toEqual({ value: 1234.5, format: '#,##0.00' })
    expect(parseNumberText('$12')).toEqual({ value: 12, format: '"$"#,##0' })
    expect(parseNumberText('-€1,000.25')).toEqual({ value: -1000.25, format: '"€"#,##0.00' })
    expect(parseNumberText('12 €')).toEqual({ value: 12, format: '#,##0 "€"' })
    expect(parseNumberText('(45)')).toEqual({ value: -45, format: null })
    expect(parseNumberText('($1,200.00)')).toEqual({ value: -1200, format: '"$"#,##0.00' })
    expect(parseNumberText('7-')).toEqual({ value: -7, format: null })
    expect(parseNumberText('12.5%')).toEqual({ value: 0.125, format: '0.0%' })
    expect(parseNumberText(' 42 ')).toEqual({ value: 42, format: null })
    expect(parseNumberText('1 234 567')).toEqual({ value: 1234567, format: '#,##0' })
    expect(parseNumberText('2.5E3')).toEqual({ value: 2500, format: null })
  })

  it('refuses what is not a number', () => {
    for (const text of ['abc', '12,34', '1.234,56', '--5', '(5)-', '$5%', '', '1 2', '$']) {
      expect(parseNumberText(text), text).toBeNull()
    }
  })
})

describe('dates written as text', () => {
  const serial = (y: number, m: number, d: number) => dateSerial(y, m, d)!

  it('counts days as Excel does', () => {
    expect(dateSerial(1900, 1, 1)).toBe(1)
    expect(dateSerial(1900, 2, 28)).toBe(59)
    expect(dateSerial(1900, 3, 1)).toBe(61)
    expect(dateSerial(2025, 12, 31)).toBe(46022)
    expect(dateSerial(1899, 12, 31)).toBeNull()
  })

  it('reads numbers in the order given, and four-digit years first whatever the order', () => {
    expect(parseDateText('31/12/2025', 'DMY')).toEqual({ serial: serial(2025, 12, 31), time: '' })
    expect(parseDateText('12/31/2025', 'MDY')).toEqual({ serial: serial(2025, 12, 31), time: '' })
    expect(parseDateText('1-2-26', 'DMY')?.serial).toBe(serial(2026, 2, 1))
    expect(parseDateText('1-2-26', 'MDY')?.serial).toBe(serial(2026, 1, 2))
    expect(parseDateText('25.12.31', 'YMD')?.serial).toBe(serial(2025, 12, 31))
    expect(parseDateText('2025-12-31', 'DMY')?.serial).toBe(serial(2025, 12, 31))
    expect(parseDateText('1/1/50', 'DMY')?.serial).toBe(serial(1950, 1, 1))
  })

  it('reads months by name, weekdays and times', () => {
    expect(parseDateText('31 Dec 2025', 'MDY')?.serial).toBe(serial(2025, 12, 31))
    expect(parseDateText('December 31, 2025', 'DMY')?.serial).toBe(serial(2025, 12, 31))
    expect(parseDateText('Wed, 31-Dec-25', 'MDY')?.serial).toBe(serial(2025, 12, 31))
    expect(parseDateText('Sept. 3 2026', 'DMY')?.serial).toBe(serial(2026, 9, 3))
    expect(parseDateText('2025-12-31 14:30', 'DMY')).toEqual({ serial: serial(2025, 12, 31) + 14.5 / 24, time: 'hh:mm' })
    expect(parseDateText('31/12/2025 2:30:15 pm', 'DMY')).toEqual({ serial: serial(2025, 12, 31) + (14 * 3600 + 30 * 60 + 15) / 86400, time: 'hh:mm:ss' })
  })

  it('refuses what is not a date', () => {
    for (const text of ['31/31/2025', '29/02/2025', '12/2025', 'next week', '14:30', '1 2 3', '31 Foo 2025', '2025-13-01', '12/31/2025 25:00']) {
      expect(parseDateText(text, 'DMY'), text).toBeNull()
    }
  })
})

describe('splitting', () => {
  it('cuts at a delimiter, keeping quoted parts whole', () => {
    expect(splitParts('Lovelace, Ada', ',', false)).toEqual(['Lovelace', 'Ada'])
    expect(splitParts('"Doe, Jane",31,"say ""hi"""', ',', false)).toEqual(['Doe, Jane', '31', 'say "hi"'])
    expect(splitParts('a,,b', ',', false)).toEqual(['a', '', 'b'])
    expect(splitParts('a,,b', ',', true)).toEqual(['a', 'b'])
    expect(splitParts('  one   two ', ' ', true)).toEqual(['one', 'two'])
    expect(splitParts('x | y | z', ' | ', false)).toEqual(['x', 'y', 'z'])
  })

  it('gives parts as cells hold them', () => {
    expect([typedPart('42'), typedPart('-1.5'), typedPart('007'), typedPart(''), typedPart('Ada')]).toEqual([42, -1.5, '007', null, 'Ada'])
  })
})
