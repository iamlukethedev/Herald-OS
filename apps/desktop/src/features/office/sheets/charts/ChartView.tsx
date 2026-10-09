import type { Univer } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import type { ECharts } from 'echarts/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type ChartSpec, isChartData } from '../../../../../shared/office/charts.ts'
import { readGrid } from './cells.ts'
import { type ChartValues, chartValues, hasNumbers } from './data.ts'
import { documentOf } from './documents.ts'
import { loadECharts } from './load.ts'
import { chartOption } from './option.ts'
import { openChartPanel } from './panel.tsx'
import { heraldChartTheme } from './theme.ts'
import { rangesOf, watchCells } from './watch.ts'

/* A chart in its floating object over the grid: ECharts drawing the spec in the drawing's data with the numbers in its cells, redrawn as they change. */

/** What Univer's floating-object layer gives the component it draws in one. */
interface FloatDomProps {
  data?: unknown
  unitId?: string
  floatDomId?: string
}

/** The component Univer draws in each chart's floating object, reading the workbooks of `univer`. */
export function chartComponent(univer: Univer, api: FUniver) {
  return function HeraldChart({ data, unitId, floatDomId }: FloatDomProps) {
    const spec = isChartData(data) ? data.spec : null
    const box = useRef<HTMLDivElement>(null)
    const chart = useRef<ECharts | null>(null)
    const drawn = useRef<ChartSpec | null>(null)
    const theme = useMemo(heraldChartTheme, [])
    const [changes, setChanges] = useState(0)
    const last = useRef<{ json: string; values: ChartValues | null } | null>(null)
    const [ready, setReady] = useState(false)
    // Read with the spec it belongs to; cells that changed without changing what the chart shows give the same values back.
    const values = useMemo(() => {
      const workbook = unitId ? api.getWorkbook(unitId) : null
      const next = workbook && spec ? chartValues(spec, (range) => readGrid(workbook, range)) : null
      const json = JSON.stringify(next)

      if (last.current?.json !== json) {
        last.current = { json, values: next }
      }

      return last.current.values
    }, [spec, unitId, changes])

    useEffect(() => (spec && unitId ? watchCells(univer, unitId, rangesOf(spec), () => setChanges((count) => count + 1)) : undefined), [spec, unitId])

    useEffect(() => {
      let gone = false
      let resizing: ResizeObserver | null = null

      void loadECharts().then((echarts) => {
        if (gone || !box.current) {
          return
        }

        chart.current = echarts.init(box.current, undefined, { renderer: 'canvas' })
        resizing = new ResizeObserver(() => chart.current?.resize())
        resizing.observe(box.current)
        setReady(true)
      })

      return () => {
        gone = true
        resizing?.disconnect()
        chart.current?.dispose()
        chart.current = null
      }
    }, [])

    useEffect(() => {
      if (!ready || !chart.current || !spec || !values) {
        return
      }

      // New numbers in the same chart animate from the old; a changed spec draws afresh, leaving nothing of the last one behind.
      chart.current.setOption(chartOption(spec, values, theme), { notMerge: drawn.current !== spec })
      drawn.current = spec
    }, [ready, spec, values, theme])

    // Univer takes the pointer for its handles as a press starts, so no click or double click reaches the chart: the second press of one does.
    return (
      <div className="relative size-full overflow-hidden rounded-lg border border-line" style={{ background: theme.background }} onMouseDown={(event) => event.detail === 2 && floatDomId && openChartPanel(documentOf(unitId), floatDomId)}>
        <div ref={box} className="absolute inset-0" />
        {values && !hasNumbers(values) && <div className="pointer-events-none absolute inset-0 grid place-items-center px-4 text-center text-[12px] text-fg-3">No numbers in this chart’s cells</div>}
      </div>
    )
  }
}
