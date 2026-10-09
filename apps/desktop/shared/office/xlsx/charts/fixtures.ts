import JSZip from 'jszip'
import { CHART_COMPONENT, CHART_DRAWING_TYPE, type CellOffset, type ChartDrawing, type ChartRange, type ChartSpec, DRAWING_RESOURCE } from '../../charts.ts'
import { CELL_TYPE, type CellMatrix, newSheet, newWorkbook, type WorkbookSnapshot } from '../../workbook.ts'
import { encodeXml } from '../xml.ts'

/*
 * Workbooks with charts for the chart tests, made here: workbooks made in Herald with a chart of
 * each kind, and workbooks as Excel writes them, part by part (Excel's chart parts with their style
 * and colour parts and extensions, anchors of each kind, a picture, a chartEx waterfall and kinds
 * Herald does not draw beside the ones it reads).
 */

export const range = (sheet: string, startRow: number, startColumn: number, endRow = startRow, endColumn = startColumn): ChartRange => ({ sheet, startRow, startColumn, endRow, endColumn })

/** Cells from rows of text and numbers, with a style id where `style` gives one. */
export function cellMatrix(rows: (string | number)[][], style?: (row: number, column: number) => string | undefined): CellMatrix {
  return Object.fromEntries(
    rows.map((row, r) => [
      r,
      Object.fromEntries(row.map((value, c) => [c, { v: value, t: typeof value === 'number' ? CELL_TYPE.number : CELL_TYPE.string, ...(style?.(r, c) ? { s: style(r, c) } : {}) }]))
    ])
  )
}

/** Sheet "Q1 sales" (id s1): months, two regions and a margin as percentages. */
export const SALES_CELLS = cellMatrix(
  [
    ['Month', 'North', 'South', 'Margin'],
    ['Jan', 120, 80, 0.25],
    ['Feb', 135, 95, 0.31],
    ['Mar', 150, 70, 0.28],
    ['Apr', 110, 105, 0.35]
  ],
  (row, column) => (row > 0 && column === 3 ? 'percent' : undefined)
)

/** Sheet "Points" (id s2): x and y values. */
export const POINTS_CELLS = cellMatrix([['X', 'Y'], [1, 2.5], [2, 3.1], [3, 4.8], [4, 4.2], [5, 6]])

const months = range('s1', 1, 0, 4, 0)

/** The series of sheet "Q1 sales", each named after its column's header. */
export const SALES_SERIES = {
  months,
  north: { name: { cell: range('s1', 0, 1) }, values: range('s1', 1, 1, 4, 1), categories: months },
  south: { name: { cell: range('s1', 0, 2) }, values: range('s1', 1, 2, 4, 2), categories: months },
  margin: { name: { cell: range('s1', 0, 3) }, values: range('s1', 1, 3, 4, 3), categories: months }
}

