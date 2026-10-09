import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { type ChartDrawing, type ChartSpec, DRAWING_RESOURCE } from '../../charts.ts'
import { HERALD_PART, readHeraldPart } from '../herald-part.ts'
import { openPackage } from '../package.ts'
import { workbookFromXlsx } from '../read.ts'
import { readResource } from '../rules.ts'
import { xlsxFromWorkbook } from '../write.ts'
import { chartDrawing, chartWorkbook, EITHER_WAY, EVERY_KIND, range, SALES_SERIES } from './fixtures.ts'
import { HERALD_SECTION, shownAnchors, withSheets } from './index.ts'
import { NOTES } from './read.ts'

/* Charts made in Herald written into .xlsx files and read back: from the chart parts alone, and exactly through Herald's part. */

type Drawings = Record<string, { data: Record<string, ChartDrawing>; order: string[] }>

const { months, north, south, margin } = SALES_SERIES

const READ_IDS: Record<string, string> = { s1: 'sheet-1', s2: 'sheet-2' }
const asRead = (spec: ChartSpec): ChartSpec => withSheets(spec, (sheet) => READ_IDS[sheet] ?? sheet)

async function withoutHeraldPart(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  zip.remove(HERALD_PART)

  return zip.generateAsync({ type: 'uint8array' })
}

/** Each axis of the first `count` chart parts: its kind, id, orientation and where it crosses the other. */
async function axesOf(bytes: Uint8Array, count: number): Promise<string[][]> {
  const zip = await JSZip.loadAsync(bytes)
  const parts = await Promise.all(Array.from({ length: count }, (_, i) => zip.file(`xl/charts/chart${i + 1}.xml`)!.async('string')))

  return parts.map((xml) => [...xml.matchAll(/<c:(catAx|valAx)><c:axId val="(\d+)"\/><c:scaling><c:orientation val="(\w+)"\/>.*?<c:crosses val="(\w+)"\/>/g)].map((match) => match.slice(1).join(' ')))
}

async function readBack(bytes: Uint8Array) {
  const { workbook, notes } = await workbookFromXlsx(bytes, { id: 'book', name: 'Book' })
  const drawings = readResource<Drawings>(workbook.resources, DRAWING_RESOURCE) ?? {}
  const charts = Object.values(drawings).flatMap((sheet) => sheet.order.map((id) => sheet.data[id]))

  return { workbook, notes, drawings, charts }
}

