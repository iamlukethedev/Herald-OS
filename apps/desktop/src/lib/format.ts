import { $locale, t } from '../store/i18n.ts'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—'
  }

  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }

  return `${value.toFixed(unit === 0 ? 0 : digits)} ${UNITS[unit]}`
}

export function formatPercent(value: number, digits = 0): string {
  return `${value.toFixed(digits)}%`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return '—'
  }

  if (seconds < 1) {
    return `${Math.round(seconds * 1000)} ms`
  }

  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  }

  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    return `${days}d ${hours % 24}h`
  }

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`
  }

  return `${minutes}m ${Math.round(seconds % 60)}s`
}

export function formatRelative(epochMsOrSeconds: number | undefined | null): string {
  if (!epochMsOrSeconds) {
    return ''
  }

  const ms = epochMsOrSeconds < 1e12 ? epochMsOrSeconds * 1000 : epochMsOrSeconds
  const delta = Date.now() - ms
  const minutes = Math.round(delta / 60_000)

  if (minutes < 1) {
    return t('time.justNow')
  }

  if (minutes < 60) {
    return t('time.minutesAgo', { count: minutes })
  }

  const hours = Math.round(minutes / 60)

  if (hours < 24) {
    return t('time.hoursAgo', { count: hours })
  }

  const days = Math.round(hours / 24)

  if (days < 7) {
    return t('time.daysAgo', { count: days })
  }

  return new Date(ms).toLocaleDateString($locale.get(), { month: 'short', day: 'numeric' })
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString($locale.get(), { hour: '2-digit', minute: '2-digit' })
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString($locale.get(), { weekday: 'long', month: 'long', day: 'numeric' })
}

export function formatSpan(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return ''
  }

  if (minutes < 60) {
    return t('time.minutes', { minutes: Math.round(minutes) })
  }

  const hours = Math.floor(minutes / 60)
  const rest = Math.round(minutes % 60)

  return rest === 0 ? t('time.hours', { hours }) : t('time.hoursMinutes', { hours, minutes: rest })
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function greetingFor(date: Date): string {
  const hour = date.getHours()

  if (hour < 5) {
    return t('overview.greeting.night')
  }

  if (hour < 12) {
    return t('overview.greeting.morning')
  }

  if (hour < 18) {
    return t('overview.greeting.afternoon')
  }

  return t('overview.greeting.evening')
}
