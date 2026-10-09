import { describe, expect, it } from 'vitest'
import { chartValues, hasNumbers, numberOf } from './data.ts'
import { cell, column, date, grid, readerOf, specOf } from './fixtures.ts'

describe('reading a chart’s cells', () => {
  it('leaves gaps for blanks, text and errors in a series, and reads numbers written as text', () => {
    const cells = grid([
      ['Month', 'Sales'],
      ['Jan', 120],
      ['Feb', null],
      ['Mar', 'n/a'],
      ['Apr', '1,250.5'],
      ['May', '#DIV/0!'],
      ['Jun', '12%'],
      ['Jul', true]
    ])
    const values = chartValues(specOf('column', [{ name: { cell: column(1, 0, 0) }, values: column(1, 1, 7), categories: column(0, 1, 7) }]), readerOf(cells))

    expect(values.categories).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'])
    expect(values.series).toEqual([{ name: 'Sales', values: [120, null, null, 1250.5, null, 0.12, null] }])
    expect(values.dates).toBe(false)
  })

  it('keeps dates as the cells show them and says they are dates', () => {
    const cells = grid([
      [date(45292, '1 Jan'), 3],
      [date(45293, '2 Jan'), 5],
      [date(45294, '3 Jan'), cell(4.5, '0.0')]
    ])
    const values = chartValues(specOf('line', [{ values: column(1, 0, 2), categories: column(0, 0, 2) }]), readerOf(cells))

    expect(values.categories).toEqual(['1 Jan', '2 Jan', '3 Jan'])
    expect(values.x).toEqual([45292, 45293, 45294])
    expect(values.xFormat).toBe('yyyy-mm-dd')
    expect(values.dates).toBe(true)
    expect(values.series[0]).toEqual({ name: 'Series 1', values: [3, 5, 4.5], format: '0.0' })
  })

  it('leaves out the rows hidden on the sheet, in every series and the categories', () => {
    const cells = grid([
      ['A', 1, 10],
      ['B', 2, 20],
      ['C', 3, 30]
    ])
    cells[1] = cells[1].map((entry) => ({ ...entry, hidden: true }))
    const values = chartValues(specOf('column', [{ values: column(1, 0, 2), categories: column(0, 0, 2) }, { values: column(2, 0, 2), categories: column(0, 0, 2) }]), readerOf(cells))

    expect(values.categories).toEqual(['A', 'C'])
    expect(values.series.map((series) => series.values)).toEqual([
      [1, 3],
      [10, 30]
    ])
  })

  it('numbers the categories when there are none, names series by their place, and reads a sheet that is gone as empty', () => {
    const cells = grid([[5], [6], [7]])
    const values = chartValues(specOf('column', [{ values: column(0, 0, 2), name: { text: ' Visits ' } }, { values: column(0, 0, 2, 'gone') }]), readerOf(cells))

    expect(values.categories).toEqual(['1', '2', '3'])
    expect(values.x).toEqual([1, 2, 3])
    expect(values.series.map((series) => series.name)).toEqual(['Visits', 'Series 2'])
    expect(values.series[1].values).toEqual([null, null, null])
    expect(hasNumbers(values)).toBe(true)
    expect(hasNumbers(chartValues(specOf('column', []), readerOf(cells)))).toBe(false)
  })

  it('reads numbers from cells', () => {
    expect([cell(3), cell('-2.5'), cell(' 7 '), cell('1,234,567'), cell('5%'), cell(''), cell('12 apples'), cell(Number.NaN), cell(false), undefined].map(numberOf)).toEqual([3, -2.5, 7, 1234567, 0.05, null, null, null, null, null])
  })
})
