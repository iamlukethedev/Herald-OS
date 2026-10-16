import { IconCheck, IconMinus, IconPlus } from '@tabler/icons-react'
import { atom } from 'nanostores'
import type React from 'react'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Dropdown, GlassCard } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { useT } from '../../../store/i18n.ts'

/*
 * Building blocks shared by every Settings section: the row/group vocabulary from the mockup,
 * the search filter, an inline popover menu, a numeric stepper, radio cards and the
 * "Changes saved" signal the page footer listens to.
 */

// ---- "Changes saved" -----------------------------------------------------------------------

/** Timestamp of the last successful write made from the Settings page. */
export const $settingsSavedAt = atom(0)

export type SectionId = 'general' | 'appearance' | 'pet' | 'room' | 'software' | 'plugins' | 'agents' | 'usage' | 'voice' | 'commands' | 'privacy' | 'notifications' | 'network' | 'storage' | 'accessibility' | 'about'

/** Section ids in nav order; kept here (not in SettingsPage) so commands can import them without the page. */
export const SETTINGS_SECTION_IDS: readonly SectionId[] = ['general', 'appearance', 'pet', 'room', 'software', 'plugins', 'agents', 'usage', 'voice', 'commands', 'privacy', 'notifications', 'network', 'storage', 'accessibility', 'about']

/** A command (voice, agent) asked the Settings page to show a section (id) and optionally search. */
export const $settingsFocus = atom<{ section?: string; query?: string; ts: number } | null>(null)

export function focusSettings(focus: { section?: string; query?: string }): void {
  $settingsFocus.set({ ...focus, ts: Date.now() })
}

export function markSaved(): void {
  $settingsSavedAt.set(Date.now())
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---- Search filter -------------------------------------------------------------------------

export const SettingsFilterContext = createContext('')

function matches(query: string, ...parts: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase()

  if (!q) {
    return true
  }

  return parts.some(part => part?.toLowerCase().includes(q))
}

/**
 * Anything searchable in Settings. Renders nothing when the page filter does not match; when
 * it does render it is tagged `data-settings-row` so groups and sections can hide themselves
 * with `:has()` when none of their rows survive the filter.
 */
export function Filterable({ label, description, keywords, children, className }: { label: string; description?: string; keywords?: string; children: React.ReactNode; className?: string }) {
  const query = useContext(SettingsFilterContext)

  if (!matches(query, label, description, keywords)) {
    return null
  }

  return (
    <div data-settings-row="" className={cn('settings-item contents', className)}>
      {children}
    </div>
  )
}

// ---- Rows and groups -----------------------------------------------------------------------

/** 32px blue-glass tile holding a tabler icon. */
export function RowIcon({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('icon-tile size-8 shrink-0 rounded-lg [&_svg]:size-4', className)}>
      {children}
    </span>
  )
}

/**
 * One settings row: icon tile, label + description, control on the right. Rows inside a group
 * are separated by 1px `bg-line` dividers. `below` renders full-width content under the row
 * (an expanding panel, a warning, an inline list).
 */
export function SettingsRow({ icon, label, description, keywords, children, below, className }: { icon?: React.ReactNode; label: string; description?: React.ReactNode; keywords?: string; children?: React.ReactNode; below?: React.ReactNode; className?: string }) {
  const searchable = typeof description === 'string' ? description : undefined

  return (
    <Filterable label={label} description={searchable} keywords={keywords}>
      <div className={cn('settings-row flex flex-col', className)}>
        <div className="flex min-h-[54px] items-center gap-3 px-3.5 py-2.5">
          {icon && <RowIcon>{icon}</RowIcon>}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] leading-tight font-medium text-fg">{label}</div>
            {description && <div className="mt-0.5 text-[12px] leading-snug text-fg-3">{description}</div>}
          </div>
          {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
        </div>
        {below && <div className="px-3.5 pb-3">{below}</div>}
      </div>
    </Filterable>
  )
}

/**
 * A group heading plus a GlassCard of rows. Hidden entirely when the search filter removed
 * every row inside (pure CSS through `:has()`, so rows stay self-contained).
 */
export function SettingsGroup({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('hidden flex-col gap-1.5 has-[.settings-item]:flex', className)}>
      {title && <h3 className="px-0.5 text-[12.5px] font-medium text-fg-2">{title}</h3>}
      <GlassCard className="flex flex-col [&>.settings-item+.settings-item>.settings-row]:border-t [&>.settings-item+.settings-item>.settings-row]:border-line">{children}</GlassCard>
    </section>
  )
}

/** Free-form block (identity card, autonomy cards) that still participates in the filter. */
export function SettingsBlock({ title, label, description, keywords, children, className }: { title?: string; label: string; description?: string; keywords?: string; children: React.ReactNode; className?: string }) {
  return (
    <Filterable label={label} description={description} keywords={keywords}>
      <section className={cn('flex flex-col gap-1.5', className)}>
        {title && <h3 className="px-0.5 text-[12.5px] font-medium text-fg-2">{title}</h3>}
        {children}
      </section>
    </Filterable>
  )
}

/** Section title + subtitle at the top of the content column. */
export function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <h2 className="text-[16px] leading-tight font-semibold text-fg">{title}</h2>
      {subtitle && <div className="mt-0.5 text-[12.5px] text-fg-3">{subtitle}</div>}
    </div>
  )
}

