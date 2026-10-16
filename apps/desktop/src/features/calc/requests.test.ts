import { describe, expect, it } from 'vitest'
import { CALC_NOTE_MAX_CHARS } from '../../../shared/calc.ts'
import { createRequestGate, planRequest, readCalcRequest } from './requests.ts'

describe('readCalcRequest', () => {
  it('holds nothing without an object carrying a finite `at`', () => {
    expect(readCalcRequest(undefined)).toBeNull()
    expect(readCalcRequest(null)).toBeNull()
    expect(readCalcRequest('notes')).toBeNull()
    expect(readCalcRequest([{ at: 1 }])).toBeNull()
    expect(readCalcRequest({ view: 'notes' })).toBeNull()
    expect(readCalcRequest({ at: '12' })).toBeNull()
    expect(readCalcRequest({ at: Number.NaN })).toBeNull()
    expect(readCalcRequest({ at: Number.POSITIVE_INFINITY })).toBeNull()
  })

  it('keeps the views and keypads it knows and drops the rest', () => {
    expect(readCalcRequest({ at: 5, view: 'graph', keypad: 'programmer' })).toEqual({ at: 5, view: 'graph', keypad: 'programmer' })
    expect(readCalcRequest({ at: 5, view: 'settings', keypad: 'abacus' })).toEqual({ at: 5 })
  })

  it('starts a note only with text worth a note, and never one main would refuse', () => {
    expect(readCalcRequest({ at: 1, text: '20% of 84.50' })?.text).toBe('20% of 84.50')
    expect(readCalcRequest({ at: 1, text: '   \n ' })?.text).toBeUndefined()
    expect(readCalcRequest({ at: 1, text: 42 })?.text).toBeUndefined()
    expect(readCalcRequest({ at: 1, text: 'x'.repeat(CALC_NOTE_MAX_CHARS + 1) })?.text).toBeUndefined()
  })

  it('keeps a search, trimmed, even an empty one (the whole history)', () => {
    expect(readCalcRequest({ at: 1, search: '  mortgage ' })?.search).toBe('mortgage')
    expect(readCalcRequest({ at: 1, search: '' })?.search).toBe('')
    expect(readCalcRequest({ at: 1, search: 7 })?.search).toBeUndefined()
  })

  it('reads a plot field by field: real entries, real points, and a range only when it is one', () => {
    const request = readCalcRequest({
      at: 1,
      plot: {
        entries: [' sin(x) * x ', '', 3, 'column B of Budget.xlsx'],
        series: [{ label: 'Budget.xlsx · column B', points: [[1, 2], [2, Number.NaN], [3, 4], 'x', [5]] }, { label: 'empty', points: [] }, null],
        xMin: -5,
        xMax: 5
      }
    })

    expect(request?.plot).toEqual({
      entries: ['sin(x) * x', 'column B of Budget.xlsx'],
      series: [
        {
          label: 'Budget.xlsx · column B',
          points: [
            [1, 2],
            [3, 4]
          ]
        }
      ],
      xMin: -5,
      xMax: 5
    })
    expect(readCalcRequest({ at: 1, plot: { entries: ['x'], xMin: 5, xMax: -5 } })?.plot).toEqual({ entries: ['x'] })
    expect(readCalcRequest({ at: 1, plot: { entries: ['x'], xMin: 0 } })?.plot).toEqual({ entries: ['x'] })
    expect(readCalcRequest({ at: 1, plot: { series: [{ points: [[0, 1]] }] } })?.plot).toEqual({ series: [{ label: 'Data', points: [[0, 1]] }] })
  })

  it('drops a plot with nothing to draw', () => {
    expect(readCalcRequest({ at: 1, plot: { entries: [], series: [], xMin: 0, xMax: 1 } })).toEqual({ at: 1 })
    expect(readCalcRequest({ at: 1, plot: ['sin(x)'] })).toEqual({ at: 1 })
  })
})

describe('planRequest', () => {
  it('shows the view a request names over the one its contents imply', () => {
    expect(planRequest({ at: 1, view: 'notes', search: 'rent' }).view).toBe('notes')
  })

  it('infers the view: a plot draws, a search searches, a keypad shows, text writes', () => {
    expect(planRequest({ at: 1, plot: { entries: ['x'] }, text: 'x' }).view).toBe('graph')
    expect(planRequest({ at: 1, search: '', keypad: 'scientific' }).view).toBe('history')
    expect(planRequest({ at: 1, keypad: 'scientific', text: '1 + 1' }).view).toBe('keypad')
    expect(planRequest({ at: 1, text: '1 + 1' }).view).toBe('notes')
    expect(planRequest({ at: 1 }).view).toBeNull()
  })

  it('carries every part of the request', () => {
    expect(planRequest({ at: 1, keypad: 'programmer', text: '0xff', search: 'hex', plot: { entries: ['x'] } })).toEqual({ view: 'graph', keypad: 'programmer', text: '0xff', search: 'hex', plot: { entries: ['x'] } })
  })
})

describe('createRequestGate', () => {
  it('passes each request once, however it arrives', () => {
    const take = createRequestGate()
    const request = { at: 1000, view: 'keypad' as const }

    expect(take(request)).toBe(true)
    expect(take({ ...request })).toBe(false)
    expect(take({ at: 1001 })).toBe(true)
    expect(take({ at: 1000, text: 'a different body, the same ask' })).toBe(false)
  })

  it('forgets the oldest requests past what it remembers', () => {
    const take = createRequestGate(2)

    expect(take({ at: 1 })).toBe(true)
    expect(take({ at: 2 })).toBe(true)
    expect(take({ at: 3 })).toBe(true)
    expect(take({ at: 3 })).toBe(false)
    expect(take({ at: 1 })).toBe(true)
  })
})
