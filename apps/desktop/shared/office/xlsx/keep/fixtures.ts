import JSZip from 'jszip'
import { relsPathOf } from '../opc.ts'

/*
 * Workbooks as Excel writes them, with the parts Herald keeps without showing: a pivot table on a
 * summary sheet over a data sheet, with a slicer; a table and sparklines on the data sheet; a
 * picture, a shape, a radar chart and a funnel (chartEx) Herald does not draw, beside a bar chart, on
 * a dashboard; and a chart sheet between them. Made here part by part, with made-up data.
 */

export type DashboardPart = 'picture' | 'shape' | 'radar' | 'chartEx' | 'bar'

export interface KeptWorkbookOptions {
  /** The pivot table on Summary over Sales (with its slicer when `slicer` is too). */
  pivot?: boolean
  slicer?: boolean
  /** The Targets table on Sales. */
  table?: boolean
  sparklines?: boolean
  chartSheet?: boolean
  /** The anchors of the dashboard's drawing, in order. */
  dashboard?: DashboardPart[]
  /** Style and colour parts for the radar chart and the funnel. */
  chartStyles?: boolean
}

export const DASHBOARD: DashboardPart[] = ['picture', 'shape', 'radar', 'chartEx', 'bar']

/** A 16 × 16 PNG, for the picture. */
export const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAB4ElEQVR42g3LIc6GIACA4f8k3wE8gAfgAB7AAxgJjkRwJAIjEZjJvXMmAiMZHIngzJ7o9+nP30/SSXqJkAySUTJJZskicZIo2SVZckluySv5+yk6Ra8QikExKibFrFgUThEVuyIrLsWteNUXNJ2m1wjNoBk1k2bWLBqniZpdkzWX5ta8+guGztAbhGEwjIbJMBsWgzNEw27IhstwG17zBUtn6S3CMlhGy2SZLYvFWaJlt2TLZbktr/2Cp/P0HuEZPKNn8syexeM80bN7sufy3J7XfyHQBfqACAyBMTAF5sAScIEY2AM5cAXuwBu+sNKt9CtiZVgZV6aVeWVZcStxZV/JK9fKvfKuX9joNvoNsTFsjBvTxryxbLiNuLFv5I1r4954ty8cdAf9gTgYDsaD6WA+WA7cQTzYD/LBdXAfvMcXEl2iT4jEkBgTU2JOLAmXiIk9kRNX4k686QuFrtAXRGEojIWpMBeWgivEwl7IhatwF97yhZPupD8RJ8PJeDKdzCfLiTuJJ/tJPrlO7pP3/EKlq/QVURkqY2WqzJWl4iqxsldy5arclbd+odE1+oZoDI2xMTXmxtJwjdjYG7lxNe7G277w0D30D+JheBgfpof5YXlwD/Fhf8gP18P98D78A7PysxBliDz+AAAAAElFTkSuQmCC',
    'base64'
  )
)

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const CX = 'http://schemas.microsoft.com/office/drawing/2014/chartex'
const CS = 'http://schemas.microsoft.com/office/drawing/2012/chartStyle'

const TYPE = {
  worksheet: `${R}/worksheet`,
  chartsheet: `${R}/chartsheet`,
  theme: `${R}/theme`,
  styles: `${R}/styles`,
  sharedStrings: `${R}/sharedStrings`,
  drawing: `${R}/drawing`,
  image: `${R}/image`,
  chart: `${R}/chart`,
  table: `${R}/table`,
  pivotTable: `${R}/pivotTable`,
  pivotCacheDefinition: `${R}/pivotCacheDefinition`,
  pivotCacheRecords: `${R}/pivotCacheRecords`,
  chartEx: 'http://schemas.microsoft.com/office/2014/relationships/chartEx',
  chartStyle: 'http://schemas.microsoft.com/office/2011/relationships/chartStyle',
  chartColorStyle: 'http://schemas.microsoft.com/office/2011/relationships/chartColorStyle',
  slicer: 'http://schemas.microsoft.com/office/2007/relationships/slicer',
  slicerCache: 'http://schemas.microsoft.com/office/2007/relationships/slicerCache'
}

