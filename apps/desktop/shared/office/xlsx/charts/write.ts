import type { ChartAxis, ChartRange, ChartSeries, ChartSpec } from '../../charts.ts'
import { CELL_TYPE, type CellSnapshot, plainTextOf } from '../../workbook.ts'
import { columnName, MAX_COLUMNS, MAX_ROWS, quoteSheet } from '../address.ts'
import { encodeXml } from '../xml.ts'
import { NS, solidFill } from './drawingml.ts'

/*
 * A Herald chart as an Excel chart part (c:chartSpace), drawn in Excel as Herald draws it: each
 * series' colour written out, the categories of the first series that has them for every series,
 * a pie's slices in the palette's colours, bars, lines and areas sized and styled alike, and caches
 * of the cells' values so the chart shows before Excel works its formulas out. Every element goes
 * where ECMA-376 (dml-chart.xsd) orders it, or Excel repairs the file.
 */

/** What writing a chart needs of the workbook: the sheets' names in the file, and their cells. */
export interface ChartCells {
  /** A sheet's name in the file, by snapshot id; undefined for a sheet that is not written. */
  sheetName: (sheet: string) => string | undefined
  /** The cells of a sheet in the snapshot, by row then column. */
  cells: (sheet: string) => Record<number, Record<number, CellSnapshot>> | undefined
  /** The number format a cell shows its value with. */
  format: (cell: CellSnapshot) => string | undefined
  date1904: boolean
}

/** Axis ids: the primary category and value axes, then the secondary ones of a combo chart. */
const AXIS = { category: 101, value: 102, category2: 103, value2: 104 }

/** Herald's lines are 2 pixels wide and its scatter points 8 pixels across. */
const LINE_WIDTH = 19050
const GRID_COLOR = '#d9d9d9'
const AXIS_COLOR = '#bfbfbf'
const TEXT_COLOR = '#595959'

const val = (name: string, value: string | number): string => `<c:${name} val="${value}"/>`

type GroupType = 'column' | 'line' | 'area'

/** How a series of a combo chart draws: its own type, else its first series as columns and the rest as lines. */
export const comboType = (spec: ChartSpec, index: number): GroupType => spec.series[index]?.type ?? (index === 0 ? 'column' : 'line')

/** A range as a chart formula writes it: "'Q1 sales'!$B$2:$B$9", a whole column as "$B:$B". */
export function formulaOf(range: ChartRange, sheetName: string): string {
  const sheet = /^(R|C|RC|R\d+C?\d*|C\d+)$/i.test(sheetName) ? `'${sheetName}'` : quoteSheet(sheetName)
  const [startColumn, endColumn] = [columnName(range.startColumn), columnName(range.endColumn)]
  let ref: string

  if (range.startRow === 0 && range.endRow >= MAX_ROWS - 1) {
    ref = `$${startColumn}:$${endColumn}`
  } else if (range.startColumn === 0 && range.endColumn >= MAX_COLUMNS - 1) {
    ref = `$${range.startRow + 1}:$${range.endRow + 1}`
  } else {
    const start = `$${startColumn}$${range.startRow + 1}`
    const end = `$${endColumn}$${range.endRow + 1}`
    ref = start === end ? start : `${start}:${end}`
  }

  return `${sheet}!${ref}`
}

/** The cells of a range in order, rows first; a whole column or row ends at the last cell with a value. */
function cellsIn(range: ChartRange, cells: Record<number, Record<number, CellSnapshot>>): (CellSnapshot | undefined)[] {
  let { endRow, endColumn } = range
  const rows = () => Object.keys(cells).map(Number).filter((row) => row >= range.startRow && row <= range.endRow)
  const columnsOf = (row: number) => Object.keys(cells[row] ?? {}).map(Number).filter((column) => column >= range.startColumn && column <= range.endColumn)

  if (range.endRow >= MAX_ROWS - 1) {
    endRow = Math.max(range.startRow, ...rows().filter((row) => columnsOf(row).length))
  } else if (range.endColumn >= MAX_COLUMNS - 1) {
    endColumn = Math.max(range.startColumn, ...rows().flatMap(columnsOf))
  }

  const found: (CellSnapshot | undefined)[] = []

  for (let row = range.startRow; row <= endRow; row++) {
    for (let column = range.startColumn; column <= endColumn; column++) {
      found.push(cells[row]?.[column])
    }
  }

  return found
}

