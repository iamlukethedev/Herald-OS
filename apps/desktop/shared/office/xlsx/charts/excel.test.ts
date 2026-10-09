import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { type ChartDrawing, type ChartSpec, DRAWING_RESOURCE } from '../../charts.ts'
import { tinted } from '../colors.ts'
import { readHeraldPart } from '../herald-part.ts'
import { parseRelationships, relsPathOf } from '../opc.ts'
import { openPackage } from '../package.ts'
import { workbookFromXlsx } from '../read.ts'
import { readResource } from '../rules.ts'
import { xlsxFromWorkbook } from '../write.ts'
import { CHART_REL, CHART_TYPE, chartFrame, chartPackage, COLUMN_CHART, excelAxes, excelChart, excelWorkbook, numRef, strRef, twoCellAnchor } from './fixtures.ts'
import { type FiledCharts, HERALD_SECTION, shownAnchors } from './index.ts'
import { NOTES } from './read.ts'

/* Charts as Excel writes them, read into the charts Herald draws, and the ones Herald leaves in the file. */

type Drawings = Record<string, { data: Record<string, ChartDrawing>; order: string[] }>

const range = (sheet: string, startRow: number, startColumn: number, endRow = startRow, endColumn = startColumn) => ({ sheet, startRow, startColumn, endRow, endColumn })

const SALES = 'sheet-1'
const POINTS = 'sheet-2'
const MONTHS = range(SALES, 1, 0, 4, 0)

async function readExcel(bytes: Uint8Array) {
  const { workbook, notes } = await workbookFromXlsx(bytes, { id: 'book', name: 'Book' })
  const drawings = readResource<Drawings>(workbook.resources, DRAWING_RESOURCE) ?? {}
  const charts = (sheet: string) => (drawings[sheet]?.order ?? []).map((id) => drawings[sheet].data[id])

  return { workbook, notes, drawings, charts }
}

