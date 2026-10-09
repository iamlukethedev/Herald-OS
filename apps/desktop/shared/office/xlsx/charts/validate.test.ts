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
  it.skipIf(!hasOpenpyxl())('writes a chart of every kind that openpyxl reads, each as its kind', async () => {
    const { bytes } = await xlsxFromWorkbook(everyKindWorkbook())
    const samples = process.env.HERALD_SHEETS_SAMPLES

    // A folder named here gets the workbook, to open in Excel by hand.
    if (samples) {
      mkdirSync(samples, { recursive: true })
      writeFileSync(join(samples, 'charts-all-kinds.xlsx'), bytes)
    }

    const read = JSON.parse(openpyxl(bytes, 'print(json.dumps({sheet.title: [[type(chart).__name__, getattr(chart, "type", None), getattr(chart, "grouping", None)] for chart in sheet._charts] for sheet in book.worksheets}))'))

    expect(read).toEqual({
      'Q1 sales': [
        ['BarChart', 'col', 'stacked'],
        ['BarChart', 'bar', 'clustered'],
        ['LineChart', null, 'standard'],
        ['AreaChart', null, 'percentStacked'],
        ['PieChart', null, null],
        ['DoughnutChart', null, null],
        ['AreaChart', null, 'stacked']
      ],
      Points: [['ScatterChart', null, null]]
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