const CONTENT = {
  worksheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  chartsheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml',
  drawing: 'application/vnd.openxmlformats-officedocument.drawing+xml',
  chart: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  chartEx: 'application/vnd.ms-office.chartex+xml',
  chartStyle: 'application/vnd.ms-office.chartstyle+xml',
  chartColorStyle: 'application/vnd.ms-office.chartcolorstyle+xml',
  table: 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml',
  pivotTable: 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml',
  pivotCacheDefinition: 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml',
  pivotCacheRecords: 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml',
  slicer: 'application/vnd.ms-excel.slicer+xml',
  slicerCache: 'application/vnd.ms-excel.slicerCache+xml'
}

/** The data on Sales: region, product, amount. */
export const SALES: [string, string, number][] = [
  ['North', 'Apples', 120],
  ['South', 'Apples', 80],
  ['North', 'Pears', 95],
  ['East', 'Pears', 60],
  ['South', 'Plums', 130],
  ['East', 'Apples', 70]
]

const TARGETS: [string, number][] = [
  ['North', 300],
  ['South', 250],
  ['East', 150]
]

const STRINGS = ['Region', 'Product', 'Amount', 'North', 'South', 'East', 'Apples', 'Pears', 'Plums', 'Target', 'Row Labels', 'Sum of Amount', 'Grand Total', 'Trend', 'Sales by region', 'Dashboard']

const relationships = (entries: [string, string, string][]): string =>
  `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('')}</Relationships>`

/** A row of cells: text through the shared strings, numbers as they are, with a style index when given. */
function row(r: number, cells: [string, string | number, number?][]): string {
  return `<row r="${r}">${cells.map(([column, value, style]) => `<c r="${column}${r}"${style ? ` s="${style}"` : ''}${typeof value === 'string' ? ` t="s"><v>${STRINGS.indexOf(value)}</v>` : `><v>${value}</v>`}</c>`).join('')}</row>`
}

const worksheet = (dimension: string, columns: string, rows: string, tail: string, selected = false): string =>
  `${HEAD}<worksheet xmlns="${MAIN}" xmlns:r="${R}" xmlns:mc="${MC}" mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"><dimension ref="${dimension}"/><sheetViews><sheetView${selected ? ' tabSelected="1"' : ''} workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/>${columns}<sheetData>${rows}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>${tail}</worksheet>`

const anchorAt = (from: [number, number], to: [number, number]): string =>
  `<xdr:from><xdr:col>${from[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${from[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${to[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${to[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`

const chartFrame = (id: number, name: string, rel: string, from: [number, number], to: [number, number]): string =>
  `<xdr:twoCellAnchor>${anchorAt(from, to)}<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="${name}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" xmlns:r="${R}" r:id="${rel}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`

const ANCHORS: Record<DashboardPart, (rel: string) => string> = {
  picture: (rel) =>
    `<xdr:twoCellAnchor editAs="oneCell">${anchorAt([0, 2], [2, 8])}<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Picture 1" descr="Company logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="${R}" r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="381000"/><a:ext cx="1219200" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`,
  shape: () =>
    `<xdr:twoCellAnchor>${anchorAt([3, 2], [6, 5])}<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="3" name="Rectangle 2"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="1828800" y="381000"/><a:ext cx="1828800" cy="571500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></xdr:spPr><xdr:txBody><a:bodyPr vertOverflow="clip" horzOverflow="clip" rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="1100"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:rPr><a:t>Figures for the quarter</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>`,
  radar: (rel) => chartFrame(4, 'Chart 3', rel, [0, 9], [6, 24]),
  chartEx: (rel) =>
    `<xdr:twoCellAnchor>${anchorAt([7, 9], [13, 24])}<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:cx1="http://schemas.microsoft.com/office/drawing/2015/9/8/chartex" Requires="cx1"><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="5" name="Chart 4"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${CX}"><cx:chart xmlns:cx="${CX}" xmlns:r="${R}" r:id="${rel}"/></a:graphicData></a:graphic></xdr:graphicFrame></mc:Choice><mc:Fallback><xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="0" name=""/><xdr:cNvSpPr><a:spLocks noTextEdit="1"/></xdr:cNvSpPr></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="4267200" y="1714500"/><a:ext cx="3657600" cy="2857500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr><xdr:txBody><a:bodyPr vertOverflow="clip" horzOverflow="clip"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1100"/><a:t>This chart isn’t available in your version of Excel.</a:t></a:r></a:p></xdr:txBody></xdr:sp></mc:Fallback></mc:AlternateContent><xdr:clientData/></xdr:twoCellAnchor>`,
  bar: (rel) => chartFrame(6, 'Chart 5', rel, [14, 9], [20, 24])
}

