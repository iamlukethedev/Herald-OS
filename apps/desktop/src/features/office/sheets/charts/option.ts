import { numfmt } from '@univerjs/core'
import type { EChartsCoreOption } from 'echarts/core'
import type { ChartAxis, ChartSpec } from '../../../../../shared/office/charts.ts'
import { OFFICE_THEME } from '../../../../../shared/office/xlsx/colors.ts'
import type { ChartValues, SeriesValues } from './data.ts'

/*
 * A chart's ECharts option: what its spec asks for, drawn with the values read from its cells in the
 * colours of Herald's theme. Building it draws nothing, so it can be checked without a page.
 */

export interface ChartTheme {
  /** Behind the chart, and behind a copied picture of it. */
  background: string
  /** The title. */
  text: string
  /** The axes' labels, the legend and the labels on the points. */
  label: string
  /** The axes' titles and lines. */
  muted: string
  /** Gridlines. */
  grid: string
  font: string
}

export interface OptionSettings {
  /** A small picture of the chart (the insert dialog's): no title, legend, labels, tooltips or animation. */
  preview?: boolean
}

/** Excel's own accent colours, for a workbook without a theme of its own. */
export const OFFICE_ACCENTS = OFFICE_THEME.slice(4, 10).map((hex) => `#${hex.toLowerCase()}`)

/** A number in a number format ("#,##0.00", "0%"), or plainly when it has none. */
export function formatNumber(value: number, format?: string): string {
  if (format && format !== 'General') {
    try {
      return String(numfmt.format(format, value, { locale: 'en-US' }))
    } catch {
      // A format numfmt cannot read leaves the plain number.
    }
  }

  return value.toLocaleString('en-US', { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 })
}

type SeriesType = 'bar' | 'line' | 'area'

/** How a series draws: a combo chart's own type for it (its first series as columns, the rest as lines, by default). */
export function seriesType(spec: ChartSpec, index: number): SeriesType {
  if (spec.kind === 'combo') {
    const type = spec.series[index]?.type ?? (index === 0 ? 'column' : 'line')

    return type === 'column' ? 'bar' : type
  }

  return spec.kind === 'column' || spec.kind === 'bar' ? 'bar' : spec.kind === 'area' ? 'area' : 'line'
}

/** Each category's total, every series' size counted. */
const totalsOf = (values: ChartValues): number[] => values.categories.map((_, i) => values.series.reduce((sum, series) => sum + Math.abs(series.values[i] ?? 0), 0))

function legendOption(spec: ChartSpec, theme: ChartTheme, titled: boolean, preview: boolean) {
  const at = preview ? 'none' : spec.legend

  if (at === 'none') {
    return { show: false }
  }

  const place = at === 'top' ? { top: titled ? 34 : 8, left: 'center' } : at === 'bottom' ? { bottom: 8, left: 'center' } : { [at]: 8, top: 'middle' }

  return {
    show: true,
    type: 'scroll',
    orient: at === 'left' || at === 'right' ? 'vertical' : 'horizontal',
    ...place,
    icon: 'roundRect',
    itemWidth: 12,
    itemHeight: 8,
    itemGap: 12,
    textStyle: { color: theme.label, fontFamily: theme.font, fontSize: 11 },
    pageTextStyle: { color: theme.label },
    pageIconColor: theme.label,
    pageIconInactiveColor: theme.grid
  }
}

/** The room the title and legend take around the plot. */
function marginsOf(spec: ChartSpec, titled: boolean, preview: boolean) {
  if (preview) {
    return { top: 8, bottom: 8, left: 8, right: 8 }
  }

  return {
    top: 14 + (titled ? 28 : 0) + (spec.legend === 'top' ? 26 : 0),
    bottom: 10 + (spec.legend === 'bottom' ? 28 : 0),
    left: spec.legend === 'left' ? '26%' : 12,
    right: spec.legend === 'right' ? '26%' : 16
  }
}

