import { useStore } from '@nanostores/react'
import { IconAdjustmentsHorizontal, IconRefresh, IconTrash } from '@tabler/icons-react'
import type React from 'react'
import { useEffect, useState } from 'react'
import { type CalcPrefs, type CalcRatesState, normalizeCalcPrefs } from '../../../../shared/calc.ts'
import { GlassButton, Toggle } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { formatRelative } from '../../../lib/format.ts'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { $locale } from '../../../store/i18n.ts'
import { notify } from '../../../store/notifications.ts'
import { useReducedMotion } from '../../pet/hooks.ts'
import { clearHistory } from '../history/store.ts'
import { useDismiss } from '../hooks.ts'
import { messageOf, ratesDay } from '../notepad/format.ts'
import { $calcRates, followRates, refreshRates } from '../rates.ts'

/** Calc's settings, behind a button in the window's header. */
export function SettingsMenu({ maxHeight }: { maxHeight?: number }) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false))
  const reduced = useReducedMotion()

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Calc settings"
        title="Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn('flex size-8 items-center justify-center rounded-lg transition-colors duration-150 hover:bg-white/8 hover:text-fg', open ? 'bg-white/8 text-fg' : 'text-fg-3')}
      >
        <IconAdjustmentsHorizontal size={17} />
      </button>
      {open && <SettingsPanel maxHeight={maxHeight} reduced={reduced} />}
    </div>
  )
}

function savePrefs(patch: Partial<CalcPrefs>): void {
  updatePrefs({ calc: patch }).catch((error: unknown) => notify({ title: 'Could not save the setting', body: messageOf(error), level: 'error' }))
}

/** Which day's rates these are and how they stand, in a line. */
function ratesStatus(state: CalcRatesState | null, locale: string | undefined): string {
  if (!state) {
    return 'Reading the rates…'
  }

  if (!state.rates) {
    if (state.status === 'off') {
      return 'No rates yet, and fetching is off.'
    }

    return state.error ? `No rates yet: the fetch failed (${state.error}). Herald tries again within the hour.` : 'No rates yet. They come the first time a note names a currency.'
  }

  const day = `Rates from ${ratesDay(state.rates.date, locale)}`
  const fetched = formatRelative(state.rates.fetchedAt)

  if (state.status === 'offline') {
    return `${day}. The last fetch failed${state.error ? ` (${state.error})` : ''}, so these answer.`
  }

  if (state.status === 'off') {
    return `${day}, kept while fetching is off.`
  }

  return `${day}, fetched ${fetched}.`
}

function SettingsPanel({ maxHeight, reduced }: { maxHeight?: number; reduced: boolean }) {
  const prefs = normalizeCalcPrefs(useStore($prefs).calc)
  const rates = useStore($calcRates)
  const locale = useStore($locale)
  const [refreshing, setRefreshing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)

  useEffect(() => followRates(), [])

  const refresh = () => {
    setRefreshing(true)
    refreshRates()
      .then(
        state => {
          if (state.error) {
            notify({ title: "Couldn't fetch the rates", body: state.rates ? `${state.error}. The last rates still answer.` : state.error, level: 'warn' })
          }
        },
        (error: unknown) => notify({ title: 'Could not refresh the rates', body: messageOf(error), level: 'error' })
      )
      .finally(() => setRefreshing(false))
  }

  const clear = () => {
    setClearing(true)
    clearHistory()
      .then(
        () => {
          setConfirming(false)
          notify({ title: 'Calc history cleared', level: 'success' })
        },
        (error: unknown) => notify({ title: 'Could not clear the history', body: messageOf(error), level: 'error' })
      )
      .finally(() => setClearing(false))
  }

  return (
    <div
      role="dialog"
      aria-label="Calc settings"
      style={maxHeight ? { maxHeight } : undefined}
      className={cn('float menu-surface absolute top-full right-0 z-40 mt-1.5 w-80 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl p-3', !reduced && 'animate-pop')}
    >
      <SettingRow
        title="Fetch currency rates daily"
        description="The European Central Bank's reference rates through frankfurter.dev, at most once a day; nothing personal is sent."
        control={<Toggle checked={prefs.fetchRates} onChange={value => savePrefs({ fetchRates: value })} label="Fetch currency rates daily" />}
      />
      <div className="mb-1 flex items-center gap-2 rounded-lg bg-white/4 px-2.5 py-2">
        <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-fg-3">{ratesStatus(rates, locale)}</p>
        <GlassButton size="sm" variant="ghost" disabled={!prefs.fetchRates || refreshing} onClick={refresh} className="shrink-0">
          <IconRefresh className={cn(refreshing && !reduced && 'animate-spin')} />
          {refreshing ? 'Refreshing…' : 'Refresh now'}
        </GlassButton>
      </div>
      <SettingRow title="Key sounds" description="A soft click as the keypad's keys are pressed." control={<Toggle checked={prefs.sounds} onChange={value => savePrefs({ sounds: value })} label="Key sounds" />} />
      <SettingRow
        title="Angles"
        description="How the scientific keypad reads sin, cos and tan."
        control={
          <div role="radiogroup" aria-label="Angles" className="inline-flex items-center gap-0.5 rounded-lg bg-black/15 p-0.5 hairline">
            {(
              [
                ['deg', 'Degrees'],
                ['rad', 'Radians']
              ] as const
            ).map(([angle, label]) => (
              <button
                key={angle}
                type="button"
                role="radio"
                aria-checked={prefs.angle === angle}
                onClick={() => savePrefs({ angle })}
                className={cn('h-6 rounded-md px-2 text-[11.5px] transition-colors duration-150', prefs.angle === angle ? 'bg-accent text-accent-fg' : 'text-fg-2 hover:bg-white/6 hover:text-fg')}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />
      <div className="my-2 h-px bg-line" />
      {confirming ? (
        <div className="rounded-lg bg-white/4 p-2.5">
          <p className="text-[12.5px] leading-snug text-fg-2">Clear every calculation in Calc's history? This can't be undone.</p>
          <div className="mt-2.5 flex justify-end gap-1.5">
            <GlassButton size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={clearing}>
              Cancel
            </GlassButton>
            <GlassButton size="sm" variant="danger" onClick={clear} disabled={clearing}>
              {clearing ? 'Clearing…' : 'Clear history'}
            </GlassButton>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[12.5px] text-fg-2 transition-colors duration-150 hover:bg-white/8 hover:text-fg">
          <IconTrash size={15} className="text-fg-3" />
          Clear history…
        </button>
      )}
    </div>
  )
}

function SettingRow({ title, description, control }: { title: string; description?: string; control: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-fg">{title}</div>
        {description && <div className="mt-0.5 text-[11.5px] leading-snug text-fg-3">{description}</div>}
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  )
}
