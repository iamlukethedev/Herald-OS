import { describe, expect, it } from 'vitest'
import { CHART_COMPONENT, CHART_DRAWING_TYPE, type ChartDrawing, DRAWING_RESOURCE } from '../../../../../shared/office/charts.ts'
import { CELL_TYPE, type CellMatrix, type CellSnapshot, newSheet, newWorkbook, type WorkbookSnapshot } from '../../../../../shared/office/workbook.ts'
import { withHeadlessSheets } from '../headless.ts'
import { renameSheet, type SheetsTarget } from '../model.ts'
import { describeChart, insertChart, listCharts, moveChart, recommendCharts, removeChart, updateChart } from './model.ts'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']
const ACCENTS = ['#156082', '#e97132', '#196b24', '#0f9ed5', '#a02b93', '#4ea72e']

function cells(rows: (string | number | null)[][]): CellMatrix {
  return Object.fromEntries(rows.map((row, r) => [r, Object.fromEntries(row.flatMap((value, c): [number, CellSnapshot][] => (value === null ? [] : [[c, typeof value === 'number' ? { v: value, t: CELL_TYPE.number } : { v: value, t: CELL_TYPE.string }]])))]))
}

/** Sales by month (revenue and costs) on one sheet, a share of channels on another, and the theme colours of the file it came from. */
function sales(): WorkbookSnapshot {
  const book = newWorkbook('book', 'Sales', [
    newSheet('s1', 'Sales', cells([['Month', 'Revenue', 'Costs'], ...MONTHS.map((month, i) => [month, 1000 + i * 100, 600 + i * 40])])),
    newSheet('s2', 'Q1 sales', cells([['Channel', 'Share'], ['Shop', 45], ['Online', 35], ['Phone', 20], [null, null], ['Notes', 'none']]))
  ])

  return { ...book, custom: { herald: { theme: { accents: ACCENTS } } } }
}

const drawingsOf = (snapshot: { resources?: { name: string; data: string }[] }) => JSON.parse(snapshot.resources?.find((resource) => resource.name === DRAWING_RESOURCE)?.data || '{}') as Record<string, { data: Record<string, ChartDrawing>; order: string[] }>

/** JSON with object keys in order, so equal drawings compare equal however Univer orders their keys. */
const stable = (value: unknown): string => JSON.stringify(value, (_key, entry) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry))

/** The drawings of the sheets that have any, to compare. */
const chartsIn = (snapshot: { resources?: { name: string; data: string }[] }) => stable(Object.entries(drawingsOf(snapshot)).filter(([, sheet]) => Object.keys(sheet.data ?? {}).length))

/** Run `change` on the sales workbook headlessly; give back what it returned, the drawings after it, and whether one undo took them back. */
async function changeAndUndo<T>(change: (target: SheetsTarget) => Promise<T>, prepare?: (target: SheetsTarget) => Promise<unknown>) {
  const { result } = await withHeadlessSheets(sales(), async ({ univer, workbook }) => {
    const target = { univer, workbook }
    await prepare?.(target)
    const before = chartsIn(workbook.save())
    const value = await change(target)
    const after = drawingsOf(workbook.save())
    workbook.undo()
    const undone = chartsIn(workbook.save()) === before

    return { value, after, undone }
  })

  return result
}