/** The ECharts option that draws `spec` with `values`, in `theme`. */
export function chartOption(spec: ChartSpec, values: ChartValues, theme: ChartTheme, settings: OptionSettings = {}): EChartsCoreOption {
  const preview = settings.preview === true
  const titled = !preview && Boolean(spec.title?.trim())
  const round = spec.kind === 'pie' || spec.kind === 'doughnut'
  const base = {
    backgroundColor: 'transparent',
    color: spec.palette?.length ? spec.palette : OFFICE_ACCENTS,
    animation: !preview,
    animationDuration: 300,
    animationDurationUpdate: 300,
    textStyle: { fontFamily: theme.font },
    title: titled ? { show: true, text: spec.title, left: 'center', top: 8, textStyle: { color: theme.text, fontFamily: theme.font, fontSize: 14, fontWeight: 600 } } : { show: false },
    legend: legendOption(spec, theme, titled, preview),
    tooltip: preview ? { show: false } : { show: true, trigger: round || spec.kind === 'scatter' ? 'item' : 'axis', confine: true, backgroundColor: theme.background, borderColor: theme.grid, textStyle: { color: theme.text, fontFamily: theme.font, fontSize: 12 } }
  }

  if (round) {
    return { ...base, series: roundSeries(spec, values, theme, titled, preview) }
  }

  if (spec.kind === 'scatter') {
    return { ...base, ...scatterParts(spec, values, theme, titled, preview) }
  }

  return { ...base, ...cartesianParts(spec, values, theme, titled, preview) }
}

interface AxisSettings {
  axis?: ChartAxis
  format?: string
  /** The value axis on the right of a combo chart: no gridlines of its own unless asked. */
  secondary?: boolean
  horizontal?: boolean
  /** Fit the axis to the values rather than start it at zero (a scatter chart's). */
  scale?: boolean
  percent?: boolean
}

function valueAxis(theme: ChartTheme, preview: boolean, { axis, format, secondary, horizontal, scale, percent }: AxisSettings) {
  return {
    type: 'value',
    show: axis?.hidden !== true,
    ...(axis?.title && !preview ? { name: axis.title, nameLocation: 'middle', nameGap: horizontal ? 28 : 40, nameRotate: horizontal ? 0 : 90, nameMoveOverlap: true, nameTextStyle: { color: theme.muted, fontFamily: theme.font, fontSize: 11 } } : {}),
    ...(axis?.min !== undefined ? { min: axis.min } : percent ? { min: 0 } : {}),
    ...(axis?.max !== undefined ? { max: axis.max } : percent ? { max: 1 } : {}),
    ...(scale ? { scale: true } : {}),
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { show: !preview, color: theme.label, fontFamily: theme.font, fontSize: 11, formatter: (value: number) => formatNumber(value, axis?.format ?? (percent ? '0%' : format)) },
    splitLine: { show: axis?.gridlines ?? !secondary, lineStyle: { color: theme.grid } }
  }
}

function categoryAxis(spec: ChartSpec, values: ChartValues, theme: ChartTheme, preview: boolean, { horizontal, edgeToEdge }: { horizontal: boolean; edgeToEdge: boolean }) {
  const axis = spec.axes?.x

  return {
    type: 'category',
    data: values.categories,
    show: axis?.hidden !== true,
    inverse: horizontal,
    boundaryGap: !edgeToEdge,
    ...(axis?.title && !preview ? { name: axis.title, nameLocation: 'middle', nameGap: horizontal ? 40 : 28, nameRotate: horizontal ? 90 : 0, nameMoveOverlap: true, nameTextStyle: { color: theme.muted, fontFamily: theme.font, fontSize: 11 } } : {}),
    axisLine: { show: true, lineStyle: { color: theme.muted } },
    axisTick: { show: false },
    axisLabel: {
      show: !preview,
      color: theme.label,
      fontFamily: theme.font,
      fontSize: 11,
      hideOverlap: true,
      ...(axis?.format ? { formatter: (label: string, index: number) => (values.x[index] === null || values.x[index] === undefined ? label : formatNumber(values.x[index]!, axis.format)) } : {})
    },
    splitLine: { show: axis?.gridlines === true, lineStyle: { color: theme.grid } }
  }
}

