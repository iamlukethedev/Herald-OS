import JSZip from 'jszip'
import { describe, expect, it, vi } from 'vitest'
import { withHeadlessSheets } from '../../../../src/features/office/sheets/headless.ts'
import { newSheet, type WorkbookSnapshot } from '../../workbook.ts'
import { parseRelationships, relsPathOf } from '../opc.ts'
import { workbookFromXlsx } from '../read.ts'
import { xlsxFromWorkbook } from '../write.ts'
import { attributesOf, elementsOf, firstElement } from '../xml.ts'
import { packageProblems } from './checks.ts'
import { DASHBOARD, keptWorkbook, PNG, THEME_ACCENTS } from './fixtures.ts'

/* Other features' readers and writers are left out, so these tests see only what keeping does. */
const charts = vi.hoisted(() => ({ shown: new Set<number>() }))

vi.mock('../charts/index.ts', () => ({ finishCharts: async () => {}, readCharts: async () => [], shownAnchors: async () => new Set(charts.shown) }))
vi.mock('../comments/index.ts', () => ({ finishComments: async () => {}, readComments: async () => [] }))

async function read(bytes: Uint8Array): Promise<WorkbookSnapshot> {
  return (await workbookFromXlsx(bytes, { id: 'book', name: 'Book' })).workbook
}

/** A written package, to look into. */
async function opened(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  const text = async (path: string) => (await zip.file(path)?.async('string')) ?? ''
  const workbook = await text('xl/workbook.xml')
  const workbookRels = parseRelationships('xl/workbook.xml', await text('xl/_rels/workbook.xml.rels'))
  const sheets = elementsOf(firstElement(workbook, 'sheets')?.inner ?? '', 'sheet').map(({ attributes }) => ({ ...attributes, path: workbookRels.find((rel) => rel.id === attributes['r:id'])?.target ?? '' }))
  const relationships = async (part: string) => parseRelationships(part, await text(relsPathOf(part)))
  const related = async (part: string, type: string) => (await relationships(part)).filter((rel) => rel.type.endsWith(`/${type}`)).map((rel) => rel.target)
  const files = (pattern: RegExp) => Object.keys(zip.files).filter((name) => pattern.test(name))

  return { zip, text, workbook, workbookRels, sheets, relationships, related, files, sheet: (name: string) => sheets.find((sheet) => sheet.name === name)?.path ?? '' }
}

