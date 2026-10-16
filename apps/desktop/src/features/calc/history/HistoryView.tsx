import { useStore } from '@nanostores/react'
import { IconCalculator, IconCheck, IconCommand, IconCopy, IconCornerDownLeft, IconHistory, IconMicrophone, IconNote, IconTrash, IconX } from '@tabler/icons-react'
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CalcHistoryEntry, CalcSource } from '../../../../shared/calc.ts'
import { HermesMark } from '../../../components/hermes-mark.tsx'
import { EmptyGlass, GlassButton, SearchField } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { logFailure } from '../../../lib/report.ts'
import { $locale } from '../../../store/i18n.ts'
import { messageOf } from '../../canvas/errors.ts'
import { useReducedMotion } from '../../pet/hooks.ts'
import { groupByDay, startOfDay, timeLabel } from './days.ts'
import { searchHistory } from './search.ts'
import { $calcHistory, $calcHistoryLoaded, clearHistory, loadHistory } from './store.ts'

export interface HistoryViewProps {
  /** The search, owned by the window so a request can set it. */
  query: string
  onQueryChange: (query: string) => void
  /** Bring a past calculation back into the note in front. */
  onUse?: (entry: CalcHistoryEntry) => void
  className?: string
}

/** Rows shown at first, and how many more Show more adds. */
const PAGE = 100

const SOURCES: Record<CalcSource, { label: string; icon: ReactNode }> = {
  notes: { label: 'From a note', icon: <IconNote size={14} stroke={1.75} /> },
  keypad: { label: 'From a keypad', icon: <IconCalculator size={14} stroke={1.75} /> },
  voice: { label: 'Said aloud', icon: <IconMicrophone size={14} stroke={1.75} /> },
  hermes: { label: 'Worked out by Hermes', icon: <HermesMark size={14} /> },
  command: { label: 'From a command', icon: <IconCommand size={14} stroke={1.75} /> }
}

/** Midnight today, moving on at midnight while the view is open. */
function useToday(): number {
  const [today, setToday] = useState(() => startOfDay(Date.now()))

  useEffect(() => {
    const timer = setTimeout(() => setToday(startOfDay(Date.now())), Math.max(1_000, startOfDay(today, 1) - Date.now() + 1_000))

    return () => clearTimeout(timer)
  }, [today])

  return today
}

interface RowProps {
  entry: CalcHistoryEntry
  time: string
  /** The row the list's one tab stop is on. */
  current: boolean
  copied: boolean
  reduced: boolean
  rowRef: (element: HTMLButtonElement | null) => void
  onFocus: () => void
  onPick: () => void
  onUse?: () => void
  onCopy: () => void
}

