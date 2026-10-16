import { useMemo } from 'react'
import { cn } from '../../../lib/cn.ts'
import { GraphCanvas, type Plot } from './GraphCanvas.tsx'
import { GraphEntries, GraphLegend, type LegendItem } from './GraphEntries.tsx'
import { type EntrySource, useGraphSources } from './sources.ts'
import type { GraphEntry, GraphSeries } from './types.ts'

export interface GraphViewProps {
  entries: GraphEntry[]
  series?: GraphSeries[]
  /** Values named in the note, for functions that use them ("a * x^2"). */
  scope?: Record<string, number>
  xMin?: number
  xMax?: number
  /** A small panel beside the notepad: no entry list. */
  compact?: boolean
  /** The Graph view's own editable list; left out, the entries are read-only. */
  onEntriesChange?: (entries: GraphEntry[]) => void
  className?: string
}

const NO_SERIES: GraphSeries[] = []

function plotsOf(entries: readonly GraphEntry[], sources: readonly EntrySource[], series: readonly GraphSeries[]): Plot[] {
  const plots: Plot[] = []

  entries.forEach((entry, index) => {
    const source = sources[index]

    if (source?.kind === 'function') {
      plots.push({ id: entry.id, label: entry.text.trim(), colour: index, fn: source.fn })
    } else if (source?.kind === 'sheet') {
      plots.push({ id: entry.id, label: source.series.label, colour: index, points: source.series.points })
    }
  })

  series.forEach((one, index) => plots.push({ id: `series-${index}`, label: one.label, colour: entries.length + index, points: one.points }))

  return plots
}

function legendOf(entries: readonly GraphEntry[], sources: readonly EntrySource[], series: readonly GraphSeries[]): LegendItem[] {
  const items: LegendItem[] = []

  entries.forEach((entry, index) => {
    const source = sources[index]
    const label = source?.kind === 'sheet' ? source.series.label : entry.text.trim()

    if (!label || source?.kind === 'empty') {
      return
    }

    const note = source?.kind === 'error' ? source.message : source?.kind === 'loading' && source.sheet ? 'reading…' : undefined
    items.push({ id: entry.id, label, colour: index, ...(note ? { note } : {}) })
  })

  series.forEach((one, index) => items.push({ id: `series-${index}`, label: one.label, colour: entries.length + index }))

  return items
}

const listed = (names: readonly string[]): string => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? ''))

export function GraphView({ entries, series = NO_SERIES, scope, xMin, xMax, compact = false, onEntriesChange, className }: GraphViewProps) {
  const { sources, retry } = useGraphSources(entries, scope)
  const plots = useMemo(() => plotsOf(entries, sources, series), [entries, sources, series])
  const description = plots.length ? `Graph of ${listed(plots.map(plot => plot.label))}` : 'Empty graph'
  const waiting = sources.some(source => source.kind === 'loading')
  const typed = entries.some(entry => entry.text.trim())
  const hint = waiting ? undefined : onEntriesChange && !compact && !typed ? 'Type a function of x in the list to draw it' : 'Nothing to draw yet'

  if (compact) {
    return (
      <div className={cn('relative min-h-0 min-w-0', className)}>
        <GraphCanvas plots={plots} xMin={xMin} xMax={xMax} compact description={description} hint={hint} className="size-full" />
        <GraphLegend items={legendOf(entries, sources, series)} />
      </div>
    )
  }

  const listing = Boolean(onEntriesChange) || entries.length > 0 || series.length > 0

  return (
    <div className={cn('flex h-full min-h-0 w-full min-w-0', className)}>
      {listing ? <GraphEntries entries={entries} sources={sources} series={series} onEntriesChange={onEntriesChange} onRetry={retry} /> : null}
      <GraphCanvas plots={plots} xMin={xMin} xMax={xMax} description={description} hint={hint} className="h-full flex-1" />
    </div>
  )
}
