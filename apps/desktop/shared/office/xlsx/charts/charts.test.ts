import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { CHART_COMPONENT, CHART_DRAWING_TYPE, type CellOffset, type ChartDrawing, type ChartSpec, DRAWING_RESOURCE } from '../../charts.ts'
import { CELL_TYPE, type CellMatrix, newSheet, newWorkbook, type WorkbookSnapshot } from '../../workbook.ts'
import { HERALD_PART, readHeraldPart } from '../herald-part.ts'
import { openPackage } from '../package.ts'
import { workbookFromXlsx } from '../read.ts'
import { readResource } from '../rules.ts'
import { xlsxFromWorkbook } from '../write.ts'
import { HERALD_SECTION, shownAnchors, withSheets } from './index.ts'
import { NOTES } from './read.ts'

/* Charts made in Herald written into .xlsx files and read back: from the chart parts alone, and exactly through Herald's part. */

type Drawings = Record<string, { data: Record<string, ChartDrawing>; order: string[] }>

const range = (sheet: string, startRow: number, startColumn: number, endRow = startRow, endColumn = startColumn) => ({ sheet, startRow, startColumn, endRow, endColumn })

function cellsOf(rows: (string | number)[][], style?: (row: number, column: number) => string | undefined): CellMatrix {
  return Object.fromEntries(
    rows.map((row, r) => [
      r,
      Object.fromEntries(row.map((value, c) => [c, { v: value, t: typeof value === 'number' ? CELL_TYPE.number : CELL_TYPE.string, ...(style?.(r, c) ? { s: style(r, c) } : {}) }]))
    ])
  )
}

const SALES = cellsOf(
  [
    ['Month', 'North', 'South', 'Margin'],
    ['Jan', 120, 80, 0.25],
    ['Feb', 135, 95, 0.31],
    ['Mar', 150, 70, 0.28],
    ['Apr', 110, 105, 0.35]
  ],
  (row, column) => (row > 0 && column === 3 ? 'percent' : undefined)
)
const POINTS = cellsOf([['X', 'Y'], [1, 2.5], [2, 3.1], [3, 4.8], [4, 4.2], [5, 6]])

const months = range('s1', 1, 0, 4, 0)
const north = { name: { cell: range('s1', 0, 1) }, values: range('s1', 1, 1, 4, 1), categories: months }
const south = { name: { cell: range('s1', 0, 2) }, values: range('s1', 1, 2, 4, 2), categories: months }
const margin = { name: { cell: range('s1', 0, 3) }, values: range('s1', 1, 3, 4, 3), categories: months }

function chartDrawing(id: string, sheet: string, spec: ChartSpec, options: { at?: number; from?: CellOffset; to?: CellOffset; anchorType?: '0' | '1' | '2' } = {}): ChartDrawing {
  const at = options.at ?? 0
  const from = options.from ?? { column: 6, columnOffset: 0, row: at * 16, rowOffset: 0 }
  const to = options.to ?? { column: 13, columnOffset: 0, row: at * 16 + 15, rowOffset: 0 }

  return {
    unitId: 'book',
    subUnitId: sheet,
    drawingId: id,
    drawingType: CHART_DRAWING_TYPE,
    componentKey: CHART_COMPONENT,
    sheetTransform: { from, to },
    axisAlignSheetTransform: { from, to },
    transform: { left: 0, top: 0, width: 0, height: 0 },
    ...(options.anchorType ? { anchorType: options.anchorType } : {}),
    allowTransform: true,
    data: { herald: 'chart', version: 1, spec }
  }
}

function workbookWith(drawings: ChartDrawing[], names: [string, string] = ['Q1 sales', 'Points']): WorkbookSnapshot {
  const book = newWorkbook('book', 'Book', [newSheet('s1', names[0], structuredClone(SALES)), newSheet('s2', names[1], structuredClone(POINTS))])
  const resource: Drawings = {}

  for (const drawing of drawings) {
    resource[drawing.subUnitId] ??= { data: {}, order: [] }
    resource[drawing.subUnitId].data[drawing.drawingId] = drawing
    resource[drawing.subUnitId].order.push(drawing.drawingId)
  }

  return { ...book, styles: { percent: { n: { pattern: '0%' } } }, resources: [{ name: DRAWING_RESOURCE, data: JSON.stringify(resource) }] }
}