/** A chart's floating object, by default over columns G to N of the `at`th 16 rows. */
export function chartDrawing(id: string, sheet: string, spec: ChartSpec, options: { at?: number; from?: CellOffset; to?: CellOffset; anchorType?: '0' | '1' | '2' } = {}): ChartDrawing {
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

/** A workbook made in Herald with sheets "Q1 sales" and "Points" (or other names), and these charts over them. */
export function chartWorkbook(drawings: ChartDrawing[], names: [string, string] = ['Q1 sales', 'Points']): WorkbookSnapshot {
  const book = newWorkbook('book', 'Book', [newSheet('s1', names[0], structuredClone(SALES_CELLS)), newSheet('s2', names[1], structuredClone(POINTS_CELLS))])
  const resource: Record<string, { data: Record<string, ChartDrawing>; order: string[] }> = {}

  for (const drawing of drawings) {
    resource[drawing.subUnitId] ??= { data: {}, order: [] }
    resource[drawing.subUnitId].data[drawing.drawingId] = drawing
    resource[drawing.subUnitId].order.push(drawing.drawingId)
  }

  return { ...book, styles: { percent: { n: { pattern: '0%' } } }, resources: [{ name: DRAWING_RESOURCE, data: JSON.stringify(resource) }] }
}

const { north, south, margin } = SALES_SERIES

/** One chart of each kind, as its chart part says it exactly: colours, gridlines, series types and markers written out. */
export const EVERY_KIND: ChartSpec[] = [
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

/** A workbook made in Herald with a chart of every kind, one under another (the scatter chart on sheet "Points"). */
export const everyKindWorkbook = (): WorkbookSnapshot => chartWorkbook(EVERY_KIND.map((spec, i) => chartDrawing(`chart-${spec.kind}`, spec.kind === 'scatter' ? 's2' : 's1', spec, { at: i })))

const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'

/** A theme whose accents tell its colours from Office's: accent 1 dark blue, accent 2 burnt orange. */
const THEME_ACCENTS = ['1F4E79', 'C55A11', '7F7F7F', 'BF8F00', '2E75B6', '548235']

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="${A}" name="Fixture"><a:themeElements><a:clrScheme name="Fixture"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>${THEME_ACCENTS.map((rgb, i) => `<a:accent${i + 1}><a:srgbClr val="${rgb}"/></a:accent${i + 1}>`).join('')}<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

/** The theme's accent colours as Herald keeps colours. */
export const FIXTURE_ACCENTS = THEME_ACCENTS.map((rgb) => `#${rgb.toLowerCase()}`)

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ${MAIN}><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts><fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

/** A 1×1 PNG. */
const PIXEL = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='), (char) => char.charCodeAt(0))

export interface FixtureSheet {
  name: string
  /** Rows from the first: text, numbers, or nothing. */
  rows: (string | number | null)[][]
  /** XML before `<sheetData>` after the sheet view (`<sheetFormatPr>`, `<cols>`). */
  head?: string
  /** Attributes of rows, by row number from 1 (`ht="30" customHeight="1"`). */
  rowAttributes?: Record<number, string>
  /** The anchors of the sheet's drawing, `{{rel:N}}` naming the Nth part of `related`. */
  anchors?: string[]
  /** What the drawing's anchors relate to: chart parts and pictures. */
  related?: { type: string; path: string }[]
}

export interface FixtureOptions {
  sheets: FixtureSheet[]
  /** More parts, with their content types (none for pictures, which have a default). */
  parts?: Record<string, { content: string | Uint8Array; type?: string }>
  /** Each part's relationships, by part path. */
  relationships?: Record<string, { type: string; target: string; id?: string }[]>
}

const column = (index: number): string => (index >= 26 ? column(Math.floor(index / 26) - 1) : '') + String.fromCharCode(65 + (index % 26))

const relsXml = (entries: { id: string; type: string; target: string }[]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_REL}">${entries.map((entry) => `<Relationship Id="${entry.id}" Type="${entry.type}" Target="${encodeXml(entry.target)}"/>`).join('')}</Relationships>`

/** A part's path as its neighbour names it ("../charts/chart1.xml"). */
function relative(from: string, to: string): string {
  const base = from.split('/').slice(0, -1)
  const path = to.split('/')
  let same = 0

  while (same < base.length && same < path.length - 1 && base[same] === path[same]) {
    same++
  }

  return [...base.slice(same).map(() => '..'), ...path.slice(same)].join('/')
}

/** A workbook written part by part, as Excel writes it: shared strings, a theme, and each sheet's drawing with what it shows. */
export async function chartPackage(options: FixtureOptions): Promise<Uint8Array> {
  const zip = new JSZip()
  const strings: string[] = []
  const overrides: Record<string, string> = {
    'xl/workbook.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    'xl/styles.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
    'xl/sharedStrings.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
    'xl/theme/theme1.xml': 'application/vnd.openxmlformats-officedocument.theme+xml'
  }
  const relationships: Record<string, { type: string; target: string; id?: string }[]> = { ...options.relationships }

  options.sheets.forEach((sheet, index) => {
    const path = `xl/worksheets/sheet${index + 1}.xml`
    const rows = sheet.rows
      .map((cells, r) => {
        const content = cells
          .map((value, c) => {
            const ref = `${column(c)}${r + 1}`

            if (value === null || value === undefined) {
              return ''
            }

            if (typeof value === 'number') {
              return `<c r="${ref}"${Number.isInteger(value) ? '' : ' s="1"'}><v>${value}</v></c>`
            }

            const at = strings.includes(value) ? strings.indexOf(value) : strings.push(value) - 1

            return `<c r="${ref}" t="s"><v>${at}</v></c>`
          })
          .join('')

        return `<row r="${r + 1}" spans="1:${cells.length}"${sheet.rowAttributes?.[r + 1] ? ` ${sheet.rowAttributes[r + 1]}` : ''} x14ac:dyDescent="0.25">${content}</row>`
      })
      .join('')
    const drawing = sheet.anchors?.length ? `<drawing r:id="rId1"/>` : ''
    overrides[path] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
    zip.file(
      path,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${MAIN} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"${index === 0 ? ' tabSelected="1"' : ''}/></sheetViews>${sheet.head ?? '<sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/>'}<sheetData>${rows}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>${drawing}</worksheet>`
    )

    if (sheet.anchors?.length) {
      const drawingPath = `xl/drawings/drawing${index + 1}.xml`
      relationships[path] = [{ type: `${REL}/drawing`, target: drawingPath, id: 'rId1' }]
      relationships[drawingPath] = (sheet.related ?? []).map((entry, n) => ({ type: entry.type, target: entry.path, id: `rId${n + 1}` }))
      overrides[drawingPath] = 'application/vnd.openxmlformats-officedocument.drawing+xml'
      const anchors = sheet.anchors.map((anchor) => anchor.replace(/\{\{rel:(\d+)\}\}/g, (_whole, n: string) => `rId${Number(n) + 1}`))
      zip.file(drawingPath, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}">${anchors.join('')}</xdr:wsDr>`)
    }
  })

  for (const [path, part] of Object.entries(options.parts ?? {})) {
    zip.file(path, part.content)

    if (part.type) {
      overrides[path] = part.type
    }
  }

  relationships[''] = [{ type: `${REL}/officeDocument`, target: 'xl/workbook.xml', id: 'rId1' }]
  relationships['xl/workbook.xml'] = [
    ...options.sheets.map((_sheet, index) => ({ type: `${REL}/worksheet`, target: `xl/worksheets/sheet${index + 1}.xml`, id: `rId${index + 1}` })),
    { type: `${REL}/theme`, target: 'xl/theme/theme1.xml', id: `rId${options.sheets.length + 1}` },
    { type: `${REL}/styles`, target: 'xl/styles.xml', id: `rId${options.sheets.length + 2}` },
    { type: `${REL}/sharedStrings`, target: 'xl/sharedStrings.xml', id: `rId${options.sheets.length + 3}` }
  ]

  for (const [part, entries] of Object.entries(relationships)) {
    const slash = part.lastIndexOf('/')
    const relsPath = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
    zip.file(relsPath, relsXml(entries.map((entry, n) => ({ id: entry.id ?? `rId${n + 1}`, type: entry.type, target: part ? relative(part, entry.target) : entry.target }))))
  }

  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${MAIN}><workbookPr defaultThemeVersion="164011"/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="12300"/></bookViews><sheets>${options.sheets.map((sheet, index) => `<sheet name="${encodeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets><calcPr calcId="191029"/></workbook>`
  )
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst ${MAIN} count="${strings.length}" uniqueCount="${strings.length}">${strings.map((text) => `<si><t>${encodeXml(text)}</t></si>`).join('')}</sst>`)
  zip.file('xl/styles.xml', STYLES)
  zip.file('xl/theme/theme1.xml', THEME)
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${Object.entries(overrides)
      .map(([path, type]) => `<Override PartName="/${path}" ContentType="${type}"/>`)
      .join('')}</Types>`
  )

  return zip.generateAsync({ type: 'uint8array' })
}

/* Excel's chart parts, as Excel 2016 writes them. */

export const CHART_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
export const CHART_REL = `${REL}/chart`
const STYLE_REL = 'http://schemas.microsoft.com/office/2011/relationships/chartStyle'
const COLORS_REL = 'http://schemas.microsoft.com/office/2011/relationships/chartColorStyle'
const USER_SHAPES_REL = `${REL}/chartUserShapes`
const CHART_EX_REL = 'http://schemas.microsoft.com/office/2014/relationships/chartEx'

const text = (size: number, color = '<a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr>', rotation = '') =>
  `<c:txPr><a:bodyPr rot="${rotation || '-60000000'}" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" anchor="ctr" anchorCtr="1"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="0" i="0" u="none" strike="noStrike" kern="1200" baseline="0"><a:solidFill>${color}</a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`

const NO_LINE = '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>'
const GRID = '<c:majorGridlines><c:spPr><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr></a:solidFill><a:round/></a:ln><a:effectLst/></c:spPr></c:majorGridlines>'
const AXIS_LINE = '<c:spPr><a:noFill/><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="25000"/><a:lumOff val="75000"/></a:schemeClr></a:solidFill><a:round/></a:ln><a:effectLst/></c:spPr>'
const unique = (n: number) => `<c:extLst><c:ext uri="{C3380CC4-5D6E-409C-BE32-E72D297353CC}" xmlns:c16="http://schemas.microsoft.com/office/drawing/2014/chart"><c16:uniqueId val="{0000000${n}-0001-0000-0000-000000000000}"/></c:ext></c:extLst>`
const LABELS_OFF = '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>'

/** A reference with its cache, as a series holds one. */
export function strRef(formula: string, values: string[]): string {
  return `<c:strRef><c:f>${encodeXml(formula)}</c:f><c:strCache><c:ptCount val="${values.length}"/>${values.map((value, i) => `<c:pt idx="${i}"><c:v>${encodeXml(value)}</c:v></c:pt>`).join('')}</c:strCache></c:strRef>`
}

export function numRef(formula: string, values: number[], format = 'General'): string {
  return `<c:numRef><c:f>${encodeXml(formula)}</c:f><c:numCache><c:formatCode>${encodeXml(format)}</c:formatCode><c:ptCount val="${values.length}"/>${values.map((value, i) => `<c:pt idx="${i}"><c:v>${value}</c:v></c:pt>`).join('')}</c:numCache></c:numRef>`
}

const richTitle = (title: string) =>
  `<c:title><c:tx><c:rich><a:bodyPr rot="0" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" anchor="ctr" anchorCtr="1"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="0" i="0" u="none" strike="noStrike" kern="1200" spc="0" baseline="0"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:pPr><a:r><a:rPr lang="en-US"/><a:t>${encodeXml(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/>${NO_LINE}</c:title><c:autoTitleDeleted val="0"/>`

/** A chart part as Excel writes one: the chart space around a plot area, title and legend. */
export function excelChart(options: { title?: string; autoTitle?: boolean; plot: string; legend?: string; userShapes?: boolean }): string {
  const title = options.title ? richTitle(options.title) : options.autoTitle ? `<c:title><c:overlay val="0"/>${NO_LINE}${text(1400)}</c:title><c:autoTitleDeleted val="0"/>` : '<c:autoTitleDeleted val="1"/>'
  const legend = options.legend === 'none' ? '' : `<c:legend><c:legendPos val="${options.legend ?? 'b'}"/><c:overlay val="0"/>${NO_LINE}${text(900)}</c:legend>`

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${REL}" xmlns:c16r2="http://schemas.microsoft.com/office/drawing/2015/06/chart">` +
    `<c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="c14" xmlns:c14="http://schemas.microsoft.com/office/drawing/2007/8/2/chart"><c14:style val="102"/></mc:Choice><mc:Fallback><c:style val="2"/></mc:Fallback></mc:AlternateContent>` +
    `<c:chart>${title}<c:plotArea><c:layout/>${options.plot}${NO_LINE}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    `<c:spPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr></a:solidFill><a:round/></a:ln><a:effectLst/></c:spPr>` +
    `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr><c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings>` +
    `${options.userShapes ? '<c:userShapes r:id="rId3"/>' : ''}</c:chartSpace>`
  )
}

/** A category axis and a value axis crossing it, as Excel writes them. */
export function excelAxes(category: number, value: number, options: { position?: 'b' | 'l'; valueTitle?: string; format?: string; max?: number } = {}): string {
  const [catPos, valPos] = options.position === 'l' ? ['l', 'b'] : ['b', 'l']
  const title = options.valueTitle
    ? `<c:title><c:tx><c:rich><a:bodyPr rot="-5400000" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" anchor="ctr" anchorCtr="1"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>${encodeXml(options.valueTitle)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/>${NO_LINE}</c:title>`
    : ''

  return (
    `<c:catAx><c:axId val="${category}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${catPos}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${AXIS_LINE}${text(900)}<c:crossAx val="${value}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
    `<c:valAx><c:axId val="${value}"/><c:scaling><c:orientation val="minMax"/>${options.max !== undefined ? `<c:max val="${options.max}"/>` : ''}</c:scaling><c:delete val="0"/><c:axPos val="${valPos}"/>${GRID}${title}<c:numFmt formatCode="${encodeXml(options.format ?? 'General')}" sourceLinked="${options.format ? 0 : 1}"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${NO_LINE}${text(900)}<c:crossAx val="${category}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr']
const NORTH = [120, 135, 150, 110]
const SOUTH = [80, 95, 70, 105]
const MARGIN = [0.25, 0.31, 0.28, 0.35]

const barSeries = (n: number, name: string, column: string, values: number[], color: string) =>
  `<c:ser><c:idx val="${n}"/><c:order val="${n}"/><c:tx>${strRef(`'Q1 sales'!$${column}$1`, [name])}</c:tx><c:spPr><a:solidFill>${color}</a:solidFill><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr><c:invertIfNegative val="0"/><c:cat>${strRef("'Q1 sales'!$A$2:$A$5", MONTHS)}</c:cat><c:val>${numRef(`'Q1 sales'!$${column}$2:$${column}$5`, values)}</c:val>${unique(n)}</c:ser>`

/** A clustered column chart: two series with names, categories and values from cells, theme colours, a title and a value axis title. */
export const COLUMN_CHART = excelChart({
  title: 'Quarterly sales',
  userShapes: true,
  plot:
    `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${barSeries(0, 'North', 'B', NORTH, '<a:schemeClr val="accent1"/>')}${barSeries(1, 'South', 'C', SOUTH, '<a:schemeClr val="accent2"><a:lumMod val="75000"/></a:schemeClr>')}` +
    `${LABELS_OFF}<c:gapWidth val="219"/><c:overlap val="-27"/><c:axId val="508467296"/><c:axId val="508467624"/></c:barChart>${excelAxes(508467296, 508467624, { valueTitle: 'Units' })}`
})

const slice = (n: number, color: string) =>
  `<c:dPt><c:idx val="${n}"/><c:bubble3D val="0"/><c:spPr><a:solidFill>${color}</a:solidFill><a:ln w="19050"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln><a:effectLst/></c:spPr>${unique(n)}</c:dPt>`

/** A pie of one series with percentages on its slices, titled after the series as Excel does. */
export const PIE_CHART = excelChart({
  autoTitle: true,
  legend: 'r',
  plot:
    `<c:pieChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx>${strRef("'Q1 sales'!$B$1", ['North'])}</c:tx>` +
    `${slice(0, '<a:schemeClr val="accent1"/>')}${slice(1, '<a:schemeClr val="accent2"/>')}${slice(2, '<a:srgbClr val="FF0000"/>')}${slice(3, '<a:schemeClr val="accent4"/>')}` +
    `<c:dLbls><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>${text(900)}<c:dLblPos val="bestFit"/><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="1"/></c:dLbls>` +
    `<c:cat>${strRef("'Q1 sales'!$A$2:$A$5", MONTHS)}</c:cat><c:val>${numRef("'Q1 sales'!$B$2:$B$5", NORTH)}</c:val>${unique(0)}</c:ser>` +
    `<c:dLbls><c:dLblPos val="bestFit"/><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="1"/></c:dLbls><c:firstSliceAng val="0"/></c:pieChart>`
})

/** Columns and a line on a secondary axis (a percentage), as Excel's "Clustered Column - Line on Secondary Axis" writes them. */
export const COMBO_CHART = excelChart({
  title: 'Sales and margin',
  plot:
    `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${barSeries(0, 'North', 'B', NORTH, '<a:schemeClr val="accent1"/>')}${LABELS_OFF}<c:gapWidth val="219"/><c:overlap val="-27"/><c:axId val="111"/><c:axId val="222"/></c:barChart>` +
    `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/><c:ser><c:idx val="1"/><c:order val="1"/><c:tx>${strRef("'Q1 sales'!$D$1", ['Margin'])}</c:tx><c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="70AD47"/></a:solidFill><a:round/></a:ln><a:effectLst/></c:spPr><c:marker><c:symbol val="none"/></c:marker>` +
    `<c:cat>${strRef("'Q1 sales'!$A$2:$A$5", MONTHS)}</c:cat><c:val>${numRef("'Q1 sales'!$D$2:$D$5", MARGIN, '0.0%')}</c:val><c:smooth val="0"/>${unique(1)}</c:ser>${LABELS_OFF}<c:marker val="1"/><c:axId val="333"/><c:axId val="444"/></c:lineChart>` +
    `${excelAxes(111, 222)}` +
    `<c:valAx><c:axId val="444"/><c:scaling><c:orientation val="minMax"/><c:max val="0.5"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="r"/><c:numFmt formatCode="0%" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${NO_LINE}${text(900)}<c:crossAx val="333"/><c:crosses val="max"/><c:crossBetween val="between"/></c:valAx>` +
    `<c:catAx><c:axId val="333"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="1"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="444"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
})

/** Points only (Excel's "Scatter"): the series' line not drawn, its markers filled with accent 1. */
export const SCATTER_CHART = excelChart({
  title: 'Growth',
  legend: 'none',
  plot:
    `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx>${strRef('Points!$B$1', ['Y'])}</c:tx><c:spPr><a:ln w="25400" cap="rnd"><a:noFill/><a:round/></a:ln><a:effectLst/></c:spPr>` +
    `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:ln w="9525"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln><a:effectLst/></c:spPr></c:marker>` +
    `<c:xVal>${numRef('Points!$A$2:$A$6', [1, 2, 3, 4, 5])}</c:xVal><c:yVal>${numRef('Points!$B:$B', [2.5, 3.1, 4.8, 4.2, 6])}</c:yVal><c:smooth val="0"/>${unique(0)}</c:ser>${LABELS_OFF}<c:axId val="51"/><c:axId val="52"/></c:scatterChart>` +
    `<c:valAx><c:axId val="51"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${AXIS_LINE}${text(900)}<c:crossAx val="52"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>` +
    `<c:valAx><c:axId val="52"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>${GRID}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${NO_LINE}${text(900)}<c:crossAx val="51"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`
})

/** A 3D clustered column chart, which Herald does not draw. */
export const COLUMN_3D_CHART = excelChart({
  title: 'In depth',
  plot: `<c:bar3DChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${barSeries(0, 'North', 'B', NORTH, '<a:schemeClr val="accent1"/>')}<c:gapWidth val="150"/><c:shape val="box"/><c:axId val="61"/><c:axId val="62"/><c:axId val="0"/></c:bar3DChart>${excelAxes(61, 62)}`
}).replace('<c:autoTitleDeleted val="0"/><c:plotArea>', '<c:autoTitleDeleted val="0"/><c:view3D><c:rotX val="15"/><c:rotY val="20"/><c:rAngAx val="1"/></c:view3D><c:plotArea>')

/** A radar chart, which Herald does not draw. */
export const RADAR_CHART = excelChart({
  title: 'Around',
  plot: `<c:radarChart><c:radarStyle val="marker"/><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx>${strRef("'Q1 sales'!$B$1", ['North'])}</c:tx><c:cat>${strRef("'Q1 sales'!$A$2:$A$5", MONTHS)}</c:cat><c:val>${numRef("'Q1 sales'!$B$2:$B$5", NORTH)}</c:val></c:ser><c:axId val="71"/><c:axId val="72"/></c:radarChart>${excelAxes(71, 72)}`
})

/** A waterfall chart, which Excel writes as a chartEx part. */
export const WATERFALL_CHART = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cx:chartSpace xmlns:a="${A}" xmlns:r="${REL}" xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chartData><cx:data id="0"><cx:strDim type="cat"><cx:f>'Q1 sales'!$A$2:$A$5</cx:f><cx:lvl ptCount="4">${MONTHS.map((month, i) => `<cx:pt idx="${i}">${month}</cx:pt>`).join('')}</cx:lvl></cx:strDim><cx:numDim type="val"><cx:f>'Q1 sales'!$B$2:$B$5</cx:f><cx:lvl ptCount="4" formatCode="General">${NORTH.map((value, i) => `<cx:pt idx="${i}">${value}</cx:pt>`).join('')}</cx:lvl></cx:numDim></cx:data></cx:chartData><cx:chart><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="waterfall" uniqueId="{6F1A2B3C-0000-4000-8000-000000000001}"><cx:dataId val="0"/><cx:layoutPr><cx:subtotals><cx:idx val="3"/></cx:subtotals></cx:layoutPr></cx:series></cx:plotAreaRegion><cx:axis id="0"><cx:catScaling gapWidth="0.5"/><cx:tickLabels/></cx:axis><cx:axis id="1"><cx:valScaling/><cx:majorGridlines/><cx:tickLabels/></cx:axis></cx:plotArea><cx:legend pos="t" align="ctr" overlay="0"/></cx:chart></cx:chartSpace>`

export const CHART_STYLE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cs:chartStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle" xmlns:a="${A}" id="201"><cs:axisTitle><cs:lnRef idx="0"/><cs:fillRef idx="0"/><cs:effectRef idx="0"/><cs:fontRef idx="minor"><a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></cs:fontRef><cs:defRPr sz="1000" kern="1200"/></cs:axisTitle></cs:chartStyle>`
export const CHART_COLORS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cs:colorStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle" xmlns:a="${A}" meth="cycle" id="10"><a:schemeClr val="accent1"/><a:schemeClr val="accent2"/><a:schemeClr val="accent3"/><a:schemeClr val="accent4"/><a:schemeClr val="accent5"/><a:schemeClr val="accent6"/><cs:variation/><cs:variation><a:lumMod val="60000"/></cs:variation></cs:colorStyle>`

/** A note drawn over the column chart (a user shape), with a picture of its own. */
const USER_SHAPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:userShapes xmlns:c="${C}"><cdr:relSizeAnchor xmlns:cdr="http://schemas.openxmlformats.org/drawingml/2006/chartDrawing"><cdr:from><cdr:x>0.05</cdr:x><cdr:y>0.05</cdr:y></cdr:from><cdr:to><cdr:x>0.15</cdr:x><cdr:y>0.15</cdr:y></cdr:to><cdr:pic><cdr:nvPicPr><cdr:cNvPr id="2" name="Logo"/><cdr:cNvPicPr/></cdr:nvPicPr><cdr:blipFill><a:blip xmlns:a="${A}" xmlns:r="${REL}" r:embed="rId1"/><a:stretch xmlns:a="${A}"><a:fillRect/></a:stretch></cdr:blipFill><cdr:spPr><a:prstGeom xmlns:a="${A}" prst="rect"><a:avLst/></a:prstGeom></cdr:spPr></cdr:pic></cdr:relSizeAnchor></c:userShapes>`

/** An anchor over two cells, as Excel writes a chart's (`{{rel:N}}` its chart). */
export function twoCellAnchor(id: number, from: [number, number, number, number], to: [number, number, number, number], graphic: string, editAs?: string): string {
  const marker = (tag: string, [col, colOff, row, rowOff]: number[]) => `<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:colOff>${colOff}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${rowOff}</xdr:rowOff></xdr:${tag}>`

  return `<xdr:twoCellAnchor${editAs ? ` editAs="${editAs}"` : ''}>${marker('from', from)}${marker('to', to)}${graphic.replace(/\{\{id\}\}/g, String(id))}<xdr:clientData/></xdr:twoCellAnchor>`
}

/** A chart's graphic frame (`{{rel:N}}` its chart part). */
export function chartFrame(rel: number, name: string): string {
  return `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="{{id}}" name="${name}"><a:extLst><a:ext uri="{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}"><a16:creationId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" id="{00000000-0008-0000-0000-00000${rel}000000}"/></a:ext></a:extLst></xdr:cNvPr><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" xmlns:r="${REL}" r:id="{{rel:${rel}}}"/></a:graphicData></a:graphic></xdr:graphicFrame>`
}

const PICTURE = `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="{{id}}" name="Picture 1"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="${REL}" r:embed="{{rel:0}}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`

const WATERFALL_ANCHOR = twoCellAnchor(
  8,
  [13, 0, 40, 0],
  [20, 0, 55, 0],
  `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:cx1="http://schemas.microsoft.com/office/drawing/2015/9/8/chartex" Requires="cx1"><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="8" name="Chart 7"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chart xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" xmlns:r="${REL}" r:id="{{rel:6}}"/></a:graphicData></a:graphic></xdr:graphicFrame></mc:Choice><mc:Fallback><xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="8" name="Chart 7"/><xdr:cNvSpPr><a:spLocks noTextEdit="1"/></xdr:cNvSpPr></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="7924800" y="7620000"/><a:ext cx="4267200" cy="2857500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:prstClr val="white"/></a:solidFill><a:ln w="1"><a:solidFill><a:prstClr val="green"/></a:solidFill></a:ln></xdr:spPr><xdr:txBody><a:bodyPr vertOverflow="clip" horzOverflow="clip"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1100"/><a:t>This chart isn't available in your version of Excel.</a:t></a:r></a:p></xdr:txBody></xdr:sp></mc:Fallback></mc:AlternateContent>`,
  'oneCell'
)

/** Where each chart of the Excel workbook sits on its sheet, by its place in the sheet's drawing. */
export const EXCEL_ANCHORS = {
  sales: [
    twoCellAnchor(2, [5, 0, 0, 0], [6, 0, 2, 0], PICTURE, 'oneCell'),
    twoCellAnchor(3, [4, 304800, 1, 9525], [11, 609600, 16, 95250], chartFrame(1, 'Chart 1')),
    `<xdr:oneCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>18</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="4572000" cy="2743200"/>${chartFrame(2, 'Chart 2').replace('{{id}}', '4')}<xdr:clientData/></xdr:oneCellAnchor>`,
    twoCellAnchor(5, [12, 0, 1, 0], [19, 0, 16, 0], chartFrame(3, 'Chart 3'), 'oneCell'),
    twoCellAnchor(6, [12, 0, 18, 0], [19, 0, 33, 0], chartFrame(4, 'Chart 4')),
    twoCellAnchor(7, [4, 0, 40, 0], [11, 0, 55, 0], chartFrame(5, 'Chart 5')),
    WATERFALL_ANCHOR
  ],
  points: [`<xdr:absoluteAnchor><xdr:pos x="1905000" y="190500"/><xdr:ext cx="3810000" cy="2286000"/>${chartFrame(0, 'Chart 1').replace('{{id}}', '2')}<xdr:clientData/></xdr:absoluteAnchor>`]
}

/**
 * A workbook as Excel writes it: sheet "Q1 sales" (months, two regions and a margin; a picture, a
 * clustered column chart with a user shape, a pie, a column and line combo with a secondary axis,
 * then a 3D column chart, a radar chart and a waterfall Herald does not draw), and sheet "Points"
 * with a scatter chart placed absolutely.
 */
export async function excelWorkbook(): Promise<Uint8Array> {
  const part = (content: string, type = CHART_TYPE) => ({ content, type })

  return chartPackage({
    sheets: [
      {
        name: 'Q1 sales',
        head: '<sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/><cols><col min="1" max="1" width="12.7109375" customWidth="1"/><col min="8" max="8" width="9.140625" hidden="1" customWidth="1"/></cols>',
        rowAttributes: { 3: 'ht="30" customHeight="1"' },
        rows: [['Month', 'North', 'South', 'Margin'], ...MONTHS.map((month, i) => [month, NORTH[i], SOUTH[i], MARGIN[i]])],
        anchors: EXCEL_ANCHORS.sales,
        related: [
          { type: `${REL}/image`, path: 'xl/media/image1.png' },
          { type: CHART_REL, path: 'xl/charts/chart1.xml' },
          { type: CHART_REL, path: 'xl/charts/chart2.xml' },
          { type: CHART_REL, path: 'xl/charts/chart3.xml' },
          { type: CHART_REL, path: 'xl/charts/chart4.xml' },
          { type: CHART_REL, path: 'xl/charts/chart5.xml' },
          { type: CHART_EX_REL, path: 'xl/charts/chartEx1.xml' }
        ]
      },
      {
        name: 'Points',
        rows: [['X', 'Y'], [1, 2.5], [2, 3.1], [3, 4.8], [4, 4.2], [5, 6]],
        anchors: EXCEL_ANCHORS.points,
        related: [{ type: CHART_REL, path: 'xl/charts/chart6.xml' }]
      }
    ],
    parts: {
      'xl/media/image1.png': { content: PIXEL },
      'xl/media/image2.png': { content: PIXEL },
      'xl/charts/chart1.xml': part(COLUMN_CHART),
      'xl/charts/chart2.xml': part(PIE_CHART),
      'xl/charts/chart3.xml': part(COMBO_CHART),
      'xl/charts/chart4.xml': part(COLUMN_3D_CHART),
      'xl/charts/chart5.xml': part(RADAR_CHART),
      'xl/charts/chart6.xml': part(SCATTER_CHART),
      'xl/charts/chartEx1.xml': part(WATERFALL_CHART, 'application/vnd.ms-office.chartex+xml'),
      'xl/charts/style1.xml': part(CHART_STYLE, 'application/vnd.ms-office.chartstyle+xml'),
      'xl/charts/colors1.xml': part(CHART_COLORS, 'application/vnd.ms-office.chartcolorstyle+xml'),
      'xl/drawings/drawing3.xml': part(USER_SHAPES, 'application/vnd.openxmlformats-officedocument.drawingml.chartshapes+xml')
    },
    relationships: {
      // Excel lists a chart's colours before its style.
      'xl/charts/chart1.xml': [
        { id: 'rId2', type: COLORS_REL, target: 'xl/charts/colors1.xml' },
        { id: 'rId1', type: STYLE_REL, target: 'xl/charts/style1.xml' },
        { id: 'rId3', type: USER_SHAPES_REL, target: 'xl/drawings/drawing3.xml' }
      ],
      'xl/drawings/drawing3.xml': [{ id: 'rId1', type: `${REL}/image`, target: 'xl/media/image2.png' }]
    }
  })
}
