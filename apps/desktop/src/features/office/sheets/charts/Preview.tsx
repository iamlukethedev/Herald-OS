import type { ECharts } from 'echarts/core'
import { useEffect, useMemo, useRef } from 'react'
import type { ChartSpec } from '../../../../../shared/office/charts.ts'
import { cn } from '../../../../lib/cn.ts'
import type { ChartValues } from './data.ts'
import { loadECharts } from './load.ts'
import { chartOption } from './option.ts'
import { heraldChartTheme } from './theme.ts'

/** A small picture of a chart, for choosing one: no title, legend or labels. */
export function ChartPreview({ spec, values, className }: { spec: ChartSpec; values: ChartValues; className?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const theme = useMemo(heraldChartTheme, [])

  useEffect(() => {
    let chart: ECharts | null = null
    let gone = false

    void loadECharts().then((echarts) => {
      if (!gone && box.current) {
        chart = echarts.init(box.current, undefined, { renderer: 'canvas' })
        chart.setOption(chartOption(spec, values, theme, { preview: true }))
      }
    })

    return () => {
      gone = true
      chart?.dispose()
    }
  }, [spec, values, theme])

  return <div ref={box} className={cn('pointer-events-none rounded-md', className)} style={{ background: theme.background }} />
}
