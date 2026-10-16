import { IconAlertCircle, IconPlus, IconTable, IconX } from '@tabler/icons-react'
import { useEffect, useRef } from 'react'
import { cn } from '../../../lib/cn.ts'
import type { EntrySource } from './sources.ts'
import { swatchOf } from './theme.ts'
import type { GraphEntry, GraphSeries } from './types.ts'

/* What the Graph view draws, as a list beside the canvas (editable in the window's Graph view) and as a small legend over a compact graph. */

const PLACEHOLDER = 'sin(x) * x, or column B of Budget.xlsx'
/** styles.css gives every input `font: inherit` outside Tailwind's layers, which beats font-mono. */
const MONO = { fontFamily: 'var(--font-mono)', fontSize: 13 } as const

const newEntry = (): GraphEntry => ({ id: crypto.randomUUID(), text: '' })

const pointsIn = (series: GraphSeries): string => `${series.points.length.toLocaleString()} ${series.points.length === 1 ? 'number' : 'numbers'}`

/** A line under an entry: what it is reading, what went wrong, or what a sheet gave. */
function EntryNote({ source, onRetry }: { source: EntrySource | undefined; onRetry: () => void }) {
  if (source?.kind === 'loading' && source.sheet) {
    return <p className="mt-1 animate-pulse-soft text-[11.5px] text-fg-3">Reading {source.sheet.workbook}…</p>
  }

  if (source?.kind === 'error') {
    return (
      <p className="mt-1 flex items-start gap-1 text-[11.5px] leading-snug text-fg-3">
        <IconAlertCircle size={13} aria-hidden className="mt-px shrink-0 text-warn" />
        <span className="min-w-0">
          {source.message}
          {source.sheet ? (
            <button type="button" onClick={onRetry} className="ml-1.5 text-accent-strong hover:underline">
              Try again
            </button>
          ) : null}
        </span>
      </p>
    )
  }

  if (source?.kind === 'sheet') {
    return <p className="mt-1 truncate text-[11.5px] text-fg-3">{`${pointsIn(source.series)} from ${source.series.label}`}</p>
  }

  return null
}

export interface GraphEntriesProps {
  entries: readonly GraphEntry[]
  sources: readonly EntrySource[]
  series: readonly GraphSeries[]
  /** Given, the list is editable. */
  onEntriesChange?: (entries: GraphEntry[]) => void
  onRetry: (text: string) => void
  className?: string
}

