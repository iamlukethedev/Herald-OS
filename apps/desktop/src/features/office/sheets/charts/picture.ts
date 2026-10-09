import type { SheetsTarget } from '../model.ts'
import { readGrid } from './cells.ts'
import { chartValues } from './data.ts'
import type { PlacedChart } from './drawings.ts'
import { loadECharts } from './load.ts'
import { chartOption } from './option.ts'
import { heraldChartTheme } from './theme.ts'

/* A chart as a picture on the clipboard: drawn again off screen at twice its size, on its own background. */

/** The chart's PNG at twice its size. */
export async function chartPicture(target: SheetsTarget, { drawing }: PlacedChart): Promise<Blob> {
  const echarts = await loadECharts()
  const theme = heraldChartTheme()
  const { spec } = drawing.data
  const values = chartValues(spec, (range) => readGrid(target.workbook, range))
  const width = Math.max(80, Math.round(drawing.transform?.width ?? 480))
  const height = Math.max(80, Math.round(drawing.transform?.height ?? 288))
  const chart = echarts.init(document.createElement('div'), undefined, { renderer: 'canvas', width, height })

  try {
    chart.setOption({ ...chartOption(spec, values, theme), animation: false })
    const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: theme.background })
    const bytes = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (char) => char.charCodeAt(0))

    return new Blob([bytes], { type: 'image/png' })
  } finally {
    chart.dispose()
  }
}

/** Put a chart on the clipboard as a picture. */
export async function copyChartPicture(target: SheetsTarget, placed: PlacedChart): Promise<void> {
  const picture = await chartPicture(target, placed)
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': picture })])
}