/** The labels on a series' points: its values, their share of the category, or the category's name. */
function pointLabels(spec: ChartSpec, values: ChartValues, series: SeriesValues, theme: ChartTheme, preview: boolean, place: { position: string; inside?: boolean }) {
  if (preview || spec.labels === 'none') {
    return { show: false }
  }

  const totals = totalsOf(values)

  return {
    show: true,
    position: place.position,
    color: place.inside ? '#ffffff' : theme.label,
    fontFamily: theme.font,
    fontSize: 10,
    formatter: ({ dataIndex }: { dataIndex: number }) => {
      const value = series.values[dataIndex]

      if (value === null || value === undefined) {
        return ''
      }

      return spec.labels === 'percent' ? (totals[dataIndex] ? formatNumber(Math.abs(value) / totals[dataIndex], '0%') : '') : spec.labels === 'category' ? (values.categories[dataIndex] ?? '') : formatNumber(value, series.format)
    }
  }
}

function cartesianParts(spec: ChartSpec, values: ChartValues, theme: ChartTheme, titled: boolean, preview: boolean) {
  const horizontal = spec.kind === 'bar'
  const stacking = spec.stacking ?? 'none'
  const percent = stacking === 'percent'
  const totals = totalsOf(values)
  const types = values.series.map((_, i) => seriesType(spec, i))
  const secondary = spec.kind === 'combo' && spec.series.some((series, i) => series.secondary && i < values.series.length)
  const onRight = (i: number) => secondary && spec.series[i]?.secondary === true
  const formatOn = (right: boolean) => values.series.find((series, i) => onRight(i) === right && series.format)?.format
  const series = values.series.map((entry, i) => {
    const type = types[i]
    const color = spec.series[i]?.color
    const stacked = stacking !== 'none' && type !== 'line'
    const data = percent && type !== 'line' ? entry.values.map((value, at) => (value === null || !totals[at] ? null : value / totals[at])) : entry.values
    const format = percent && type !== 'line' ? '0%' : entry.format

    return {
      type: type === 'bar' ? 'bar' : 'line',
      name: entry.name,
      data,
      ...(onRight(i) ? { yAxisIndex: 1 } : {}),
      ...(stacked ? { stack: `${type}-${onRight(i) ? 1 : 0}` } : {}),
      ...(type === 'bar' ? { barMaxWidth: 56, barCategoryGap: '35%' } : { smooth: spec.series[i]?.smooth === true, showSymbol: spec.series[i]?.markers ?? (!preview && values.categories.length <= 40), symbolSize: 6, connectNulls: false, lineStyle: { width: preview ? 1.5 : 2, ...(color ? { color } : {}) } }),
      ...(type === 'area' ? { areaStyle: { opacity: stacked ? 0.8 : 0.35 } } : {}),
      ...(color ? { itemStyle: { color } } : {}),
      tooltip: { valueFormatter: (value: unknown) => (typeof value === 'number' ? formatNumber(value, format) : '–') },
      label: pointLabels(spec, values, entry, theme, preview, { position: type === 'bar' ? (stacked ? 'inside' : horizontal ? 'right' : 'top') : 'top', inside: type === 'bar' && stacked })
    }
  })
  const categories = categoryAxis(spec, values, theme, preview, { horizontal, edgeToEdge: types.length > 0 && types.every((type) => type === 'area') })
  const primary = valueAxis(theme, preview, { axis: spec.axes?.y, format: formatOn(false), horizontal, percent })
  const valueAxes = secondary ? [primary, valueAxis(theme, preview, { axis: spec.axes?.y2, format: formatOn(true), secondary: true })] : primary

  return {
    grid: { ...marginsOf(spec, titled, preview), outerBoundsMode: 'same', outerBoundsContain: 'all' },
    xAxis: horizontal ? valueAxes : categories,
    yAxis: horizontal ? categories : valueAxes,
    series
  }
}

