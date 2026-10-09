import { describe, expect, it } from 'vitest'
import { CELL_TYPE, newSheet, newWorkbook, type WorkbookSnapshot } from '../../../../shared/office/workbook.ts'
import { withHeadlessSheets } from './headless.ts'
import { addSheet, cellFor, checkSheetName, describeWorkbook, filterRange, formatSteps, freeze, parseTarget, readRange, removeSheet, renameSheet, type SheetsTarget, setFormat, settled, sortRange, valuesGrid, writeRange } from './model.ts'

function budget(): WorkbookSnapshot {
  const sheet = newSheet('s1', 'Budget', {
    0: { 0: { v: 'Item', t: CELL_TYPE.string }, 1: { v: 'Cost', t: CELL_TYPE.string }, 2: { v: 'Paid', t: CELL_TYPE.string } },
    1: { 0: { v: 'Rent', t: CELL_TYPE.string }, 1: { v: 1200, t: CELL_TYPE.number, s: 'money' }, 2: { v: 1, t: CELL_TYPE.boolean } },
    2: { 0: { v: 'Food', t: CELL_TYPE.string }, 1: { v: 310.5, t: CELL_TYPE.number, s: 'money' }, 2: { v: 0, t: CELL_TYPE.boolean } },
    3: { 0: { v: 'Bus', t: CELL_TYPE.string }, 1: { v: 60, t: CELL_TYPE.number, s: 'money' }, 2: { v: 1, t: CELL_TYPE.boolean } },
    4: { 0: { v: 'Total', t: CELL_TYPE.string }, 1: { f: '=SUM(B2:B4)', v: 1570.5, t: CELL_TYPE.number } }
  })

  return { ...newWorkbook('book', 'Budget', [sheet, newSheet('s2', 'Notes')]), styles: { money: { n: { pattern: '#,##0.00' } } } }
}

/** JSON with object keys in order, so equal snapshots compare equal however Univer orders their keys. */
const stable = (value: unknown): string => JSON.stringify(value, (_key, entry) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry))

/** Run `change` on the budget headlessly; give back the workbook after it, and whether one undo put it back. */
async function changeAndUndo<T>(change: (target: SheetsTarget) => Promise<T>) {
  return withHeadlessSheets(budget(), async ({ univer, workbook }) => {
    const before = workbook.save()
    const result = await change({ univer, workbook })
    const after = workbook.save()
    workbook.undo()
    const undone = workbook.save()

    return { result, after, undone: stable(undone.sheets) === stable(before.sheets) && stable(undone.sheetOrder) === stable(before.sheetOrder) }
  })
}

describe('reading', () => {
  it('reads the text of a cell Univer keeps as rich text alone, as it keeps text typed into a formatted cell', async () => {
    const p = { id: 'cell', documentStyle: {}, body: { dataStream: 'Typed in Herald\r\n', textRuns: [{ st: 0, ed: 1, ts: { cl: { rgb: '#0c1431' } } }, { st: 1, ed: 15, ts: { ff: 'Calibri' } }], paragraphs: [{ startIndex: 15 }] } }
    const book = newWorkbook('rich', 'Rich', [newSheet('s', 'Rich', { 0: { 0: { v: null, p } } })])
    const { result } = await withHeadlessSheets(book, ({ univer, workbook }) => readRange({ univer, workbook }, { range: 'A1' }))

    expect(result.values).toEqual([['Typed in Herald']])
  })

  it('reads values, formulas and what cells show', async () => {
    const { result } = await withHeadlessSheets(budget(), ({ univer, workbook }) => readRange({ univer, workbook }, { range: 'A2:C3' }))

    expect(result).toEqual({
      sheet: 'Budget',
      range: 'A2:C3',
      values: [['Rent', 1200, true], ['Food', 310.5, false]],
      formulas: [[null, null, null], [null, null, null]],
      text: [['Rent', '1,200.00', 'TRUE'], ['Food', '310.50', 'FALSE']]
    })
  })

  it('describes the sheets', async () => {
    const { result } = await withHeadlessSheets(budget(), ({ univer, workbook }) => describeWorkbook({ univer, workbook }))

    expect(result).toEqual({ active: 'Budget', sheets: [{ name: 'Budget', rows: 5, columns: 3, hidden: false, frozen: { rows: 0, columns: 0 } }, { name: 'Notes', rows: 0, columns: 0, hidden: false, frozen: { rows: 0, columns: 0 } }] })
  })
})

