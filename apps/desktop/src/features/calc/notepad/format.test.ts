import { describe, expect, it } from 'vitest'
import type { CalcRatesState } from '../../../../shared/calc.ts'
import { messageOf, ratesDay, ratesLabel } from './format.ts'

const NOW = Date.UTC(2026, 9, 16, 3, 0)
const state = (status: CalcRatesState['status'], date = '2026-10-15'): CalcRatesState => ({ status, rates: { base: 'EUR', date, fetchedAt: NOW - 3_600_000, rates: { EUR: 1, USD: 1.08 } } })

describe('messageOf', () => {
  it("drops Electron's wrapping around a message from main", () => {
    expect(messageOf(new Error("Error invoking remote method 'herald-os:calc:note-save': Error: The note is too long"))).toBe('The note is too long')
    expect(messageOf('plain words')).toBe('plain words')
    expect(messageOf(new Error(''))).toBe('Something went wrong')
  })
})

describe('the rates line', () => {
  it("writes the ECB's day the locale's way, with the year only when it is another", () => {
    expect(ratesDay('2026-10-15', 'en-US', NOW)).toBe('Oct 15')
    expect(ratesDay('2026-10-15', 'en-GB', NOW)).toBe('15 Oct')
    expect(ratesDay('2025-12-31', 'en-US', NOW)).toBe('Dec 31, 2025')
    expect(ratesDay('soon', 'en-US', NOW)).toBe('soon')
  })

  it('says which day the rates are from, and hints when they cannot be fresh', () => {
    expect(ratesLabel(state('fresh'), 'en-US', NOW)).toEqual({ text: 'Rates from Oct 15', hint: null })
    expect(ratesLabel(state('cached'), 'en-US', NOW).hint).toBeNull()
    expect(ratesLabel(state('offline'), 'en-US', NOW).hint).toBe('offline')
    expect(ratesLabel(state('off'), 'en-US', NOW).hint).toBe('updates off')
  })

  it('says so when there are no rates yet', () => {
    expect(ratesLabel(null, 'en-US', NOW)).toEqual({ text: 'No currency rates yet', hint: null })
    expect(ratesLabel({ status: 'none', rates: null }, 'en-US', NOW)).toEqual({ text: 'No currency rates yet', hint: null })
    expect(ratesLabel({ status: 'off', rates: null }, 'en-US', NOW).hint).toBe('updates off')
  })
})
