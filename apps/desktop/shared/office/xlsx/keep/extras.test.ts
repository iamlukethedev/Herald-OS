import JSZip from 'jszip'
import { describe, expect, it, vi } from 'vitest'
import type { WorkbookSnapshot } from '../../workbook.ts'
import { workbookFromXlsx } from '../read.ts'
import { readResource, RESOURCES, type UDefinedName, WORKBOOK_SCOPE } from '../rules.ts'
import { xlsxFromWorkbook } from '../write.ts'
import { openedPackage as opened, packageProblems } from './checks.ts'
import { keptWorkbook, PNG, withParts } from './fixtures.ts'

/* Other features' readers and writers are left out, so these tests see only what keeping does. */
vi.mock('../charts/index.ts', () => ({ finishCharts: async () => {}, readCharts: async () => [], shownAnchors: async () => new Set() }))
vi.mock('../comments/index.ts', () => ({ finishComments: async () => {}, readComments: async () => [] }))

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const X15 = 'http://schemas.microsoft.com/office/spreadsheetml/2010/11/main'
const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'

async function read(bytes: Uint8Array): Promise<WorkbookSnapshot> {
  return (await workbookFromXlsx(bytes, { id: 'book', name: 'Book' })).workbook
}

function remove(workbook: WorkbookSnapshot, id: string): WorkbookSnapshot {
  delete workbook.sheets[id]
  workbook.sheetOrder = workbook.sheetOrder.filter((entry) => entry !== id)

  return workbook
}

/** Links to another workbook, a formula using them, custom properties and a background picture. */
const workbookExtras = {
  files: {
    'xl/externalLinks/externalLink1.xml': `${HEAD}<externalLink xmlns="${MAIN}" xmlns:r="${R}"><externalBook r:id="rId1"><sheetNames><sheetName val="Prices"/></sheetNames><sheetDataSet><sheetData sheetId="0"><row r="1"><cell r="A1"><v>2.5</v></cell></row></sheetData></sheetDataSet></externalBook></externalLink>`,
    'docProps/custom.xml': `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Department"><vt:lpwstr>Fixtures</vt:lpwstr></property></Properties>`,
    'xl/media/image2.png': PNG
  },
  relationships: {
    'xl/externalLinks/externalLink1.xml': [['rId1', `${R}/externalLinkPath`, 'Prices.xlsx', true]] as [string, string, string, boolean][],
    'xl/workbook.xml': [['rId20', `${R}/externalLink`, 'externalLinks/externalLink1.xml']] as [string, string, string][],
    '': [['rId4', `${R}/custom-properties`, 'docProps/custom.xml']] as [string, string, string][],
    'xl/worksheets/sheet3.xml': [['rId2', `${R}/image`, '../media/image2.png']] as [string, string, string][]
  },
  types: {
    'xl/externalLinks/externalLink1.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml',
    'docProps/custom.xml': 'application/vnd.openxmlformats-officedocument.custom-properties+xml'
  },
  change: {
    'xl/workbook.xml': (xml: string) => xml.replace('<definedNames>', '<externalReferences><externalReference r:id="rId20"/></externalReferences><definedNames>'),
    'xl/worksheets/sheet1.xml': (xml: string) => xml.replace('</row><row r="3">', '<c r="D2"><f>[1]Prices!A1</f><v>2.5</v></c></row><row r="3">'),
    'xl/worksheets/sheet3.xml': (xml: string) => xml.replace('<drawing r:id="rId1"/>', '<drawing r:id="rId1"/><picture r:id="rId2"/>')
  }
}