function numberIn(cell: CellSnapshot | undefined): number | null {
  const value = cell?.v

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (cell?.t === CELL_TYPE.number && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }

  return null
}

function textIn(cell: CellSnapshot | undefined): string {
  const value = cell?.v

  if (value === undefined || value === null || value === '') {
    return plainTextOf(cell)
  }

  return typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value)
}

class ChartWriter {
  constructor(
    private readonly spec: ChartSpec,
    private readonly source: ChartCells,
    private readonly palette: string[]
  ) {}

  private cells(range: ChartRange): (CellSnapshot | undefined)[] {
    const cells = this.source.cells(range.sheet)

    return cells ? cellsIn(range, cells) : []
  }

  /** A reference to a range with its cache: numbers (c:numRef) when every value in it is one, else text (c:strRef). */
  reference(range: ChartRange, numbers: boolean): string {
    const formula = encodeXml(formulaOf(range, this.source.sheetName(range.sheet) ?? ''))
    const cells = this.cells(range)
    const filled = cells.filter((cell) => textIn(cell) !== '')

    if (numbers || (filled.length && filled.every((cell) => numberIn(cell) !== null))) {
      const formats = cells.map((cell) => (numberIn(cell) === null ? undefined : (this.source.format(cell!) ?? 'General')))
      const format = formats.find(Boolean) ?? 'General'
      const points = cells
        .map((cell, i) => {
          const value = numberIn(cell)

          return value === null ? '' : `<c:pt idx="${i}"${formats[i] !== format ? ` formatCode="${encodeXml(formats[i]!)}"` : ''}><c:v>${value}</c:v></c:pt>`
        })
        .join('')

      return `<c:numRef><c:f>${formula}</c:f><c:numCache><c:formatCode>${encodeXml(format)}</c:formatCode><c:ptCount val="${cells.length}"/>${points}</c:numCache></c:numRef>`
    }

    const points = cells.map((cell, i) => (textIn(cell) === '' ? '' : `<c:pt idx="${i}"><c:v>${encodeXml(textIn(cell))}</c:v></c:pt>`)).join('')

    return `<c:strRef><c:f>${formula}</c:f><c:strCache><c:ptCount val="${cells.length}"/>${points}</c:strCache></c:strRef>`
  }

  /** The series' name (c:tx): its cell, or its text. */
  name(series: ChartSeries): string {
    const cell = series.name?.cell

    if (cell && this.source.sheetName(cell.sheet) !== undefined) {
      const formula = encodeXml(formulaOf(cell, this.source.sheetName(cell.sheet)!))
      const text = this.cells(cell).map(textIn).join(' ')

      return `<c:tx><c:strRef><c:f>${formula}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${encodeXml(text)}</c:v></c:pt></c:strCache></c:strRef></c:tx>`
    }

    return series.name?.text ? `<c:tx><c:v>${encodeXml(series.name.text)}</c:v></c:tx>` : ''
  }

  /** The categories every series is drawn against: the first series' that has them. */
  get categories(): ChartRange | undefined {
    return this.spec.series.find((series) => series.categories && this.source.sheetName(series.categories.sheet) !== undefined)?.categories
  }

  points(series: ChartSeries): number {
    return this.cells(series.values).length
  }

  colorOf(index: number): string {
    return this.spec.series[index]?.color ?? this.palette[index % this.palette.length]
  }

  /** The data labels a series or chart group shows (c:dLbls), the show flags in the schema's order. */
  labels(type: GroupType | 'pie' | 'doughnut' | 'scatter', position: boolean, stacked: boolean): string {
    const mode = this.spec.labels
    const round = type === 'pie' || type === 'doughnut'
    const shown = { value: mode === 'value' || (mode === 'percent' && !round && type !== 'scatter'), category: mode === 'category', percent: mode === 'percent' && round }
    const at = position && mode !== 'none' ? { column: stacked ? 'ctr' : 'outEnd', line: 't', scatter: 't', pie: 'outEnd', area: '', doughnut: '' }[type] : ''

    return (
      `<c:dLbls>${at ? val('dLblPos', at) : ''}${val('showLegendKey', 0)}${val('showVal', Number(shown.value))}${val('showCatName', Number(shown.category))}` +
      `${val('showSerName', 0)}${val('showPercent', Number(shown.percent))}${val('showBubbleSize', 0)}${round ? val('showLeaderLines', 1) : ''}</c:dLbls>`
    )
  }