describe('keeping the parts of a file that Herald does not show', () => {
  it('keeps a pivot table refreshed on opening, its slicer, a table, sparklines, pictures, shapes, charts and a chart sheet when a cell changes', async () => {
    const original = await keptWorkbook()
    const { snapshot } = await withHeadlessSheets(await read(original), ({ workbook }) => {
      workbook.getSheetByName('Sales')?.getRange('C2').setValue(150)
    })
    const { bytes, losses } = await xlsxFromWorkbook(snapshot, { original })
    const file = await opened(bytes)

    expect(await packageProblems(bytes)).toEqual([])
    expect(losses).toEqual([])
    expect(file.sheets.map((sheet) => sheet.name)).toEqual(['Sales', 'Summary', 'Chart1', 'Dashboard'])

    // The pivot table, its cache (refreshed on opening, over Sales) and its records.
    const [pivotTable] = await file.related(file.sheet('Summary'), 'pivotTable')
    const [cache] = await file.related(pivotTable, 'pivotCacheDefinition')
    const cacheXml = await file.text(cache)
    expect(attributesOf(/<pivotTableDefinition\b[^>]*>/.exec(await file.text(pivotTable))![0]).cacheId).toBe('7')
    expect(file.workbook).toMatch(/<pivotCaches><pivotCache cacheId="7" r:id="rId\d+"\/><\/pivotCaches>/)
    expect(cacheXml).toMatch(/<pivotCacheDefinition\b[^>]*\srefreshOnLoad="1"/)
    expect(cacheXml).toContain('<worksheetSource ref="A1:C7" sheet="Sales"/>')
    expect(await file.related(cache, 'pivotCacheRecords')).toHaveLength(1)

    // The pivot table's number format and bold values, in Herald's style sheet.
    const styles = await file.text('xl/styles.xml')
    const format = /<numFmt numFmtId="(\d+)" formatCode="#,##0&quot; kg&quot;"\/>/.exec(styles)?.[1]
    expect(format).toBeDefined()
    expect(await file.text(pivotTable)).toContain(`<dataField name="Sum of Amount" fld="2" baseField="0" baseItem="0" numFmtId="${format}"/>`)
    const dxf = Number(/<format dxfId="(\d+)">/.exec(await file.text(pivotTable))?.[1])
    expect(elementsOf(firstElement(styles, 'dxfs')!.inner, 'dxf')[dxf].outer).toContain('<b/>')

    // The slicer: its cache names Summary by its sheetId now, and its name is defined.
    const [slicerCache] = file.workbookRels.filter((rel) => rel.type.endsWith('/slicerCache')).map((rel) => rel.target)
    const summaryId = file.sheets.find((sheet) => sheet.name === 'Summary')?.sheetId
    expect(await file.text(slicerCache)).toContain(`<pivotTable tabId="${summaryId}" name="PivotTable1"/>`)
    expect(file.workbook).toMatch(/<x14:slicerCaches><x14:slicerCache r:id="rId\d+"\/><\/x14:slicerCaches>/)
    expect(file.workbook).toContain('<definedName name="Slicer_Region">#N/A</definedName>')
    expect(await file.related(file.sheet('Summary'), 'slicer')).toHaveLength(1)
    expect(await file.text(file.sheet('Summary'))).toMatch(/<x14:slicerList><x14:slicer r:id="rId\d+"\/><\/x14:slicerList>/)

    // The table, its column's format in Herald's style sheet, and the sparklines.
    const sales = await file.text(file.sheet('Sales'))
    const [table] = await file.related(file.sheet('Sales'), 'table')
    expect(sales).toMatch(/<tableParts count="1"><tablePart r:id="rId\d+"\/><\/tableParts>/)
    expect(await file.text(table)).toMatch(/<tableColumn id="2" name="Target" dataDxfId="\d+"\/>/)
    expect(sales).toContain('<xm:f>Sales!C2:C7</xm:f><xm:sqref>H2</xm:sqref>')

    // The dashboard's anchors, each with its parts, and the slicer's anchor on Summary.
    const [dashboardDrawing] = await file.related(file.sheet('Dashboard'), 'drawing')
    const drawingXml = await file.text(dashboardDrawing)
    expect([...drawingXml.matchAll(/<xdr:cNvPr id="(\d+)" name="([^"]*)"/g)].map((found) => found[2])).toEqual(['Picture 1', 'Rectangle 2', 'Chart 3', 'Chart 4', '', 'Chart 5'])
    const [image] = await file.related(dashboardDrawing, 'image')
    expect(await file.zip.file(image)!.async('uint8array')).toEqual(PNG)
    const chartParts = await file.related(dashboardDrawing, 'chart')
    expect(chartParts).toHaveLength(2)
    expect((await file.relationships(chartParts[0])).map((rel) => rel.type.split('/').pop())).toEqual(['chartStyle', 'chartColorStyle'])
    expect(await file.related(dashboardDrawing, 'chartEx')).toHaveLength(1)
    const [summaryDrawing] = await file.related(file.sheet('Summary'), 'drawing')
    expect(await file.text(summaryDrawing)).toContain('<sle:slicer xmlns:sle="http://schemas.microsoft.com/office/drawing/2010/slicer" name="Region"/>')

    // The chart sheet, back between Summary and Dashboard; the name on Dashboard follows it.
    const [chartSheetDrawing] = await file.related(file.sheet('Chart1'), 'drawing')
    expect(await file.related(chartSheetDrawing, 'chart')).toHaveLength(1)
    expect(file.workbook).toMatch(/<definedName name="Total" localSheetId="3">/)

    // The source's theme.
    expect(await file.text('xl/theme/theme1.xml')).toContain(`<a:accent1><a:srgbClr val="${THEME_ACCENTS[0]}"/></a:accent1>`)
  })
})

describe('second saves', () => {
  it('keeps each part once when a file Herald saved is saved again', async () => {
    const original = await keptWorkbook()
    const once = await xlsxFromWorkbook(await read(original), { original })
    const twice = await xlsxFromWorkbook(await read(once.bytes), { original: once.bytes })
    const [first, second] = [await opened(once.bytes), await opened(twice.bytes)]

    expect(await packageProblems(twice.bytes)).toEqual([])
    expect(twice.losses).toEqual([])
    expect(second.files(/./).sort()).toEqual(first.files(/./).sort())
    expect(second.sheets.map((sheet) => sheet.name)).toEqual(['Sales', 'Summary', 'Chart1', 'Dashboard'])
    expect(second.files(/^xl\/pivotCache\/pivotCacheDefinition/)).toHaveLength(1)
    expect(second.workbook.match(/<pivotCache /g)).toHaveLength(1)
    expect(second.workbook.match(/Slicer_Region/g)).toHaveLength(1)
    expect((await second.text(second.sheet('Sales'))).match(/sparklineGroup /g)).toHaveLength(1)
    const [drawing] = await second.related(second.sheet('Dashboard'), 'drawing')
    expect((await second.text(drawing)).match(/<xdr:twoCellAnchor/g)).toHaveLength(DASHBOARD.length)
  })
})

describe('sheets renamed, deleted and added', () => {
  it('writes a renamed data sheet’s new name into the pivot cache, the charts and the sparklines', async () => {
    const original = await keptWorkbook()
    const workbook = await read(original)
    workbook.sheets['sheet-1'].name = 'Revenue'
    const { bytes, losses } = await xlsxFromWorkbook(workbook, { original })
    const file = await opened(bytes)
    const [pivotTable] = await file.related(file.sheet('Summary'), 'pivotTable')
    const [cache] = await file.related(pivotTable, 'pivotCacheDefinition')
    const [drawing] = await file.related(file.sheet('Dashboard'), 'drawing')
    const [radar, bar] = await file.related(drawing, 'chart')
    const [chartEx] = await file.related(drawing, 'chartEx')

    expect(await packageProblems(bytes)).toEqual([])
    expect(losses).toEqual([])
    expect(await file.text(cache)).toMatch(/<worksheetSource ref="A1:C7" sheet="Revenue"\/>/)
    expect(await file.text(cache)).toContain('refreshOnLoad="1"')
    expect(await file.text(radar)).toContain('<c:f>Revenue!$C$2:$C$7</c:f>')
    expect(await file.text(radar)).not.toContain('Sales!')
    expect(await file.text(bar)).toContain('<c:f>Revenue!$A$2:$A$7</c:f>')
    expect(await file.text(chartEx)).toContain('<cx:f>Revenue!$C$1</cx:f>')
    expect(await file.text(file.sheet('Revenue'))).toContain('<xm:f>Revenue!C2:C7</xm:f>')
  })

  it('drops the pivot table, its cache, its slicer and the slicer’s anchor with the sheet they are on', async () => {
    const original = await keptWorkbook()
    const workbook = await read(original)
    delete workbook.sheets['sheet-2']
    workbook.sheetOrder = workbook.sheetOrder.filter((id) => id !== 'sheet-2')
    const { bytes, losses } = await xlsxFromWorkbook(workbook, { original })
    const file = await opened(bytes)

    expect(await packageProblems(bytes)).toEqual([])
    expect(losses).toEqual([])
    expect(file.sheets.map((sheet) => sheet.name)).toEqual(['Sales', 'Chart1', 'Dashboard'])
    expect(file.files(/^xl\/(pivotTables|pivotCache|slicers|slicerCaches)\//)).toEqual([])
    expect(file.workbook).not.toMatch(/pivotCaches|slicerCaches/)
    expect(file.files(/^xl\/drawings\/drawing\d+\.xml$/)).toHaveLength(2)
  })

  it('keeps the pivot cache as it was, without refreshing it, when its data sheet is gone, and drops the charts of that sheet', async () => {
    const original = await keptWorkbook()
    const workbook = await read(original)
    delete workbook.sheets['sheet-1']
    workbook.sheetOrder = workbook.sheetOrder.filter((id) => id !== 'sheet-1')
    const { bytes, losses } = await xlsxFromWorkbook(workbook, { original })
    const file = await opened(bytes)
    const [pivotTable] = await file.related(file.sheet('Summary'), 'pivotTable')
    const [cache] = await file.related(pivotTable, 'pivotCacheDefinition')
    const [drawing] = await file.related(file.sheet('Dashboard'), 'drawing')

    expect(await packageProblems(bytes)).toEqual([])
    expect(await file.text(cache)).toContain('<worksheetSource ref="A1:C7" sheet="Sales"/>')
    expect(await file.text(cache)).not.toContain('refreshOnLoad')
    expect([...(await file.text(drawing)).matchAll(/<xdr:cNvPr id="\d+" name="([^"]+)"/g)].map((found) => found[1])).toEqual(['Picture 1', 'Rectangle 2'])
    expect(file.sheets.map((sheet) => sheet.name)).toEqual(['Summary', 'Dashboard'])
    expect(losses).toEqual(['Charts on Dashboard that showed a deleted sheet’s data are not kept.', 'The chart sheet Chart1 is left out: the sheet its chart showed is gone.'])
  })

  it('puts the chart sheet after the sheet it followed when sheets are added and moved', async () => {
    const original = await keptWorkbook()
    const workbook = await read(original)
    workbook.sheets.added = newSheet('added', 'Notes')
    workbook.sheetOrder = ['added', 'sheet-4', 'sheet-1', 'sheet-2']
    const { bytes, losses } = await xlsxFromWorkbook(workbook, { original })
    const file = await opened(bytes)

    expect(await packageProblems(bytes)).toEqual([])
    expect(losses).toEqual([])
    expect(file.sheets.map((sheet) => sheet.name)).toEqual(['Notes', 'Dashboard', 'Sales', 'Summary', 'Chart1'])
    expect(file.workbook).toMatch(/<definedName name="Total" localSheetId="1">/)
  })
})

describe('tables', () => {
  it('makes a table a plain range when its headers changed, and says so', async () => {
    const original = await keptWorkbook()
    const { snapshot } = await withHeadlessSheets(await read(original), ({ workbook }) => {
      workbook.getSheetByName('Sales')?.getRange('F1').setValue('Goal')
    })
    const { bytes, losses } = await xlsxFromWorkbook(snapshot, { original })
    const file = await opened(bytes)

    expect(await packageProblems(bytes)).toEqual([])
    expect(losses).toEqual(['The table Targets on Sales becomes a plain range: its headers changed.'])
    expect(file.files(/^xl\/tables\//)).toEqual([])
    expect(await file.text(file.sheet('Sales'))).not.toContain('tableParts')
  })

  it('makes a table a plain range when merged cells overlap it', async () => {
    const original = await keptWorkbook()
    const workbook = await read(original)
    workbook.sheets['sheet-1'].mergeData = [{ startRow: 2, endRow: 3, startColumn: 5, endColumn: 5 }]
    const { losses } = await xlsxFromWorkbook(workbook, { original })

    expect(losses).toEqual(['The table Targets on Sales becomes a plain range: merged cells overlap it.'])
  })
})

describe('charts Herald shows', () => {
  it('leaves an anchor Herald reads as a chart to the charts it writes', async () => {
    const original = await keptWorkbook()
    charts.shown = new Set([DASHBOARD.indexOf('bar')])

    try {
      const { bytes } = await xlsxFromWorkbook(await read(original), { original })
      const file = await opened(bytes)
      const [drawing] = await file.related(file.sheet('Dashboard'), 'drawing')

      expect(await packageProblems(bytes)).toEqual([])
      expect(await file.text(drawing)).not.toContain('Chart 5')
      expect(await file.related(drawing, 'chart')).toHaveLength(1)
      expect(file.files(/^xl\/charts\/chart\d+\.xml$/)).toHaveLength(2)
    } finally {
      charts.shown = new Set()
    }
  })
})
