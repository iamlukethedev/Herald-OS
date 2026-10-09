import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { workbookFromXlsx } from '../../../../../shared/office/xlsx/read.ts'
import { xlsxFromWorkbook } from '../../../../../shared/office/xlsx/write.ts'
import { withHeadlessSheets } from '../headless.ts'
import { type CellInput, readRange, type SheetsTarget, settled, writeRange } from '../model.ts'
import { changeAndUndo, SALES, salesBook, stable, type Value } from './fixtures.ts'
import { labelKey, listSummaries, refreshSummary, type SummaryFunction, summarize, summarySource } from './summary.ts'

const REGION = 0
const PRODUCT = 1
const QUARTER = 2
const AMOUNT = 3

/** What a summary cell should hold, worked out in plain code from the rows it takes in. */
function expected(rows: Value[][], fn: SummaryFunction, keep: (row: Value[]) => boolean): number | '' {
  const amounts = rows.filter(keep).map((row) => row[AMOUNT]).filter((value): value is number => typeof value === 'number')

  if (fn === 'count') {
    return amounts.length
  }

  if (!amounts.length) {
    return ''
  }

  const sum = amounts.reduce((total, value) => total + value, 0)

  return fn === 'sum' ? sum : fn === 'average' ? sum / amounts.length : fn === 'min' ? Math.min(...amounts) : Math.max(...amounts)
}

const is = (column: number, label: Value) => (row: Value[]) => labelKey(row[column] as CellInput) === labelKey(label as CellInput)
const both = (...tests: ((row: Value[]) => boolean)[]) => (row: Value[]) => tests.every((test) => test(row))
const any = () => true

/** Make a summary, work its formulas out, and read it. */
async function summaryOf(target: SheetsTarget, args: Parameters<typeof summarize>[1]) {
  const made = await summarize(target, args)
  await settled(target)

  return { made, read: readRange(target, { range: made.range, sheet: made.sheet }) }
}

const FUNCTIONS: SummaryFunction[] = ['sum', 'count', 'average', 'min', 'max']

