import { describe, expect, it } from 'vitest'
import { evaluate } from './index.ts'
import { numberSymbols } from './numbers.ts'
import type { EvalResult } from './types.ts'

async function answer(text: string, locale: string): Promise<EvalResult> {
  const result = await evaluate(text, { locale, now: Date.UTC(2026, 9, 16, 2), zone: 'Europe/Berlin', rates: null })

  expect(result.ok, `${locale} ${text}: ${result.error}`).toBe(true)

  return result
}

describe('the locale’s number characters', () => {
  it('come from Intl', () => {
    expect(numberSymbols('en-US')).toMatchObject({ group: ',', decimal: '.', groups: [3, 3], commaDecimal: false })
    expect(numberSymbols('de-DE')).toMatchObject({ group: '.', decimal: ',', commaDecimal: true })
    expect(numberSymbols('pt-BR')).toMatchObject({ group: '.', decimal: ',' })
    expect(numberSymbols('fr-FR')).toMatchObject({ group: '\u202f', decimal: ',' })
    expect(numberSymbols('en-IN')).toMatchObject({ group: ',', decimal: '.', groups: [3, 2] })
    expect(numberSymbols('es-ES').groupFour).toBe(false)
  })

  it('fall back to the system for a locale Intl cannot read', () => {
    expect(numberSymbols('not a locale').decimal).toMatch(/^[.,]$/)
    expect(numberSymbols('en_AU')).toMatchObject({ group: ',', decimal: '.' })
  })
})

describe('reading numbers', () => {
  it('reads en-US groups and decimals', async () => {
    expect((await answer('2,400.50 + 1', 'en-US')).value?.exact).toBe('2401.5')
    expect((await answer('1,000,000 / 4', 'en-US')).value?.exact).toBe('250000')
  })

  it('reads de-DE and pt-BR, where the comma is the decimal', async () => {
    expect((await answer('2.400,50 + 1', 'de-DE')).value?.exact).toBe('2401.5')
    expect((await answer('2.400,50 * 2', 'pt-BR')).value?.exact).toBe('4801')
    expect((await answer('0,1 + 0,2', 'de-DE')).value?.exact).toBe('0.3')
    expect((await answer('1.234', 'de-DE')).value?.exact).toBe('1234')
    expect((await answer('2.5', 'de-DE')).value?.exact).toBe('2.5')
  })

  it('reads fr-FR with spaces between groups', async () => {
    expect((await answer('2 400,50 + 1', 'fr-FR')).value?.exact).toBe('2401.5')
    expect((await answer('2\u202f400,50 + 1', 'fr-FR')).value?.exact).toBe('2401.5')
    expect((await answer('2\u00a0400 * 2', 'fr-FR')).value?.exact).toBe('4800')
  })

  it('reads en-IN lakh grouping', async () => {
    expect((await answer('1,00,000 + 1', 'en-IN')).value?.exact).toBe('100001')
    expect((await answer('12,34,567 * 1', 'en-IN')).value?.exact).toBe('1234567')
  })

  it('separates function arguments with ; or ", " where the comma is the decimal', async () => {
    expect((await answer('max(2,5; 3)', 'de-DE')).value?.exact).toBe('3')
    expect((await answer('max(2, 5)', 'de-DE')).value?.exact).toBe('5')
    expect((await answer('max(2,5)', 'de-DE')).value?.exact).toBe('2.5')
    expect((await answer('round(2,345; 2)', 'de-DE')).display).toBe('2,35')
    expect((await answer('max(2, 5)', 'en-US')).value?.exact).toBe('5')
    expect((await answer('round(2.345, 2)', 'en-US')).value?.exact).toBe('2.35')
  })
})

describe('writing numbers', () => {
  it('writes exact decimals with the locale’s characters', async () => {
    expect((await answer('2400.5 * 1', 'en-US')).display).toBe('2,400.5')
    expect((await answer('2400,5 * 1', 'de-DE')).display).toBe('2.400,5')
    expect((await answer('2400,5 * 1', 'pt-BR')).display).toBe('2.400,5')
    expect((await answer('2400,5 * 1', 'fr-FR')).display).toBe('2\u202f400,5')
    expect((await answer('100000 * 3', 'en-IN')).display).toBe('3,00,000')
  })

  it('writes long exact values in full', async () => {
    expect((await answer('2^100', 'de-DE')).display).toBe('1.267.650.600.228.229.401.496.703.205.376')
    expect((await answer('123456789012345678,25 + 0', 'de-DE')).display).toBe('123.456.789.012.345.678,25')
  })

  it('leaves four-digit numbers ungrouped where the locale does', async () => {
    expect((await answer('1234 * 1', 'es-ES')).display).toBe('1234')
    expect((await answer('12345 * 1', 'es-ES')).display).toBe('12.345')
  })

  it('writes percentages and money the locale’s way', async () => {
    expect((await answer('20 as a % of 80', 'de-DE')).display).toBe('25\u00a0%')
    expect((await answer('1.234,50 €', 'de-DE')).display).toBe('1.234,50\u00a0€')
    expect((await answer('R$ 1.200,50 + 10%', 'pt-BR')).display).toBe('R$\u00a01.320,55')
  })

  it('writes a value that never ends with the locale’s decimal', async () => {
    expect((await answer('1/3', 'fr-FR')).display).toBe('0,3333333333')
  })
})