describe('inserting a chart', () => {
  it('charts a block beside it as the floating object Univer keeps, in the file theme’s colours, as one step to undo', async () => {
    const { value, after, undone } = await changeAndUndo((target) => insertChart(target, { range: 'A1:C7' }))
    const drawing = after.s1.data[value.chart]

    expect(value).toEqual({
      chart: expect.stringMatching(/^chart-/),
      sheet: 'Sales',
      kind: 'column',
      series: [
        { name: 'Revenue', nameCell: 'Sales!B1', values: 'Sales!B2:B7', categories: 'Sales!A2:A7' },
        { name: 'Costs', nameCell: 'Sales!C1', values: 'Sales!C2:C7', categories: 'Sales!A2:A7' }
      ]
    })
    expect(drawing).toMatchObject({ unitId: 'book', subUnitId: 's1', drawingType: CHART_DRAWING_TYPE, componentKey: CHART_COMPONENT, anchorType: '1', allowTransform: true, sheetTransform: { from: { column: 4, row: 0, columnOffset: 0, rowOffset: 0 } }, transform: { width: 480, height: 288 } })
    expect(drawing.data).toEqual({
      herald: 'chart',
      version: 1,
      spec: {
        kind: 'column',
        series: [
          { values: { sheet: 's1', startRow: 1, endRow: 6, startColumn: 1, endColumn: 1 }, name: { cell: { sheet: 's1', startRow: 0, endRow: 0, startColumn: 1, endColumn: 1 } }, categories: { sheet: 's1', startRow: 1, endRow: 6, startColumn: 0, endColumn: 0 } },
          { values: { sheet: 's1', startRow: 1, endRow: 6, startColumn: 2, endColumn: 2 }, name: { cell: { sheet: 's1', startRow: 0, endRow: 0, startColumn: 2, endColumn: 2 } }, categories: { sheet: 's1', startRow: 1, endRow: 6, startColumn: 0, endColumn: 0 } }
        ],
        legend: 'bottom',
        labels: 'none',
        stacking: 'none',
        palette: ACCENTS
      }
    })
    expect(after.s1.order).toEqual([value.chart])
    expect(undone).toBe(true)
  })

  it('charts the table around one cell, titling a chart of one series after it', async () => {
    const { value, after } = await changeAndUndo((target) => insertChart(target, { range: "'Q1 sales'!B3", kind: 'pie', labels: 'percent' }))
    const { spec } = after.s2.data[value.chart].data

    expect(value).toMatchObject({ sheet: 'Q1 sales', kind: 'pie', series: [{ name: 'Share', values: "'Q1 sales'!B2:B4", categories: "'Q1 sales'!A2:A4" }] })
    expect(spec).toMatchObject({ kind: 'pie', title: 'Share', legend: 'bottom', labels: 'percent' })
  })

  it('takes settings, a place over cells and a size', async () => {
    const { value, after } = await changeAndUndo((target) => insertChart(target, { range: 'A1:B7', kind: 'line', title: 'Revenue by month', legend: 'top', axes: { y: { title: 'Pounds', min: 0, format: '#,##0' } }, at: 'H10:M24' }))
    const drawing = after.s1.data[value.chart]

    expect(drawing.data.spec).toMatchObject({ kind: 'line', title: 'Revenue by month', legend: 'top', axes: { y: { title: 'Pounds', min: 0, format: '#,##0' } } })
    expect(drawing.sheetTransform.from).toEqual({ column: 7, columnOffset: 0, row: 9, rowOffset: 0 })
    expect(drawing.sheetTransform.to).toEqual({ column: 13, columnOffset: 0, row: 24, rowOffset: 0 })
    expect(drawing.transform).toEqual({ left: 46 + 7 * 88, top: 20 + 9 * 24, width: 6 * 88, height: 15 * 24 })
  })

  it('starts a combo chart with columns and a line, a much smaller series on the second axis', async () => {
    const book = newWorkbook('book', 'Margins', [newSheet('s1', 'Margins', cells([['Month', 'Revenue', 'Margin'], ...MONTHS.map((month, i) => [month, 12000 + i * 900, 0.2 + i / 100])]))])
    const { result } = await withHeadlessSheets(book, async ({ univer, workbook }) => {
      const target = { univer, workbook }
      const inserted = await insertChart(target, { range: 'A1' })

      return { inserted, recommended: recommendCharts(target, { range: 'B2' }) }
    })

    expect(result.recommended[0].kind).toBe('combo')
    expect(result.inserted.kind).toBe('combo')
    expect(result.inserted.series.map((series) => [series.type, series.secondary ?? false])).toEqual([
      ['column', false],
      ['line', true]
    ])
  })

  it('keeps a new chart clear of the charts already there', async () => {
    const { value, after } = await changeAndUndo((target) => insertChart(target, { range: 'A1:C7' }), (target) => insertChart(target, { range: 'A1:C7' }))
    const [first] = Object.values(after.s1.data).filter((drawing) => drawing.drawingId !== value.chart)

    expect(after.s1.data[value.chart].sheetTransform.from.row).toBeGreaterThan(first.sheetTransform.to.row)
  })

  it('explains what is wrong with its arguments', async () => {
    await withHeadlessSheets(sales(), async ({ univer, workbook }) => {
      const target = { univer, workbook }

      await expect(insertChart(target, { range: '' })).rejects.toThrow('Say which cells to chart')
      await expect(insertChart(target, { range: 'Z90' })).rejects.toThrow('Z90 has no numbers to chart')
      await expect(insertChart(target, { range: "'Q1 sales'!A6:B6" })).rejects.toThrow('has no numbers to chart')
      await expect(insertChart(target, { range: 'A1:C7', kind: 'radar' })).rejects.toThrow('kind is one of column, bar, line, area, pie, doughnut, scatter, combo, not “radar”')
      await expect(insertChart(target, { range: 'A1:C7', colour: 'red' })).rejects.toThrow('insertChart does not take colour')
      await expect(insertChart(target, { range: 'A1:C7', series: [{ values: 'B2:C7' }] })).rejects.toThrow('series 1 values is one column or one row of cells, not B2:C7')
      await expect(insertChart(target, { range: 'A1:C7', series: [{ values: 'B2:B7', color: 'reddish' }] })).rejects.toThrow('series 1 color is a colour like #4472c4')
      await expect(insertChart(target, { range: 'A1:C7', axes: { y: { min: 10, max: 5 } } })).rejects.toThrow('axes.y: min (10) has to be below max (5)')
      await expect(insertChart(target, { range: 'A1:C7', size: { width: 20 } })).rejects.toThrow('size.width is a number of pixels from 80 to 4000')
      await expect(insertChart(target, { range: 'Nowhere!A1' })).rejects.toThrow('There is no sheet called “Nowhere”')

      expect(listCharts(target)).toEqual([])
    })
  })
})