describe('summaries', () => {
  it('works out sum, count, average, min and max by row label, with live formulas over whole columns', async () => {
    const result = await changeAndUndo(salesBook(), (target) => summaryOf(target, { source: 'B3', rows: ['Region'], values: FUNCTIONS.map((fn) => ({ field: 'Amount', fn })) }))
    const { made, read } = result.value
    const labels = ['East', 'North', 'West', null]

    expect(made).toMatchObject({ preview: false, sheet: 'Summary', newSheet: true, range: 'A1:F6', source: 'Sales!A1:D11', rows: 4, columns: 0, values: ['Sum of Amount', 'Count of Amount', 'Average of Amount', 'Min of Amount', 'Max of Amount'] })
    expect(read.values[0]).toEqual(['Region', 'Sum of Amount', 'Count of Amount', 'Average of Amount', 'Min of Amount', 'Max of Amount'])
    expect(read.values.map((row) => row[0])).toEqual(['Region', 'East', 'North', 'West', '(blank)', 'Grand total'])
    labels.forEach((label, index) => FUNCTIONS.forEach((fn, j) => expect(read.values[index + 1][j + 1], `${label} ${fn}`).toBeCloseTo(expected(SALES, fn, is(REGION, label)) as number, 9)))
    FUNCTIONS.forEach((fn, j) => expect(read.values[5][j + 1], `total ${fn}`).toBeCloseTo(expected(SALES, fn, any) as number, 9))
    expect(read.formulas[1][1]).toBe('=SUMIFS(Sales!$D:$D,Sales!$A:$A,$A2)')
    expect(read.formulas[4][1]).toBe('=SUMIFS(Sales!$D:$D,Sales!$A:$A,"")')
    expect(read.formulas[1][2]).toBe('=COUNTIFS(Sales!$D:$D,"<>",Sales!$A:$A,$A2)')
    expect(read.formulas[1][4]).toBe('=IF(COUNTIFS(Sales!$A:$A,$A2)=0,"",MINIFS(Sales!$D:$D,Sales!$A:$A,$A2))')
    expect(read.formulas[5].slice(1)).toEqual(['=SUM(Sales!$D:$D)', '=SUM(C2:C5)', '=AVERAGE(Sales!$D:$D)', '=MIN(Sales!$D:$D)', '=MAX(Sales!$D:$D)'])
    expect(read.text[1].slice(1, 3)).toEqual(['290.50', '4'])
    expect(result.after.sheetOrder).toEqual(['sales', expect.any(String), 'notes'])
    expect(result.undone).toBe(true)
  })

  it('puts column labels across, with grand totals both ways', async () => {
    const { result } = await withHeadlessSheets(salesBook(), (target) => summaryOf(target, { source: 'A1:D11', rows: ['Region'], columns: ['Quarter'], values: [{ field: 'Amount', fn: 'sum' }] }))
    const { read } = result

    expect(read.values.slice(0, 2)).toEqual([['Quarter', 'Q1', 'Q2', 'Grand total'], ['Region', 'Sum of Amount', 'Sum of Amount', 'Sum of Amount']])

    for (const [index, label] of ['East', 'North', 'West', null].entries()) {
      const sums = [both(is(REGION, label), is(QUARTER, 'Q1')), both(is(REGION, label), is(QUARTER, 'Q2')), is(REGION, label)].map((keep) => expected(SALES, 'sum', keep) || 0)
      expect(read.values[index + 2].slice(1), String(label)).toEqual(sums)
    }

    expect(read.values[6]).toEqual(['Grand total', expected(SALES, 'sum', is(QUARTER, 'Q1')), expected(SALES, 'sum', is(QUARTER, 'Q2')), expected(SALES, 'sum', any)])
    expect(read.formulas[2][1]).toBe('=SUMIFS(Sales!$D:$D,Sales!$A:$A,$A3,Sales!$C:$C,B$1)')
  })

  it('shows nothing for a min or average where no rows fall, and counts per column label', async () => {
    const { result } = await withHeadlessSheets(salesBook(), (target) => summaryOf(target, { source: 'A1', rows: ['Product'], columns: ['Region'], values: [{ field: 'Amount', fn: 'min' }, { field: 'Amount', fn: 'count' }] }))
    const { read } = result
    const regions = ['East', 'North', 'West', null]

    expect(read.values[0]).toEqual(['Region', 'East', 'East', 'North', 'North', 'West', 'West', '(blank)', '(blank)', 'Grand total', 'Grand total'])
    expect(read.values.slice(2).map((row) => row[0])).toEqual(['Apples', 'Mixed*', 'Pears', 'Grand total'])

    for (const [index, product] of ['Apples', 'Mixed*', 'Pears'].entries()) {
      regions.forEach((region, j) => {
        const keep = both(is(PRODUCT, product), is(REGION, region))
        // An empty result reads back as an empty cell.
        expect(read.values[index + 2][1 + j * 2], `${product} ${region} min`).toEqual(expected(SALES, 'min', keep) === '' ? null : expected(SALES, 'min', keep))
        expect(read.values[index + 2][2 + j * 2], `${product} ${region} count`).toEqual(expected(SALES, 'count', keep))
      })
    }

    expect(read.values[5].slice(-2)).toEqual([expected(SALES, 'min', any), expected(SALES, 'count', any)])
  })

  it('keeps the values filters name, one matched and several by leaving the others out, wildcards and empty values read as themselves', async () => {
    const rows = [...SALES, ['East', 'Mixed nuts', 'Q1', 5]]
    const { result } = await withHeadlessSheets(salesBook(rows), async (target) => ({
      kept: await summaryOf(target, { source: 'A1', rows: ['Region'], values: ['Amount'], filters: [{ field: 'Product', values: ['apples', 'Pears', 'Mixed*'] }], destination: 'new' }),
      one: await summaryOf(target, { source: 'Sales!A1', rows: ['Product'], values: ['Amount'], filters: [{ field: 'Quarter', values: ['Q1'] }] }),
      blank: await summaryOf(target, { source: 'Sales!A1', rows: ['Product'], values: ['Amount'], filters: [{ field: 'Region', values: ['(blank)'] }] })
    }))
    const kept = both((row) => ['apples', 'pears', 'mixed*'].includes(String(row[PRODUCT]).toLowerCase()))

    expect(result.kept.read.values.map((row) => row[1])).toEqual(['Sum of Amount', ...['East', 'North', 'West', null].map((region) => expected(rows, 'sum', both(kept, is(REGION, region)))), expected(rows, 'sum', kept)])
    expect(result.kept.read.formulas[1][1]).toBe('=SUMIFS(Sales!$D:$D,Sales!$A:$A,$A2,Sales!$B:$B,"<>Mixed nuts")')
    expect(result.one.read.values.slice(1).map((row) => row[0])).toEqual(['Apples', 'Mixed nuts', 'Mixed*', 'Pears', 'Grand total'])
    expect(result.one.read.values.slice(1).map((row) => row[1])).toEqual([...['Apples', 'Mixed nuts', 'Mixed*', 'Pears'].map((product) => expected(rows, 'sum', both(is(PRODUCT, product), is(QUARTER, 'Q1')))), expected(rows, 'sum', is(QUARTER, 'Q1'))])
    expect(result.one.read.formulas[3][1]).toBe('=SUMIFS(Sales!$D:$D,Sales!$B:$B,"=Mixed~*",Sales!$C:$C,"Q1")')
    expect(result.blank.read.values).toEqual([['Product', 'Sum of Amount'], ['Pears', 30], ['Grand total', 30]])
  })

  it('previews its shape without changing anything', async () => {
    const result = await changeAndUndo(salesBook(), (target) => summarize(target, { source: 'A1', rows: ['Region', 'Product'], values: ['Amount'], preview: true }))

    expect(result.value).toMatchObject({ preview: true, sheet: 'Summary', newSheet: true, range: 'A1:C10', rows: 8, headers: ['Region', 'Product', 'Sum of Amount'], labels: [['East', 'Apples'], ['East', 'Mixed*'], ['East', 'Pears'], ['North', 'Apples'], ['North', 'Pears']] })
    expect(result.unchanged).toBe(true)
  })

  it('goes beside its table, an empty column between, and says what to give instead', async () => {
    await withHeadlessSheets(salesBook(), async (target) => {
      const beside = await summaryOf(target, { source: 'A1', rows: ['Region'], values: ['Amount'], destination: { cell: 'F2' } })

      expect(beside.made).toMatchObject({ sheet: 'Sales', range: 'F2:G7' })
      expect(beside.read.formulas[1][1]).toBe('=SUMIFS($D:$D,$A:$A,$F3)')
      await expect(summarize(target, { source: 'A1', rows: ['Region'], values: ['Amount'], destination: { cell: 'E1' } })).rejects.toThrow(/an empty one between it and the table \(from F1\)/)
      await expect(summarize(target, { source: 'A1', rows: ['Region'], values: ['Amount'], destination: { sheet: 'Sales', cell: 'G5' } })).rejects.toThrow(/needs G5:H10 on Sales, which has data/)
      await expect(summarize(target, { source: 'A1', rows: [], values: ['Amount'] })).rejects.toThrow(/rows is a list of columns, like \["Region"\]/)
      await expect(summarize(target, { source: 'A1', rows: ['Area'], values: ['Amount'] })).rejects.toThrow(/“Area” is not a column of A1:D11; its columns are Region, Product, Quarter, Amount/)
      await expect(summarize(target, { source: 'A1', rows: ['Region'], values: [{ field: 'Amount', fn: 'median' }] })).rejects.toThrow(/fn is sum, count, average, min, max/)
      await expect(summarize(target, { source: 'A1', rows: ['Region'], columns: ['region'], values: ['Amount'] })).rejects.toThrow(/once in rows and columns/)
      await expect(summarize(target, { source: 'A1', rows: ['Region'], values: ['Amount'], filters: [{ field: 'Product', values: ['Kiwis'] }] })).rejects.toThrow(/Product has no value “Kiwis”; its values include Apples, Pears, Mixed\*/)
      await expect(summarize(target, { source: 'A1', rows: ['Region'], values: ['Amount'], destination: 42 })).rejects.toThrow(/destination is/)
    })
  })

  it('counts new rows with known labels at once, and takes in new labels when refreshed', async () => {
    await withHeadlessSheets(salesBook(), async (target) => {
      const { made } = await summaryOf(target, { source: 'A1', rows: ['Region'], values: ['Amount', { field: 'Product', fn: 'count' }] })
      const added: Value[][] = [['East', 'Apples', 'Q3', 100], ['South', 'Pears', 'Q3', 40], ['South', 'Apples', 'Q3', 2.5]]
      await writeRange(target, { range: 'A12', sheet: 'Sales', values: added })
      await settled(target)
      const live = readRange(target, { range: made.range, sheet: 'Summary' }).values
      const rows = [...SALES, ...added]

      expect(live[1]).toEqual(['East', expected(rows, 'sum', is(REGION, 'East')), 5])
      expect(live.map((row) => row[0])).not.toContain('South')

      const refreshed = await refreshSummary(target, { sheet: 'Summary' })
      await settled(target)
      const read = readRange(target, { range: refreshed.summaries[0].range, sheet: 'Summary' }).values

      expect(refreshed.summaries[0]).toMatchObject({ range: 'A1:C7', source: 'Sales!A1:D14', rows: 5, before: 4 })
      expect(read.map((row) => row[0])).toEqual(['Region', 'East', 'North', 'South', 'West', '(blank)', 'Grand total'])
      expect(read[3]).toEqual(['South', 42.5, 2])
      expect(read[6]).toEqual(['Grand total', expected(rows, 'sum', any), rows.length])
      expect(listSummaries(target, { sheet: 'Summary' }).summaries).toEqual([{ id: 'summary-1', range: 'A1:C7', source: 'Sales!A1:D14', rows: ['Region'], columns: [], values: ['Sum of Amount', 'Count of Product'], filters: [] }])
    })
  })

  it('refreshes in one step to undo, shrinking when rows go, and beside its table without reaching into itself', async () => {
    const { result } = await withHeadlessSheets(salesBook(), async (target) => {
      await summarize(target, { source: 'A1', rows: ['Region'], values: ['Amount'], destination: 'Sales!F1' })
      await writeRange(target, { range: 'A12', sheet: 'Sales', values: [['South', 'Pears', 'Q3', 40]] })
      await settled(target)
      const before = target.workbook.save()
      const refreshed = await refreshSummary(target, { sheet: 'Sales', summary: 'G3' })
      await settled(target)
      const after = readRange(target, { range: 'F1:G7', sheet: 'Sales' }).values
      target.workbook.undo()
      await settled(target)

      return { refreshed, after, undone: stable(target.workbook.save().sheets) === stable(before.sheets) }
    })

    expect(result.refreshed.summaries[0]).toMatchObject({ range: 'F1:G7', source: 'Sales!A1:D12', rows: 5 })
    expect(result.after.map((row) => row[0])).toEqual(['Region', 'East', 'North', 'South', 'West', '(blank)', 'Grand total'])
    expect(result.undone).toBe(true)

    await withHeadlessSheets(salesBook(), async (target) => {
      await summarize(target, { source: 'A1', rows: ['Region'], values: ['Amount'] })
      target.workbook.getSheetByName('Sales')!.getRange('A2:D11').clearContent()
      await writeRange(target, { range: 'A2', sheet: 'Sales', values: [['East', 'Apples', 'Q1', 7]] })
      const refreshed = await refreshSummary(target, {})
      await settled(target)

      expect(refreshed.summaries[0]).toMatchObject({ range: 'A1:B3', rows: 1, before: 4 })
      expect(readRange(target, { range: 'A1:B6', sheet: 'Summary' }).values).toEqual([['Region', 'Sum of Amount'], ['East', 7], ['Grand total', 7], [null, null], [null, null], [null, null]])
      await expect(refreshSummary(target, { sheet: 'Notes' })).rejects.toThrow(/There is no summary on Notes/)
      await expect(refreshSummary(target, { summary: 'summary-9' })).rejects.toThrow(/There is no summary “summary-9” here/)

      target.workbook.getSheetByName('Summary')!.insertRowsBefore(0, 2)
      await writeRange(target, { range: 'A1', sheet: 'Summary', values: [['A title over the summary']] })
      await expect(refreshSummary(target, {})).rejects.toThrow(/The summary that was at A1:B3 is not there as it was made/)
      expect(readRange(target, { range: 'A1', sheet: 'Summary' }).values).toEqual([['A title over the summary']])
    })
  })

  it('describes its table for the dialog', async () => {
    const { result } = await withHeadlessSheets(salesBook(), (target) => summarySource(target, { source: 'C5' }))

    expect(result).toMatchObject({ sheet: 'Sales', range: 'A1:D11', rows: 10 })
    expect(result.fields.map((field) => [field.name, field.numeric, field.distinct])).toEqual([['Region', false, 4], ['Product', false, 3], ['Quarter', false, 2], ['Amount', true, 10]])
    expect(result.fields[0].values.map((value) => value.text)).toEqual(['East', 'North', 'West', '(blank)'])
    expect(result.fields[3].values[0]).toEqual({ value: 15, text: '15.00' })
  })
})

