import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadedMath } from './math.ts'
import { CURRENCY_WORDS, MATH_WORDS, UNIT_WORDS } from './vocabulary.ts'

describe('the vocabulary', () => {
  it('holds the unit words, symbols and phrases', () => {
    for (const word of ['km', 'kilometres', 'miles', '°f', 'fahrenheit', 'sq ft', 'mph', 'kwh', 'pounds', 'lbs', 'gb', 'mib', 'hours', 'celsius', 'fl oz', 'hectares']) {
      expect(UNIT_WORDS.has(word), word).toBe(true)
    }
  })

  it('holds currency codes, names and symbols, but not codes that are everyday words', () => {
    for (const word of ['usd', 'eur', 'brl', 'dollars', 'euro', 'euros', 'reais', 'yen', 'rupees', '€', '$', '£', 'r$', 'zł', 'kr', 'pounds']) {
      expect(CURRENCY_WORDS.has(word), word).toBe(true)
    }

    for (const word of ['all', 'try', 'cup', 'top', 'mad']) {
      expect(CURRENCY_WORDS.has(word), word).toBe(false)
    }
  })

  it('holds functions, constants and operator words', () => {
    for (const word of ['sqrt', 'square root', 'square root of', 'sin', 'ln', 'log', 'pi', 'π', 'e', 'plus', 'minus', 'times', 'divided by', 'percent', 'squared', 'thousand', 'million', 'half', 'split']) {
      expect(MATH_WORDS.has(word), word).toBe(true)
    }
  })

  it('is all lower case', () => {
    for (const set of [UNIT_WORDS, CURRENCY_WORDS, MATH_WORDS]) {
      for (const word of set) {
        expect(word).toBe(word.toLowerCase())
      }
    }
  })

  it('loads no math.js', () => {
    expect(loadedMath()).toBeNull()
  })
})

describe('math.js', () => {
  it('is only ever imported on demand, so it stays in its own chunk', () => {
    const folder = new URL('.', import.meta.url)
    const sources = readdirSync(folder).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))

    for (const name of sources) {
      const text = readFileSync(new URL(name, folder), 'utf8')
      const imports = text.match(/^import\s+(?!type\b)[^;\n]*from\s+'mathjs'/gm) ?? []

      expect(imports, name).toEqual([])
    }

    expect(readFileSync(new URL('math.ts', folder), 'utf8')).toContain("import('mathjs')")
  })
})