const SLICER_ANCHOR = `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14"><xdr:twoCellAnchor editAs="oneCell">${anchorAt([3, 2], [6, 12])}<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Region"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2010/slicer"><sle:slicer xmlns:sle="http://schemas.microsoft.com/office/drawing/2010/slicer" name="Region"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></mc:Choice><mc:Fallback><xdr:twoCellAnchor editAs="oneCell">${anchorAt([3, 2], [6, 12])}<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="0" name=""/><xdr:cNvSpPr><a:spLocks noTextEdit="1"/></xdr:cNvSpPr></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="2438400" y="381000"/><a:ext cx="1828800" cy="1905000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:prstClr val="white"/></a:solidFill><a:ln w="1"><a:solidFill><a:prstClr val="green"/></a:solidFill></a:ln></xdr:spPr><xdr:txBody><a:bodyPr vertOverflow="clip" horzOverflow="clip"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1100"/><a:t>This shape represents a slicer. Slicers are supported in Excel 2010 or later.</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor></mc:Fallback></mc:AlternateContent>`

const drawing = (anchors: string): string => `${HEAD}<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}">${anchors}</xdr:wsDr>`

const textCache = (values: string[]): string => `<c:strCache><c:ptCount val="${values.length}"/>${values.map((value, n) => `<c:pt idx="${n}"><c:v>${value}</c:v></c:pt>`).join('')}</c:strCache>`
const numberCache = (values: number[]): string => `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${values.map((value, n) => `<c:pt idx="${n}"><c:v>${value}</c:v></c:pt>`).join('')}</c:numCache>`

/** A series of the amounts on Sales by region, as each kind of chart has it. */
function series(kind: 'radar' | 'bar' | 'line'): string {
  const tx = `<c:tx><c:strRef><c:f>Sales!$C$1</c:f>${textCache(['Amount'])}</c:strRef></c:tx>`
  const data = `<c:cat><c:strRef><c:f>Sales!$A$2:$A$7</c:f>${textCache(SALES.map(([region]) => region))}</c:strRef></c:cat><c:val><c:numRef><c:f>Sales!$C$2:$C$7</c:f>${numberCache(SALES.map(([, , amount]) => amount))}</c:numRef></c:val>`
  const marker = kind === 'bar' ? '<c:invertIfNegative val="0"/>' : '<c:marker><c:symbol val="none"/></c:marker>'

  return `<c:ser><c:idx val="0"/><c:order val="0"/>${tx}${marker}${data}${kind === 'line' ? '<c:smooth val="0"/>' : ''}</c:ser>`
}

const LABELS = '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>'

const axes = (cat: number, val: number): string =>
  `<c:catAx><c:axId val="${cat}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${val}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx><c:valAx><c:axId val="${val}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${cat}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`

function chart(kind: 'radar' | 'bar' | 'line', title: string): string {
  const [cat, val] = kind === 'radar' ? [510001, 510002] : kind === 'bar' ? [520001, 520002] : [530001, 530002]
  const plot =
    kind === 'radar'
      ? `<c:radarChart><c:radarStyle val="marker"/><c:varyColors val="0"/>${series(kind)}${LABELS}<c:axId val="${cat}"/><c:axId val="${val}"/></c:radarChart>`
      : kind === 'bar'
        ? `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series(kind)}${LABELS}<c:gapWidth val="219"/><c:overlap val="-27"/><c:axId val="${cat}"/><c:axId val="${val}"/></c:barChart>`
        : `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series(kind)}${LABELS}<c:marker val="1"/><c:axId val="${cat}"/><c:axId val="${val}"/></c:lineChart>`

  return `${HEAD}<c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${R}"><c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}${axes(cat, val)}</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings></c:chartSpace>`
}

const CHART_EX = `${HEAD}<cx:chartSpace xmlns:a="${A}" xmlns:r="${R}" xmlns:cx="${CX}"><cx:chartData><cx:data id="0"><cx:strDim type="cat"><cx:f>_xlchart.v1.0</cx:f><cx:lvl ptCount="${SALES.length}">${SALES.map(([region], n) => `<cx:pt idx="${n}">${region}</cx:pt>`).join('')}</cx:lvl></cx:strDim><cx:numDim type="val"><cx:f>_xlchart.v1.1</cx:f><cx:lvl ptCount="${SALES.length}" formatCode="General">${SALES.map(([, , amount], n) => `<cx:pt idx="${n}">${amount}</cx:pt>`).join('')}</cx:lvl></cx:numDim></cx:data></cx:chartData><cx:chart><cx:title pos="t" align="ctr" overlay="0"><cx:tx><cx:txData><cx:v>Funnel</cx:v></cx:txData></cx:tx></cx:title><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="funnel" uniqueId="{6B1A1D4E-2C5F-4C8A-9E0B-2D7F4A3C1B11}"><cx:tx><cx:txData><cx:f>Sales!$C$1</cx:f><cx:v>Amount</cx:v></cx:txData></cx:tx><cx:dataId val="0"/></cx:series></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>`