describe('charts written into a file and read back', () => {
  it('gives back every kind from its chart part alone: titles, axes, legend, labels, colours, stacking, hole, secondary axis', async () => {
    const drawings = EVERY_KIND.map((spec, i) => chartDrawing(`c${i}`, spec.kind === 'scatter' ? 's2' : 's1', spec, { at: i }))
    const { bytes, losses } = await xlsxFromWorkbook(chartWorkbook(drawings))
    const { charts, notes } = await readBack(await withoutHeraldPart(bytes))

    expect(losses).toEqual([])
    expect(notes.filter((note) => (Object.values(NOTES) as string[]).includes(note))).toEqual([])
    expect(charts.map((chart) => chart.data.spec.kind).sort()).toEqual(EVERY_KIND.map((spec) => spec.kind).sort())

    for (const spec of EVERY_KIND) {
      expect(charts.find((chart) => chart.data.spec.kind === spec.kind)!.data.spec).toEqual(asRead(spec))
    }
  })

  it('gives back bars and columns with their categories either way round, writing each way as Excel reads it', async () => {
    const { bytes } = await xlsxFromWorkbook(chartWorkbook(EITHER_WAY.map((spec, i) => chartDrawing(`c${i}`, 's1', spec, { at: i }))))
    const { charts } = await readBack(await withoutHeraldPart(bytes))

    expect(charts.map((chart) => chart.data.spec)).toEqual(EITHER_WAY.map(asRead))
    // Excel lists bars from the bottom up and columns from the left (minMax); a value axis crosses at the far end of reversed categories.
    expect(await axesOf(bytes, EITHER_WAY.length)).toEqual([
      ['catAx 101 maxMin autoZero', 'valAx 102 minMax max'],
      ['catAx 101 minMax autoZero', 'valAx 102 minMax autoZero'],
      ['catAx 101 minMax autoZero', 'valAx 102 minMax autoZero'],
      ['catAx 101 maxMin autoZero', 'valAx 102 minMax max'],
      ['catAx 101 maxMin autoZero', 'valAx 102 minMax max', 'valAx 104 minMax autoZero', 'catAx 103 maxMin autoZero']
    ])
  })

  it('writes the axes of charts that do not reverse their categories as before', async () => {
    const plain = EVERY_KIND.filter((spec) => ['bar', 'column', 'combo'].includes(spec.kind))
    const { bytes } = await xlsxFromWorkbook(chartWorkbook(plain.map((spec, i) => chartDrawing(`c${i}`, 's1', spec, { at: i }))))

    expect(await axesOf(bytes, plain.length)).toEqual([
      ['catAx 101 minMax autoZero', 'valAx 102 minMax autoZero'],
      ['catAx 101 maxMin autoZero', 'valAx 102 minMax max'],
      ['catAx 101 minMax autoZero', 'valAx 102 minMax autoZero', 'valAx 104 minMax max', 'catAx 103 minMax autoZero']
    ])
  })

  it('gives back the exact spec through Herald’s part: its palette, label mode, fields Excel has no place for, and the drawing’s id', async () => {
    const spec = { kind: 'column', series: [{ values: north.values, categories: months }, { values: south.values }], legend: 'right', labels: 'percent', palette: ['#111111', '#222222'], axes: { y: { max: 200 } }, later: { field: [1, 2] } } as ChartSpec
    const { bytes, losses } = await xlsxFromWorkbook(chartWorkbook([chartDrawing('mine', 's1', spec)]))
    const { charts, workbook } = await readBack(bytes)

    expect(losses).toEqual(['Excel labels columns, bars, lines and areas with their values where Herald Sheets shows each one’s share of its category.'])
    expect(charts).toHaveLength(1)
    expect(charts[0].drawingId).toBe('mine')
    expect(charts[0].data.spec).toEqual(asRead(spec))
    expect(charts[0].data.source).toMatchObject({ part: 'xl/charts/chart1.xml', anchor: 0 })
    expect(readResource<Drawings>(workbook.resources, DRAWING_RESOURCE)!['sheet-1'].order).toEqual(['mine'])
  })

  it('shows in Excel what Herald draws: the palette in turn, the first categories for every series, values for percentages', async () => {
    const spec: ChartSpec = { kind: 'column', series: [{ values: north.values, categories: months }, { values: south.values }], legend: 'right', labels: 'percent', palette: ['#111111', '#222222'] }
    const { bytes } = await xlsxFromWorkbook(chartWorkbook([chartDrawing('mine', 's1', spec)]))
    const { charts } = await readBack(await withoutHeraldPart(bytes))

    expect(charts[0].data.spec).toEqual(
      asRead({
        kind: 'column',
        series: [
          { values: north.values, categories: months, color: '#111111' },
          { values: south.values, categories: months, color: '#222222' }
        ],
        legend: 'right',
        labels: 'value',
        axes: { x: { gridlines: false }, y: { gridlines: true } }
      })
    )
  })

  it('writes what a spec leaves to Herald’s defaults: Office colours, columns then lines in a combo, markers up to 40 points, a half hole', async () => {
    const combo: ChartSpec = { kind: 'combo', series: [north, south], legend: 'bottom', labels: 'none' }
    const doughnut: ChartSpec = { kind: 'doughnut', series: [north], legend: 'none', labels: 'none' }
    const { bytes } = await xlsxFromWorkbook(chartWorkbook([chartDrawing('combo', 's1', combo), chartDrawing('ring', 's1', doughnut, { at: 1 })]))
    const { charts } = await readBack(await withoutHeraldPart(bytes))

    expect(charts[0].data.spec.series).toEqual(
      asRead({
        ...combo,
        series: [
          { ...north, color: '#4472c4', type: 'column' },
          { ...south, color: '#ed7d31', type: 'line', markers: true }
        ]
      }).series
    )
    expect(charts[1].data.spec).toMatchObject({ hole: 50, palette: ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000'] })
  })

  it('reads a chart another app changed since from its XML, not from Herald’s part', async () => {
    const spec: ChartSpec = { kind: 'column', title: 'Before', series: [north], legend: 'right', labels: 'none', palette: ['#111111'] }
    const { bytes } = await xlsxFromWorkbook(chartWorkbook([chartDrawing('mine', 's1', spec)]))
    const zip = await JSZip.loadAsync(bytes)
    zip.file('xl/charts/chart1.xml', (await zip.file('xl/charts/chart1.xml')!.async('string')).replace('<a:t>Before</a:t>', '<a:t>After</a:t>'))
    const { charts } = await readBack(await zip.generateAsync({ type: 'uint8array' }))

    expect(charts[0].data.spec).toMatchObject({ title: 'After', series: [{ color: '#111111' }] })
    expect(charts[0].data.spec.palette).toBeUndefined()
    expect(charts[0].drawingId).not.toBe('mine')
  })

  it('anchors charts over their cells with their offsets, moving and sizing with them as the drawing says', async () => {
    const spec: ChartSpec = { kind: 'line', series: [north], legend: 'none', labels: 'none' }
    const drawings = [
      chartDrawing('both', 's1', spec, { from: { column: 1, columnOffset: 12.5, row: 2, rowOffset: 3 }, to: { column: 8, columnOffset: 30.25, row: 17, rowOffset: 0 } }),
      chartDrawing('moves', 's1', spec, { at: 2, anchorType: '0' }),
      chartDrawing('stays', 's1', spec, { at: 3, anchorType: '2' })
    ]
    const { bytes } = await xlsxFromWorkbook(chartWorkbook(drawings))
    const xml = await (await JSZip.loadAsync(bytes)).file('xl/drawings/drawing1.xml')!.async('string')
    const { charts } = await readBack(bytes)

    expect(xml).toContain('<xdr:from><xdr:col>1</xdr:col><xdr:colOff>119063</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>28575</xdr:rowOff></xdr:from>')
    expect(xml.match(/<xdr:twoCellAnchor[^>]*>/g)).toEqual(['<xdr:twoCellAnchor>', '<xdr:twoCellAnchor editAs="oneCell">', '<xdr:twoCellAnchor editAs="absolute">'])
    expect(xml).toMatch(/<xdr:cNvPr id="\d+" name="Chart 1"\/>.*name="Chart 2".*name="Chart 3"/)
    expect(charts.map((chart) => [chart.drawingId, chart.anchorType, chart.sheetTransform])).toEqual([
      ['both', '1', drawings[0].sheetTransform],
      ['moves', '0', drawings[1].sheetTransform],
      ['stays', '2', drawings[2].sheetTransform]
    ])
    expect(charts[0].transform.width).toBeGreaterThan(0)
    expect(charts[0].axisAlignSheetTransform).toEqual(charts[0].sheetTransform)
  })

  it('names sheets in formulas as Excel does, quoting the names that need it', async () => {
    const spec: ChartSpec = { kind: 'column', series: [north], legend: 'none', labels: 'none' }
    const quoted = async (name: string) => {
      const { bytes } = await xlsxFromWorkbook(chartWorkbook([chartDrawing('c', 's1', spec)], [name, 'Points']))
      const chart = await (await JSZip.loadAsync(bytes)).file('xl/charts/chart1.xml')!.async('string')
      const { charts } = await readBack(await withoutHeraldPart(bytes))

      expect(charts[0].data.spec.series[0].values).toEqual(range('sheet-1', 1, 1, 4, 1))

      return /<c:val><c:numRef><c:f>([^<]*)<\/c:f>/.exec(chart)?.[1]
    }

    expect(await quoted('Sales')).toBe('Sales!$B$2:$B$5')
    expect(await quoted('Q1 sales')).toBe("'Q1 sales'!$B$2:$B$5")
    expect(await quoted("Bob's data")).toBe("'Bob''s data'!$B$2:$B$5")
    expect(await quoted('2024')).toBe("'2024'!$B$2:$B$5")
    expect(await quoted('R1C1')).toBe("'R1C1'!$B$2:$B$5")
    expect(await quoted('AB12')).toBe("'AB12'!$B$2:$B$5")
  })

  it('caches the cells’ values with their number formats, so the chart shows before Excel works it out', async () => {
    const spec: ChartSpec = { kind: 'line', series: [margin], legend: 'none', labels: 'none' }
    const { bytes } = await xlsxFromWorkbook(chartWorkbook([chartDrawing('c', 's1', spec)]))
    const chart = await (await JSZip.loadAsync(bytes)).file('xl/charts/chart1.xml')!.async('string')

    expect(chart).toContain("<c:tx><c:strRef><c:f>'Q1 sales'!$D$1</c:f><c:strCache><c:ptCount val=\"1\"/><c:pt idx=\"0\"><c:v>Margin</c:v></c:pt></c:strCache></c:strRef></c:tx>")
    expect(chart).toContain('<c:cat><c:strRef><c:f>\'Q1 sales\'!$A$2:$A$5</c:f><c:strCache><c:ptCount val="4"/><c:pt idx="0"><c:v>Jan</c:v></c:pt>')
    expect(chart).toContain('<c:numCache><c:formatCode>0%</c:formatCode><c:ptCount val="4"/><c:pt idx="0"><c:v>0.25</c:v></c:pt><c:pt idx="1"><c:v>0.31</c:v></c:pt>')
  })

  it('says which anchors of a file it wrote are charts, as reading them finds', async () => {
    const drawings = EVERY_KIND.slice(0, 3).map((spec, i) => chartDrawing(`c${i}`, 's1', spec, { at: i }))
    const { bytes } = await xlsxFromWorkbook(chartWorkbook(drawings))
    const pkg = await openPackage(bytes)
    const { charts } = await readBack(bytes)

    expect([...(await shownAnchors(pkg, pkg.sheets[0]))]).toEqual([0, 1, 2])
    expect(charts.map((chart) => chart.data.source?.anchor)).toEqual([0, 1, 2])
    expect(Object.keys(((await readHeraldPart(pkg))?.[HERALD_SECTION] ?? {}) as object)).toEqual(['Q1 sales'])
  })

  it('writes the series it can and passes over broken ones', async () => {
    const spec = { kind: 'line', series: [null, { values: { sheet: 's1' } }, north], legend: 'none', labels: 'none' } as unknown as ChartSpec
    const { bytes, losses } = await xlsxFromWorkbook(chartWorkbook([chartDrawing('c', 's1', spec)]))
    const { charts } = await readBack(await withoutHeraldPart(bytes))

    expect(losses).toEqual([])
    expect(charts[0].data.spec.series.map((series) => series.values)).toEqual([range('sheet-1', 1, 1, 4, 1)])
  })

  it('leaves out a chart whose cells are on a sheet since deleted', async () => {
    const spec: ChartSpec = { kind: 'column', series: [{ values: range('gone', 0, 0, 3, 0) }], legend: 'none', labels: 'none' }
    const { bytes, losses } = await xlsxFromWorkbook(chartWorkbook([chartDrawing('c', 's1', spec)]))

    expect(losses).toEqual(['Charts whose cells were all on sheets since deleted are left out of the file.'])
    expect((await openPackage(bytes)).files.some((path) => path.startsWith('xl/charts/'))).toBe(false)
  })
})
