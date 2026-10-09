import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { type ChartSpec, DRAWING_RESOURCE } from '../../charts.ts'
import { children, type XmlElement } from '../../docx/xml.ts'
import { workbookFromXlsx } from '../read.ts'
import { readResource } from '../rules.ts'
import { xlsxFromWorkbook } from '../write.ts'
import { parsePart } from './drawingml.ts'
import { chartDrawing, chartWorkbook, everyKindWorkbook, excelWorkbook, range, SALES_SERIES } from './fixtures.ts'

/*
 * The chart and drawing parts Herald writes, their elements in the order ECMA-376 gives them (Excel
 * repairs a file whose elements are out of order). Each type lists its children's places in turn,
 * the elements that may fill one place joined by "|", and the type of each child that has children
 * of its own Herald writes.
 */

const ORDER: Record<string, string> = {
  'c:CT_ChartSpace': 'c:date1904 c:lang c:roundedCorners c:style c:clrMapOvr c:pivotSource c:protection c:chart=c:CT_Chart c:spPr=a:CT_ShapeProperties c:txPr=a:CT_TextBody c:externalData c:printSettings c:userShapes c:extLst',
  'c:CT_Chart': 'c:title=c:CT_Title c:autoTitleDeleted c:pivotFmts c:view3D c:floor c:sideWall c:backWall c:plotArea=c:CT_PlotArea c:legend=c:CT_Legend c:plotVisOnly c:dispBlanksAs c:showDLblsOverMax c:extLst',
  'c:CT_Title': 'c:tx=c:CT_Tx c:layout c:overlay c:spPr=a:CT_ShapeProperties c:txPr=a:CT_TextBody c:extLst',
  'c:CT_Tx': 'c:strRef=c:CT_StrRef|c:rich=a:CT_TextBody',
  'c:CT_PlotArea':
    'c:layout c:areaChart=c:CT_AreaChart|c:area3DChart|c:lineChart=c:CT_LineChart|c:line3DChart|c:stockChart|c:radarChart|c:scatterChart=c:CT_ScatterChart|c:pieChart=c:CT_PieChart|c:pie3DChart|c:doughnutChart=c:CT_DoughnutChart|c:barChart=c:CT_BarChart|c:bar3DChart|c:ofPieChart|c:surfaceChart|c:surface3DChart|c:bubbleChart c:valAx=c:CT_ValAx|c:catAx=c:CT_CatAx|c:dateAx|c:serAx c:dTable c:spPr=a:CT_ShapeProperties c:extLst',
  'c:CT_Legend': 'c:legendPos c:legendEntry c:layout c:overlay c:spPr=a:CT_ShapeProperties c:txPr=a:CT_TextBody c:extLst',
  'c:CT_AreaChart': 'c:grouping c:varyColors c:ser=c:CT_AreaSer c:dLbls=c:CT_DLbls c:dropLines=c:CT_ChartLines c:axId c:extLst',
  'c:CT_LineChart': 'c:grouping c:varyColors c:ser=c:CT_LineSer c:dLbls=c:CT_DLbls c:dropLines=c:CT_ChartLines c:hiLowLines=c:CT_ChartLines c:upDownBars c:marker c:smooth c:axId c:extLst',
  'c:CT_ScatterChart': 'c:scatterStyle c:varyColors c:ser=c:CT_ScatterSer c:dLbls=c:CT_DLbls c:axId c:extLst',
  'c:CT_PieChart': 'c:varyColors c:ser=c:CT_PieSer c:dLbls=c:CT_DLbls c:firstSliceAng c:extLst',
  'c:CT_DoughnutChart': 'c:varyColors c:ser=c:CT_PieSer c:dLbls=c:CT_DLbls c:firstSliceAng c:holeSize c:extLst',
  'c:CT_BarChart': 'c:barDir c:grouping c:varyColors c:ser=c:CT_BarSer c:dLbls=c:CT_DLbls c:gapWidth c:overlap c:serLines=c:CT_ChartLines c:axId c:extLst',
  'c:CT_AreaSer': 'c:idx c:order c:tx=c:CT_SerTx c:spPr=a:CT_ShapeProperties c:pictureOptions c:dPt=c:CT_DPt c:dLbls=c:CT_DLbls c:trendline c:errBars c:cat=c:CT_AxDataSource c:val=c:CT_NumDataSource c:extLst',
  'c:CT_LineSer': 'c:idx c:order c:tx=c:CT_SerTx c:spPr=a:CT_ShapeProperties c:marker=c:CT_Marker c:dPt=c:CT_DPt c:dLbls=c:CT_DLbls c:trendline c:errBars c:cat=c:CT_AxDataSource c:val=c:CT_NumDataSource c:smooth c:extLst',
  'c:CT_ScatterSer': 'c:idx c:order c:tx=c:CT_SerTx c:spPr=a:CT_ShapeProperties c:marker=c:CT_Marker c:dPt=c:CT_DPt c:dLbls=c:CT_DLbls c:trendline c:errBars c:xVal=c:CT_AxDataSource c:yVal=c:CT_NumDataSource c:smooth c:extLst',
  'c:CT_PieSer': 'c:idx c:order c:tx=c:CT_SerTx c:spPr=a:CT_ShapeProperties c:explosion c:dPt=c:CT_DPt c:dLbls=c:CT_DLbls c:cat=c:CT_AxDataSource c:val=c:CT_NumDataSource c:extLst',
  'c:CT_BarSer': 'c:idx c:order c:tx=c:CT_SerTx c:spPr=a:CT_ShapeProperties c:invertIfNegative c:pictureOptions c:dPt=c:CT_DPt c:dLbls=c:CT_DLbls c:trendline c:errBars c:cat=c:CT_AxDataSource c:val=c:CT_NumDataSource c:shape c:extLst',
  'c:CT_SerTx': 'c:strRef=c:CT_StrRef|c:v',
  'c:CT_DPt': 'c:idx c:invertIfNegative c:marker=c:CT_Marker c:bubble3D c:explosion c:spPr=a:CT_ShapeProperties c:pictureOptions c:extLst',
  'c:CT_Marker': 'c:symbol c:size c:spPr=a:CT_ShapeProperties c:extLst',
  'c:CT_DLbls': 'c:dLbl c:delete c:numFmt c:spPr=a:CT_ShapeProperties c:txPr=a:CT_TextBody c:dLblPos c:showLegendKey c:showVal c:showCatName c:showSerName c:showPercent c:showBubbleSize c:separator c:showLeaderLines c:leaderLines=c:CT_ChartLines c:extLst',
  'c:CT_AxDataSource': 'c:multiLvlStrRef|c:numRef=c:CT_NumRef|c:numLit=c:CT_NumData|c:strRef=c:CT_StrRef|c:strLit=c:CT_StrData',
  'c:CT_NumDataSource': 'c:numRef=c:CT_NumRef|c:numLit=c:CT_NumData',
  'c:CT_StrRef': 'c:f c:strCache=c:CT_StrData c:extLst',
  'c:CT_NumRef': 'c:f c:numCache=c:CT_NumData c:extLst',
  'c:CT_StrData': 'c:ptCount c:pt=c:CT_StrVal c:extLst',
  'c:CT_NumData': 'c:formatCode c:ptCount c:pt=c:CT_NumVal c:extLst',
  'c:CT_StrVal': 'c:v',
  'c:CT_NumVal': 'c:v',
  'c:CT_ValAx':
    'c:axId c:scaling=c:CT_Scaling c:delete c:axPos c:majorGridlines=c:CT_ChartLines c:minorGridlines=c:CT_ChartLines c:title=c:CT_Title c:numFmt c:majorTickMark c:minorTickMark c:tickLblPos c:spPr=a:CT_ShapeProperties c:txPr=a:CT_TextBody c:crossAx c:crosses|c:crossesAt c:crossBetween c:majorUnit c:minorUnit c:dispUnits c:extLst',
  'c:CT_CatAx':
    'c:axId c:scaling=c:CT_Scaling c:delete c:axPos c:majorGridlines=c:CT_ChartLines c:minorGridlines=c:CT_ChartLines c:title=c:CT_Title c:numFmt c:majorTickMark c:minorTickMark c:tickLblPos c:spPr=a:CT_ShapeProperties c:txPr=a:CT_TextBody c:crossAx c:crosses|c:crossesAt c:auto c:lblAlgn c:lblOffset c:tickLblSkip c:tickMarkSkip c:noMultiLvlLbl c:extLst',
  'c:CT_Scaling': 'c:logBase c:orientation c:max c:min c:extLst',
  'c:CT_ChartLines': 'c:spPr=a:CT_ShapeProperties',
  'a:CT_ShapeProperties': 'a:xfrm=a:CT_Transform2D a:custGeom|a:prstGeom a:noFill|a:solidFill=a:CT_SolidColorFillProperties|a:gradFill|a:blipFill|a:pattFill|a:grpFill a:ln=a:CT_LineProperties a:effectLst|a:effectDag a:scene3d a:sp3d a:extLst',
  'a:CT_SolidColorFillProperties': 'a:scrgbClr|a:srgbClr=a:CT_SRgbColor|a:hslClr|a:sysClr|a:schemeClr|a:prstClr',
  'a:CT_SRgbColor': 'a:tint|a:shade|a:comp|a:inv|a:gray|a:alpha|a:alphaOff|a:alphaMod|a:hue|a:hueOff|a:hueMod|a:sat|a:satOff|a:satMod|a:lum|a:lumOff|a:lumMod|a:red|a:redOff|a:redMod|a:green|a:greenOff|a:greenMod|a:blue|a:blueOff|a:blueMod|a:gamma|a:invGamma',
  'a:CT_LineProperties': 'a:noFill|a:solidFill=a:CT_SolidColorFillProperties|a:gradFill|a:pattFill a:prstDash|a:custDash a:round|a:bevel|a:miter a:headEnd a:tailEnd a:extLst',
  'a:CT_TextBody': 'a:bodyPr a:lstStyle a:p=a:CT_TextParagraph',
  'a:CT_TextParagraph': 'a:pPr=a:CT_TextParagraphProperties a:r=a:CT_RegularTextRun|a:br|a:fld a:endParaRPr=a:CT_TextCharacterProperties',
  'a:CT_TextParagraphProperties': 'a:lnSpc a:spcBef a:spcAft a:buClrTx|a:buClr a:buSzTx|a:buSzPct|a:buSzPts a:buFontTx|a:buFont a:buNone|a:buAutoNum|a:buChar|a:buBlip a:tabLst a:defRPr=a:CT_TextCharacterProperties a:extLst',
  'a:CT_RegularTextRun': 'a:rPr=a:CT_TextCharacterProperties a:t',
  'a:CT_TextCharacterProperties':
    'a:ln=a:CT_LineProperties a:noFill|a:solidFill=a:CT_SolidColorFillProperties|a:gradFill|a:blipFill|a:pattFill|a:grpFill a:effectLst|a:effectDag a:highlight a:uLnTx|a:uLn=a:CT_LineProperties a:uFillTx|a:uFill a:latin a:ea a:cs a:sym a:hlinkClick a:hlinkMouseOver a:rtl a:extLst',
  'a:CT_Transform2D': 'a:off a:ext',
  'xdr:CT_Drawing': 'xdr:twoCellAnchor=xdr:CT_TwoCellAnchor|xdr:oneCellAnchor|xdr:absoluteAnchor',
  'xdr:CT_TwoCellAnchor': 'xdr:from=xdr:CT_Marker xdr:to=xdr:CT_Marker xdr:sp|xdr:grpSp|xdr:graphicFrame=xdr:CT_GraphicalObjectFrame|xdr:cxnSp|xdr:pic|xdr:contentPart xdr:clientData',
  'xdr:CT_Marker': 'xdr:col xdr:colOff xdr:row xdr:rowOff',
  'xdr:CT_GraphicalObjectFrame': 'xdr:nvGraphicFramePr=xdr:CT_GraphicalObjectFrameNonVisual xdr:xfrm=a:CT_Transform2D a:graphic=a:CT_GraphicalObject',
  'xdr:CT_GraphicalObjectFrameNonVisual': 'xdr:cNvPr=a:CT_NonVisualDrawingProps xdr:cNvGraphicFramePr=a:CT_NonVisualGraphicFrameProperties',
  'a:CT_NonVisualDrawingProps': 'a:hlinkClick a:hlinkHover a:extLst',
  'a:CT_NonVisualGraphicFrameProperties': 'a:graphicFrameLocks a:extLst',
  'a:CT_GraphicalObject': 'a:graphicData'
}