const CHART_STYLE = `${HEAD}<cs:chartStyle xmlns:cs="${CS}" xmlns:a="${A}" id="317"/>`
const CHART_COLORS = `${HEAD}<cs:colorStyle xmlns:cs="${CS}" xmlns:a="${A}" meth="cycle" id="10"><a:schemeClr val="accent1"/><a:schemeClr val="accent2"/><a:schemeClr val="accent3"/><a:schemeClr val="accent4"/><a:schemeClr val="accent5"/><a:schemeClr val="accent6"/><cs:variation/><cs:variation><a:lumMod val="60000"/></cs:variation><cs:variation><a:lumMod val="80000"/><a:lumOff val="20000"/></cs:variation></cs:colorStyle>`

/** A complete theme whose accents are plain to tell from Office's: accent 1 teal, accent 2 brick. */
export const THEME_ACCENTS = ['1F6F5B', 'C8553D', 'F28F3B', '588B8B', '8E7DBE', '6B4E71']

const THEME = `${HEAD}<a:theme xmlns:a="${A}" name="Fixture Theme"><a:themeElements><a:clrScheme name="Fixture"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="2B2B3A"/></a:dk2><a:lt2><a:srgbClr val="EDEAE4"/></a:lt2>${THEME_ACCENTS.map((rgb, n) => `<a:accent${n + 1}><a:srgbClr val="${rgb}"/></a:accent${n + 1}>`).join('')}<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Fixture"><a:majorFont><a:latin typeface="Georgia"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`

/** Styles with a number format and differential formats the pivot table and the table name. */
const STYLES = `${HEAD}<styleSheet xmlns="${MAIN}" xmlns:mc="${MC}" mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0&quot; kg&quot;"/></numFmts><fonts count="2" x14ac:knownFonts="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="2"><dxf><font><color rgb="FF006100"/></font></dxf><dxf><font><b/></font><numFmt numFmtId="164" formatCode="#,##0&quot; kg&quot;"/></dxf></dxfs><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`

const PIVOT_CACHE = `${HEAD}<pivotCacheDefinition xmlns="${MAIN}" xmlns:r="${R}" r:id="rId1" refreshedBy="Fixture" refreshedDate="45567.5" createdVersion="6" refreshedVersion="6" minRefreshableVersion="3" recordCount="${SALES.length}"><cacheSource type="worksheet"><worksheetSource ref="A1:C7" sheet="Sales"/></cacheSource><cacheFields count="3"><cacheField name="Region" numFmtId="0"><sharedItems count="3"><s v="North"/><s v="South"/><s v="East"/></sharedItems></cacheField><cacheField name="Product" numFmtId="0"><sharedItems count="3"><s v="Apples"/><s v="Pears"/><s v="Plums"/></sharedItems></cacheField><cacheField name="Amount" numFmtId="0"><sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1" containsInteger="1" minValue="60" maxValue="130"/></cacheField></cacheFields><extLst><ext uri="{725AE2AE-9491-48be-B2B4-4EB974FC3084}" xmlns:x14="${X14}"><x14:pivotCacheDefinition pivotCacheId="1"/></ext></extLst></pivotCacheDefinition>`

const PIVOT_RECORDS = `${HEAD}<pivotCacheRecords xmlns="${MAIN}" xmlns:r="${R}" count="${SALES.length}">${SALES.map(([region, product, amount]) => `<r><x v="${['North', 'South', 'East'].indexOf(region)}"/><x v="${['Apples', 'Pears', 'Plums'].indexOf(product)}"/><n v="${amount}"/></r>`).join('')}</pivotCacheRecords>`