export function InlineNote({ tone = 'warn', children, className }: { tone?: 'warn' | 'info' | 'danger'; children: React.ReactNode; className?: string }) {
  const color = { warn: 'text-warn', info: 'text-fg-2', danger: 'text-danger' }[tone]

  return <div className={cn('text-[12px] leading-snug', color, className)}>{children}</div>
}

// ---- Controls ------------------------------------------------------------------------------

export interface MenuItem<T extends string = string> {
  id: T
  label: React.ReactNode
  description?: React.ReactNode
  trailing?: React.ReactNode
  disabled?: boolean
}

/** Closes when the pointer lands outside `ref` or Escape is pressed. */
export function useDismiss(open: boolean, close: () => void): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        close()
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
      }
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  return ref
}

/** Dropdown button that opens an inline list of options. */
export function MenuDropdown<T extends string>({ label, items, value, onSelect, disabled, className, menuClassName, ariaLabel }: { label: React.ReactNode; items: readonly MenuItem<T>[]; value?: T; onSelect: (id: T) => void; disabled?: boolean; className?: string; menuClassName?: string; ariaLabel: string }) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))

  useEffect(() => {
    if (disabled) {
      setOpen(false)
    }
  }, [disabled])

  return (
    <div ref={ref} className="relative">
      <Dropdown
        label={<span className="max-w-[220px] truncate">{label}</span>}
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        aria-disabled={disabled || undefined}
        aria-haspopup="listbox"
        aria-expanded={open && !disabled}
        className={cn(disabled && 'opacity-50', className)}
      />
      {open && !disabled && (
        <div role="listbox" aria-label={ariaLabel} className={cn('float animate-pop absolute top-[calc(100%+6px)] right-0 z-30 min-w-[220px] rounded-lg p-1', menuClassName)}>
          {items.map(item => {
            const active = item.id === value

            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={active}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false)
                  onSelect(item.id)
                }}
                className={cn('flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors disabled:opacity-40', active ? 'bg-accent-soft text-fg' : 'text-fg-2 hover:bg-white/8 hover:text-fg')}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.label}</span>
                  {item.description && <span className="block truncate text-[11.5px] text-fg-3">{item.description}</span>}
                </span>
                {item.trailing}
                {active && <IconCheck size={14} className="shrink-0 text-accent-strong" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** −/+ numeric stepper matching the mockup. */
export function Stepper({ value, onChange, min = 1, max = 99, disabled, label }: { value: number | null; onChange: (next: number) => void; min?: number; max?: number; disabled?: boolean; label: string }) {
  const t = useT()
  const current = value ?? min
  const step = (delta: number) => onChange(Math.max(min, Math.min(max, current + delta)))

  return (
    <div className={cn('inline-flex h-8 items-stretch overflow-hidden rounded-lg border border-line bg-white/6', disabled && 'opacity-50')} role="group" aria-label={label}>
      <button type="button" aria-label={t('settings.decrease', { name: label })} disabled={disabled || current <= min} onClick={() => step(-1)} className="flex w-8 items-center justify-center text-fg-2 hover:bg-white/10 hover:text-fg disabled:opacity-40">
        <IconMinus size={14} />
      </button>
      <span className="flex min-w-9 items-center justify-center border-x border-line px-2 text-[12.5px] font-medium tabular-nums text-fg">{value ?? '—'}</span>
      <button type="button" aria-label={t('settings.increase', { name: label })} disabled={disabled || current >= max} onClick={() => step(1)} className="flex w-8 items-center justify-center text-fg-2 hover:bg-white/10 hover:text-fg disabled:opacity-40">
        <IconPlus size={14} />
      </button>
    </div>
  )
}

/** Selectable card with a radio indicator (Autonomy). */
export function RadioCard({ icon, label, description, selected, onSelect, disabled }: { icon: React.ReactNode; label: string; description: string; selected: boolean; onSelect: () => void; disabled?: boolean }) {
  return (
    <GlassCard as="button" interactive selected={selected} onClick={disabled ? undefined : onSelect} className={cn('flex min-w-0 flex-1 items-center gap-3 px-3.5 py-3', disabled && 'cursor-default opacity-60')}>
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center text-fg [&_svg]:size-5">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-fg" title={label}>
          {label}
        </span>
        <span className="block truncate text-[12px] text-fg-3" title={description}>
          {description}
        </span>
      </span>
      <span aria-hidden="true" className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors', selected ? 'border-accent-strong' : 'border-line-strong')}>
        {selected && <span className="size-2 rounded-full bg-accent-strong shadow-[0_0_8px_currentColor]" />}
      </span>
    </GlassCard>
  )
}

/** Monospace log/pre block used by About and Privacy. */
export function LogView({ lines, empty = 'Nothing yet.', className }: { lines: string[]; empty?: string; className?: string }) {
  return <pre className={cn('selectable max-h-[320px] overflow-auto rounded-lg border border-line bg-black/25 p-3 font-mono text-[11px] leading-relaxed text-fg-3', className)}>{lines.join('\n') || empty}</pre>
}

/** Read a boolean shell preference from localStorage. */
export function readLocalFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)

    return raw == null ? fallback : raw === 'true'
  } catch {
    return fallback
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage may be unavailable; the in-memory state still applies for this session.
  }
}
