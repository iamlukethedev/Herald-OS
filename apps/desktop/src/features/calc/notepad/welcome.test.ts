import { describe, expect, it } from 'vitest'
import { CALC_NOTE_MAX_CHARS, noteTitle } from '../../../../shared/calc.ts'
import { plainKind, splitLines } from './layout.ts'
import { WELCOME_NOTE } from './welcome.ts'

describe('the Welcome note', () => {
  const lines = splitLines(WELCOME_NOTE)

  it('is named for the app', () => {
    expect(noteTitle(WELCOME_NOTE)).toBe('Welcome to Herald Calc')
  })

  it('shows off every kind of line', () => {
    for (const line of [
      '20% of 84.50',
      '84.50 + 15%',
      '15% off 60',
      'what % of 80 is 20',
      '2,400 + 180 split 3 ways',
      '5 km in miles',
      '350°F in C',
      '1.5 GB in MB',
      '100 USD in BRL',
      '€50 + £20 in USD',
      'days until Dec 25',
      '3 weeks from today',
      'Mar 3 to Jun 9 in days',
      '9am Sydney in New York',
      'budget = 1,200',
      'rent = 850',
      'budget - rent',
      'sum',
      'y = sin(x) * x'
    ]) {
      expect(lines).toContain(line)
    }

    expect(lines.some(line => plainKind(line) === 'heading')).toBe(true)
    expect(lines.some(line => plainKind(line) === 'comment')).toBe(true)
    expect(lines.some(line => /^\w+: [\d.,]+$/.test(line))).toBe(true)
  })

  it('sums lines that add up, under a heading of their own', () => {
    const sum = lines.indexOf('sum')
    const heading = lines.slice(0, sum).findLastIndex(line => plainKind(line) === 'heading')
    const above = lines.slice(heading + 1, sum).filter(line => line.trim() && !plainKind(line))

    expect(above.length).toBeGreaterThan(1)
    expect(above.every(line => /\d/.test(line) && !line.includes('='))).toBe(true)
  })

  it('fits in a note and ends with a newline, ready for the next line', () => {
    expect(WELCOME_NOTE.length).toBeLessThan(CALC_NOTE_MAX_CHARS)
    expect(WELCOME_NOTE.endsWith('\n')).toBe(true)
  })
})