describe('reading, changing, moving and removing charts', () => {
  it('lists and describes charts with their ranges as A1 text, following a sheet that is renamed', async () => {
    const { result } = await withHeadlessSheets(sales(), async ({ univer, workbook }) => {
      const target = { univer, workbook }
      const { chart } = await insertChart(target, { range: 'A1:C7', title: 'Sales' })
      await insertChart(target, { range: "'Q1 sales'!A1:B4" })
      await renameSheet(target, { sheet: 'Sales', name: 'Year 1' })

      return { all: listCharts(target), second: listCharts(target, { sheet: 'Q1 sales' }), described: describeChart(target, { chart: 'sales' }), byNumber: describeChart(target, { chart: 1 }).chart === chart }
    })

    expect(result.all.map((chart) => [chart.sheet, chart.kind, chart.title, chart.at, chart.series])).toEqual([
      ['Year 1', 'column', 'Sales', 'E1', 2],
      ['Q1 sales', 'pie', 'Share', 'D1', 1]
    ])
    expect(result.second).toHaveLength(1)
    expect(result.described).toMatchObject({ sheet: 'Year 1', title: 'Sales', size: { width: 480, height: 288 }, series: [{ name: 'Revenue', nameCell: "'Year 1'!B1", values: "'Year 1'!B2:B7", categories: "'Year 1'!A2:A7" }, { name: 'Costs' }], legend: 'bottom', labels: 'none', stacking: 'none', axes: {}, palette: ACCENTS })
    expect(result.byNumber).toBe(true)
  })

  it('changes several settings as one step to undo', async () => {
    const { value, undone } = await changeAndUndo(
      async (target) => updateChart(target, { chart: 1, kind: 'combo', title: 'Revenue and costs', legend: 'right', labels: 'value', axes: { y: { title: 'Pounds', gridlines: false }, y2: { format: '0%' } }, palette: ['#111111', '#222222'] }),
      (target) => insertChart(target, { range: 'A1:C7' })
    )

    expect(value).toMatchObject({ kind: 'combo', title: 'Revenue and costs', legend: 'right', labels: 'value', axes: { y: { title: 'Pounds', gridlines: false }, y2: { format: '0%' } }, palette: ['#111111', '#222222'] })
    expect(value.series.map((series) => series.type)).toEqual(['column', 'line'])
    expect(undone).toBe(true)
  })

  it('replaces the series, the categories and the axes’ settings', async () => {
    const { value } = await changeAndUndo(
      async (target) => {
        await updateChart(target, { chart: 1, series: [{ values: 'C2:C7', nameCell: 'C1', color: '#ABC', type: 'line' }, { values: 'B2:B7', name: 'Takings', secondary: true }], categories: 'A2:A7', axes: { y: { min: 0, max: 2000 } } })

        return updateChart(target, { chart: 1, axes: { y: { max: null }, x: { hidden: true } }, stacking: 'percent', hole: 30 })
      },
      (target) => insertChart(target, { range: 'A1:C7' })
    )

    expect(value.series).toEqual([
      { name: 'Costs', nameCell: 'Sales!C1', values: 'Sales!C2:C7', categories: 'Sales!A2:A7', color: '#aabbcc', type: 'line' },
      { name: 'Takings', values: 'Sales!B2:B7', categories: 'Sales!A2:A7', secondary: true }
    ])
    expect(value.axes).toEqual({ y: { min: 0 }, x: { hidden: true } })
    expect(value.stacking).toBe('percent')
  })

  it('lays the series out again from a new block, and changes nothing when nothing changes', async () => {
    const { result } = await withHeadlessSheets(sales(), async ({ univer, workbook }) => {
      const target = { univer, workbook }
      await insertChart(target, { range: 'A1:C7' })
      const narrowed = await updateChart(target, { chart: 1, range: 'A1:B4' })
      const before = JSON.stringify(drawingsOf(workbook.save()))
      await updateChart(target, { chart: 1, legend: narrowed.legend })

      return { narrowed, same: JSON.stringify(drawingsOf(workbook.save())) === before }
    })

    expect(result.narrowed.series).toEqual([{ name: 'Revenue', nameCell: 'Sales!B1', values: 'Sales!B2:B4', categories: 'Sales!A2:A4' }])
    expect(result.same).toBe(true)
  })

  it('moves and sizes a chart as one step to undo', async () => {
    const { value, after, undone } = await changeAndUndo(
      (target) => moveChart(target, { chart: 1, at: 'B12', size: { width: 600, height: 300 } }),
      (target) => insertChart(target, { range: 'A1:C7' })
    )
    const drawing = Object.values(after.s1.data)[0]

    expect(value).toMatchObject({ sheet: 'Sales', at: 'B12', size: { width: 600, height: 300 } })
    expect(drawing.sheetTransform.from).toEqual({ column: 1, columnOffset: 0, row: 11, rowOffset: 0 })
    expect(drawing.transform).toMatchObject({ width: 600, height: 300 })
    expect(undone).toBe(true)
  })

  it('removes a chart as one step to undo', async () => {
    const { value, after, undone } = await changeAndUndo((target) => removeChart(target, { chart: 1 }), (target) => insertChart(target, { range: 'A1:C7' }))

    expect(value).toEqual({ chart: expect.stringMatching(/^chart-/), sheet: 'Sales' })
    expect(Object.keys(after.s1?.data ?? {})).toEqual([])
    expect(undone).toBe(true)
  })

  it('keeps charts in the workbook it saves and finds them when it loads again', async () => {
    const { snapshot } = await withHeadlessSheets(sales(), (target) => insertChart(target, { range: 'A1:C7', title: 'Kept' }))
    const { result } = await withHeadlessSheets(snapshot, (target) => listCharts(target))

    expect(result).toMatchObject([{ sheet: 'Sales', title: 'Kept', at: 'E1' }])
  })

  it('explains what is wrong with its arguments', async () => {
    await withHeadlessSheets(sales(), async ({ univer, workbook }) => {
      const target = { univer, workbook }

      expect(() => describeChart(target, { chart: 'x' })).toThrow('This workbook has no charts yet')
      await insertChart(target, { range: 'A1:C7', title: 'Sales' })
      await insertChart(target, { range: 'A1:C7', title: 'Sales' })

      expect(() => describeChart(target, { chart: 'Profit' })).toThrow(/There is no chart “Profit”: give a chart’s id, title or number \(chart-\w+ \(“Sales” on Sales\)/)
      expect(() => describeChart(target, { chart: 'sales' })).toThrow('Several charts are titled “sales”')
      await expect(updateChart(target, { chart: 1 })).rejects.toThrow('Say what to change')
      await expect(updateChart(target, { chart: 1, legend: 'middle' })).rejects.toThrow('legend is one of top, bottom, left, right, none')
      await expect(updateChart(target, { chart: 1, series: [] })).rejects.toThrow('series is a list of at least one series')
      await expect(updateChart(target, { chart: 1, series: [{ name: 'No values' }] })).rejects.toThrow('series 1 needs values')
      await expect(updateChart(target, { chart: 1, axes: { z: {} } })).rejects.toThrow('axes does not take z')
      await expect(updateChart(target, { chart: 1, hole: 95 })).rejects.toThrow('hole is the doughnut’s hole as a percentage of its size, from 0 to 90')
      await expect(updateChart(target, { chart: 1, palette: 'bright' })).rejects.toThrow('palette is a list of colours')
      await expect(moveChart(target, { chart: 1 })).rejects.toThrow('Say where to')
      await expect(moveChart(target, { chart: 1, at: "'Q1 sales'!B2" })).rejects.toThrow('at is a cell on Sales, where the chart is')
      expect(() => recommendCharts(target, { range: "'Q1 sales'!A6:B6" })).toThrow('has no numbers to chart')
    })
  })
})