/** Sum of Amount by region, the regions sorted (East, North, South), on Summary!A3:B7. */
const PIVOT_TABLE = `${HEAD}<pivotTableDefinition xmlns="${MAIN}" name="PivotTable1" cacheId="7" applyNumberFormats="0" applyBorderFormats="0" applyFontFormats="0" applyPatternFormats="0" applyAlignmentFormats="0" applyWidthHeightFormats="1" dataCaption="Values" updatedVersion="6" minRefreshableVersion="3" useAutoFormatting="1" itemPrintTitles="1" createdVersion="6" indent="0" outline="1" outlineData="1" multipleFieldFilters="0"><location ref="A3:B7" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/><pivotFields count="3"><pivotField axis="axisRow" showAll="0"><items count="4"><item x="2"/><item x="0"/><item x="1"/><item t="default"/></items></pivotField><pivotField showAll="0"/><pivotField dataField="1" showAll="0"/></pivotFields><rowFields count="1"><field x="0"/></rowFields><rowItems count="4"><i><x/></i><i><x v="1"/></i><i><x v="2"/></i><i t="grand"><x/></i></rowItems><colItems count="1"><i/></colItems><dataFields count="1"><dataField name="Sum of Amount" fld="2" baseField="0" baseItem="0" numFmtId="164"/></dataFields><formats count="1"><format dxfId="1"><pivotArea outline="0" collapsedLevelsAreSubtotals="1" fieldPosition="0"><references count="1"><reference field="4294967294" count="1" selected="0"><x v="0"/></reference></references></pivotArea></format></formats><pivotTableStyleInfo name="PivotStyleLight16" showRowHeaders="1" showColHeaders="1" showRowStripes="0" showColStripes="0" showLastColumn="1"/></pivotTableDefinition>`

const SLICER_CACHE = `${HEAD}<slicerCacheDefinition xmlns="${X14}" xmlns:mc="${MC}" mc:Ignorable="x" xmlns:x="${MAIN}" name="Slicer_Region" sourceName="Region"><pivotTables><pivotTable tabId="3" name="PivotTable1"/></pivotTables><data><tabular pivotCacheId="1"><items count="3"><i x="2" s="1"/><i x="0" s="1"/><i x="1" s="1"/></items></tabular></data></slicerCacheDefinition>`
const SLICERS = `${HEAD}<slicers xmlns="${X14}" xmlns:mc="${MC}" mc:Ignorable="x" xmlns:x="${MAIN}"><slicer name="Region" cache="Slicer_Region" caption="Region" rowHeight="241300"/></slicers>`

const TABLE = `${HEAD}<table xmlns="${MAIN}" id="1" name="Targets" displayName="Targets" ref="E1:F4" totalsRowShown="0"><autoFilter ref="E1:F4"/><tableColumns count="2"><tableColumn id="1" name="Region"/><tableColumn id="2" name="Target" dataDxfId="0"/></tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`

const SPARKLINES = `<ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}" xmlns:x14="${X14}"><x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:sparklineGroup displayEmptyCellsAs="gap" markers="1"><x14:colorSeries theme="4" tint="-0.499984740745262"/><x14:colorNegative theme="5"/><x14:colorAxis rgb="FF000000"/><x14:colorMarkers theme="4" tint="-0.499984740745262"/><x14:colorFirst theme="4" tint="0.39997558519241921"/><x14:colorLast theme="4" tint="0.39997558519241921"/><x14:colorHigh theme="4"/><x14:colorLow theme="4"/><x14:sparklines><x14:sparkline><xm:f>Sales!C2:C7</xm:f><xm:sqref>H2</xm:sqref></x14:sparkline></x14:sparklines></x14:sparklineGroup></x14:sparklineGroups></ext>`

const CHART_SHEET = `${HEAD}<chartsheet xmlns="${MAIN}" xmlns:r="${R}"><sheetPr/><sheetViews><sheetView zoomScale="118" workbookViewId="0" zoomToFit="1"/></sheetViews><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><drawing r:id="rId1"/></chartsheet>`
const CHART_SHEET_DRAWING = drawing(`<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="8670925" cy="6292850"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></xdr:cNvGraphicFramePr></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" xmlns:r="${R}" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:absoluteAnchor>`)

export interface ExtraParts {
  /** Parts added or replaced, by path. */
  files?: Record<string, string | Uint8Array>
  /** Relationships added to parts, by the part they belong to ("" for the package): id, type, target as the .rels part writes it, external. */
  relationships?: Record<string, [string, string, string, boolean?][]>
  /** Content types of added parts, by path. */
  types?: Record<string, string>
  /** Changes to parts' XML. */
  change?: Record<string, (xml: string) => string>
}