function scatterParts(spec: ChartSpec, values: ChartValues, theme: ChartTheme, titled: boolean, preview: boolean) {
  const series = values.series.map((entry, i) => {
    const color = spec.series[i]?.color
    const points = entry.values.map((y, at) => ({ value: [values.x[at], y], at })).filter(({ value: [x, y] }) => x !== null && x !== undefined && y !== null)

    return {
      type: 'scatter',
      name: entry.name,
      data: points.map(({ value }) => value),
      symbolSize: preview ? 5 : 8,
      ...(color ? { itemStyle: { color } } : {}),
      tooltip: { formatter: ({ value }: { value: [number, number] }) => `${entry.name}<br/>${formatNumber(value[0], values.xFormat)}, ${formatNumber(value[1], entry.format)}` },
      label:
        preview || spec.labels === 'none' || spec.labels === 'percent'
          ? { show: false }
          : { show: true, position: 'top', color: theme.label, fontFamily: theme.font, fontSize: 10, formatter: ({ dataIndex }: { dataIndex: number }) => (spec.labels === 'category' ? (values.categories[points[dataIndex]?.at] ?? '') : formatNumber(points[dataIndex]?.value[1] as number, entry.format)) }
    }
  })

  return {
    grid: { ...marginsOf(spec, titled, preview), outerBoundsMode: 'same', outerBoundsContain: 'all' },
    xAxis: { ...valueAxis(theme, preview, { axis: spec.axes?.x, format: values.xFormat, horizontal: true, scale: true }), splitLine: { show: spec.axes?.x?.gridlines ?? true, lineStyle: { color: theme.grid } }, axisLine: { show: true, lineStyle: { color: theme.muted } } },
    yAxis: valueAxis(theme, preview, { axis: spec.axes?.y, format: values.series[0]?.format, scale: true }),
    series
  }
}

/** A pie (its first series) or a doughnut (a ring for each series), slices in the palette's colours by category. */
function roundSeries(spec: ChartSpec, values: ChartValues, theme: ChartTheme, titled: boolean, preview: boolean) {
  const doughnut = spec.kind === 'doughnut'
  const palette = spec.palette?.length ? spec.palette : OFFICE_ACCENTS
  const legend = preview ? 'none' : spec.legend
  const labelled = !preview && spec.labels !== 'none'
  const center = [legend === 'left' ? '62%' : legend === 'right' ? '38%' : '50%', titled || legend === 'top' ? '56%' : legend === 'bottom' ? '46%' : '50%']
  const outer = preview ? 90 : labelled ? 60 : 70
  const inner = doughnut ? (outer * Math.min(90, Math.max(0, spec.hole ?? 50))) / 100 : 0
  const rings = doughnut ? values.series : values.series.slice(0, 1)
  const band = (outer - inner) / Math.max(1, rings.length)

  return rings.map((entry, r) => {
    const total = entry.values.reduce<number>((sum, value) => sum + Math.abs(value ?? 0), 0)
    const slices = values.categories.map((name, i) => ({ name, value: entry.values[i] === null ? 0 : Math.abs(entry.values[i]!), itemStyle: { color: palette[i % palette.length] } })).filter((slice) => slice.value > 0)

    return {
      type: 'pie',
      name: entry.name,
      radius: [`${inner + band * r}%`, `${inner + band * (r + 1) - (rings.length > 1 && r < rings.length - 1 ? 1 : 0)}%`],
      center,
      startAngle: 90,
      avoidLabelOverlap: true,
      data: slices,
      itemStyle: { borderColor: theme.background, borderWidth: preview ? 0.5 : 1 },
      tooltip: { valueFormatter: (value: unknown) => (typeof value === 'number' ? formatNumber(value, entry.format) : '–') },
      label: labelled
        ? {
            show: r === rings.length - 1,
            position: 'outside',
            color: theme.label,
            fontFamily: theme.font,
            fontSize: 10,
            formatter: ({ name, value }: { name: string; value: number }) => (spec.labels === 'percent' ? (total ? formatNumber(value / total, '0%') : '') : spec.labels === 'category' ? name : formatNumber(value, entry.format))
          }
        : { show: false },
      labelLine: { show: labelled && r === rings.length - 1, lineStyle: { color: theme.muted } }
    }
  })
}
