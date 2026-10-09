import { IconArrowDown, IconArrowUp, IconPlus, IconTrash, IconX } from '@tabler/icons-react'
import { ICommandService } from '@univerjs/core'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { CHART_KINDS, type ChartAxis, type ChartSeries, type ChartSpec } from '../../../../../shared/office/charts.ts'
import { quoteSheet, rangeName } from '../../../../../shared/office/xlsx/address.ts'
import { cn } from '../../../../lib/cn.ts'
import { messageOf } from '../../../canvas/errors.ts'
import { liveTarget } from '../live.ts'
import { parseTarget } from '../model.ts'
import { closePanel, openPanel, panelFor } from '../ui/overlay.tsx'
import { workbookPalette } from './cells.ts'
import { chartsOf } from './drawings.ts'
import { KindIcon } from './kinds.tsx'
import { type ChartDescription, describeChart, type SeriesDescription, updateChart } from './model.ts'
import { OFFICE_ACCENTS } from './option.ts'
import { KIND_NAMES } from './recommend.ts'
import { heraldPalette } from './theme.ts'

/*
 * A chart's settings, beside its sheet: what it shows (its series and their cells), how (its kind,
 * title, axes, legend, labels, stacking and colours). Each change is one step to undo and redraws the
 * chart at once; the panel follows the chart through undo and closes when it goes.
 */

const panelId = (docKey: string, chart: string) => `chart:${docKey}:${chart}`

/** Open the settings of a chart in its document's side panel. */
export function openChartPanel(docKey: string | null, chart: string): void {
  if (docKey) {
    openPanel(docKey, panelId(docKey, chart), <ChartPanel key={chart} docKey={docKey} chart={chart} />)
  }
}

/** Close a document's chart panel, if it has one open. */
export function closeChartPanels(docKey: string): void {
  if (panelFor()?.startsWith(`chart:${docKey}:`)) {
    closePanel()
  }
}

interface Shown {
  description: ChartDescription
  spec: ChartSpec
}

function shownIn(docKey: string, chart: string): Shown | null {
  const target = liveTarget(docKey)
  const placed = target ? chartsOf(target).find((entry) => entry.id === chart) : null

  return target && placed ? { description: describeChart(target, { chart }), spec: placed.drawing.data.spec } : null
}

/** A series as updateChart takes it back: its name kept as it is given (a cell, text, or none). */
function seriesInput(described: SeriesDescription, series: ChartSeries | undefined): Record<string, unknown> {
  return {
    values: described.values,
    ...(described.nameCell ? { nameCell: described.nameCell } : series?.name?.text ? { name: series.name.text } : {}),
    ...(described.categories ? { categories: described.categories } : {}),
    ...(described.color ? { color: described.color } : {}),
    ...(described.type ? { type: described.type } : {}),
    ...(described.secondary ? { secondary: true } : {}),
    ...(described.smooth !== undefined ? { smooth: described.smooth } : {}),
    ...(described.markers !== undefined ? { markers: described.markers } : {})
  }
}

/** A range moved one column (or row, for a row of cells) on, as A1 text. */
function nextOver(reference: string): string {
  const { sheet, range } = parseTarget(reference)
  const across = range.startRow === range.endRow && range.startColumn !== range.endColumn
  const moved = across ? { ...range, startRow: range.startRow + 1, endRow: range.endRow + 1 } : { ...range, startColumn: range.startColumn + 1, endColumn: range.endColumn + 1 }

  return `${sheet ? `${quoteSheet(sheet)}!` : ''}${rangeName(moved)}`
}

function Heading({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-[11px] font-medium tracking-wide text-fg-3 uppercase">{children}</div>
}

const INPUT = 'glass-input h-7 min-w-0 rounded-md px-2 text-[12px] text-fg outline-none placeholder:text-fg-4'

/** Text that changes the chart when it is left or Enter is pressed (not at each key), and goes back with Escape. */
function Field({ value, onCommit, label, placeholder, className }: { value: string; onCommit: (text: string) => void; label: string; placeholder?: string; className?: string }) {
  const [text, setText] = useState(value)

  useEffect(() => setText(value), [value])

  return (
    <input
      value={text}
      aria-label={label}
      title={label}
      placeholder={placeholder}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
        } else if (event.key === 'Escape') {
          event.stopPropagation()
          setText(value)
        }
      }}
      className={cn(INPUT, className)}
    />
  )
}

