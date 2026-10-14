import { IconFile } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { cn } from '../../lib/cn.ts'

/*
 * Small pieces the Overview blocks share: initials avatars, shimmer placeholders, lazy file
 * thumbnails and a few text helpers. Nothing here knows about stores.
 */

export function initialsOf(text: string): string {
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

  if (words.length === 0) {
    return 'H'
  }

  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase()
  }

  return `${words[0][0]}${words[1][0]}`.toUpperCase()
}

export function titleCase(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

/** "Research agent" style label from a goal sentence: its first three words. */
export function agentNameFor(goal: string): string {
  const words = goal
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)

  return words.length ? titleCase(words.join(' ')) : 'Hermes'
}

export function Avatar({ label, size = 28, className }: { label: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full border border-line-strong bg-accent-soft font-semibold text-fg shadow-[inset_0_1px_0_rgba(255,255,255,.18)]', className)}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.36)) }}
    >
      {initialsOf(label)}
    </span>
  )
}

export function AvatarStack({ labels, label, max = 3, size = 26 }: { labels: string[]; label: string; max?: number; size?: number }) {
  const shown = labels.slice(0, max)
  const extra = labels.length - shown.length

  if (shown.length === 0) {
    return null
  }

  return (
    <div className="flex items-center" aria-label={label}>
      {shown.map((label, index) => (
        <Avatar key={`${label}-${index}`} label={label} size={size} className={cn('ring-2 ring-bg', index > 0 && '-ml-2')} />
      ))}
      {extra > 0 && <span className="ml-1.5 text-[11px] text-fg-3">+{extra}</span>}
    </div>
  )
}

export function Shimmer({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('shimmer rounded-lg', className)} />
}

/** Quiet single-line empty state used inside the right column. */
export function Quiet({ children }: { children: React.ReactNode }) {
  return <div className="px-1 py-1.5 text-[12px] text-fg-4">{children}</div>
}

/** Rounded glass tile holding a tabler icon (the non-registry version of AppTile). */
export function IconTile({ children, size = 40, className }: { children: React.ReactNode; size?: number; className?: string }) {
  return (
    <span className={cn('icon-tile shrink-0 [&_svg]:size-[55%]', className)} style={{ width: size, height: size, borderRadius: Math.round(size * 0.24) }} aria-hidden="true">
      {children}
    </span>
  )
}

const thumbCache = new Map<string, string | null>()

/** Lazy Quick Look thumbnail with a neutral tile while loading and a glyph when none exists. */
export function FileThumb({ path, size = 256, className }: { path: string; size?: number; className?: string }) {
  const [state, setState] = useState<{ path: string; url: string | null } | null>(() => (thumbCache.has(path) ? { path, url: thumbCache.get(path) ?? null } : null))

  useEffect(() => {
    if (thumbCache.has(path)) {
      setState({ path, url: thumbCache.get(path) ?? null })

      return
    }

    let cancelled = false
    window.heraldOS.fs
      .thumbnail(path, size)
      .then(url => {
        thumbCache.set(path, url)

        if (!cancelled) {
          setState({ path, url })
        }
      })
      .catch(() => {
        thumbCache.set(path, null)

        if (!cancelled) {
          setState({ path, url: null })
        }
      })

    return () => {
      cancelled = true
    }
  }, [path, size])

  const ready = state?.path === path

  if (!ready) {
    return <Shimmer className={cn('rounded-lg', className)} />
  }

  if (!state.url) {
    return (
      <div className={cn('flex items-center justify-center rounded-lg bg-white/6 text-fg-3 hairline', className)} aria-hidden="true">
        <IconFile size={20} />
      </div>
    )
  }

  return <img src={state.url} alt="" draggable={false} className={cn('rounded-lg object-cover hairline', className)} />
}

/** Epochs may arrive in seconds or milliseconds. */
export function toMs(value: number | string | null | undefined): number | null {
  if (value == null || value === '') {
    return null
  }

  if (typeof value === 'number') {
    return value < 1e12 ? value * 1000 : value
  }

  const numeric = Number(value)

  if (Number.isFinite(numeric)) {
    return numeric < 1e12 ? numeric * 1000 : numeric
  }

  const parsed = Date.parse(value)

  return Number.isNaN(parsed) ? null : parsed
}

export function isToday(ms: number, now = new Date()): boolean {
  const date = new Date(ms)

  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
}

export function formatHourMinute(ms: number): string {
  const date = new Date(ms)

  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
