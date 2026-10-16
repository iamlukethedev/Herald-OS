import { describe, expect, it } from 'vitest'
import { CALC_PREFS_DEFAULTS, mergeCalcPrefs, normalizeCalcPrefs, notePreview, noteTitle } from './calc.ts'

describe('normalizeCalcPrefs', () => {
  it('reads the defaults from nothing, or from anything that is not an object', () => {
    for (const raw of [undefined, null, 'scientific', 42, true, [], [{ sounds: true }]]) {
      expect(normalizeCalcPrefs(raw), JSON.stringify(raw)).toEqual(CALC_PREFS_DEFAULTS)
    }
  })

  it('keeps known values only: the rates fetch on unless turned off, the key sounds off unless turned on', () => {
    expect(normalizeCalcPrefs({ fetchRates: false, sounds: true, angle: 'rad', keypad: 'programmer' })).toEqual({ fetchRates: false, sounds: true, angle: 'rad', keypad: 'programmer' })
    expect(normalizeCalcPrefs({ fetchRates: 'no', sounds: 'yes', angle: 'grad', keypad: 'hex', theme: 'neon' })).toEqual(CALC_PREFS_DEFAULTS)
    expect(normalizeCalcPrefs({ fetchRates: 0, sounds: 1, keypad: 'scientific' })).toEqual({ ...CALC_PREFS_DEFAULTS, keypad: 'scientific' })
  })
})

describe('mergeCalcPrefs', () => {
  const current = { ...CALC_PREFS_DEFAULTS, sounds: true, keypad: 'scientific' as const }

  it('writes a patch over the current prefs field by field, a field left undefined keeping its value', () => {
    expect(mergeCalcPrefs(current, { angle: 'rad' })).toEqual({ ...current, angle: 'rad' })
    expect(mergeCalcPrefs(current, { sounds: undefined, fetchRates: false })).toEqual({ ...current, fetchRates: false })
    expect(mergeCalcPrefs(undefined, { keypad: 'programmer' })).toEqual({ ...CALC_PREFS_DEFAULTS, keypad: 'programmer' })

    for (const patch of [undefined, null, 'rad', [], {}]) {
      expect(mergeCalcPrefs(current, patch), JSON.stringify(patch)).toEqual(current)
    }
  })

  it('never lets a bad value through: a field patched with one falls back to its default', () => {
    expect(mergeCalcPrefs({ ...current, angle: 'rad' }, { angle: 'grad', keypad: 'hex', fetchRates: 'off', extra: 1 })).toEqual({ ...CALC_PREFS_DEFAULTS, sounds: true })
  })
})

describe('noteTitle', () => {
  it("names a note after its first line with text, without a heading's # or a comment's //", () => {
    expect(noteTitle('\n\n  # Groceries  \nMilk 2 * 1.20')).toBe('Groceries')
    expect(noteTitle('### Trip to Lisbon\nFlights 2 * 420')).toBe('Trip to Lisbon')
    expect(noteTitle('// Rent split\n1200 / 3')).toBe('Rent split')
    expect(noteTitle('20% of 84.50')).toBe('20% of 84.50')
  })

  it('calls a note with no words Untitled', () => {
    for (const text of ['', '   ', '\n\n', '#', '// ']) {
      expect(noteTitle(text), JSON.stringify(text)).toBe('Untitled')
    }
  })

  it('cuts a title longer than 60 characters to 59 and an ellipsis', () => {
    expect(noteTitle('a'.repeat(60))).toBe('a'.repeat(60))
    expect(noteTitle(`# ${'b'.repeat(61)}`)).toBe(`${'b'.repeat(59)}…`)
  })
})

describe('notePreview', () => {
  it('shows the three lines with text after the title, on one line', () => {
    expect(notePreview('# Trip\n\nFlights   2 * 420\n\tHotel 3 * 95\n\nTotal = sum\nTaxi 30')).toBe('Flights 2 * 420 · Hotel 3 * 95 · Total = sum')
    expect(notePreview('Only a title\n\n')).toBe('')
    expect(notePreview('')).toBe('')
  })

  it('cuts a preview longer than 120 characters to 119 and an ellipsis', () => {
    expect(notePreview(`Title\n${'c'.repeat(120)}`)).toBe('c'.repeat(120))
    expect(notePreview(`Title\n${'c'.repeat(200)}`)).toBe(`${'c'.repeat(119)}…`)
  })
})