describe('summaries in .xlsx files', () => {
  it('keep their formulas and how they were made, so a refresh still works after the file is read again', async () => {
    const { snapshot } = await withHeadlessSheets(salesBook(), (target) => summarize(target, { source: 'A1', rows: ['Region'], columns: ['Quarter'], values: [{ field: 'Amount', fn: 'max' }], filters: [{ field: 'Product', values: ['Apples', 'Pears'] }] }))
    const { bytes, losses } = await xlsxFromWorkbook(snapshot)
    const zip = await JSZip.loadAsync(bytes)
    const parts = await Promise.all(Object.keys(zip.files).filter((name) => name.startsWith('xl/worksheets/sheet')).map((name) => zip.file(name)!.async('string')))
    const read = await workbookFromXlsx(bytes, { id: 'again', name: 'Sales' })
    const summary = Object.values(read.workbook.sheets).find((sheet) => sheet.name === 'Summary')!

    expect(losses).toEqual([])
    expect(parts.join('')).toContain('<f>IF(COUNTIFS(Sales!$A:$A,$A3,Sales!$C:$C,B$1,Sales!$B:$B,&quot;&lt;&gt;Mixed~*&quot;)=0,&quot;&quot;,_xlfn.MAXIFS(Sales!$D:$D,Sales!$A:$A,$A3,Sales!$C:$C,B$1,Sales!$B:$B,&quot;&lt;&gt;Mixed~*&quot;))</f>')
    expect(summary.cellData[2][1].f).toBe('=IF(COUNTIFS(Sales!$A:$A,$A3,Sales!$C:$C,B$1,Sales!$B:$B,"<>Mixed~*")=0,"",MAXIFS(Sales!$D:$D,Sales!$A:$A,$A3,Sales!$C:$C,B$1,Sales!$B:$B,"<>Mixed~*"))')
    expect((summary.custom as { herald?: { summaries?: unknown[] } }).herald?.summaries).toEqual([
      {
        id: 'summary-1',
        at: 'A1',
        size: { rows: 7, columns: 4 },
        source: { sheet: 'Sales', sheetId: 'sales', start: 'A1', range: 'A1:D11' },
        rows: ['Region'],
        columns: ['Quarter'],
        values: [{ field: 'Amount', fn: 'max' }],
        filters: [{ field: 'Product', values: ['Apples', 'Pears'] }]
      }
    ])

    const { result } = await withHeadlessSheets(read.workbook, async (target) => {
      await writeRange(target, { range: 'A12', sheet: 'Sales', values: [['South', 'Pears', 'Q1', 500], ['South', 'Mixed*', 'Q1', 900]] })
      const refreshed = await refreshSummary(target, { sheet: 'Summary' })
      await settled(target)

      return { refreshed, values: readRange(target, { range: refreshed.summaries[0].range, sheet: 'Summary' }).values }
    })

    expect(result.refreshed.summaries[0]).toMatchObject({ range: 'A1:D8', source: 'Sales!A1:D13' })
    expect(result.values[4]).toEqual(['South', 500, null, 500])
    expect(result.values[7]).toEqual(['Grand total', 500, 200, 500])
  })
})
