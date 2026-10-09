import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { describe, expect, it } from 'vitest'
import { CHART_KINDS, type ChartDrawing, type ChartSpec, DRAWING_RESOURCE } from '../../../../../shared/office/charts.ts'
import { excelBarWorkbook } from '../../../../../shared/office/xlsx/charts/fixtures.ts'
import { workbookFromXlsx } from '../../../../../shared/office/xlsx/read.ts'
import { readResource } from '../../../../../shared/office/xlsx/rules.ts'
import type { ChartValues } from './data.ts'
import { specOf } from './fixtures.ts'
import { type ChartTheme, chartOption, formatNumber, OFFICE_ACCENTS } from './option.ts'

echarts.use([BarChart, LineChart, PieChart, ScatterChart, GridComponent, LegendComponent, TitleComponent, TooltipComponent, SVGRenderer])

const THEME: ChartTheme = { background: '#0d1a4a', text: '#f3f7ff', label: '#d8e4ff', muted: '#b0c4f5', grid: '#2a3a6a', font: 'Inter' }
const range = { sheet: 's1', startRow: 0, endRow: 3, startColumn: 1, endColumn: 1 }
const two = [{ values: range }, { values: { ...range, startColumn: 2, endColumn: 2 } }]
const VALUES: ChartValues = {
  categories: ['Q1', 'Q2', 'Q3', 'Q4'],
  x: [null, null, null, null],
  dates: false,
  series: [
    { name: 'Revenue', values: [1200, 1500, null, 1800], format: '#,##0' },
    { name: 'Margin', values: [0.2, 0.25, 0.22, 0.3], format: '0%' }
  ]
}

// The option is plain data with formatter functions in it: these read it.
type Option = Record<string, any>
const optionOf = (spec: ChartSpec, values = VALUES, preview = false) => chartOption(spec, values, THEME, { preview }) as Option
const call = (formatter: unknown, ...args: unknown[]) => (formatter as (...input: unknown[]) => unknown)(...args)