/** Where `element`'s children (and theirs) leave the order of `type`, or are not among its children at all. */
function misplaced(element: XmlElement, type: string, path = element.name): string[] {
  const order = ORDER[type]

  if (!order) {
    return []
  }

  const places = order.split(' ').map((place) => place.split('|').map((entry) => entry.split('=') as [string, string?]))
  const problems: string[] = []
  let at = 0

  for (const child of children(element)) {
    const index = places.findIndex((place, i) => i >= at && place.some(([name]) => name === child.name))

    if (index < 0) {
      problems.push(`${path}/${child.name} ${places.some((place) => place.some(([name]) => name === child.name)) ? 'comes too late' : 'has no place here'}`)
      continue
    }

    at = index
    const childType = places[index].find(([name]) => name === child.name)![1]

    if (childType) {
      problems.push(...misplaced(child, childType, `${path}/${child.name}`))
    }
  }

  return problems
}

/** The order problems of every chart and drawing part of a package Herald wrote. */
async function problemsIn(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes)
  const problems: string[] = []
  const parts = Object.keys(zip.files).filter((path) => /^xl\/(charts\/chart|drawings\/drawing)\d+\.xml$/.test(path))

  for (const path of parts) {
    const root = parsePart(await zip.file(path)!.async('string'))
    const type = root?.name === 'c:chartSpace' ? 'c:CT_ChartSpace' : root?.name === 'xdr:wsDr' ? 'xdr:CT_Drawing' : undefined

    if (type) {
      problems.push(...misplaced(root!, type).map((problem) => `${path}: ${problem}`))
    }
  }

  return problems
}