function Choices<T extends string>({ value, options, onChange, label }: { value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => value !== option && onChange(option)}
          className={cn('h-6 rounded-md border px-2 text-[11.5px] transition-colors duration-120', value === option ? 'border-accent bg-accent text-accent-fg' : 'border-line text-fg-2 hover:bg-white/8 hover:text-fg')}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-fg-2 hover:text-fg">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="accent-accent" />
      {children}
    </label>
  )
}

/** A colour that changes the chart when the picker closes, not at each step of picking it. */
function Swatch({ color, onCommit, label }: { color: string; onCommit: (color: string) => void; label: string }) {
  const input = useRef<HTMLInputElement>(null)
  const [shown, setShown] = useState(color)
  const commit = useRef(onCommit)
  commit.current = onCommit

  useEffect(() => setShown(color), [color])

  useEffect(() => {
    const element = input.current
    const done = () => element && element.value !== color && commit.current(element.value)
    element?.addEventListener('change', done)

    return () => element?.removeEventListener('change', done)
  }, [color])

  return (
    <label title={label} className="relative size-5 shrink-0 cursor-pointer rounded border border-line-strong" style={{ background: shown }}>
      <input ref={input} type="color" aria-label={label} value={shown} onChange={(event) => setShown(event.target.value)} className="absolute inset-0 size-full cursor-pointer opacity-0" />
    </label>
  )
}

const LEGEND_CHOICES = [
  ['none', 'None'],
  ['top', 'Top'],
  ['bottom', 'Bottom'],
  ['left', 'Left'],
  ['right', 'Right']
] as const
const LABEL_CHOICES = [
  ['none', 'None'],
  ['value', 'Values'],
  ['percent', 'Percent'],
  ['category', 'Categories']
] as const
const STACKING_CHOICES = [
  ['none', 'Side by side'],
  ['stacked', 'Stacked'],
  ['percent', '100%']
] as const
const TYPE_CHOICES = [
  ['column', 'Columns'],
  ['line', 'Line'],
  ['area', 'Area']
] as const