const READ_IDS: Record<string, string> = { s1: 'sheet-1', s2: 'sheet-2' }
const asRead = (spec: ChartSpec): ChartSpec => withSheets(spec, (sheet) => READ_IDS[sheet] ?? sheet)

async function withoutHeraldPart(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  zip.remove(HERALD_PART)

  return zip.generateAsync({ type: 'uint8array' })
}

async function readBack(bytes: Uint8Array) {
  const { workbook, notes } = await workbookFromXlsx(bytes, { id: 'book', name: 'Book' })
  const drawings = readResource<Drawings>(workbook.resources, DRAWING_RESOURCE) ?? {}
  const charts = Object.values(drawings).flatMap((sheet) => sheet.order.map((id) => sheet.data[id]))

  return { workbook, notes, drawings, charts }
}

/** One chart of each kind, as its chart part says it exactly: colours, gridlines, series types and markers written out. */
const EVERY_KIND: ChartSpec[] = [
  {
    kind: 'column',
    title: 'Quarterly sales',
    series: [
      { ...north, color: '#1f4e79' },
      { ...south, color: '#c55a11' }
    ],
    stacking: 'stacked',
    legend: 'bottom',
    labels: 'value',
    axes: { x: { gridlines: false, title: 'Month' }, y: { gridlines: true, title: 'Units', min: 0, max: 300, format: '#,##0' } }
  },
  { kind: 'bar', title: 'By region', series: [{ name: { text: 'North' }, values: north.values, categories: months, color: '#2e75b6' }], legend: 'none', labels: 'category', axes: { x: { gridlines: true }, y: { gridlines: false, hidden: true } } },
  {
    kind: 'line',
    series: [
      { ...north, color: '#1f4e79', markers: true, smooth: true },
      { ...south, color: '#548235', markers: false }
    ],
    legend: 'top',
    labels: 'none',
    axes: { x: { gridlines: false }, y: { gridlines: true } }
  },
  {
    kind: 'area',
    title: 'Two lines\nof title',
    series: [
      { ...north, color: '#1f4e79' },
      { ...south, color: '#c55a11' }
    ],
    stacking: 'percent',
    legend: 'right',
    labels: 'none',
    axes: { x: { gridlines: false }, y: { gridlines: true, format: '0%' } }
  },
  { kind: 'pie', title: 'North', series: [north], legend: 'right', labels: 'percent', palette: ['#1f4e79', '#c55a11', '#7f7f7f', '#bf8f00'] },
  { kind: 'doughnut', series: [north, south], legend: 'bottom', labels: 'category', palette: ['#2e75b6', '#548235', '#bf8f00', '#7030a0'], hole: 60 },
  {
    kind: 'scatter',
    title: 'Growth',
    series: [{ name: { cell: range('s2', 0, 1) }, values: range('s2', 1, 1, 5, 1), categories: range('s2', 1, 0, 5, 0), color: '#1f4e79' }],
    legend: 'none',
    labels: 'value',
    axes: { x: { gridlines: true, min: 0, max: 6, title: 'X' }, y: { gridlines: false, title: 'Y' } }
  },
  {
    kind: 'combo',
    title: 'Sales and margin',
    series: [
      { ...north, color: '#1f4e79', type: 'column' },
      { ...south, color: '#c55a11', type: 'area' },
      { ...margin, color: '#548235', type: 'line', secondary: true, markers: true }
    ],
    stacking: 'stacked',
    legend: 'bottom',
    labels: 'none',
    axes: { x: { gridlines: false }, y: { gridlines: true, title: 'Units' }, y2: { gridlines: false, min: 0, max: 0.5, format: '0%', title: 'Margin' } }
  }
]

