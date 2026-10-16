import { describe, expect, it } from 'vitest'
import type { DocumentResult, LineResult } from '../engine/types.ts'
import { functionText, noteGraphEntries, noteScope, sameEntries, sameScope } from './graph.ts'

const doc = (lines: LineResult[]): DocumentResult => ({ lines, total: null, totalDisplay: null, usesRates: false, functions: [] })

describe('the note graph', () => {
  const lines: LineResult[] = [
    { index: 0, kind: 'value', source: 'a = 2', name: 'a', label: 'a', value: { kind: 'number', exact: '2', number: 2 }, display: '2' },
    { index: 1, kind: 'value', source: 'trip = 5 km', name: 'trip', value: { kind: 'unit', exact: '5', number: 5, unit: 'km' }, display: '5 km' },
    { index: 2, kind: 'function', source: 'y = sin(x) * x', plot: { name: 'y', expression: 'sin(x) * x', variable: 'x', index: 2 } },
    { index: 3, kind: 'plot', source: 'plot a * t^2', plot: { name: '', expression: 'a * t^2 + sqrt(t)', variable: 't', index: 3 } },
    { index: 4, kind: 'plot', source: 'plot column B of Budget.xlsx', plotSource: 'column B of Budget.xlsx' },
    { index: 5, kind: 'value', source: 'a = 3', name: 'a', value: { kind: 'number', exact: '3', number: 3 }, display: '3' },
    { index: 6, kind: 'error', source: 'plot' }
  ]

  it('draws each function, over x, and each sheet, in line order', () => {
    expect(noteGraphEntries(doc(lines))).toEqual([
      { id: 'note-2', text: 'sin(x) * x' },
      { id: 'note-3', text: 'a * x^2 + sqrt(x)' },
      { id: 'note-4', text: 'column B of Budget.xlsx' }
    ])
    expect(noteGraphEntries(null)).toEqual([])
  })

  it('renames only the variable itself, never a name containing it', () => {
    expect(functionText({ name: 'f', expression: 'tan(t) + t2 + t', variable: 't', index: 0 })).toBe('tan(x) + t2 + x')
    expect(functionText({ name: 'f', expression: 'x^2', variable: 'x', index: 0 })).toBe('x^2')
  })

  it('hands the graph the numbers the note names, as they stand at its end', () => {
    expect(noteScope(doc(lines))).toEqual({ a: 3 })
  })

  it('compares lists and scopes by what they hold', () => {
    expect(sameEntries([{ id: 'a', text: 'x' }], [{ id: 'a', text: 'x' }])).toBe(true)
    expect(sameEntries([{ id: 'a', text: 'x' }], [{ id: 'a', text: 'x^2' }])).toBe(false)
    expect(sameScope({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(sameScope({ a: 1 }, { a: 1, b: 2 })).toBe(false)
  })
})