  seriesLabels(type: GroupType | 'pie' | 'doughnut' | 'scatter', stacked = false): string {
    return this.spec.labels === 'none' ? '' : this.labels(type, true, stacked)
  }

  series(index: number, type: GroupType | 'pie' | 'doughnut' | 'scatter', stacked: boolean): string {
    const series = this.spec.series[index]
    const color = this.colorOf(index)
    const head = `${val('idx', index)}${val('order', index)}${this.name(series)}`
    const categories = this.categories
    const cat = (tag: string) => (categories ? `<c:${tag}>${this.reference(categories, tag === 'xVal')}</c:${tag}>` : '')
    const values = (tag: string) => `<c:${tag}>${this.reference(series.values, true)}</c:${tag}>`
    const marker = (size: number) => `<c:marker>${val('symbol', 'circle')}${val('size', size)}<c:spPr>${solidFill(color)}<a:ln w="9525">${solidFill(color)}</a:ln></c:spPr></c:marker>`

    switch (type) {
      case 'column':
        return `<c:ser>${head}<c:spPr>${solidFill(color)}<a:ln><a:noFill/></a:ln></c:spPr>${val('invertIfNegative', 0)}${this.seriesLabels(type, stacked)}${cat('cat')}${values('val')}</c:ser>`
      case 'line': {
        const markers = series.markers ?? this.points(series) <= 40

        return `<c:ser>${head}<c:spPr><a:ln w="${LINE_WIDTH}" cap="rnd">${solidFill(color)}<a:round/></a:ln></c:spPr>${markers ? marker(5) : `<c:marker>${val('symbol', 'none')}</c:marker>`}${this.seriesLabels(type)}${cat('cat')}${values('val')}${val('smooth', Number(series.smooth === true))}</c:ser>`
      }
      case 'area':
        return `<c:ser>${head}<c:spPr><a:solidFill><a:srgbClr val="${color.slice(1).toUpperCase()}"><a:alpha val="${stacked ? 80000 : 35000}"/></a:srgbClr></a:solidFill><a:ln w="${LINE_WIDTH}">${solidFill(color)}</a:ln></c:spPr>${this.seriesLabels(type)}${cat('cat')}${values('val')}</c:ser>`
      case 'pie':
      case 'doughnut': {
        const slices = Array.from({ length: this.points(series) }, (_, i) => `<c:dPt>${val('idx', i)}${val('bubble3D', 0)}<c:spPr>${solidFill(this.palette[i % this.palette.length])}<a:ln w="9525">${solidFill('#ffffff')}</a:ln></c:spPr></c:dPt>`)

        return `<c:ser>${head}${slices.join('')}${this.seriesLabels(type)}${cat('cat')}${values('val')}</c:ser>`
      }
      case 'scatter':
        return `<c:ser>${head}<c:spPr><a:ln w="${LINE_WIDTH}"><a:noFill/></a:ln></c:spPr>${marker(6)}${this.seriesLabels(type)}${cat('xVal')}${values('yVal')}${val('smooth', 0)}</c:ser>`
    }
  }

  title(text: string | undefined, size: number, rotated = false): string {
    const lines = text?.trim() ? text.split('\n') : []

    if (!lines.length) {
      return ''
    }

    const run = (line: string) => `<a:p><a:pPr><a:defRPr sz="${size}" b="${size > 1200 ? 1 : 0}"/></a:pPr>${line ? `<a:r><a:rPr lang="en-US" sz="${size}" b="${size > 1200 ? 1 : 0}"/><a:t>${encodeXml(line)}</a:t></a:r>` : ''}</a:p>`

    return `<c:title><c:tx><c:rich><a:bodyPr${rotated ? ' rot="-5400000" vert="horz"' : ''}/><a:lstStyle/>${lines.map(run).join('')}</c:rich></c:tx>${val('overlay', 0)}</c:title>`
  }

  gridlines(show: boolean): string {
    return show ? `<c:majorGridlines><c:spPr><a:ln w="9525">${solidFill(GRID_COLOR)}</a:ln></c:spPr></c:majorGridlines>` : ''
  }

  numberFormat(axis: ChartAxis | undefined): string {
    return axis?.format ? `<c:numFmt formatCode="${encodeXml(axis.format)}" sourceLinked="0"/>` : '<c:numFmt formatCode="General" sourceLinked="1"/>'
  }