describe('changes, each one step to undo', () => {
  it('writes values and formulas from a cell, and works the formulas out', async () => {
    const { result } = await changeAndUndo(async (target) => {
      const written = await writeRange(target, { range: 'D1', values: [['Share'], ['=B2/B5'], [null]] })
      await settled(target)

      return { written, read: readRange(target, { range: 'D1:D2' }) }
    })

    expect(result.result.written).toEqual({ sheet: 'Budget', range: 'D1:D3', cells: 3 })
    expect(result.result.read.formulas).toEqual([[null], ['=B2/B5']])
    expect(result.result.read.values[1][0]).toBeCloseTo(0.7641, 3)
    expect(result.undone).toBe(true)
  })

  it('fills a whole range with one value, and grows the sheet for what does not fit', async () => {
    const { result } = await changeAndUndo(async (target) => {
      await writeRange(target, { range: 'A2:B3', values: [[0]] })
      await writeRange(target, { range: 'A1002', values: [['far down']] })

      return readRange(target, { range: 'A2:B3' })
    })

    expect(result.result.values).toEqual([[0, 0], [0, 0]])
    expect(result.after.sheets.s1.rowCount).toBeGreaterThanOrEqual(1002)
  })

  it('formats a range: number format, font, fill and borders together', async () => {
    const { result } = await changeAndUndo(async (target) => {
      const done = await setFormat(target, { range: 'A1:C1', format: { bold: true, background: '#fff3bf', border: { edges: 'bottom', style: 'medium' }, align: 'center' } })

      return { done, text: readRange(target, { range: 'B2' }).text }
    })
    const header = result.after.sheets.s1.cellData![0][0]
    const style = typeof header.s === 'string' ? result.after.styles[header.s] : header.s

    expect(result.result.done.changes).toEqual(['bold', 'fill #fff3bf', 'aligned center', 'medium borders (bottom)'])
    expect(style).toMatchObject({ bl: 1, ht: 2, bd: { b: { s: 8 } } })
    expect(JSON.stringify(style)).toContain('fff3bf')
    expect(result.undone).toBe(true)
  })

  it('adds, renames and removes sheets', async () => {
    const added = await changeAndUndo((target) => addSheet(target, { name: 'March', index: 1 }))
    const renamed = await changeAndUndo((target) => renameSheet(target, { sheet: 'notes', name: 'Ideas' }))
    const removed = await changeAndUndo((target) => removeSheet(target, { sheet: 'Notes' }))

    expect(added.result.result).toEqual({ sheet: 'March', index: 1 })
    expect(added.result.after.sheetOrder.map((id) => added.result.after.sheets[id].name)).toEqual(['Budget', 'March', 'Notes'])
    expect(renamed.result.result).toEqual({ from: 'Notes', to: 'Ideas' })
    expect(removed.result.after.sheetOrder).toEqual(['s1'])
    expect([added.result.undone, renamed.result.undone, removed.result.undone]).toEqual([true, true, true])
  })

  it('sorts under a header by a column named by its header', async () => {
    const { result } = await changeAndUndo(async (target) => {
      const sorted = await sortRange(target, { range: 'A1:C4', by: 'Cost', header: true, ascending: false })

      return { sorted, read: readRange(target, { range: 'A1:A4' }).values }
    })

    expect(result.result.sorted).toEqual({ sheet: 'Budget', range: 'A2:C4', column: 'B', ascending: false })
    expect(result.result.read).toEqual([['Item'], ['Rent'], ['Food'], ['Bus']])
    expect(result.undone).toBe(true)
  })

  it('sorts a range that does not start in column A by the column named', async () => {
    const { result } = await withHeadlessSheets(budget(), async ({ univer, workbook }) => {
      await sortRange({ univer, workbook }, { range: 'B1:C4', by: 'Cost', header: true })

      return readRange({ univer, workbook }, { range: 'B2:B4' }).values
    })

    expect(result).toEqual([[60], [310.5], [1200]])
  })

  it('filters by values and by a condition, and clears the filter', async () => {
    const byValue = await changeAndUndo((target) => filterRange(target, { range: 'A1:C4', by: 'Item', values: ['Rent', 'Bus'] }))
    const byCondition = await changeAndUndo((target) => filterRange(target, { range: 'A1:C4', by: 'B', condition: { operator: 'lessThan', value: 500 } }))
    const cleared = await withHeadlessSheets(budget(), async ({ univer, workbook }) => {
      await filterRange({ univer, workbook }, { range: 'A1:C4', by: 'A', values: ['Rent'] })
      await filterRange({ univer, workbook }, { clear: true })

      return workbook.getActiveSheet().getFilter()
    })

    expect(byValue.result.result).toEqual({ sheet: 'Budget', range: 'A1:C4', column: 'A', hidden: 1 })
    expect(byCondition.result.result.hidden).toBe(1)
    expect([byValue.result.undone, byCondition.result.undone]).toEqual([true, true])
    expect(cleared.result).toBeNull()
  })

  it('freezes rows and columns, and unfreezes', async () => {
    const frozen = await changeAndUndo((target) => freeze(target, { rows: 1, columns: 1 }))

    expect(frozen.result.after.sheets.s1.freeze).toEqual({ xSplit: 1, ySplit: 1, startRow: 1, startColumn: 1 })
    expect(frozen.result.undone).toBe(true)
  })
})