describe('the option of each kind of chart', () => {
  it('draws columns up from categories along the bottom, labelled in the cells’ number format', () => {
    const option = optionOf(specOf('column', two, { title: 'Sales', axes: { y: { title: 'Pounds', min: 0, max: 2000 } } }))

    expect(option.series.map((series: Option) => series.type)).toEqual(['bar', 'bar'])
    expect(option.xAxis).toMatchObject({ type: 'category', data: ['Q1', 'Q2', 'Q3', 'Q4'], inverse: false, boundaryGap: true })
    expect(option.yAxis).toMatchObject({ type: 'value', name: 'Pounds', min: 0, max: 2000, splitLine: { show: true } })
    expect(call(option.yAxis.axisLabel.formatter, 1500)).toBe('1,500')
    expect(option.title).toMatchObject({ show: true, text: 'Sales' })
    expect(option.color).toEqual(OFFICE_ACCENTS)
    expect(option.series[0].data).toEqual([1200, 1500, null, 1800])
  })

  it('draws bars across, the first category at the top', () => {
    const option = optionOf(specOf('bar', two))

    expect(option.xAxis.type).toBe('value')
    expect(option.yAxis).toMatchObject({ type: 'category', inverse: true })
  })

  it('runs the categories the other way round when the axis is reversed: bars from the bottom up, columns from the right', () => {
    const reversed = { axes: { x: { reverse: true } } }

    expect(optionOf(specOf('bar', two, reversed)).yAxis).toMatchObject({ type: 'category', inverse: false })
    expect(optionOf(specOf('column', two, reversed)).xAxis).toMatchObject({ type: 'category', inverse: true })
    expect(optionOf(specOf('combo', two, reversed)).xAxis).toMatchObject({ type: 'category', inverse: true })
    expect(optionOf(specOf('line', two, { axes: { x: { reverse: false } } })).xAxis).toMatchObject({ inverse: false })
  })

  it('runs values down their axis when it is reversed, and leaves the others as they were', () => {
    const column = optionOf(specOf('column', two, { axes: { y: { reverse: true } } }))
    const bar = optionOf(specOf('bar', two, { axes: { y: { reverse: true } } }))
    const combo = optionOf(specOf('combo', [{ values: range }, { ...two[1], type: 'line', secondary: true }], { axes: { y2: { reverse: true } } }))
    const scatter = optionOf(specOf('scatter', two, { axes: { x: { reverse: true }, y: { reverse: true } } }), { ...VALUES, x: [1, 2, 3, 4] })

    expect(column.yAxis).toMatchObject({ type: 'value', inverse: true })
    expect(column.xAxis.inverse).toBe(false)
    expect(bar.xAxis).toMatchObject({ type: 'value', inverse: true })
    expect(bar.yAxis.inverse).toBe(true)
    expect(combo.yAxis[0].inverse).toBeUndefined()
    expect(combo.yAxis[1]).toMatchObject({ type: 'value', inverse: true })
    expect([scatter.xAxis.inverse, scatter.yAxis.inverse]).toEqual([true, true])
    expect(optionOf(specOf('column', two)).yAxis.inverse).toBeUndefined()
  })

  it('draws charts Excel made the way Excel shows them: its bars from the bottom up, columns it reversed or turned upside down', async () => {
    const { workbook } = await workbookFromXlsx(await excelBarWorkbook(), { id: 'book', name: 'Book' })
    const drawings = readResource<Record<string, { data: Record<string, ChartDrawing>; order: string[] }>>(workbook.resources, DRAWING_RESOURCE)!
    const [bars, columns, upsideDown] = drawings['sheet-1'].order.map((id) => drawings['sheet-1'].data[id].data.spec)

    expect(optionOf(bars).yAxis).toMatchObject({ type: 'category', inverse: false })
    expect(optionOf(bars).xAxis.inverse).toBeUndefined()
    expect(optionOf(columns).xAxis).toMatchObject({ type: 'category', inverse: true })
    expect(optionOf(upsideDown).xAxis).toMatchObject({ type: 'category', inverse: false })
    expect(optionOf(upsideDown).yAxis).toMatchObject({ type: 'value', inverse: true })
  })

  it('draws lines with gaps for missing values, smoothed and marked as each series asks', () => {
    const option = optionOf(specOf('line', [{ values: range, smooth: true, markers: false, color: '#ff0000' }, two[1]]))

    expect(option.series[0]).toMatchObject({ type: 'line', smooth: true, showSymbol: false, connectNulls: false, itemStyle: { color: '#ff0000' }, lineStyle: { color: '#ff0000' } })
    expect(option.series[1]).toMatchObject({ smooth: false, showSymbol: true })
  })

  it('draws areas edge to edge, stacked when asked', () => {
    const option = optionOf(specOf('area', two, { stacking: 'stacked' }))

    expect(option.xAxis.boundaryGap).toBe(false)
    expect(option.series.map((series: Option) => [series.type, series.stack, series.areaStyle.opacity])).toEqual([
      ['line', 'area-0', 0.8],
      ['line', 'area-0', 0.8]
    ])
  })

  it('stacks columns as shares of each category on an axis from 0% to 100%', () => {
    const option = optionOf(specOf('column', two, { stacking: 'percent', labels: 'value' }), { ...VALUES, series: [{ name: 'A', values: [1, 3, null, 2] }, { name: 'B', values: [3, 1, 4, 2] }] })

    expect(option.series[0]).toMatchObject({ stack: 'bar-0', data: [0.25, 0.75, null, 0.5] })
    expect(option.yAxis).toMatchObject({ min: 0, max: 1 })
    expect(call(option.yAxis.axisLabel.formatter, 0.5)).toBe('50%')
    expect(call(option.series[0].tooltip.valueFormatter, 0.25)).toBe('25%')
    expect(call(option.series[0].label.formatter, { dataIndex: 1 })).toBe('3')
  })

  it('labels points with their share of the category or its name', () => {
    const shares = optionOf(specOf('column', two, { labels: 'percent' }), { ...VALUES, series: [{ name: 'A', values: [1, 3, null, 2] }, { name: 'B', values: [3, 1, 4, 2] }] })
    const names = optionOf(specOf('line', two, { labels: 'category' }))

    expect(call(shares.series[0].label.formatter, { dataIndex: 0 })).toBe('25%')
    expect(call(shares.series[0].label.formatter, { dataIndex: 2 })).toBe('')
    expect(call(names.series[1].label.formatter, { dataIndex: 3 })).toBe('Q4')
  })

  it('draws a combo chart’s series as each asks, the smaller scale on an axis of its own', () => {
    const option = optionOf(specOf('combo', [{ values: range }, { ...two[1], type: 'line', secondary: true }], { axes: { y2: { title: 'Margin', format: '0.0%' } } }))

    expect(option.series.map((series: Option) => [series.type, series.yAxisIndex])).toEqual([
      ['bar', undefined],
      ['line', 1]
    ])
    expect(option.yAxis).toHaveLength(2)
    expect(option.yAxis[1]).toMatchObject({ name: 'Margin', splitLine: { show: false } })
    expect(call(option.yAxis[0].axisLabel.formatter, 1500)).toBe('1,500')
    expect(call(option.yAxis[1].axisLabel.formatter, 0.25)).toBe('25.0%')
  })

  it('draws a pie of the first series, slices coloured by category and labelled with their shares', () => {
    const option = optionOf(specOf('pie', two, { labels: 'percent', palette: ['#111111', '#222222', '#333333', '#444444'] }))

    expect(option.series).toHaveLength(1)
    expect(option.series[0].radius).toEqual(['0%', '60%'])
    expect(option.series[0].data).toEqual([
      { name: 'Q1', value: 1200, itemStyle: { color: '#111111' } },
      { name: 'Q2', value: 1500, itemStyle: { color: '#222222' } },
      { name: 'Q4', value: 1800, itemStyle: { color: '#444444' } }
    ])
    expect(call(option.series[0].label.formatter, { name: 'Q2', value: 1500 })).toBe('33%')
    expect(option.tooltip.trigger).toBe('item')
  })

  it('draws a doughnut with its hole, a ring for each series', () => {
    const option = optionOf(specOf('doughnut', two, { hole: 50, legend: 'right' }))

    expect(option.series.map((series: Option) => series.radius)).toEqual([
      ['35%', '51.5%'],
      ['52.5%', '70%']
    ])
    expect(option.series[0].center).toEqual(['38%', '50%'])
    expect(option.legend).toMatchObject({ show: true, orient: 'vertical', right: 8 })
  })

  it('draws a scatter chart of x against y, leaving out rows without both', () => {
    const option = optionOf(specOf('scatter', [{ values: range }]), { categories: ['160', '172', '', '181'], x: [160, 172, null, 181], dates: false, series: [{ name: 'Weight', values: [55, null, 70, 82] }] })

    expect(option.series[0].data).toEqual([
      [160, 55],
      [181, 82]
    ])
    expect(option.xAxis).toMatchObject({ type: 'value', scale: true })
    expect(call(option.series[0].tooltip.formatter, { value: [160, 55] })).toBe('Weight<br/>160, 55')
  })

  it('places the legend and leaves room for it and the title', () => {
    expect(optionOf(specOf('column', two, { legend: 'none' })).legend).toEqual({ show: false })
    expect(optionOf(specOf('column', two, { legend: 'top', title: 'T' }))).toMatchObject({ legend: { top: 34, left: 'center' }, grid: { top: 68 } })
    expect(optionOf(specOf('column', two, { legend: 'left' })).grid.left).toBe('26%')
  })

  it('hides axes, gridlines and decorations as asked, and all of them in a preview', () => {
    const hidden = optionOf(specOf('column', two, { axes: { x: { hidden: true, gridlines: true }, y: { hidden: true, gridlines: false } } }))
    const preview = optionOf(specOf('column', two, { title: 'Sales', labels: 'value' }), VALUES, true)

    expect([hidden.xAxis.show, hidden.xAxis.splitLine.show, hidden.yAxis.show, hidden.yAxis.splitLine.show]).toEqual([false, true, false, false])
    expect([preview.title.show, preview.legend.show, preview.tooltip.show, preview.animation, preview.series[0].label.show, preview.yAxis.axisLabel.show]).toEqual([false, false, false, false, false, false])
  })

  it('gives ECharts an option it draws, for every kind', () => {
    for (const kind of CHART_KINDS) {
      const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 480, height: 288 })
      chart.setOption(chartOption(specOf(kind, two, { title: 'Sales', labels: 'value', stacking: kind === 'column' ? 'stacked' : 'none' }), VALUES, THEME))
      const svg = chart.renderToSVGString()
      chart.dispose()

      expect(svg).toContain('<svg')
      expect(svg).toContain('Sales')
    }
  })
})

describe('formatting numbers', () => {
  it('uses the number format, else the plain number', () => {
    expect([formatNumber(1234.5, '#,##0.00'), formatNumber(0.125, '0.0%'), formatNumber(1234.567), formatNumber(12, 'General'), formatNumber(45292, 'yyyy-mm-dd')]).toEqual(['1,234.50', '12.5%', '1,234.57', '12', '2024-01-01'])
  })
})