describe('charts Excel made', () => {
  it('reads a clustered column chart with its names, categories, values, theme colours and titles', async () => {
    const { charts } = await readExcel(await excelWorkbook())
    const column = charts(SALES)[0]

    expect(column.data.spec).toEqual({
      kind: 'column',
      title: 'Quarterly sales',
      series: [
        { name: { cell: range(SALES, 0, 1) }, values: range(SALES, 1, 1, 4, 1), categories: MONTHS, color: '#1f4e79' },
        { name: { cell: range(SALES, 0, 2) }, values: range(SALES, 1, 2, 4, 2), categories: MONTHS, color: `#${tinted('C55A11', -0.25).toLowerCase()}` }
      ],
      legend: 'bottom',
      labels: 'none',
      axes: { x: { gridlines: false }, y: { gridlines: true, title: 'Units' } }
    } satisfies ChartSpec)
    expect(column.data.source).toMatchObject({ part: 'xl/charts/chart1.xml', anchor: 1 })
  })

  it('places a chart over its cells as Herald Sheets sizes them: custom widths, hidden columns, tall rows', async () => {
    const { charts } = await readExcel(await excelWorkbook())
    const [column, pie] = charts(SALES)

    expect(column).toMatchObject({
      unitId: 'book',
      subUnitId: SALES,
      drawingType: 8,
      componentKey: 'herald-chart',
      anchorType: '1',
      allowTransform: true,
      sheetTransform: { from: { column: 4, columnOffset: 32, row: 1, rowOffset: 1 }, to: { column: 11, columnOffset: 64, row: 16, rowOffset: 10 } },
      // Column A is 89 pixels, H is hidden and row 3 is 40 pixels tall; Univer counts past its 46 by 20 pixel headers.
      transform: { left: 46 + 313, top: 20 + 21, width: 416, height: 329 }
    })
    expect(column.axisAlignSheetTransform).toEqual(column.sheetTransform)
    // A one-cell anchor's far corner comes from its size.
    expect(pie).toMatchObject({ anchorType: '0', sheetTransform: { from: { column: 4, columnOffset: 0, row: 18, rowOffset: 0 }, to: { column: 12, columnOffset: 32, row: 32, rowOffset: 8 } }, transform: { left: 327, top: 400, width: 480, height: 288 } })
  })

  it('reads a pie with percentages on its slices, titled after its series as Excel shows it', async () => {
    const { charts } = await readExcel(await excelWorkbook())

    expect(charts(SALES)[1].data.spec).toEqual({
      kind: 'pie',
      title: 'North',
      series: [{ name: { cell: range(SALES, 0, 1) }, values: range(SALES, 1, 1, 4, 1), categories: MONTHS }],
      legend: 'right',
      labels: 'percent',
      palette: ['#1f4e79', '#c55a11', '#ff0000', '#bf8f00']
    } satisfies ChartSpec)
  })

  it('reads columns with a line on a secondary axis as a combo chart', async () => {
    const { charts } = await readExcel(await excelWorkbook())
    const combo = charts(SALES)[2]

    expect(combo.anchorType).toBe('0')
    expect(combo.data.spec).toEqual({
      kind: 'combo',
      title: 'Sales and margin',
      series: [
        { name: { cell: range(SALES, 0, 1) }, values: range(SALES, 1, 1, 4, 1), categories: MONTHS, color: '#1f4e79', type: 'column' },
        { name: { cell: range(SALES, 0, 3) }, values: range(SALES, 1, 3, 4, 3), categories: MONTHS, color: '#70ad47', type: 'line', secondary: true, markers: false }
      ],
      legend: 'bottom',
      labels: 'none',
      axes: { x: { gridlines: false }, y: { gridlines: true }, y2: { gridlines: false, min: 0, max: 0.5, format: '0%' } }
    } satisfies ChartSpec)
  })

  it('reads a scatter chart placed absolutely, a whole column trimmed to its values', async () => {
    const { charts } = await readExcel(await excelWorkbook())
    const [scatter] = charts(POINTS)

    expect(scatter.data.spec).toEqual({
      kind: 'scatter',
      title: 'Growth',
      series: [{ name: { cell: range(POINTS, 0, 1) }, values: range(POINTS, 0, 1, 5, 1), categories: range(POINTS, 1, 0, 5, 0), color: '#1f4e79' }],
      legend: 'none',
      labels: 'none',
      axes: { x: { gridlines: false, min: 0 }, y: { gridlines: true } }
    } satisfies ChartSpec)
    expect(scatter).toMatchObject({ anchorType: '2', sheetTransform: { from: { column: 3, columnOffset: 8, row: 1, rowOffset: 0 }, to: { column: 9, columnOffset: 24, row: 13, rowOffset: 0 } }, transform: { left: 246, top: 40, width: 400, height: 240 } })
  })

  it('leaves 3D, radar and chartEx charts and pictures in the file, and says which anchors it shows', async () => {
    const bytes = await excelWorkbook()
    const { charts, notes } = await readExcel(bytes)
    const pkg = await openPackage(bytes)

    expect(charts(SALES).map((chart) => chart.data.source?.anchor)).toEqual([1, 2, 3])
    expect([...(await shownAnchors(pkg, pkg.sheets[0]))]).toEqual([1, 2, 3])
    expect([...(await shownAnchors(pkg, pkg.sheets[1]))]).toEqual([0])
    expect(notes).toContain(NOTES.shapes)
    expect(new Set(charts(SALES).map((chart) => chart.drawingId)).size).toBe(3)
  })
})