describe('charts written into a file and read back', () => {
  it('gives back every kind from its chart part alone: titles, axes, legend, labels, colours, stacking, hole, secondary axis', async () => {
    const drawings = EVERY_KIND.map((spec, i) => chartDrawing(`c${i}`, spec.kind === 'scatter' ? 's2' : 's1', spec, { at: i }))
    const { bytes, losses } = await xlsxFromWorkbook(workbookWith(drawings))
    const { charts, notes } = await readBack(await withoutHeraldPart(bytes))

    expect(losses).toEqual([])
    expect(notes.filter((note) => (Object.values(NOTES) as string[]).includes(note))).toEqual([])
    expect(charts.map((chart) => chart.data.spec.kind).sort()).toEqual(EVERY_KIND.map((spec) => spec.kind).sort())

    for (const spec of EVERY_KIND) {
      expect(charts.find((chart) => chart.data.spec.kind === spec.kind)!.data.spec).toEqual(asRead(spec))
    }
  })

  it('gives back the exact spec through Herald’s part: its palette, label mode, fields Excel has no place for, and the drawing’s id', async () => {
    const spec = { kind: 'column', series: [{ values: north.values, categories: months }, { values: south.values }], legend: 'right', labels: 'percent', palette: ['#111111', '#222222'], axes: { y: { max: 200 } }, later: { field: [1, 2] } } as ChartSpec
    const { bytes, losses } = await xlsxFromWorkbook(workbookWith([chartDrawing('mine', 's1', spec)]))
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
    const { bytes } = await xlsxFromWorkbook(workbookWith([chartDrawing('mine', 's1', spec)]))
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
    const { bytes } = await xlsxFromWorkbook(workbookWith([chartDrawing('combo', 's1', combo), chartDrawing('ring', 's1', doughnut, { at: 1 })]))
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
    const { bytes } = await xlsxFromWorkbook(workbookWith([chartDrawing('mine', 's1', spec)]))
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
    const { bytes } = await xlsxFromWorkbook(workbookWith(drawings))
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
      const { bytes } = await xlsxFromWorkbook(workbookWith([chartDrawing('c', 's1', spec)], [name, 'Points']))
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
    const { bytes } = await xlsxFromWorkbook(workbookWith([chartDrawing('c', 's1', spec)]))
    const chart = await (await JSZip.loadAsync(bytes)).file('xl/charts/chart1.xml')!.async('string')

    expect(chart).toContain("<c:tx><c:strRef><c:f>'Q1 sales'!$D$1</c:f><c:strCache><c:ptCount val=\"1\"/><c:pt idx=\"0\"><c:v>Margin</c:v></c:pt></c:strCache></c:strRef></c:tx>")
    expect(chart).toContain('<c:cat><c:strRef><c:f>\'Q1 sales\'!$A$2:$A$5</c:f><c:strCache><c:ptCount val="4"/><c:pt idx="0"><c:v>Jan</c:v></c:pt>')
    expect(chart).toContain('<c:numCache><c:formatCode>0%</c:formatCode><c:ptCount val="4"/><c:pt idx="0"><c:v>0.25</c:v></c:pt><c:pt idx="1"><c:v>0.31</c:v></c:pt>')
  })

  it('says which anchors of a file it wrote are charts, as reading them finds', async () => {
    const drawings = EVERY_KIND.slice(0, 3).map((spec, i) => chartDrawing(`c${i}`, 's1', spec, { at: i }))
    const { bytes } = await xlsxFromWorkbook(workbookWith(drawings))
    const pkg = await openPackage(bytes)
    const { charts } = await readBack(bytes)

    expect([...(await shownAnchors(pkg, pkg.sheets[0]))]).toEqual([0, 1, 2])
    expect(charts.map((chart) => chart.data.source?.anchor)).toEqual([0, 1, 2])
    expect(Object.keys(((await readHeraldPart(pkg))?.[HERALD_SECTION] ?? {}) as object)).toEqual(['Q1 sales'])
  })

  it('leaves out a chart whose cells are on a sheet since deleted', async () => {
    const spec: ChartSpec = { kind: 'column', series: [{ values: range('gone', 0, 0, 3, 0) }], legend: 'none', labels: 'none' }
    const { bytes, losses } = await xlsxFromWorkbook(workbookWith([chartDrawing('c', 's1', spec)]))

    expect(losses).toEqual(['Charts whose cells were all on sheets since deleted are left out of the file.'])
    expect((await openPackage(bytes)).files.some((path) => path.startsWith('xl/charts/'))).toBe(false)
  })
})