/** A package with parts added, related and given content types, and parts changed. */
export async function withParts(bytes: Uint8Array, extra: ExtraParts): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  const text = async (path: string) => (await zip.file(path)?.async('string')) ?? ''

  for (const [path, content] of Object.entries(extra.files ?? {})) {
    zip.file(path, content)
  }

  for (const [part, entries] of Object.entries(extra.relationships ?? {})) {
    const path = relsPathOf(part)
    const xml = zip.file(path) ? await text(path) : relationships([])
    zip.file(path, xml.replace('</Relationships>', `${entries.map(([id, type, target, external]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`))
  }

  const types = Object.entries(extra.types ?? {}).map(([path, type]) => `<Override PartName="/${path}" ContentType="${type}"/>`)
  zip.file('[Content_Types].xml', (await text('[Content_Types].xml')).replace('</Types>', `${types.join('')}</Types>`))

  for (const [path, change] of Object.entries(extra.change ?? {})) {
    zip.file(path, change(await text(path)))
  }

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

/** A workbook as Excel writes it with the parts asked for (all of them by default). */
export async function keptWorkbook(options: KeptWorkbookOptions = {}): Promise<Uint8Array> {
  const { pivot = true, table = true, sparklines = true, chartSheet = true, chartStyles = true, dashboard = DASHBOARD } = options
  const slicer = pivot && (options.slicer ?? true)
  const zip = new JSZip()
  const parts: Record<string, string> = {}
  const types: [string, string][] = [
    ['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
    ['/xl/worksheets/sheet1.xml', CONTENT.worksheet],
    ['/xl/worksheets/sheet2.xml', CONTENT.worksheet],
    ['/xl/worksheets/sheet3.xml', CONTENT.worksheet],
    ['/xl/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
    ['/xl/styles.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'],
    ['/xl/sharedStrings.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'],
    ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
    ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml']
  ]
  const part = (path: string, xml: string, type?: string) => {
    parts[path] = xml

    if (type) {
      types.push([`/${path}`, type])
    }
  }

  // Sales: the data, the Targets table and sparklines of the amounts.
  const salesRows = [
    row(1, [['A', 'Region'], ['B', 'Product'], ['C', 'Amount'], ...(table ? ([['E', 'Region'], ['F', 'Target']] as [string, string][]) : []), ...(sparklines ? ([['H', 'Trend']] as [string, string][]) : [])]),
    ...SALES.map(([region, product, amount], n) => row(n + 2, [['A', region], ['B', product], ['C', amount], ...(table && TARGETS[n] ? ([['E', TARGETS[n][0]], ['F', TARGETS[n][1]]] as [string, string | number][]) : [])]))
  ].join('')
  part('xl/worksheets/sheet1.xml', worksheet('A1:H7', '<cols><col min="8" max="8" width="12" customWidth="1"/></cols>', salesRows, `${table ? '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>' : ''}${sparklines ? `<extLst>${SPARKLINES}</extLst>` : ''}`))

  if (table) {
    part('xl/worksheets/_rels/sheet1.xml.rels', relationships([['rId1', TYPE.table, '../tables/table1.xml']]))
    part('xl/tables/table1.xml', TABLE, CONTENT.table)
  }

  // Summary: the pivot table's cells, the pivot table and its slicer.
  const summaryRows = [row(1, [['A', 'Sales by region', 2]]), ...(pivot ? [row(3, [['A', 'Row Labels'], ['B', 'Sum of Amount']]), row(4, [['A', 'East'], ['B', 130, 1]]), row(5, [['A', 'North'], ['B', 215, 1]]), row(6, [['A', 'South'], ['B', 210, 1]]), row(7, [['A', 'Grand Total'], ['B', 555, 1]])] : [])].join('')
  const summaryRels: [string, string, string][] = []

  if (pivot) {
    summaryRels.push(['rId1', TYPE.pivotTable, '../pivotTables/pivotTable1.xml'])
    part('xl/pivotTables/pivotTable1.xml', PIVOT_TABLE, CONTENT.pivotTable)
    part('xl/pivotTables/_rels/pivotTable1.xml.rels', relationships([['rId1', TYPE.pivotCacheDefinition, '../pivotCache/pivotCacheDefinition1.xml']]))
    part('xl/pivotCache/pivotCacheDefinition1.xml', PIVOT_CACHE, CONTENT.pivotCacheDefinition)
    part('xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels', relationships([['rId1', TYPE.pivotCacheRecords, 'pivotCacheRecords1.xml']]))
    part('xl/pivotCache/pivotCacheRecords1.xml', PIVOT_RECORDS, CONTENT.pivotCacheRecords)
  }

  if (slicer) {
    summaryRels.push(['rId2', TYPE.drawing, '../drawings/drawing2.xml'], ['rId3', TYPE.slicer, '../slicers/slicer1.xml'])
    part('xl/drawings/drawing2.xml', drawing(SLICER_ANCHOR), CONTENT.drawing)
    part('xl/slicers/slicer1.xml', SLICERS, CONTENT.slicer)
    part('xl/slicerCaches/slicerCache1.xml', SLICER_CACHE, CONTENT.slicerCache)
  }

  const summaryTail = slicer ? `<drawing r:id="rId2"/><extLst><ext uri="{A8765BA9-456A-4dab-B4F3-ACF838C121DE}" xmlns:x14="${X14}"><x14:slicerList><x14:slicer r:id="rId3"/></x14:slicerList></ext></extLst>` : ''
  part('xl/worksheets/sheet2.xml', worksheet('A1:B7', '<cols><col min="1" max="1" width="13.140625" bestFit="1" customWidth="1"/><col min="2" max="2" width="15.28515625" bestFit="1" customWidth="1"/></cols>', summaryRows, summaryTail, true))

  if (summaryRels.length) {
    part('xl/worksheets/_rels/sheet2.xml.rels', relationships(summaryRels))
  }

  // Dashboard: a drawing with a picture, a shape and charts.
  const dashboardRels: [string, string, string][] = []
  const anchors = dashboard.map((name) => {
    const id = `rId${dashboardRels.length + 1}`

    if (name === 'picture') {
      dashboardRels.push([id, TYPE.image, '../media/image1.png'])
    } else if (name === 'radar') {
      dashboardRels.push([id, TYPE.chart, '../charts/chart1.xml'])
      part('xl/charts/chart1.xml', chart('radar', 'Amount by region'), CONTENT.chart)
    } else if (name === 'chartEx') {
      dashboardRels.push([id, TYPE.chartEx, '../charts/chartEx1.xml'])
      part('xl/charts/chartEx1.xml', CHART_EX, CONTENT.chartEx)
    } else if (name === 'bar') {
      dashboardRels.push([id, TYPE.chart, '../charts/chart2.xml'])
      part('xl/charts/chart2.xml', chart('bar', 'Amounts'), CONTENT.chart)
    }

    return ANCHORS[name](id)
  })

  if (chartStyles && dashboard.includes('radar')) {
    part('xl/charts/_rels/chart1.xml.rels', relationships([['rId1', TYPE.chartStyle, 'style1.xml'], ['rId2', TYPE.chartColorStyle, 'colors1.xml']]))
    part('xl/charts/style1.xml', CHART_STYLE, CONTENT.chartStyle)
    part('xl/charts/colors1.xml', CHART_COLORS, CONTENT.chartColorStyle)
  }

  if (chartStyles && dashboard.includes('chartEx')) {
    part('xl/charts/_rels/chartEx1.xml.rels', relationships([['rId1', TYPE.chartStyle, 'style2.xml'], ['rId2', TYPE.chartColorStyle, 'colors2.xml']]))
    part('xl/charts/style2.xml', CHART_STYLE, CONTENT.chartStyle)
    part('xl/charts/colors2.xml', CHART_COLORS, CONTENT.chartColorStyle)
  }

  if (anchors.length) {
    part('xl/drawings/drawing1.xml', drawing(anchors.join('')), CONTENT.drawing)
    part('xl/drawings/_rels/drawing1.xml.rels', relationships(dashboardRels))
    part('xl/worksheets/_rels/sheet3.xml.rels', relationships([['rId1', TYPE.drawing, '../drawings/drawing1.xml']]))
  }

  part('xl/worksheets/sheet3.xml', worksheet('A1', '', row(1, [['A', 'Dashboard', 2]]), anchors.length ? '<drawing r:id="rId1"/>' : ''))

  if (chartSheet) {
    part('xl/chartsheets/sheet1.xml', CHART_SHEET, CONTENT.chartsheet)
    part('xl/chartsheets/_rels/sheet1.xml.rels', relationships([['rId1', TYPE.drawing, '../drawings/drawing3.xml']]))
    part('xl/drawings/drawing3.xml', CHART_SHEET_DRAWING, CONTENT.drawing)
    part('xl/drawings/_rels/drawing3.xml.rels', relationships([['rId1', TYPE.chart, '../charts/chart3.xml']]))
    part('xl/charts/chart3.xml', chart('line', 'Amounts over the list'), CONTENT.chart)
  }

  const workbookRels: [string, string, string][] = [
    ['rId1', TYPE.worksheet, 'worksheets/sheet1.xml'],
    ['rId2', TYPE.worksheet, 'worksheets/sheet2.xml'],
    ...(chartSheet ? ([['rId3', TYPE.chartsheet, 'chartsheets/sheet1.xml']] as [string, string, string][]) : []),
    ['rId4', TYPE.worksheet, 'worksheets/sheet3.xml'],
    ['rId5', TYPE.theme, 'theme/theme1.xml'],
    ['rId6', TYPE.styles, 'styles.xml'],
    ['rId7', TYPE.sharedStrings, 'sharedStrings.xml'],
    ...(pivot ? ([['rId8', TYPE.pivotCacheDefinition, 'pivotCache/pivotCacheDefinition1.xml']] as [string, string, string][]) : []),
    ...(slicer ? ([['rId9', TYPE.slicerCache, 'slicerCaches/slicerCache1.xml']] as [string, string, string][]) : [])
  ]
  const names = [
    ...(dashboard.includes('chartEx') ? ['<definedName name="_xlchart.v1.0" hidden="1">Sales!$A$2:$A$7</definedName>', '<definedName name="_xlchart.v1.1" hidden="1">Sales!$C$2:$C$7</definedName>'] : []),
    '<definedName name="Amounts">Sales!$C$2:$C$7</definedName>',
    ...(slicer ? ['<definedName name="Slicer_Region">#N/A</definedName>'] : []),
    `<definedName name="Total" localSheetId="${chartSheet ? 3 : 2}">Summary!$B$7</definedName>`
  ]
  const sheets = [
    '<sheet name="Sales" sheetId="1" r:id="rId1"/>',
    '<sheet name="Summary" sheetId="3" r:id="rId2"/>',
    ...(chartSheet ? ['<sheet name="Chart1" sheetId="5" r:id="rId3"/>'] : []),
    '<sheet name="Dashboard" sheetId="4" r:id="rId4"/>'
  ]
  const extensions = `${slicer ? `<ext uri="{BBE1A952-AA13-448e-AADC-164F8A28A991}" xmlns:x14="${X14}"><x14:slicerCaches><x14:slicerCache r:id="rId9"/></x14:slicerCaches></ext>` : ''}<ext uri="{79F54976-1DA5-4618-B147-4CDE4B953A38}" xmlns:x14="${X14}"><x14:workbookPr/></ext>`
  part(
    'xl/workbook.xml',
    `${HEAD}<workbook xmlns="${MAIN}" xmlns:r="${R}" xmlns:mc="${MC}" mc:Ignorable="x15" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"><fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27328"/><workbookPr defaultThemeVersion="166925"/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="12300" activeTab="1"/></bookViews><sheets>${sheets.join('')}</sheets><definedNames>${names.join('')}</definedNames><calcPr calcId="191029"/>${pivot ? '<pivotCaches><pivotCache cacheId="7" r:id="rId8"/></pivotCaches>' : ''}<extLst>${extensions}</extLst></workbook>`
  )
  part('xl/_rels/workbook.xml.rels', relationships(workbookRels))
  part('xl/theme/theme1.xml', THEME)
  part('xl/styles.xml', STYLES)
  part('xl/sharedStrings.xml', `${HEAD}<sst xmlns="${MAIN}" count="${STRINGS.length}" uniqueCount="${STRINGS.length}">${STRINGS.map((text) => `<si><t>${text}</t></si>`).join('')}</sst>`)
  part('_rels/.rels', relationships([['rId1', `${R}/officeDocument`, 'xl/workbook.xml'], ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'], ['rId3', `${R}/extended-properties`, 'docProps/app.xml']]))
  part('docProps/core.xml', `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Fixture</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2026-10-01T09:00:00Z</dcterms:created></cp:coreProperties>`)
  part('docProps/app.xml', `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>`)

  for (const [path, xml] of Object.entries(parts)) {
    zip.file(path, xml)
  }

  if (dashboard.includes('picture')) {
    zip.file('xl/media/image1.png', PNG)
  }

  zip.file('[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${types.map(([name, type]) => `<Override PartName="${name}" ContentType="${type}"/>`).join('')}</Types>`)

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
