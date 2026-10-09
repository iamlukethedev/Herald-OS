import { describe, expect, it } from 'vitest'
import { CELL_TYPE, type CellMatrix, newSheet, newWorkbook } from '../../../../../shared/office/workbook.ts'
import { withHeadlessSheets } from '../headless.ts'
import { column, specOf } from './fixtures.ts'
import { describeChart, insertChart } from './model.ts'
import { specAfter, trackChartRanges } from './track.ts'

const rows = (startRow: number, endRow: number) => ({ id: 'sheet.command.insert-row', params: { unitId: 'book', subUnitId: 's1', range: { startRow, endRow, startColumn: 0, endColumn: 25 }, direction: 'up' } })
const SPEC = specOf('column', [{ values: column(1, 1, 6), name: { cell: column(1, 0, 0) }, categories: column(0, 1, 6) }, { values: column(2, 1, 6, 's2') }])

describe('a chart’s ranges as rows and columns move', () => {
  it('stretches a range when rows go in inside it, and leaves ranges on other sheets', () => {
    const after = specAfter(SPEC, rows(3, 4), 's1')

    expect(after.series[0]).toEqual({ values: column(1, 1, 8), name: { cell: column(1, 0, 0) }, categories: column(0, 1, 8) })
    expect(after.series[1]).toEqual(SPEC.series[1])
  })

  it('moves ranges along when columns go in before them', () => {
    const after = specAfter(SPEC, { id: 'sheet.command.insert-col', params: { unitId: 'book', subUnitId: 's1', range: { startRow: 0, endRow: 999, startColumn: 0, endColumn: 0 }, direction: 'left' } }, 's1')

    expect(after.series[0].values).toEqual({ sheet: 's1', startRow: 1, endRow: 6, startColumn: 2, endColumn: 2 })
    expect(after.series[0].categories).toEqual({ sheet: 's1', startRow: 1, endRow: 6, startColumn: 1, endColumn: 1 })
  })

  it('shrinks a range when some of its rows go, and drops a series whose cells all go', () => {
    const remove = (startRow: number, endRow: number) => ({ id: 'sheet.command.remove-row', params: { unitId: 'book', subUnitId: 's1', range: { startRow, endRow, startColumn: 0, endColumn: 25 } } })

    expect(specAfter(SPEC, remove(2, 3), 's1').series[0].values).toEqual(column(1, 1, 4))
    expect(specAfter(SPEC, remove(0, 9), 's1').series).toEqual([SPEC.series[1]])
  })

  it('gives the same spec back when nothing it reads moves', () => {
    expect(specAfter(SPEC, rows(20, 21), 's1')).toBe(SPEC)
    expect(specAfter(SPEC, { id: 'sheet.command.set-range-values', params: {} }, 's1')).toBe(SPEC)
  })

  it('moves a chart’s ranges in the same step to undo as the rows inserted', async () => {
    const data: CellMatrix = Object.fromEntries([['Month', 'Sales'], ...['Jan', 'Feb', 'Mar', 'Apr'].map((month, i) => [month, 10 + i])].map((row, r) => [r, Object.fromEntries(row.map((value, c) => [c, typeof value === 'number' ? { v: value, t: CELL_TYPE.number } : { v: value, t: CELL_TYPE.string }]))]))
    const { result } = await withHeadlessSheets(newWorkbook('book', 'Book', [newSheet('s1', 'Sales', data)]), async ({ univer, workbook }) => {
      const target = { univer, workbook }
      trackChartRanges(univer)
      const { chart } = await insertChart(target, { range: 'A1:B5' })
      workbook.getActiveSheet().insertRowsBefore(2, 2)
      const moved = describeChart(target, { chart }).series[0]
      workbook.undo()
      const back = describeChart(target, { chart }).series[0]

      return { moved, back }
    })

    expect(result.moved).toMatchObject({ values: 'Sales!B2:B7', categories: 'Sales!A2:A7' })
    expect(result.back).toMatchObject({ values: 'Sales!B2:B5', categories: 'Sales!A2:A5' })
  })
})