  categoryAxis(id: number, crossing: number, axis: ChartAxis | undefined, options: { position: string; deleted?: boolean; reversed?: boolean }): string {
    return (
      `<c:catAx>${val('axId', id)}<c:scaling>${val('orientation', options.reversed ? 'maxMin' : 'minMax')}</c:scaling>${val('delete', Number(options.deleted || axis?.hidden === true))}${val('axPos', options.position)}` +
      `${this.gridlines(axis?.gridlines === true)}${this.title(axis?.title, 1000, options.position === 'l' || options.position === 'r')}${this.numberFormat(axis)}` +
      `${val('majorTickMark', 'none')}${val('minorTickMark', 'none')}${val('tickLblPos', 'nextTo')}<c:spPr><a:noFill/><a:ln w="9525">${solidFill(AXIS_COLOR)}</a:ln></c:spPr>` +
      `${val('crossAx', crossing)}${val('crosses', 'autoZero')}${val('auto', 1)}${val('lblAlgn', 'ctr')}${val('lblOffset', 100)}${val('noMultiLvlLbl', 0)}</c:catAx>`
    )
  }

  valueAxis(id: number, crossing: number, axis: ChartAxis | undefined, options: { position: string; gridlines: boolean; crosses: 'autoZero' | 'max'; between: 'between' | 'midCat'; line?: boolean }): string {
    const bounds = `${axis?.max !== undefined ? val('max', axis.max) : ''}${axis?.min !== undefined ? val('min', axis.min) : ''}`

    return (
      `<c:valAx>${val('axId', id)}<c:scaling>${val('orientation', 'minMax')}${bounds}</c:scaling>${val('delete', Number(axis?.hidden === true))}${val('axPos', options.position)}` +
      `${this.gridlines(axis?.gridlines ?? options.gridlines)}${this.title(axis?.title, 1000, options.position === 'l' || options.position === 'r')}${this.numberFormat(axis)}` +
      `${val('majorTickMark', 'none')}${val('minorTickMark', 'none')}${val('tickLblPos', 'nextTo')}<c:spPr><a:noFill/>${options.line ? `<a:ln w="9525">${solidFill(AXIS_COLOR)}</a:ln>` : '<a:ln><a:noFill/></a:ln>'}</c:spPr>` +
      `${val('crossAx', crossing)}${val('crosses', options.crosses)}${val('crossBetween', options.between)}</c:valAx>`
    )
  }