const { north, south, margin, months } = SALES_SERIES

/** Charts that leave things to Herald's defaults, or reach the corners of what is written. */
const VARIANTS: ChartSpec[] = [
  { kind: 'column', series: [north, south], legend: 'right', labels: 'percent' },
  { kind: 'column', series: [{ values: north.values }], legend: 'none', labels: 'value', stacking: 'percent', axes: { x: { hidden: true, format: '0.0', title: 'x' }, y: { hidden: true, gridlines: false } } },
  { kind: 'bar', series: [north, south], legend: 'left', labels: 'value', stacking: 'stacked' },
  { kind: 'bar', series: [north], legend: 'top', labels: 'percent', title: ' ' },
  { kind: 'line', series: [north, south, margin], legend: 'bottom', labels: 'value', axes: { x: { gridlines: true }, y: { title: 'Two\nlines' } } },
  { kind: 'area', series: [north], legend: 'none', labels: 'category' },
  { kind: 'pie', series: [north, south], legend: 'none', labels: 'value' },
  { kind: 'pie', series: [{ values: north.values, name: { text: 'Text & <name>' } }], legend: 'top', labels: 'category' },
  { kind: 'doughnut', series: [north], legend: 'right', labels: 'percent', hole: 5 },
  { kind: 'scatter', series: [{ values: range('s2', 1, 1, 5, 1), categories: range('s2', 1, 0, 5, 0) }, { values: range('s2', 0, 1, 1048575, 1) }], legend: 'bottom', labels: 'category' },
  { kind: 'scatter', series: [{ values: range('s2', 1, 1, 5, 1) }], legend: 'none', labels: 'percent' },
  { kind: 'combo', series: [north, { ...south, type: 'area' }, { ...margin, type: 'line', secondary: true }], legend: 'right', labels: 'value', stacking: 'percent' },
  { kind: 'combo', series: [{ ...north, type: 'line' }, { ...margin, type: 'column', secondary: true }], legend: 'top', labels: 'category', axes: { y2: { hidden: true, gridlines: true } } },
  { kind: 'combo', series: [{ ...north, secondary: true }], legend: 'none', labels: 'none' },
  { kind: 'combo', series: [north, { ...south, type: 'area' }, { ...margin, secondary: true }], legend: 'bottom', labels: 'value', stacking: 'stacked', axes: { x: { reverse: true, title: 'Month' } } },
  { kind: 'bar', series: [north, south], legend: 'right', labels: 'value', stacking: 'percent', axes: { x: { reverse: true } } },
  { kind: 'column', series: [{ values: range('s1', 1, 0, 1, 16383), categories: months }], legend: 'none', labels: 'none' }
]

