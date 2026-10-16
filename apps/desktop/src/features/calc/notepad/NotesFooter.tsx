import { IconChartLine, IconCloudOff, IconRefresh } from '@tabler/icons-react'
import { useState } from 'react'
import type { CalcRatesState } from '../../../../shared/calc.ts'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { notify } from '../../../store/notifications.ts'
import { useDismiss } from '../hooks.ts'
import { refreshRates } from '../rates.ts'
import { messageOf, ratesLabel } from './format.ts'

export interface NotesFooterProps {
  total: string | null
  usesRates: boolean
  rates: CalcRatesState | null
  fetchRates: boolean
  locale: string | undefined
  /** The note has something to draw, so the graph can be shown or hidden. */
  graph: { shown: boolean; toggle: () => void } | null
  reduced: boolean
}

/** Under the note: the running total, and which day's currency rates it used. */
export function NotesFooter({ total, usesRates, rates, fetchRates, locale, graph, reduced }: NotesFooterProps) {
  return (
    <footer className="flex h-11 shrink-0 items-center gap-2 border-t border-line pr-4 pl-2.5">
      {usesRates ? <RatesButton rates={rates} fetchRates={fetchRates} locale={locale} reduced={reduced} /> : <span className="flex-1" />}
      {graph && (
        <button
          type="button"
          aria-pressed={graph.shown}
          aria-label={graph.shown ? 'Hide the graph' : 'Show the graph'}
          title={graph.shown ? 'Hide the graph' : 'Show the graph'}
          onClick={graph.toggle}
          className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 hover:bg-white/8', graph.shown ? 'text-accent-strong' : 'text-fg-3 hover:text-fg')}
        >
          <IconChartLine size={16} />
        </button>
      )}
      <div className="flex min-w-0 items-baseline gap-2.5 pl-1">
        {total !== null && <span className="text-[12px] text-fg-3">Total</span>}
        <span className="selectable truncate text-[16px] font-semibold text-fg tabular-nums" aria-live="polite">
          {total}
        </span>
      </div>
    </footer>
  )
}

function RatesButton({ rates, fetchRates, locale, reduced }: { rates: CalcRatesState | null; fetchRates: boolean; locale: string | undefined; reduced: boolean }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false))
  const label = ratesLabel(rates, locale)

  const refresh = () => {
    setBusy(true)
    setNote(null)
    refreshRates()
      .then(
        state => setNote(state.error ? `Couldn't reach the rates just now (${state.error}).${state.rates ? ' The last ones still answer.' : ''}` : state.status === 'fresh' ? 'Up to date.' : null),
        (error: unknown) => notify({ title: 'Could not refresh the rates', body: messageOf(error), level: 'error' })
      )
      .finally(() => setBusy(false))
  }

  return (
    <div ref={ref} className="relative min-w-0 flex-1">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setNote(null)
          setOpen(!open)
        }}
        className="flex h-7 max-w-full items-center gap-1.5 rounded-lg px-2 text-[12px] text-fg-4 transition-colors duration-150 hover:bg-white/6 hover:text-fg-3"
      >
        {label.hint && <IconCloudOff size={13} className="shrink-0" />}
        <span className="truncate">
          {label.text}
          {label.hint && <span> · {label.hint}</span>}
        </span>
      </button>
      {open && (
        <div role="dialog" aria-label="Currency rates" className={cn('float menu-surface absolute bottom-full left-0 z-30 mb-1.5 w-72 max-w-[calc(100vw-2rem)] rounded-xl p-3 text-[12.5px]', !reduced && 'animate-pop')}>
          <p className="leading-snug text-fg-2">The European Central Bank's reference rates, fetched at most once a day.</p>
          {note && <p className="mt-2 leading-snug text-fg-3">{note}</p>}
          <div className="mt-3">
            {fetchRates ? (
              <GlassButton size="sm" disabled={busy} onClick={refresh}>
                <IconRefresh className={cn(busy && !reduced && 'animate-spin')} />
                {busy ? 'Refreshing…' : 'Refresh rates'}
              </GlassButton>
            ) : (
              <p className="leading-snug text-fg-3">Fetching rates is off in Calc's settings, so the last ones answer.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