  /** The plot area's chart groups and axes. */
  plot(): string {
    const { spec } = this
    const indexes = spec.series.map((_, i) => i).filter((i) => this.source.sheetName(spec.series[i].values.sheet) !== undefined)
    const stacking = spec.stacking ?? 'none'
    const grouping = stacking === 'stacked' ? 'stacked' : stacking === 'percent' ? 'percentStacked' : undefined
    const stacked = grouping !== undefined

    if (spec.kind === 'pie' || spec.kind === 'doughnut') {
      const series = indexes.map((i) => this.series(i, spec.kind as 'pie', false)).join('')
      const hole = spec.kind === 'doughnut' ? val('holeSize', Math.round(Math.min(90, Math.max(10, spec.hole ?? 50)))) : ''

      return `<c:${spec.kind}Chart>${val('varyColors', 1)}${series}${this.labels(spec.kind, false, false)}${val('firstSliceAng', 0)}${hole}</c:${spec.kind}Chart>`
    }

    if (spec.kind === 'scatter') {
      const series = indexes.map((i) => this.series(i, 'scatter', false)).join('')

      return (
        `<c:scatterChart>${val('scatterStyle', 'lineMarker')}${val('varyColors', 0)}${series}${this.labels('scatter', false, false)}${val('axId', AXIS.category)}${val('axId', AXIS.value)}</c:scatterChart>` +
        this.valueAxis(AXIS.category, AXIS.value, spec.axes?.x, { position: 'b', gridlines: true, crosses: 'autoZero', between: 'midCat', line: true }) +
        this.valueAxis(AXIS.value, AXIS.category, spec.axes?.y, { position: 'l', gridlines: true, crosses: 'autoZero', between: 'midCat' })
      )
    }

    const typeOf = (i: number): GroupType => (spec.kind === 'combo' ? comboType(spec, i) : spec.kind === 'line' ? 'line' : spec.kind === 'area' ? 'area' : 'column')
    const secondaryOf = (i: number) => spec.kind === 'combo' && spec.series[i].secondary === true
    // With nothing on the primary axes, the secondary ones are the primary ones.
    const twoAxes = indexes.some(secondaryOf) && indexes.some((i) => !secondaryOf(i))
    const horizontal = spec.kind === 'bar'
    const groups: string[] = []

    for (const secondary of twoAxes ? [false, true] : [false]) {
      const [category, value] = secondary ? [AXIS.category2, AXIS.value2] : [AXIS.category, AXIS.value]
      const axes = `${val('axId', category)}${val('axId', value)}`

      for (const type of ['area', 'column', 'line'] as const) {
        const members = indexes.filter((i) => typeOf(i) === type && (!twoAxes || secondaryOf(i) === secondary))

        if (!members.length) {
          continue
        }

        const series = members.map((i) => this.series(i, type, stacked && type !== 'line')).join('')
        const labels = this.labels(type, false, stacked)

        if (type === 'column') {
          // Herald leaves 35% of each category between its bars, and 20% of a bar between bars side by side.
          const bars = stacked ? 1 : members.length
          const gap = Math.round(Math.min(500, (35 / 65) * bars * 100))
          groups.push(`<c:barChart>${val('barDir', horizontal ? 'bar' : 'col')}${val('grouping', grouping ?? 'clustered')}${val('varyColors', 0)}${series}${labels}${val('gapWidth', gap)}${val('overlap', stacked ? 100 : -20)}${axes}</c:barChart>`)
        } else if (type === 'line') {
          groups.push(`<c:lineChart>${val('grouping', 'standard')}${val('varyColors', 0)}${series}${labels}${val('marker', 1)}${axes}</c:lineChart>`)
        } else {
          groups.push(`<c:areaChart>${val('grouping', grouping ?? 'standard')}${val('varyColors', 0)}${series}${labels}${axes}</c:areaChart>`)
        }
      }
    }

    const areasOnly = indexes.length > 0 && indexes.every((i) => typeOf(i) === 'area')
    const between = areasOnly ? 'midCat' : 'between'
    // Herald lists a bar chart's categories from the top down; the value axis then crosses at the far end to stay below them.
    const axes =
      this.categoryAxis(AXIS.category, AXIS.value, spec.axes?.x, { position: horizontal ? 'l' : 'b', reversed: horizontal }) +
      this.valueAxis(AXIS.value, AXIS.category, spec.axes?.y, { position: horizontal ? 'b' : 'l', gridlines: true, crosses: horizontal ? 'max' : 'autoZero', between })
    const secondaryAxes = twoAxes
      ? this.valueAxis(AXIS.value2, AXIS.category2, spec.axes?.y2, { position: 'r', gridlines: false, crosses: 'max', between }) + this.categoryAxis(AXIS.category2, AXIS.value2, undefined, { position: 'b', deleted: true })
      : ''

    return `${groups.join('')}${axes}${secondaryAxes}`
  }

  legend(): string {
    const position = { right: 'r', left: 'l', top: 't', bottom: 'b' }[this.spec.legend as string]

    return position ? `<c:legend>${val('legendPos', position)}${val('overlay', 0)}</c:legend>` : ''
  }

  chartSpace(): string {
    const title = this.title(this.spec.title, 1400)

    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}">` +
      `${val('date1904', Number(this.source.date1904))}${val('roundedCorners', 0)}` +
      `<c:chart>${title ? `${title}${val('autoTitleDeleted', 0)}` : val('autoTitleDeleted', 1)}<c:plotArea><c:layout/>${this.plot()}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>` +
      `${this.legend()}${val('plotVisOnly', 1)}${val('dispBlanksAs', 'gap')}</c:chart>` +
      `<c:spPr>${solidFill('#ffffff')}<a:ln w="9525">${solidFill(GRID_COLOR)}</a:ln></c:spPr>` +
      `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900">${solidFill(TEXT_COLOR)}</a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr></c:chartSpace>`
    )
  }
}

/** Whether a chart has a series whose cells are on a sheet the file has. */
export const hasSeries = (spec: ChartSpec, source: Pick<ChartCells, 'sheetName'>): boolean => spec.series.some((series) => source.sheetName(series.values.sheet) !== undefined)

/** A chart part for a chart: series colours from the series or `palette` in turn. */
export function chartXml(spec: ChartSpec, source: ChartCells, palette: string[]): string {
  return new ChartWriter(spec, source, palette.length ? palette : ['#4472c4']).chartSpace()
}
