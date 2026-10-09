/* ECharts comes the first time a chart is drawn, not with the window. */

type ECharts = (typeof import('./echarts.ts'))['echarts']

let loading: Promise<ECharts> | null = null

/** ECharts, loaded once. */
export function loadECharts(): Promise<ECharts> {
  loading ??= import('./echarts.ts').then((module) => module.echarts)

  return loading
}
