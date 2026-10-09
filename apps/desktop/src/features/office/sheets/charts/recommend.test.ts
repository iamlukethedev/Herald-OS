import { describe, expect, it } from 'vitest'
import { cell, date, grid } from './fixtures.ts'
import { layoutOf, recommend } from './recommend.ts'

const origin = (rows: number, columns: number, startRow = 0, startColumn = 0) => ({ startRow, startColumn, endRow: startRow + rows - 1, endColumn: startColumn + columns - 1 })
const kinds = (rows: unknown[][]) => recommend(grid(rows)).map((entry) => (entry.stacking ? `${entry.kind} ${entry.stacking}` : entry.kind))

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']

describe('laying out a selection', () => {
  it('takes series from columns under a header row, with text in the first column as categories', () => {
    const block = grid([['Month', 'Sales', 'Costs'], ...MONTHS.map((month, i) => [month, 100 + i, 80 + i])])

    expect(layoutOf(block, origin(7, 3, 1, 1))).toEqual({
      byColumns: true,
      categories: { startRow: 2, endRow: 7, startColumn: 1, endColumn: 1 },
      series: [
        { values: { startRow: 2, endRow: 7, startColumn: 2, endColumn: 2 }, name: { startRow: 1, endRow: 1, startColumn: 2, endColumn: 2 } },
        { values: { startRow: 2, endRow: 7, startColumn: 3, endColumn: 3 }, name: { startRow: 1, endRow: 1, startColumn: 3, endColumn: 3 } }
      ]
    })
  })

  it('takes series from rows when the block is wider than it is tall, with years over the columns as categories', () => {
    const block = grid([
      ['Region', 2023, 2024, 2025],
      ['North', 10, 12, 15],
      ['South', 8, 9, 11]
    ])

    expect(layoutOf(block, origin(3, 4))).toEqual({
      byColumns: false,
      categories: { startRow: 0, endRow: 0, startColumn: 1, endColumn: 3 },
      series: [
        { values: { startRow: 1, endRow: 1, startColumn: 1, endColumn: 3 }, name: { startRow: 1, endRow: 1, startColumn: 0, endColumn: 0 } },
        { values: { startRow: 2, endRow: 2, startColumn: 1, endColumn: 3 }, name: { startRow: 2, endRow: 2, startColumn: 0, endColumn: 0 } }
      ]
    })
  })

  it('reads years over columns of numbers as their names, and a column of years as the categories', () => {
    const byYear = grid([
      ['Product', 2023, 2024],
      ['Tea', 10, 12],
      ['Cake', 8, 9],
      ['Soup', 4, 6]
    ])
    const years = grid([
      [2021, 300],
      [2022, 340],
      [2023, 390]
    ])

    expect(layoutOf(byYear, origin(4, 3)).series.map((series) => series.name)).toEqual([
      { startRow: 0, endRow: 0, startColumn: 1, endColumn: 1 },
      { startRow: 0, endRow: 0, startColumn: 2, endColumn: 2 }
    ])
    expect(layoutOf(years, origin(3, 2))).toEqual({ byColumns: true, categories: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 0 }, series: [{ values: { startRow: 0, endRow: 2, startColumn: 1, endColumn: 1 } }] })
  })

  it('gives a scatter chart its x values from the first column of numbers, and every other chart a series from it', () => {
    const block = grid([
      ['Height', 'Weight'],
      [160, 55],
      [172, 70],
      [181, 82]
    ])

    expect(layoutOf(block, origin(4, 2), 'scatter')).toEqual({
      byColumns: true,
      categories: { startRow: 1, endRow: 3, startColumn: 0, endColumn: 0 },
      series: [{ values: { startRow: 1, endRow: 3, startColumn: 1, endColumn: 1 }, name: { startRow: 0, endRow: 0, startColumn: 1, endColumn: 1 } }]
    })
    expect(layoutOf(block, origin(4, 2), 'column').series).toHaveLength(2)
  })

  it('reads one column of numbers under its name as one series without categories', () => {
    expect(layoutOf(grid([['Visits'], [5], [7]]), origin(3, 1))).toEqual({ byColumns: true, series: [{ values: { startRow: 1, endRow: 2, startColumn: 0, endColumn: 0 }, name: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } }] })
  })
})

describe('recommending charts', () => {
  it('puts columns first for one series by category, then bars, a pie and a line', () => {
    expect(kinds([['Month', 'Sales'], ...MONTHS.map((month, i) => [month, 100 + i * 7])])).toEqual(['column', 'bar', 'pie', 'line'])
  })

  it('puts a pie first for shares of a whole', () => {
    expect(kinds([['Channel', 'Share'], ['Shop', 45], ['Online', 35], ['Phone', 20]]).slice(0, 2)).toEqual(['pie', 'doughnut'])
    expect(kinds([['Channel', 'Share'], ['Shop', cell(0.6, '0%')], ['Online', cell(0.3, '0%')]])[0]).toBe('pie')
  })

  it('puts a line first for dates', () => {
    expect(kinds([['Day', 'Visits'], [date(45292, '1 Jan'), 3], [date(45293, '2 Jan'), 5], [date(45294, '3 Jan'), 4]])[0]).toBe('line')
  })

  it('offers columns, lines and stacking for several series', () => {
    expect(kinds([['Month', 'North', 'South'], ...MONTHS.map((month, i) => [month, 10 + i, 12 + i])])).toEqual(['column', 'line', 'column stacked', 'area stacked', 'bar'])
  })

  it('puts a combo with a second axis first for series on very different scales', () => {
    const rows = [['Month', 'Revenue', 'Margin'], ...MONTHS.map((month, i) => [month, 12000 + i * 900, cell(0.2 + i / 100, '0%')])]

    expect(recommend(grid(rows))[0]).toEqual({ kind: 'combo', reason: expect.stringContaining('different scales') })
  })

  it('puts a scatter chart first for two columns of numbers', () => {
    expect(kinds([['Height', 'Weight'], [160, 55], [172, 70], [181, 82]])[0]).toBe('scatter')
  })

  it('puts bars first for long category names, and a line for many points', () => {
    expect(kinds([['Team', 'Score'], ['Customer support and success', 7], ['Research and development', 9], ['Facilities and maintenance', 6]])[0]).toBe('bar')
    expect(kinds([['Day', 'Steps'], ...Array.from({ length: 30 }, (_, i) => [`Day ${i + 1}`, 4000 + i * 50])])[0]).toBe('line')
  })

  it('recommends nothing for cells without numbers', () => {
    expect(recommend(grid([['Name', 'Town'], ['Ada', 'Bath']]))).toEqual([])
    expect(recommend([])).toEqual([])
  })
})