describe('charts Excel made, saved again', () => {
  const saved = async (change?: (workbook: Awaited<ReturnType<typeof readExcel>>['workbook']) => void) => {
    const original = await excelWorkbook()
    const { workbook } = await readExcel(original)
    change?.(workbook)
    const { bytes, losses } = await xlsxFromWorkbook(workbook, { original })
    const pkg = await openPackage(bytes)
    const filed = ((await readHeraldPart(pkg))?.[HERALD_SECTION] ?? {}) as FiledCharts

    return { original: await JSZip.loadAsync(original), zip: await JSZip.loadAsync(bytes), bytes, losses, filed }
  }
  const bytesOf = (zip: JSZip, path: string) => zip.file(path)!.async('uint8array')

  it('copies an unchanged chart byte for byte, with its style, colours, the shapes over it and their picture', async () => {
    const { original, zip, filed } = await saved()
    const [column, pie, combo] = Object.values(filed['Q1 sales']).map((chart) => chart.part)
    const types = await zip.file('[Content_Types].xml')!.async('string')
    const rels = parseRelationships(column, await zip.file(relsPathOf(column))!.async('string'))

    expect(await bytesOf(zip, column)).toEqual(await bytesOf(original, 'xl/charts/chart1.xml'))
    expect(await bytesOf(zip, pie)).toEqual(await bytesOf(original, 'xl/charts/chart2.xml'))
    expect(await bytesOf(zip, combo)).toEqual(await bytesOf(original, 'xl/charts/chart3.xml'))
    expect(await bytesOf(zip, Object.values(filed.Points)[0].part)).toEqual(await bytesOf(original, 'xl/charts/chart6.xml'))
    // Excel's relationship ids stay, its colours listed before its style.
    expect(rels.map((rel) => [rel.id, rel.type.split('/').pop()])).toEqual([
      ['rId2', 'chartColorStyle'],
      ['rId1', 'chartStyle'],
      ['rId3', 'chartUserShapes']
    ])
    expect(await bytesOf(zip, rels[0].target)).toEqual(await bytesOf(original, 'xl/charts/colors1.xml'))
    expect(await bytesOf(zip, rels[1].target)).toEqual(await bytesOf(original, 'xl/charts/style1.xml'))
    expect(await bytesOf(zip, rels[2].target)).toEqual(await bytesOf(original, 'xl/drawings/drawing3.xml'))
    const picture = parseRelationships(rels[2].target, await zip.file(relsPathOf(rels[2].target))!.async('string'))[0]
    expect(await bytesOf(zip, picture.target)).toEqual(await bytesOf(original, 'xl/media/image2.png'))
    expect(types).toContain(`<Override PartName="/${column}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`)
    expect(types).toContain(`<Override PartName="/${rels[1].target}" ContentType="application/vnd.ms-office.chartstyle+xml"/>`)
    expect(types).toContain(`<Override PartName="/${rels[0].target}" ContentType="application/vnd.ms-office.chartcolorstyle+xml"/>`)
    expect(types).toContain(`<Override PartName="/${rels[2].target}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chartshapes+xml"/>`)
    expect(types).toContain('<Default Extension="png" ContentType="image/png"/>')
  })

  it('reads the charts it copied back as they were read from Excel', async () => {
    const original = await excelWorkbook()
    const first = await readExcel(original)
    const { bytes } = await xlsxFromWorkbook(first.workbook, { original })
    const again = await readExcel(bytes)

    expect(again.charts(SALES).map((chart) => chart.data.spec)).toEqual(first.charts(SALES).map((chart) => chart.data.spec))
    expect(again.charts(POINTS).map((chart) => chart.data.spec)).toEqual(first.charts(POINTS).map((chart) => chart.data.spec))
    expect(again.charts(SALES).map((chart) => chart.drawingId)).toEqual(first.charts(SALES).map((chart) => chart.drawingId))
  })

  it('writes a chart changed since from its spec, leaving the others copied', async () => {
    const { original, zip, filed } = await saved((workbook) => {
      const drawings = readResource<Drawings>(workbook.resources, DRAWING_RESOURCE)!
      const column = drawings[SALES].data[drawings[SALES].order[0]]
      column.data.spec = { ...column.data.spec, title: 'Sales by region' }
      workbook.resources = (workbook.resources as { name: string; data: string }[]).map((resource) => (resource.name === DRAWING_RESOURCE ? { ...resource, data: JSON.stringify(drawings) } : resource))
    })
    const [column, pie] = Object.values(filed['Q1 sales']).map((chart) => chart.part)
    const xml = await zip.file(column)!.async('string')

    expect(xml).toContain('<a:t>Sales by region</a:t>')
    expect(xml).not.toContain('c:userShapes')
    expect(zip.file(relsPathOf(column))).toBeNull()
    expect(await bytesOf(zip, pie)).toEqual(await bytesOf(original, 'xl/charts/chart2.xml'))
  })

  it('writes a chart anew when a sheet its formulas name was renamed', async () => {
    const { zip, filed } = await saved((workbook) => {
      workbook.sheets[SALES].name = 'Sales'
    })
    const xml = await zip.file(Object.values(filed.Sales)[0].part)!.async('string')

    expect(xml).toContain('<c:f>Sales!$B$2:$B$5</c:f>')
    expect(xml).not.toContain('Q1 sales')
    // The scatter chart on the other sheet names only its own sheet, which kept its name.
    expect(await zip.file(Object.values(filed.Points)[0].part)!.async('string')).toContain('<c14:style val="102"/>')
  })
})