function AxisSettings({ title, axis, onChange, range, format, gridlines }: { title: string; axis: ChartAxis | undefined; onChange: (axis: Record<string, unknown>) => void; range: boolean; format: boolean; gridlines: boolean }) {
  const number = (text: string) => (text.trim() === '' ? null : Number(text))

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[12px] text-fg-2">{title}</div>
      <Field label={`${title} title`} placeholder="Axis title" value={axis?.title ?? ''} onCommit={(text) => onChange({ title: text })} />
      {(range || format) && (
        <div className="flex gap-1.5">
          {range && <Field label={`${title} minimum`} placeholder="Min" value={axis?.min === undefined ? '' : String(axis.min)} onCommit={(text) => onChange({ min: number(text) })} className="w-0 flex-1" />}
          {range && <Field label={`${title} maximum`} placeholder="Max" value={axis?.max === undefined ? '' : String(axis.max)} onCommit={(text) => onChange({ max: number(text) })} className="w-0 flex-1" />}
          {format && <Field label={`${title} number format`} placeholder="Format" value={axis?.format ?? ''} onCommit={(text) => onChange({ format: text })} className="w-0 flex-[1.4]" />}
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1.5">
        <Check checked={axis?.gridlines ?? gridlines} onChange={(shown) => onChange({ gridlines: shown })}>
          Gridlines
        </Check>
        <Check checked={axis?.hidden === true} onChange={(hidden) => onChange({ hidden })}>
          Hidden
        </Check>
        <Check checked={axis?.reverse === true} onChange={(reverse) => onChange({ reverse })}>
          Reverse order
        </Check>
      </div>
    </div>
  )
}

function ChartPanel({ docKey, chart }: { docKey: string; chart: string }) {
  const [shown, setShown] = useState(() => shownIn(docKey, chart))
  const [error, setError] = useState('')

  useEffect(() => {
    const target = liveTarget(docKey)

    if (!target) {
      return
    }

    const unitId = target.workbook.getId()
    const listener = target.univer
      .__getInjector()
      .get(ICommandService)
      .onCommandExecuted((command) => {
        if ((command.params as { unitId?: string } | undefined)?.unitId !== unitId || !['sheet.mutation.set-drawing-apply', 'sheet.mutation.set-range-values', 'sheet.mutation.set-worksheet-name'].includes(command.id)) {
          return
        }

        const next = shownIn(docKey, chart)

        if (next) {
          setShown(next)
        } else {
          closePanel(panelId(docKey, chart))
        }
      })

    return () => listener.dispose()
  }, [docKey, chart])

  if (!shown) {
    return null
  }

  const { description, spec } = shown
  const change = (args: Record<string, unknown>) => {
    const target = liveTarget(docKey)

    if (target) {
      setError('')
      updateChart(target, { chart, ...args }).catch((failure) => setError(messageOf(failure)))
    }
  }
  const inputs = () => description.series.map((series, i) => seriesInput(series, spec.series[i]))
  const changeSeries = (index: number, settings: Record<string, unknown>) => change({ series: inputs().map((series, i) => (i === index ? { ...series, ...settings } : series)) })
  const moveSeries = (index: number, by: number) => {
    const list = inputs()
    const [series] = list.splice(index, 1)
    list.splice(index + by, 0, series)
    change({ series: list })
  }
  const addSeries = () => {
    const last = description.series[description.series.length - 1]

    if (last) {
      change({ series: [...inputs(), { values: nextOver(last.values), ...(last.nameCell ? { nameCell: nextOver(last.nameCell) } : {}), ...(last.categories ? { categories: last.categories } : {}) }] })
    }
  }
  const cartesian = !['pie', 'doughnut'].includes(description.kind)
  const combo = description.kind === 'combo'
  const scatter = description.kind === 'scatter'
  const stackable = ['column', 'bar', 'area', 'combo'].includes(description.kind)
  const target = liveTarget(docKey)
  const palettes = [
    ['Workbook theme', target ? workbookPalette(target.workbook) : OFFICE_ACCENTS],
    ['Herald', heraldPalette()],
    ['Office', OFFICE_ACCENTS]
  ] as const
  const colorOf = (i: number) => description.series[i]?.color ?? description.palette[i % Math.max(1, description.palette.length)] ?? '#4472c4'

  return (
    <div className="flex flex-col gap-4 p-3 text-[12.5px] text-fg">
      <header className="flex items-center justify-between">
        <span className="text-[13px] font-medium">Chart</span>
        <button type="button" aria-label="Close" onClick={() => closePanel(panelId(docKey, chart))} className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg">
          <IconX size={15} />
        </button>
      </header>
      {error && <p className="rounded-md bg-danger/10 px-2 py-1.5 text-[11.5px] text-danger">{error}</p>}

      <section>
        <Heading>Kind</Heading>
        <div className="grid grid-cols-4 gap-1">
          {CHART_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              title={KIND_NAMES[kind]}
              onClick={() => kind !== description.kind && change({ kind })}
              className={cn('flex flex-col items-center gap-0.5 rounded-md border py-1.5 text-[10.5px] transition-colors duration-120', kind === description.kind ? 'border-accent bg-accent-soft text-fg' : 'border-transparent text-fg-2 hover:bg-white/8 hover:text-fg')}
            >
              <KindIcon kind={kind} size={18} />
              {KIND_NAMES[kind]}
            </button>
          ))}
        </div>
      </section>

      <section>
        <Heading>Title</Heading>
        <Field label="Chart title" placeholder="No title" value={description.title} onCommit={(title) => change({ title })} className="w-full" />
      </section>

      <section className="flex flex-col gap-2">
        <Heading>Data</Heading>
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] text-fg-3">{scatter ? 'X values' : 'Categories'}</span>
          <Field label={scatter ? 'X values' : 'Categories'} placeholder="None" value={description.series[0]?.categories ?? ''} onCommit={(categories) => change({ categories })} className="w-full" />
        </label>
        {description.series.map((series, i) => (
          <div key={`${i}-${series.values}`} className="flex flex-col gap-1.5 rounded-lg border border-line p-2">
            <div className="flex items-center gap-1.5">
              <Swatch label={`Colour of ${series.name}`} color={colorOf(i)} onCommit={(color) => changeSeries(i, { color })} />
              <Field
                label="Series name"
                placeholder="Name, or a cell like =B1"
                value={series.nameCell ? `=${series.nameCell}` : (spec.series[i]?.name?.text ?? '')}
                onCommit={(text) => changeSeries(i, text.trim().startsWith('=') ? { nameCell: text.trim().slice(1), name: undefined } : { name: text.trim() || undefined, nameCell: undefined })}
                className="w-0 flex-1"
              />
              <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => moveSeries(i, -1)} className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg disabled:opacity-30">
                <IconArrowUp size={14} />
              </button>
              <button type="button" aria-label="Move down" disabled={i === description.series.length - 1} onClick={() => moveSeries(i, 1)} className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg disabled:opacity-30">
                <IconArrowDown size={14} />
              </button>
              <button type="button" aria-label="Remove series" disabled={description.series.length === 1} onClick={() => change({ series: inputs().filter((_, at) => at !== i) })} className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-white/8 hover:text-danger disabled:opacity-30">
                <IconTrash size={14} />
              </button>
            </div>
            <Field label={`Cells of ${series.name}`} value={series.values} onCommit={(values) => changeSeries(i, { values })} className="w-full" />
            {combo && (
              <div className="flex items-center justify-between gap-2">
                <Choices label={`How ${series.name} is drawn`} value={series.type ?? (i === 0 ? 'column' : 'line')} options={TYPE_CHOICES} onChange={(type) => changeSeries(i, { type })} />
                <Check checked={series.secondary === true} onChange={(secondary) => changeSeries(i, { secondary })}>
                  Right axis
                </Check>
              </div>
            )}
            {(['line', 'area'].includes(description.kind) || (combo && (series.type ?? (i === 0 ? 'column' : 'line')) !== 'column')) && (
              <div className="flex gap-3">
                <Check checked={series.smooth === true} onChange={(smooth) => changeSeries(i, { smooth })}>
                  Smooth
                </Check>
                <Check checked={series.markers !== false} onChange={(markers) => changeSeries(i, { markers })}>
                  Markers
                </Check>
              </div>
            )}
          </div>
        ))}
        <button type="button" onClick={addSeries} className="flex h-7 items-center justify-center gap-1.5 rounded-md border border-dashed border-line text-[12px] text-fg-2 hover:bg-white/8 hover:text-fg">
          <IconPlus size={14} />
          Add series
        </button>
      </section>

      {cartesian && (
        <section className="flex flex-col gap-3">
          <Heading>Axes</Heading>
          <AxisSettings title={scatter ? 'X axis' : 'Category axis'} axis={description.axes.x} range={scatter} format={scatter} gridlines={scatter} onChange={(x) => change({ axes: { x } })} />
          <AxisSettings title={scatter ? 'Y axis' : 'Value axis'} axis={description.axes.y} range format gridlines onChange={(y) => change({ axes: { y } })} />
          {combo && description.series.some((series) => series.secondary) && <AxisSettings title="Second value axis" axis={description.axes.y2} range format gridlines={false} onChange={(y2) => change({ axes: { y2 } })} />}
        </section>
      )}

      <section>
        <Heading>Legend</Heading>
        <Choices label="Legend" value={description.legend} options={LEGEND_CHOICES} onChange={(legend) => change({ legend })} />
      </section>

      <section>
        <Heading>Labels</Heading>
        <Choices label="Labels" value={description.labels} options={LABEL_CHOICES} onChange={(labels) => change({ labels })} />
      </section>

      {stackable && (
        <section>
          <Heading>Stacking</Heading>
          <Choices label="Stacking" value={description.stacking} options={STACKING_CHOICES} onChange={(stacking) => change({ stacking })} />
        </section>
      )}

      {description.kind === 'doughnut' && (
        <section>
          <Heading>Hole</Heading>
          <Hole value={description.hole ?? 50} onCommit={(hole) => change({ hole })} />
        </section>
      )}

      <section>
        <Heading>Colours</Heading>
        <div className="flex flex-col gap-1">
          {palettes.map(([name, colors]) => {
            const active = colors.length > 0 && colors.join() === description.palette.join()

            return (
              <button
                key={name}
                type="button"
                disabled={!colors.length}
                onClick={() => !active && change({ palette: [...colors] })}
                className={cn('flex h-8 items-center justify-between gap-2 rounded-md border px-2 transition-colors duration-120 disabled:opacity-40', active ? 'border-accent bg-accent-soft' : 'border-line hover:bg-white/8')}
              >
                <span className="text-[12px] text-fg-2">{name}</span>
                <span className="flex gap-0.5">
                  {colors.slice(0, 6).map((color) => (
                    <span key={color} className="size-3.5 rounded-sm" style={{ background: color }} />
                  ))}
                </span>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}

/** The doughnut's hole, changed when the slider is let go. */
function Hole({ value, onCommit }: { value: number; onCommit: (hole: number) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [shown, setShown] = useState(value)
  const commit = useRef(onCommit)
  commit.current = onCommit

  useEffect(() => setShown(value), [value])

  useEffect(() => {
    const element = input.current
    const done = () => element && Number(element.value) !== value && commit.current(Number(element.value))
    element?.addEventListener('change', done)

    return () => element?.removeEventListener('change', done)
  }, [value])

  return (
    <div className="flex items-center gap-2">
      <input ref={input} type="range" min={0} max={90} step={5} value={shown} aria-label="Doughnut hole" onChange={(event) => setShown(Number(event.target.value))} className="min-w-0 flex-1 accent-accent" />
      <span className="w-9 text-right text-[12px] text-fg-2 tabular-nums">{shown}%</span>
    </div>
  )
}
