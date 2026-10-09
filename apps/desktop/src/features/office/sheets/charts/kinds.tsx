import { IconChartArea, IconChartBar, IconChartDonut, IconChartDots, IconChartHistogram, IconChartLine, IconChartPie } from '@tabler/icons-react'
import type { ChartKind } from '../../../../../shared/office/charts.ts'
import { cn } from '../../../../lib/cn.ts'

/* The icon of each kind of chart, as the insert dialog and the chart panel show them. */

const ICONS = { column: IconChartBar, bar: IconChartBar, line: IconChartLine, area: IconChartArea, pie: IconChartPie, doughnut: IconChartDonut, scatter: IconChartDots, combo: IconChartHistogram } as const

export function KindIcon({ kind, size = 18, className }: { kind: ChartKind; size?: number; className?: string }) {
  const Icon = ICONS[kind]

  // Tabler draws columns; bars are its columns turned on their side.
  return <Icon size={size} stroke={1.6} className={cn(kind === 'bar' && 'rotate-90', className)} />
}