describe('charts Herald does not read', () => {
  const sheet = { name: 'Data', rows: [['Item', 'Value'], ['A', 1], ['B', 2]] as (string | number)[][] }
  const single = (series: string) =>
    excelChart({ plot: `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/>${series}</c:ser><c:gapWidth val="150"/><c:axId val="1"/><c:axId val="2"/></c:barChart>${excelAxes(1, 2)}` })
  const withChart = (xml: string) =>
    chartPackage({ sheets: [{ ...sheet, anchors: [twoCellAnchor(2, [3, 0, 1, 0], [9, 0, 15, 0], chartFrame(0, 'Chart 1'))], related: [{ type: CHART_REL, path: 'xl/charts/chart1.xml' }] }], parts: { 'xl/charts/chart1.xml': { content: xml, type: CHART_TYPE } } })
  const shown = async (xml: string) => {
    const pkg = await openPackage(await withChart(xml))

    return (await shownAnchors(pkg, pkg.sheets[0])).size
  }

  it('reads a plain reference, quoted or not, with or without dollars', async () => {
    expect(await shown(single(`<c:val>${numRef('Data!$B$2:$B$3', [1, 2])}</c:val>`))).toBe(1)
    expect(await shown(single(`<c:val>${numRef("'Data'!B2:B3", [1, 2])}</c:val>`))).toBe(1)
    expect(await shown(COLUMN_CHART.replace(/'Q1 sales'/g, 'Data'))).toBe(1)
  })

  it('leaves charts of other workbooks, defined names, literal data and several areas', async () => {
    expect(await shown(single(`<c:val>${numRef('[1]Data!$B$2:$B$3', [1, 2])}</c:val>`))).toBe(0)
    expect(await shown(single(`<c:val>${numRef("'[Other.xlsx]Data'!$B$2:$B$3", [1, 2])}</c:val>`))).toBe(0)
    expect(await shown(single(`<c:val>${numRef('Data!Values', [1, 2])}</c:val>`))).toBe(0)
    expect(await shown(single(`<c:val>${numRef('Values', [1, 2])}</c:val>`))).toBe(0)
    expect(await shown(single(`<c:val>${numRef('(Data!$B$2,Data!$B$3)', [1, 2])}</c:val>`))).toBe(0)
    expect(await shown(single('<c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="1"/><c:pt idx="0"><c:v>4</c:v></c:pt></c:numLit></c:val>'))).toBe(0)
    expect(await shown(single(`<c:cat><c:strLit><c:ptCount val="1"/><c:pt idx="0"><c:v>A</c:v></c:pt></c:strLit></c:cat><c:val>${numRef('Data!$B$2', [1])}</c:val>`))).toBe(0)
    expect(await shown(single(`<c:tx>${strRef('Data!Title', ['A'])}</c:tx><c:val>${numRef('Data!$B$2', [1])}</c:val>`))).toBe(0)
    expect(await shown(single(`<c:val>${numRef('Missing!$B$2:$B$3', [1, 2])}</c:val>`))).toBe(0)
    expect(await shown(single(`<c:val>${numRef('Data!#REF!', [1, 2])}</c:val>`))).toBe(0)
  })
})