function HistoryRow({ entry, time, current, copied, reduced, rowRef, onFocus, onPick, onUse, onCopy }: RowProps) {
  const source = Object.hasOwn(SOURCES, entry.source) ? SOURCES[entry.source] : SOURCES.notes
  const tabIndex = current ? 0 : -1
  const action = cn('flex size-7 items-center justify-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg', !reduced && 'transition-colors duration-150')

  return (
    <li className="group/reveal-row flex items-center gap-1" onFocus={onFocus}>
      <button
        ref={rowRef}
        type="button"
        tabIndex={tabIndex}
        data-os-target={`calc-history:${entry.id}`}
        aria-label={`${entry.input} = ${entry.result}${entry.context ? `, ${entry.context}` : ''}. ${source.label}, ${time}`}
        onClick={onPick}
        className={cn('flex min-w-0 flex-1 items-center gap-3 rounded-lg py-2 pr-3 pl-2.5 text-left hover:bg-white/6', !reduced && 'transition-colors duration-150')}
      >
        <span title={source.label} className="flex size-4 shrink-0 items-center justify-center text-fg-4">
          {source.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-fg">{entry.input}</span>
          {entry.context && <span className="block truncate text-[11.5px] text-fg-4">{entry.context}</span>}
        </span>
        <span className="max-w-[45%] shrink-0 truncate text-right text-[13px] font-medium text-fg tabular-nums">{entry.result}</span>
        <time dateTime={new Date(entry.at).toISOString()} className="w-14 shrink-0 text-right text-[11.5px] text-fg-4 tabular-nums">
          {time}
        </time>
      </button>
      <div className={cn('reveal flex shrink-0 items-center gap-0.5 pr-1', !reduced && 'transition-opacity duration-150')}>
        {onUse && (
          <button type="button" tabIndex={tabIndex} aria-label={`Use ${entry.input} in the note`} title="Use in the note" onClick={onUse} className={action}>
            <IconCornerDownLeft size={15} />
          </button>
        )}
        <button type="button" tabIndex={tabIndex} aria-label={copied ? `Copied ${entry.result}` : `Copy ${entry.result}`} title={copied ? 'Copied' : 'Copy the result'} onClick={onCopy} className={action}>
          {copied ? <IconCheck size={15} className="text-ok" /> : <IconCopy size={15} />}
        </button>
      </div>
    </li>
  )
}

/** Every calculation kept, searchable by its words, under the day it was made. */
export function HistoryView({ query, onQueryChange, onUse, className }: HistoryViewProps) {
  const entries = useStore($calcHistory)
  const loaded = useStore($calcHistoryLoaded)
  const locale = useStore($locale)
  const reduced = useReducedMotion()
  const today = useToday()
  const [searched, setSearched] = useState(query)
  const [limit, setLimit] = useState(PAGE)
  const [active, setActive] = useState(0)
  const [copied, setCopied] = useState<{ id: string; at: number } | null>(null)
  const [status, setStatus] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  const search = useRef<HTMLDivElement>(null)
  const clearButton = useRef<HTMLButtonElement>(null)
  const rows = useRef<(HTMLButtonElement | null)[]>([])
  const ids = useId()

  // A new search starts from its best match, with one page of rows.
  if (searched !== query) {
    setSearched(query)
    setLimit(PAGE)
    setActive(0)
  }

  useEffect(() => {
    void loadHistory()
  }, [])

  useEffect(() => {
    if (!copied) {
      return
    }

    const timer = setTimeout(() => setCopied(null), 1_500)

    return () => clearTimeout(timer)
  }, [copied])

  const found = useMemo(() => searchHistory(entries, query, limit + 1, { now: today, locale }), [entries, query, limit, today, locale])
  const groups = useMemo(() => {
    let start = 0

    return groupByDay(found.slice(0, limit), today, locale).map(group => {
      const first = start
      start += group.entries.length

      return { ...group, start: first }
    })
  }, [found, limit, today, locale])
  const count = groups.reduce((sum, group) => sum + group.entries.length, 0)
  const current = Math.min(active, Math.max(0, count - 1))
  const more = found.length > limit
  const asked = query.trim()

  const focusSearch = () => search.current?.querySelector('input')?.focus()

  const focusRow = (index: number) => {
    const next = Math.max(0, Math.min(count - 1, index))
    setActive(next)
    rows.current[next]?.focus()
  }

  function copy(entry: CalcHistoryEntry) {
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(entry.result))
      .then(
        () => {
          setProblem(null)
          setCopied({ id: entry.id, at: Date.now() })
          setStatus(`Copied ${entry.result}`)
        },
        (error: unknown) => {
          logFailure('clipboard.writeText')(error)
          setCopied(null)
          setProblem(`Could not copy ${entry.result}: ${messageOf(error)}`)
        }
      )
  }

  const pick = (entry: CalcHistoryEntry) => (onUse ? onUse(entry) : copy(entry))

  function onSearchKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowDown' && count > 0) {
      event.preventDefault()
      focusRow(current)
    }
  }

  function onListKey(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, () => void> = {
      ArrowDown: () => focusRow(current + 1),
      ArrowUp: () => (current === 0 ? focusSearch() : focusRow(current - 1)),
      Home: () => focusRow(0),
      End: () => focusRow(count - 1)
    }
    const move = moves[event.key]

    if (move && count > 0) {
      event.preventDefault()
      move()
    }
  }

  function clearSearch() {
    onQueryChange('')
    focusSearch()
  }

  function cancelClear() {
    setConfirming(false)
    clearButton.current?.focus()
  }

  async function confirmClear() {
    setClearing(true)
    setProblem(null)

    try {
      await clearHistory()
      setConfirming(false)
      setStatus('History cleared')
      focusSearch()
    } catch (error) {
      setProblem(`Could not clear the history: ${messageOf(error)}`)
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
        <div ref={search} className="min-w-0 flex-1" onKeyDown={onSearchKey}>
          <SearchField
            value={query}
            onChange={onQueryChange}
            placeholder="Search calculations"
            trailing={
              query ? (
                <button type="button" aria-label="Clear the search" onClick={clearSearch} className="flex size-5 items-center justify-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg">
                  <IconX size={13} />
                </button>
              ) : null
            }
          />
        </div>
        {entries.length > 0 && (
          <GlassButton ref={clearButton} variant="ghost" size="sm" aria-expanded={confirming} onClick={() => setConfirming(true)}>
            <IconTrash />
            Clear history
          </GlassButton>
        )}
      </div>

      {confirming && (
        <div
          role="group"
          aria-label="Clear history"
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              cancelClear()
            }
          }}
          className={cn('mx-4 mb-2 flex shrink-0 items-center gap-3 rounded-xl border border-line bg-white/4 px-3 py-2.5', !reduced && 'animate-rise')}
        >
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] text-fg">{entries.length === 1 ? 'Clear the one calculation in the history?' : `Clear all ${entries.length.toLocaleString(locale)} calculations?`}</div>
            <div className="text-[12px] text-fg-3">Every window forgets them, and this can’t be undone.</div>
          </div>
          <GlassButton variant="ghost" size="sm" autoFocus disabled={clearing} onClick={cancelClear}>
            Cancel
          </GlassButton>
          <GlassButton variant="danger" size="sm" disabled={clearing} onClick={() => void confirmClear()}>
            {clearing ? 'Clearing…' : 'Clear'}
          </GlassButton>
        </div>
      )}

      {problem && (
        <p role="alert" className="mx-4 mb-2 shrink-0 text-[12px] text-danger">
          {problem}
        </p>
      )}
      <p className="sr-only" aria-live="polite">
        {status}
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-busy={!loaded}>
        {!loaded ? null : entries.length === 0 ? (
          <EmptyGlass className="mx-2 mt-1" icon={<IconHistory />} title="No calculations yet" description="What you work out in a note, on a keypad, by voice or with Hermes shows up here, to find again by its words." />
        ) : count === 0 ? (
          <EmptyGlass
            className="mx-2 mt-1"
            icon={<IconHistory />}
            title={`Nothing matches “${asked}”`}
            description="Try fewer words, part of a number, or a day like yesterday."
            action={
              <GlassButton variant="ghost" size="sm" onClick={clearSearch}>
                Clear the search
              </GlassButton>
            }
          />
        ) : (
          <>
            <div onKeyDown={onListKey}>
              {groups.map((group, index) => (
                <section key={group.key} aria-labelledby={`${ids}-${group.key}`}>
                  <h3 id={`${ids}-${group.key}`} className={cn('px-2.5 pb-1 text-[11.5px] font-medium text-fg-3', index === 0 ? 'pt-1' : 'pt-3')}>
                    {group.label}
                  </h3>
                  <ul className="space-y-0.5">
                    {group.entries.map((entry, offset) => {
                      const position = group.start + offset

                      return (
                        <HistoryRow
                          key={entry.id}
                          entry={entry}
                          time={timeLabel(entry.at, locale)}
                          current={position === current}
                          copied={copied?.id === entry.id}
                          reduced={reduced}
                          rowRef={element => {
                            rows.current[position] = element
                          }}
                          onFocus={() => setActive(position)}
                          onPick={() => pick(entry)}
                          onUse={onUse ? () => onUse(entry) : undefined}
                          onCopy={() => copy(entry)}
                        />
                      )
                    })}
                  </ul>
                </section>
              ))}
            </div>
            {more && (
              <div className="flex justify-center pt-2">
                <GlassButton variant="ghost" size="sm" onClick={() => setLimit(limit + PAGE)}>
                  Show more
                </GlassButton>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