describe('the order of what Herald writes', () => {
  it('finds an element out of the schema’s order, or where it has no place', () => {
    const chart = (inner: string) => parsePart(`<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart>${inner}</c:chart></c:chartSpace>`)!

    expect(misplaced(chart('<c:legend/><c:plotArea/>'), 'c:CT_ChartSpace')).toEqual(['c:chartSpace/c:chart/c:plotArea comes too late'])
    expect(misplaced(chart('<c:plotArea><c:barChart><c:grouping/><c:barDir/><c:hole/></c:barChart></c:plotArea>'), 'c:CT_ChartSpace')).toEqual([
      'c:chartSpace/c:chart/c:plotArea/c:barChart/c:barDir comes too late',
      'c:chartSpace/c:chart/c:plotArea/c:barChart/c:hole has no place here'
    ])
  })

  it('writes every kind of chart, and its anchor, in the schema’s order', async () => {
    expect(await problemsIn((await xlsxFromWorkbook(everyKindWorkbook())).bytes)).toEqual([])
  })

  it('writes charts left to Herald’s defaults in the schema’s order, anchored each way', async () => {
    const drawings = VARIANTS.map((spec, i) => chartDrawing(`v${i}`, 's1', spec, { at: i, anchorType: (['0', '1', '2'] as const)[i % 3] }))

    expect(await problemsIn((await xlsxFromWorkbook(chartWorkbook(drawings))).bytes)).toEqual([])
  })

  it('writes charts read from Excel and changed since in the schema’s order', async () => {
    const original = await excelWorkbook()
    const { workbook } = await workbookFromXlsx(original, { id: 'book', name: 'Book' })
    const resource = readResource<Record<string, { data: Record<string, { data: { spec: ChartSpec } }>; order: string[] }>>(workbook.resources, DRAWING_RESOURCE)!

    for (const sheet of Object.values(resource)) {
      for (const id of sheet.order) {
        sheet.data[id].data.spec = { ...sheet.data[id].data.spec, title: 'Changed' }
      }
    }

    workbook.resources = (workbook.resources as { name: string; data: string }[]).map((entry) => (entry.name === DRAWING_RESOURCE ? { ...entry, data: JSON.stringify(resource) } : entry))
    const { bytes } = await xlsxFromWorkbook(workbook, { original })
    const charts = Object.keys((await JSZip.loadAsync(bytes)).files).filter((path) => /^xl\/charts\/chart\d+\.xml$/.test(path))
    // Parts carried over untouched (the 3D and radar charts) are Excel's own, with its mc:AlternateContent.
    const mine = (await problemsIn(bytes)).filter((problem) => !/mc:AlternateContent/.test(problem))

    expect(charts.length).toBeGreaterThanOrEqual(4)
    expect(mine).toEqual([])
  })
})