describe('arguments', () => {
  it('reads ranges with and without sheets, and says what a range is', () => {
    expect(parseTarget("'Q1 sales'!B2:D5")).toEqual({ sheet: 'Q1 sales', range: { startRow: 1, startColumn: 1, endRow: 4, endColumn: 3 } })
    expect(() => parseTarget('nowhere')).toThrow(/is not a range/)
  })

  it('checks sheet names as Excel does', () => {
    expect(checkSheetName(' Q2 ', ['Budget'])).toBe('Q2')
    expect(() => checkSheetName('a/b', [])).toThrow(/cannot name a sheet/)
    expect(() => checkSheetName('budget', ['Budget'])).toThrow(/already/)
    expect(checkSheetName('Budget', ['Budget'], 'Budget')).toBe('Budget')
  })

  it('turns values into cells, and checks their shape', () => {
    expect(cellFor('=A1*2')).toMatchObject({ f: '=A1*2' })
    expect(cellFor('=')).toMatchObject({ v: '=', t: 1 })
    expect(cellFor(true)).toMatchObject({ v: 1, t: 3 })
    expect(cellFor(null)).toEqual({ v: null, f: null, si: null, p: null })
    expect(valuesGrid([1, 2], { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }, false)).toEqual([[1, 2]])
    expect(() => valuesGrid([[1, 2]], { startRow: 0, startColumn: 0, endRow: 2, endColumn: 0 }, true)).toThrow(/3 by 1 cells but the values are 1 by 2/)
  })

  it('checks formats and says what they have', () => {
    expect(formatSteps({ numberFormat: '0%', italic: false }).map((step) => step.label)).toEqual(['number format 0%', 'not italic'])
    expect(() => formatSteps({ colour: 'red' })).toThrow(/do not have colour/)
    expect(() => formatSteps({ color: 'red' })).toThrow(/is a colour like/)
    expect(() => formatSteps({})).toThrow(/changes nothing/)
  })
})
