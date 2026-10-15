import { IconChevronDown, IconDots, IconSearch } from '@tabler/icons-react'
import type React from 'react'
import { cn } from '../../lib/cn.ts'
import type { AppIconId } from '../../shell/apps.ts'
import { AppTile } from '../app-icon.tsx'

/*
 * The glass page vocabulary shared by every page inside the main window. One primitive per concern:
 * PageHeader, GlassCard, Pill, Tabs, Chips, SearchField, Toggle, Section, KeyValue, EmptyGlass.
 */

export function PageHeader({ icon, title, subtitle, actions, className }: { icon: AppIconId; title: string; subtitle?: string; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-4 px-6 pt-5 pb-4', className)}>
      <div className="flex items-center gap-3.5">
        <AppTile id={icon} size={44} />
        <div>
          <h1 className="text-[20px] leading-tight font-semibold tracking-tight text-fg">{title}</h1>
          {subtitle && <div className="text-[12.5px] text-fg-3">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function GlassCard({ children, className, selected, interactive, onClick, as = 'div', ...rest }: { children: React.ReactNode; className?: string; selected?: boolean; interactive?: boolean; onClick?: () => void; as?: 'div' | 'button' } & Omit<React.HTMLAttributes<HTMLElement>, 'onClick' | 'className' | 'children'>) {
  const Comp = as as 'div'

  return (
    <Comp
      onClick={onClick}
      className={cn('glass-card rounded-xl text-left', interactive && 'glass-card-hover cursor-pointer', selected && 'glass-card-selected', className)}
      {...(as === 'button' ? { type: 'button' } : {})}
      {...(rest as React.HTMLAttributes<HTMLDivElement>)}
    >
      {children}
    </Comp>
  )
}

export type PillTone = 'accent' | 'progress' | 'ok' | 'warn' | 'danger' | 'muted' | 'info'

const PILL: Record<PillTone, string> = {
  accent: 'bg-accent-soft text-accent-strong border-accent/40',
  progress: 'bg-progress/15 text-progress border-progress/40',
  ok: 'bg-ok/15 text-ok border-ok/40',
  warn: 'bg-warn/15 text-warn border-warn/40',
  danger: 'bg-danger/15 text-danger border-danger/40',
  muted: 'bg-white/6 text-fg-2 border-line',
  info: 'bg-info/15 text-info border-info/40'
}

export function Pill({ children, tone = 'muted', dot, className }: { children: React.ReactNode; tone?: PillTone; dot?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-medium whitespace-nowrap', PILL[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

export function StatusDot({ tone = 'ok', pulse, className }: { tone?: PillTone; pulse?: boolean; className?: string }) {
  const color = { accent: 'bg-accent-strong', progress: 'bg-progress', ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', muted: 'bg-fg-4', info: 'bg-info' }[tone]

  return <span className={cn('inline-block size-2 rounded-full shadow-[0_0_8px_currentColor]', color, pulse && 'animate-pulse-soft', className)} />
}

export interface TabDef<T extends string> {
  id: T
  label: string
  count?: number
  icon?: React.ReactNode
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: readonly TabDef<T>[]; value: T; onChange: (id: T) => void; className?: string }) {
  return (
    <div className={cn('inline-flex items-center gap-1 rounded-lg bg-black/15 p-1 hairline', className)} role="tablist">
      {tabs.map(tab => {
        const active = tab.id === value

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={cn('flex h-7 items-center gap-1.5 rounded-md px-3 text-[12.5px] transition-colors duration-150', active ? 'bg-accent text-accent-fg shadow-[0_2px_10px_rgba(47,125,255,.45)]' : 'text-fg-2 hover:bg-white/6 hover:text-fg')}
          >
            {tab.icon}
            {tab.label}
            {tab.count != null && <span className={cn('rounded-full px-1.5 text-[10.5px] tabular-nums', active ? 'bg-white/25' : 'bg-white/10 text-fg-3')}>{tab.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

export function Chips<T extends string>({ items, value, onChange, className }: { items: readonly { id: T; label: string }[]; value: T; onChange: (id: T) => void; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {items.map(item => {
        const active = item.id === value

        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            className={cn('h-7 rounded-full border px-3 text-[12px] transition-colors duration-150', active ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-white/4 text-fg-2 hover:bg-white/8 hover:text-fg')}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}

export function SearchField({ value, onChange, placeholder, className, trailing, autoFocus, onSubmit }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; trailing?: React.ReactNode; autoFocus?: boolean; onSubmit?: () => void }) {
  return (
    <label className={cn('glass-input flex h-9 items-center gap-2.5 rounded-lg px-3', className)}>
      <IconSearch size={15} className="shrink-0 text-fg-3" />
      <input
        value={value}
        autoFocus={autoFocus}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && onSubmit) {
            onSubmit()
          }
        }}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-4"
      />
      {trailing}
    </label>
  )
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('relative h-[22px] w-10 shrink-0 rounded-full border transition-colors duration-150 disabled:opacity-40', checked ? 'border-accent-strong bg-accent shadow-[0_0_12px_rgba(47,125,255,.5)]' : 'border-line bg-black/25')}
    >
      <span className={cn('absolute top-[2px] left-0 size-4 rounded-full bg-paper shadow transition-transform duration-150', checked ? 'translate-x-[19px]' : 'translate-x-[2px]')} />
    </button>
  )
}

export function Section({ title, action, children, className }: { title: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('flex min-h-0 flex-col gap-2.5', className)}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-fg">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export function LinkAction({ children, onClick, className }: { children: React.ReactNode; onClick?: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={cn('flex items-center gap-1 text-[12px] text-accent-strong hover:underline', className)}>
      {children}
      <span aria-hidden="true">→</span>
    </button>
  )
}

export function KeyValue({ rows, className }: { rows: { label: string; value: React.ReactNode }[]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[96px_1fr] gap-x-4 gap-y-2.5 text-[12.5px]', className)}>
      {rows.map(row => (
        <div key={row.label} className="contents">
          <dt className="text-fg-3">{row.label}</dt>
          <dd className="selectable text-fg">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function GlassButton({ children, variant = 'secondary', size = 'md', className, ...rest }: React.ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'icon' }) {
  const variants = {
    primary: 'bg-accent text-accent-fg border-accent-strong/60 hover:bg-accent-strong shadow-[0_4px_16px_rgba(47,125,255,.45)] font-medium',
    secondary: 'bg-white/6 text-fg border-line hover:bg-white/10 hover:border-line-strong',
    ghost: 'bg-transparent text-fg-2 border-transparent hover:bg-white/8 hover:text-fg',
    danger: 'bg-danger/10 text-danger border-danger/40 hover:bg-danger/20'
  }
  const sizes = { sm: 'h-8 px-3 text-[12.5px] gap-1.5 rounded-lg', md: 'h-9 px-3.5 text-[13px] gap-2 rounded-lg', icon: 'size-9 rounded-lg' }

  return (
    <button type="button" className={cn('inline-flex items-center justify-center whitespace-nowrap border transition-colors duration-120 disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0', variants[variant], sizes[size], className)} {...rest}>
      {children}
    </button>
  )
}

export function MoreButton(props: React.ComponentProps<'button'>) {
  return (
    <button type="button" aria-label="More" className="flex size-8 items-center justify-center rounded-lg text-fg-3 hover:bg-white/8 hover:text-fg" {...props}>
      <IconDots size={16} />
    </button>
  )
}

export function Dropdown({ label, className, onClick, ...button }: { label: React.ReactNode; className?: string; onClick?: () => void } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'onClick' | 'type'>) {
  return (
    <button type="button" {...button} onClick={onClick} className={cn('flex h-8 items-center gap-2 rounded-lg border border-line bg-white/6 px-3 text-[12.5px] text-fg hover:bg-white/10 disabled:cursor-default disabled:hover:bg-white/6', className)}>
      {label}
      <IconChevronDown size={14} className="text-fg-3" />
    </button>
  )
}

export function EmptyGlass({ icon, title, description, action, className }: { icon?: React.ReactNode; title: string; description?: string; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line px-6 py-8 text-center', className)}>
      {icon && <div className="text-fg-3 [&_svg]:size-7">{icon}</div>}
      <div className="text-[13px] text-fg-2">{title}</div>
      {description && <div className="max-w-sm text-[12px] text-fg-3">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function ProgressBar({ value, tone = 'accent', className }: { value: number; tone?: 'accent' | 'progress' | 'ok'; className?: string }) {
  const color = { accent: 'bg-accent-strong', progress: 'bg-progress', ok: 'bg-ok' }[tone]

  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-black/25', className)}>
      <div className={cn('h-full rounded-full shadow-[0_0_10px_currentColor] transition-[width] duration-500', color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}