/** A timeline on the pivot table, on Summary beside the slicer. */
const timeline = {
  files: {
    'xl/timelineCaches/timelineCache1.xml': `${HEAD}<timelineCacheDefinition xmlns="${X15}" xmlns:mc="${MC}" mc:Ignorable="x" xmlns:x="${MAIN}" name="NativeTimeline_Date" sourceName="Date"><pivotTables><pivotTable tabId="3" name="PivotTable1"/></pivotTables><state minimalRefreshVersion="6" lastRefreshVersion="6" pivotCacheId="1" filterType="unknown"><bounds startDate="2026-01-01T00:00:00" endDate="2027-01-01T00:00:00"/></state></timelineCacheDefinition>`,
    'xl/timelines/timeline1.xml': `${HEAD}<timelines xmlns="${X15}" xmlns:mc="${MC}" mc:Ignorable="x" xmlns:x="${MAIN}"><timeline name="Date" cache="NativeTimeline_Date" caption="Date" level="2" selectionLevel="2" style="MyTimelineStyle"/></timelines>`
  },
  relationships: {
    'xl/workbook.xml': [['rId21', 'http://schemas.microsoft.com/office/2011/relationships/timelineCache', 'timelineCaches/timelineCache1.xml']] as [string, string, string][],
    'xl/worksheets/sheet2.xml': [['rId4', 'http://schemas.microsoft.com/office/2011/relationships/timeline', '../timelines/timeline1.xml']] as [string, string, string][]
  },
  types: {
    'xl/timelineCaches/timelineCache1.xml': 'application/vnd.ms-excel.timelineCache+xml',
    'xl/timelines/timeline1.xml': 'application/vnd.ms-excel.timeline+xml'
  },
  change: {
    'xl/workbook.xml': (xml: string) =>
      xml.replace('</definedNames>', '<definedName name="NativeTimeline_Date">#N/A</definedName></definedNames>').replace('</extLst>', `<ext uri="{D0CA8CA8-9F24-4464-BF8E-62219DCF47F9}" xmlns:x15="${X15}"><x15:timelineCacheRefs><x15:timelineCacheRef r:id="rId21"/></x15:timelineCacheRefs></ext></extLst>`),
    'xl/worksheets/sheet2.xml': (xml: string) => xml.replace('</extLst>', `<ext uri="{7E03D99C-DC04-49d9-9315-930204A7B6E9}" xmlns:x15="${X15}"><x15:timelineRefs><x15:timelineRef r:id="rId4"/></x15:timelineRefs></ext></extLst>`),
    'xl/drawings/drawing2.xml': (xml: string) =>
      xml.replace(
        '</xdr:wsDr>',
        `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:tsle="http://schemas.microsoft.com/office/drawing/2012/timeslicer" Requires="tsle"><xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="Date"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2012/timeslicer"><tsle:timeslicer xmlns:tsle="http://schemas.microsoft.com/office/drawing/2012/timeslicer" name="Date"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></mc:Choice></mc:AlternateContent></xdr:wsDr>`
      )
  }
}

/** A SmartArt diagram on the dashboard, with its drawing, whose data names it through the dashboard drawing's relationships. */
const smartArt = {
  files: {
    'xl/diagrams/data1.xml': `${HEAD}<dgm:dataModel xmlns:dgm="${DGM}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst><dgm:pt modelId="{1}" type="doc"/></dgm:ptLst><dgm:cxnLst/><dgm:bg/><dgm:whole/><dgm:extLst><a:ext uri="http://schemas.microsoft.com/office/drawing/2008/diagram"><dsp:dataModelExt xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" relId="rId14" minVer="http://schemas.openxmlformats.org/drawingml/2006/diagram"/></a:ext></dgm:extLst></dgm:dataModel>`,
    'xl/diagrams/layout1.xml': `${HEAD}<dgm:layoutDef xmlns:dgm="${DGM}" uniqueId="urn:microsoft.com/office/officeart/2005/8/layout/default"/>`,
    'xl/diagrams/quickStyle1.xml': `${HEAD}<dgm:styleDef xmlns:dgm="${DGM}" uniqueId="urn:microsoft.com/office/officeart/2005/8/quickstyle/simple1"/>`,
    'xl/diagrams/colors1.xml': `${HEAD}<dgm:colorsDef xmlns:dgm="${DGM}" uniqueId="urn:microsoft.com/office/officeart/2005/8/colors/accent1_2"/>`,
    'xl/diagrams/drawing1.xml': `${HEAD}<dsp:drawing xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram"/>`
  },
  relationships: {
    'xl/drawings/drawing1.xml': [
      ['rId10', `${R}/diagramData`, '../diagrams/data1.xml'],
      ['rId11', `${R}/diagramLayout`, '../diagrams/layout1.xml'],
      ['rId12', `${R}/diagramQuickStyle`, '../diagrams/quickStyle1.xml'],
      ['rId13', `${R}/diagramColors`, '../diagrams/colors1.xml'],
      ['rId14', 'http://schemas.microsoft.com/office/2007/relationships/diagramDrawing', '../diagrams/drawing1.xml']
    ] as [string, string, string][]
  },
  types: {
    'xl/diagrams/data1.xml': 'application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml',
    'xl/diagrams/layout1.xml': 'application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml',
    'xl/diagrams/quickStyle1.xml': 'application/vnd.openxmlformats-officedocument.drawingml.diagramStyle+xml',
    'xl/diagrams/colors1.xml': 'application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml',
    'xl/diagrams/drawing1.xml': 'application/vnd.ms-office.drawingml.diagramDrawing+xml'
  },
  change: {
    'xl/drawings/drawing1.xml': (xml: string) =>
      xml.replace(
        '</xdr:wsDr>',
        `<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>26</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>40</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="7" name="Diagram 6"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${DGM}"><dgm:relIds xmlns:dgm="${DGM}" xmlns:r="${R}" r:dm="rId10" r:lo="rId11" r:qs="rId12" r:cs="rId13"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`
      )
  }
}