export function GraphEntries({ entries, sources, series, onEntriesChange, onRetry, className }: GraphEntriesProps) {
  const inputs = useRef(new Map<string, HTMLInputElement>())
  const focusing = useRef<string | null>(null)

  useEffect(() => {
    const id = focusing.current

    if (id) {
      focusing.current = null
      inputs.current.get(id)?.focus()
    }
  }, [entries])

  const change = (next: GraphEntry[], focus?: string) => {
    focusing.current = focus ?? null
    onEntriesChange?.(next)
  }

  const add = (after?: number) => {
    const entry = newEntry()
    const at = after === undefined ? entries.length : after + 1
    change([...entries.slice(0, at), entry, ...entries.slice(at)], entry.id)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    const entry = entries[index]

    if (event.key === 'Enter') {
      event.preventDefault()
      add(index)
    } else if (event.key === 'Backspace' && !entry.text && entries.length > 1) {
      event.preventDefault()
      const neighbour = index > 0 ? entries[index - 1] : entries[1]
      change(
        entries.filter(other => other.id !== entry.id),
        neighbour?.id
      )
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = entries[index + (event.key === 'ArrowDown' ? 1 : -1)]

      if (next) {
        event.preventDefault()
        inputs.current.get(next.id)?.focus()
      }
    }
  }

  return (
    <aside aria-label="What the graph draws" className={cn('flex min-h-0 w-72 shrink-0 flex-col border-r border-line', className)}>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {entries.map((entry, index) => (
          <li key={entry.id} className="group flex items-start gap-2 rounded-lg px-1.5 py-1">
            <span aria-hidden className={cn('mt-2.5 size-3 shrink-0 rounded-full', swatchOf(index), sources[index]?.kind === 'function' || sources[index]?.kind === 'sheet' ? '' : 'opacity-40')} />
            <div className="min-w-0 flex-1">
              {onEntriesChange ? (
                <input
                  ref={element => {
                    if (element) {
                      inputs.current.set(entry.id, element)
                    } else {
                      inputs.current.delete(entry.id)
                    }
                  }}
                  value={entry.text}
                  onChange={event => change(entries.map(other => (other.id === entry.id ? { ...other, text: event.target.value } : other)))}
                  onKeyDown={event => onKeyDown(event, index)}
                  aria-label={`Line ${index + 1} of the graph`}
                  placeholder={PLACEHOLDER}
                  spellCheck={false}
                  autoComplete="off"
                  className="glass-input h-8 w-full rounded-lg px-2.5 font-mono text-[13px] text-fg outline-none placeholder:text-fg-4"
                  style={MONO}
                />
              ) : (
                <p className="truncate py-1.5 font-mono text-[13px] text-fg" title={entry.text}>
                  {entry.text}
                </p>
              )}
              <EntryNote source={sources[index]} onRetry={() => onRetry(entry.text)} />
            </div>
            {onEntriesChange ? (
              <button
                type="button"
                aria-label={entry.text.trim() ? `Remove ${entry.text.trim()}` : 'Remove this line'}
                onClick={() => change(entries.filter(other => other.id !== entry.id))}
                className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-md text-fg-4 group-focus-within:text-fg-3 group-hover:text-fg-3 hover:bg-white/8 hover:text-fg"
              >
                <IconX size={14} />
              </button>
            ) : null}
          </li>
        ))}
        {series.map((one, index) => (
          <li key={`series-${index}`} className="flex items-start gap-2 rounded-lg px-1.5 py-1">
            <span aria-hidden className={cn('mt-2.5 size-3 shrink-0 rounded-full', swatchOf(entries.length + index))} />
            <div className="min-w-0 flex-1 py-1">
              <p className="flex items-center gap-1.5 truncate text-[13px] text-fg" title={one.label}>
                <IconTable size={14} aria-hidden className="shrink-0 text-fg-3" />
                <span className="truncate">{one.label}</span>
              </p>
              <p className="mt-0.5 text-[11.5px] text-fg-3">{pointsIn(one)}</p>
            </div>
          </li>
        ))}
      </ul>
      {onEntriesChange ? (
        <div className="border-t border-line p-2">
          {entries.length ? null : <p className="px-1.5 pb-2 text-[12px] leading-snug text-fg-3">Type a function of x, like sin(x) * x, or a sheet's column, like column B of Budget.xlsx.</p>}
          <button type="button" onClick={() => add()} className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[12.5px] text-fg-2 hover:bg-white/8 hover:text-fg">
            <IconPlus size={15} aria-hidden />
            Add a line
          </button>
        </div>
      ) : null}
    </aside>
  )
}

export interface LegendItem {
  id: string
  label: string
  colour: number
  /** A gentle note in place of the curve: "Reading Budget.xlsx…", an error. */
  note?: string
}

/** The small legend over a compact graph. */
export function GraphLegend({ items, className }: { items: readonly LegendItem[]; className?: string }) {
  const shown = items.slice(0, 4)

  if (!shown.length) {
    return null
  }

  return (
    <ul aria-label="Legend" className={cn('pointer-events-none absolute right-2 bottom-2 flex max-w-[60%] flex-col items-end gap-0.5 rounded-md bg-surface px-1.5 py-1 text-[10.5px] text-fg-3', className)}>
      {shown.map(item => (
        <li key={item.id} className="flex max-w-full min-w-0 items-center gap-1.5">
          <span aria-hidden className={cn('size-2 shrink-0 rounded-full', swatchOf(item.colour), item.note ? 'opacity-40' : '')} />
          <span className={cn('truncate', item.note ? 'text-fg-4' : '')}>{item.note ? `${item.label}: ${item.note}` : item.label}</span>
        </li>
      ))}
      {items.length > shown.length ? <li className="text-fg-4">and {items.length - shown.length} more</li> : null}
    </ul>
  )
}
