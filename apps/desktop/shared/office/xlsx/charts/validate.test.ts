import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withHeadlessSheets } from '../../../../src/features/office/sheets/headless.ts'
import { DRAWING_RESOURCE } from '../../charts.ts'
import { hasOpenpyxl, hasXmllint, malformedParts, openpyxl } from '../comments/checks.ts'
import { workbookFromXlsx } from '../read.ts'
import { readResource } from '../rules.ts'
import { xlsxFromWorkbook } from '../write.ts'
import { everyKindWorkbook, excelWorkbook } from './fixtures.ts'

/* What other readers make of the charts Herald writes, and Univer of the charts Herald reads. */

describe('charts other readers open', () => {
  it.skipIf(!hasOpenpyxl())('writes a chart of every kind that openpyxl reads, each as its kind, the way its categories run included', async () => {
    const { bytes } = await xlsxFromWorkbook(everyKindWorkbook())
    const samples = process.env.HERALD_SHEETS_SAMPLES

    // A folder named here gets the workbook, to open in Excel by hand.
    if (samples) {
      mkdirSync(samples, { recursive: true })
      writeFileSync(join(samples, 'charts-all-kinds.xlsx'), bytes)
    }

    const script = 'order = lambda chart: getattr(getattr(getattr(chart, "x_axis", None), "scaling", None), "orientation", None)\nprint(json.dumps({sheet.title: [[type(chart).__name__, getattr(chart, "type", None), getattr(chart, "grouping", None), order(chart)] for chart in sheet._charts] for sheet in book.worksheets}))'
    const read = JSON.parse(openpyxl(bytes, script))

    // Herald's bars run from the top down where Excel's run from the bottom up (minMax).
    expect(read).toEqual({
      'Q1 sales': [
        ['BarChart', 'col', 'stacked', 'minMax'],
        ['BarChart', 'bar', 'clustered', 'maxMin'],
        ['LineChart', null, 'standard', 'minMax'],
        ['AreaChart', null, 'percentStacked', 'minMax'],
        ['PieChart', null, null, null],
        ['DoughnutChart', null, null, null],
        ['AreaChart', null, 'stacked', 'minMax'],
        ['BarChart', 'bar', 'clustered', 'minMax'],
        ['BarChart', 'col', 'clustered', 'maxMin'],
        ['BarChart', 'col', 'clustered', 'maxMin']
      ],
      Points: [['ScatterChart', null, null, 'minMax']]
    })
  })

  it.skipIf(!hasXmllint())('writes chart and drawing parts that are well formed', async () => {
    expect(await malformedParts((await xlsxFromWorkbook(everyKindWorkbook())).bytes)).toEqual([])
  })
})

describe('charts in Univer', () => {
  it('keeps the drawings of the charts read from a file as Univer’s drawing plugin loads and saves them', async () => {
    const { workbook } = await workbookFromXlsx(await excelWorkbook(), { id: 'book', name: 'Book' })
    const { snapshot } = await withHeadlessSheets(workbook, () => undefined)

    expect(readResource(workbook.resources, DRAWING_RESOURCE)).toBeTruthy()
    expect(readResource(snapshot.resources, DRAWING_RESOURCE)).toEqual(readResource(workbook.resources, DRAWING_RESOURCE))
  })
})