describe('what else the source file holds', () => {
  it('keeps links to other workbooks in their order, custom properties and a background picture', async () => {
    const original = await withParts(await keptWorkbook(), workbookExtras)
    const { bytes, losses } = await xlsxFromWorkbook(await read(original), { original })
    const file = await opened(bytes)
    const [link] = file.workbookRels.filter((rel) => rel.type.endsWith('/externalLink'))

    expect(await packageProblems(bytes)).toEqual([])
    expect(losses).toEqual([])
    expect(file.workbook).toContain(`<externalReferences><externalReference r:id="${link.id}"/></externalReferences>`)
    expect(await file.relationships(link.target)).toEqual([{ id: 'rId1', type: `${R}/externalLinkPath`, target: 'Prices.xlsx', external: true }])
    expect(await file.text(file.sheet('Sales'))).toContain('<f>[1]Prices!A1</f>')
    expect(await file.related('', 'custom-properties')).toEqual(['docProps/custom.xml'])
    expect(await file.text('docProps/custom.xml')).toContain('<vt:lpwstr>Fixtures</vt:lpwstr>')
    const [picture] = await file.related(file.sheet('Dashboard'), 'image')
    expect(await file.zip.file(picture)!.async('uint8array')).toEqual(PNG)
    expect(await file.text(file.sheet('Dashboard'))).toMatch(/<drawing r:id="rId\d+"\/><picture r:id="rId\d+"\/>/)
  })

  it('keeps a timeline with its pivot table, and drops it with the pivot table’s sheet', async () => {
    const original = await withParts(await keptWorkbook(), timeline)
    const kept = await xlsxFromWorkbook(await read(original), { original })
    const file = await opened(kept.bytes)
    const [cache] = file.workbookRels.filter((rel) => rel.type.endsWith('/timelineCache')).map((rel) => rel.target)
    const [part] = await file.related(file.sheet('Summary'), 'timeline')
    const [drawing] = await file.related(file.sheet('Summary'), 'drawing')

    expect(await packageProblems(kept.bytes)).toEqual([])
    expect(await file.text(cache)).toContain(`<pivotTable tabId="${file.sheets.find((sheet) => sheet.name === 'Summary')?.sheetId}" name="PivotTable1"/>`)
    expect(await file.text(part)).not.toContain('MyTimelineStyle')
    expect(file.workbook).toMatch(/<x15:timelineCacheRefs><x15:timelineCacheRef r:id="rId\d+"\/><\/x15:timelineCacheRefs>/)
    expect(await file.text(file.sheet('Summary'))).toMatch(/<x15:timelineRefs><x15:timelineRef r:id="rId\d+"\/><\/x15:timelineRefs>/)
    expect(await file.text(drawing)).toContain('name="Date"/></a:graphicData>')

    const dropped = await xlsxFromWorkbook(remove(await read(original), 'sheet-2'), { original })
    const without = await opened(dropped.bytes)

    expect(await packageProblems(dropped.bytes)).toEqual([])
    expect(without.files(/^xl\/(timelines|timelineCaches)\//)).toEqual([])
    expect(without.workbook).not.toContain('timelineCache')
  })

  it('keeps SmartArt from its data and layout, without the drawing the data names through the sheet’s drawing', async () => {
    const original = await withParts(await keptWorkbook({ dashboard: ['picture'] }), smartArt)
    const { bytes, losses } = await xlsxFromWorkbook(await read(original), { original })
    const file = await opened(bytes)
    const [drawing] = await file.related(file.sheet('Dashboard'), 'drawing')
    const [data] = await file.related(drawing, 'diagramData')

    expect(await packageProblems(bytes)).toEqual([])
    expect(losses).toEqual([])
    expect(await file.text(drawing)).toMatch(/<dgm:relIds xmlns:dgm="[^"]+" xmlns:r="[^"]+" r:dm="rId\d+" r:lo="rId\d+" r:qs="rId\d+" r:cs="rId\d+"\/>/)
    expect((await file.relationships(drawing)).map((rel) => rel.type.split('/').pop())).toEqual(['image', 'diagramData', 'diagramLayout', 'diagramQuickStyle', 'diagramColors'])
    expect(await file.text(data)).not.toContain('dataModelExt')
    expect(file.files(/^xl\/diagrams\//)).toHaveLength(4)
  })

  it('keeps a pivot chart by its pivot table’s sheet name now, and makes it a chart of its cells without that pivot table', async () => {
    const pivotChart = (xml: string) => xml.replace('<c:roundedCorners val="0"/>', '<c:roundedCorners val="0"/><c:pivotSource><c:name>[Book.xlsx]Summary!PivotTable1</c:name><c:fmtId val="0"/></c:pivotSource>').replace('<c:autoTitleDeleted val="0"/>', '<c:autoTitleDeleted val="0"/><c:pivotFmts><c:pivotFmt><c:idx val="0"/></c:pivotFmt></c:pivotFmts>')
    const original = await withParts(await keptWorkbook({ dashboard: ['radar'] }), { change: { 'xl/charts/chart1.xml': pivotChart } })
    const renamed = await read(original)
    renamed.sheets['sheet-2'].name = 'Totals'
    const kept = await opened((await xlsxFromWorkbook(renamed, { original })).bytes)
    const [chart] = await kept.related((await kept.related(kept.sheet('Dashboard'), 'drawing'))[0], 'chart')

    expect(await kept.text(chart)).toContain('<c:pivotSource><c:name>[Book.xlsx]Totals!PivotTable1</c:name>')

    const plain = await opened((await xlsxFromWorkbook(remove(await read(original), 'sheet-2'), { original })).bytes)
    const [cells] = await plain.related((await plain.related(plain.sheet('Dashboard'), 'drawing'))[0], 'chart')

    expect(await plain.text(cells)).not.toMatch(/pivotSource|pivotFmts/)
    expect(await plain.text(cells)).toContain('<c:f>Sales!$C$2:$C$7</c:f>')
  })

  it('keeps a shape’s link to a place in the workbook, with its sheet’s name now', async () => {
    const original = await withParts(await keptWorkbook({ dashboard: ['shape'] }), {
      relationships: { 'xl/drawings/drawing1.xml': [['rId9', `${R}/hyperlink`, '#Summary!A1']] },
      change: { 'xl/drawings/drawing1.xml': (xml) => xml.replace('<xdr:cNvPr id="3" name="Rectangle 2"/>', `<xdr:cNvPr id="3" name="Rectangle 2"><a:hlinkClick xmlns:r="${R}" r:id="rId9"/></xdr:cNvPr>`) }
    })
    const workbook = await read(original)
    workbook.sheets['sheet-2'].name = 'Totals'
    const { bytes, losses } = await xlsxFromWorkbook(workbook, { original })
    const file = await opened(bytes)
    const [drawing] = await file.related(file.sheet('Dashboard'), 'drawing')

    expect(await packageProblems(bytes)).toEqual([])
    expect(losses).toEqual([])
    expect(await file.relationships(drawing)).toEqual([{ id: expect.any(String), type: `${R}/hyperlink`, target: '#Totals!A1', external: true }])
  })

  it('keeps a hidden chart sheet hidden', async () => {
    const original = await withParts(await keptWorkbook(), { change: { 'xl/workbook.xml': (xml) => xml.replace('<sheet name="Chart1" sheetId="5" r:id="rId3"/>', '<sheet name="Chart1" sheetId="5" state="hidden" r:id="rId3"/>') } })
    const { bytes } = await xlsxFromWorkbook(await read(original), { original })

    expect((await opened(bytes)).sheets.find((sheet) => sheet.name === 'Chart1')?.state).toBe('hidden')
  })
})

describe('slicers on another sheet than their pivot table', () => {
  /** The slicer moved from Summary, beside its pivot table, to the dashboard. */
  async function slicerOnDashboard(): Promise<Uint8Array> {
    const source = await keptWorkbook({ chartSheet: false, dashboard: ['picture'] })
    const anchor = /<mc:AlternateContent[\s\S]*<\/mc:AlternateContent>/.exec((await (await JSZip.loadAsync(source)).file('xl/drawings/drawing2.xml')!.async('string')) ?? '')![0]

    return withParts(source, {
      relationships: { 'xl/worksheets/sheet3.xml': [['rId3', 'http://schemas.microsoft.com/office/2007/relationships/slicer', '../slicers/slicer1.xml']] },
      change: {
        'xl/worksheets/_rels/sheet2.xml.rels': (xml) => xml.replace(/<Relationship Id="rId[23]"[^>]*\/>/g, ''),
        'xl/worksheets/sheet2.xml': (xml) => xml.replace(/<drawing r:id="rId2"\/><extLst>.*<\/extLst>/, ''),
        'xl/worksheets/sheet3.xml': (xml) => xml.replace('</worksheet>', '<extLst><ext uri="{A8765BA9-456A-4dab-B4F3-ACF838C121DE}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:slicerList><x14:slicer r:id="rId3"/></x14:slicerList></ext></extLst></worksheet>'),
        'xl/drawings/drawing1.xml': (xml) => xml.replace('</xdr:wsDr>', `${anchor.replace('id="2" name="Region"', 'id="9" name="Region"')}</xdr:wsDr>`)
      }
    })
  }

  it('drops the slicer’s cache with the sheet the slicer was on', async () => {
    const original = await slicerOnDashboard()
    // Without the chart sheet, the dashboard is the third sheet.
    const { bytes, losses } = await xlsxFromWorkbook(remove(await read(original), 'sheet-3'), { original })
    const file = await opened(bytes)

    expect(await packageProblems(bytes)).toEqual([])
    expect(losses).toEqual([])
    expect(file.files(/^xl\/(slicers|slicerCaches)\//)).toEqual([])
    expect(file.workbook).not.toContain('slicerCache')
    expect(await file.related(file.sheet('Summary'), 'pivotTable')).toHaveLength(1)
  })

  it('drops a slicer whose pivot table went with its sheet, and says so', async () => {
    const original = await slicerOnDashboard()
    const { bytes, losses } = await xlsxFromWorkbook(remove(await read(original), 'sheet-2'), { original })
    const file = await opened(bytes)
    const [drawing] = await file.related(file.sheet('Dashboard'), 'drawing')

    expect(await packageProblems(bytes)).toEqual([])
    expect(losses).toEqual(['The slicer Region on Dashboard is not kept: the pivot table it filtered is gone.'])
    expect(await file.text(drawing)).not.toContain('slicer')
    expect(await file.text(file.sheet('Dashboard'))).not.toContain('slicerList')
  })
})

describe('what cannot come along', () => {
  it('leaves out a chart sheet whose name a sheet now has', async () => {
    const original = await keptWorkbook()
    const workbook = await read(original)
    workbook.sheets['sheet-4'].name = 'Chart1'
    const { bytes, losses } = await xlsxFromWorkbook(workbook, { original })

    expect(await packageProblems(bytes)).toEqual([])
    expect(losses).toEqual(['The chart sheet Chart1 is left out: another sheet has its name.'])
    expect((await opened(bytes)).sheets.map((sheet) => sheet.name)).toEqual(['Sales', 'Summary', 'Chart1'])
  })

  it('makes a table a plain range when a defined name has its name', async () => {
    const original = await keptWorkbook()
    const workbook = await read(original)
    const names = readResource<Record<string, UDefinedName>>(workbook.resources, RESOURCES.definedNames) ?? {}
    names.clash = { id: 'clash', name: 'Targets', formulaOrRefString: 'Sales!$E$1', localSheetId: WORKBOOK_SCOPE }
    workbook.resources = (workbook.resources as { name: string; data: string }[]).map((resource) => (resource.name === RESOURCES.definedNames ? { ...resource, data: JSON.stringify(names) } : resource))
    const { bytes, losses } = await xlsxFromWorkbook(workbook, { original })

    expect(await packageProblems(bytes)).toEqual([])
    expect(losses).toEqual(['The table Targets on Sales becomes a plain range: a defined name has its name.'])
  })

  it('drops sparklines that showed a deleted sheet’s data, and says so', async () => {
    const sparklines = `<extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:sparklineGroup><x14:sparklines><x14:sparkline><xm:f>Sales!C2:C7</xm:f><xm:sqref>B2</xm:sqref></x14:sparkline></x14:sparklines></x14:sparklineGroup><x14:sparklineGroup><x14:sparklines><x14:sparkline><xm:f>Dashboard!A1:A3</xm:f><xm:sqref>B3</xm:sqref></x14:sparkline></x14:sparklines></x14:sparklineGroup></x14:sparklineGroups></ext></extLst>`
    const original = await withParts(await keptWorkbook({ chartSheet: false, dashboard: [] }), { change: { 'xl/worksheets/sheet3.xml': (xml) => xml.replace('</worksheet>', `${sparklines}</worksheet>`) } })
    const { bytes, losses } = await xlsxFromWorkbook(remove(await read(original), 'sheet-1'), { original })
    const dashboard = await (await opened(bytes)).text((await opened(bytes)).sheet('Dashboard'))

    expect(await packageProblems(bytes)).toEqual([])
    expect(losses).toEqual(['Sparklines on Dashboard that showed a deleted sheet’s data are not kept.'])
    expect(dashboard).toContain('<xm:f>Dashboard!A1:A3</xm:f>')
    expect(dashboard).not.toContain('Sales!')
  })
})

describe('pivot caches', () => {
  it('refreshes a cache over a table while the table is kept, and keeps it as it was once the table is not', async () => {
    const original = await withParts(await keptWorkbook(), { change: { 'xl/pivotCache/pivotCacheDefinition1.xml': (xml) => xml.replace('<worksheetSource ref="A1:C7" sheet="Sales"/>', '<worksheetSource name="Targets"/>') } })
    const cacheOf = async (bytes: Uint8Array) => {
      const file = await opened(bytes)

      return file.text((await file.related((await file.related(file.sheet('Summary'), 'pivotTable'))[0], 'pivotCacheDefinition'))[0])
    }
    const workbook = await read(original)

    expect(await cacheOf((await xlsxFromWorkbook(workbook, { original })).bytes)).toContain('refreshOnLoad="1"')

    workbook.sheets['sheet-1'].cellData[0][5] = { v: 'Goal', t: 1 }

    expect(await cacheOf((await xlsxFromWorkbook(workbook, { original })).bytes)).not.toContain('refreshOnLoad')
  })

  it('copies a cache two pivot tables share once, and lists it once', async () => {
    const source = await keptWorkbook({ chartSheet: false })
    const second = (await (await JSZip.loadAsync(source)).file('xl/pivotTables/pivotTable1.xml')!.async('string')).replace('name="PivotTable1"', 'name="PivotTable2"')
    const original = await withParts(source, {
      files: { 'xl/pivotTables/pivotTable2.xml': second },
      relationships: { 'xl/worksheets/sheet3.xml': [['rId2', `${R}/pivotTable`, '../pivotTables/pivotTable2.xml']], 'xl/pivotTables/pivotTable2.xml': [['rId1', `${R}/pivotCacheDefinition`, '../pivotCache/pivotCacheDefinition1.xml']] },
      types: { 'xl/pivotTables/pivotTable2.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml' }
    })
    const { bytes } = await xlsxFromWorkbook(await read(original), { original })
    const file = await opened(bytes)
    const caches = await Promise.all([...(await file.related(file.sheet('Summary'), 'pivotTable')), ...(await file.related(file.sheet('Dashboard'), 'pivotTable'))].map(async (table) => (await file.related(table, 'pivotCacheDefinition'))[0]))

    expect(await packageProblems(bytes)).toEqual([])
    expect(caches).toHaveLength(2)
    expect(new Set(caches).size).toBe(1)
    expect(file.files(/^xl\/pivotCache\/pivotCacheDefinition/)).toHaveLength(1)
    expect(file.workbook.match(/<pivotCache /g)).toHaveLength(1)
  })
})
