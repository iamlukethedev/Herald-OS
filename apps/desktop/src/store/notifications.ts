import { atom } from 'nanostores'
import type { IncomingNotification } from '../../shared/ipc.ts'
import { logFailure } from '../lib/report.ts'
import type { SurfaceId } from './surface.ts'
import { $prefs, $windowState } from './backend.ts'
import { onGatewayEvent } from './gateway.ts'

export type NotificationLevel = 'info' | 'success' | 'warn' | 'error'

/** A notification another application sent through the freedesktop D-Bus service (panels mode). */
export interface DesktopNotificationRef {
  id: number
  appName: string
  /** Pairs of [actionKey, label] the app offered. */
  actions: Array<[string, string]>
}

/** A button on one of Herald OS's own notifications: an OS command, so it survives being saved. */
export interface NotificationAction {
  label: string
  command: string
  args?: Record<string, unknown>
}

export interface HermesNotification {
  id: string
  title: string
  body?: string
  /** Small secondary line under the title (the sending app's name for desktop notifications). */
  subtitle?: string
  level: NotificationLevel
  ts: number
  read: boolean
  surface?: SurfaceId
  /** Stable key for sticky notifications the backend clears explicitly. */
  key?: string
  /** Set when this came from another app; clicks and dismissals are reported back to it. */
  desktop?: DesktopNotificationRef
  actions?: NotificationAction[]
}

export const $notifications = atom<HermesNotification[]>([])
export const $notificationsOpen = atom(false)
/** Transient toasts: the most recent unread notifications, shown for a few seconds. */
export const $toasts = atom<HermesNotification[]>([])

const MAX = 200
let counter = 0

export interface NotifyInput {
  title: string
  body?: string
  subtitle?: string
  level?: NotificationLevel
  surface?: SurfaceId
  key?: string
  /** Also raise a native notification when the window is unfocused. */
  native?: boolean
  toast?: boolean
  desktop?: DesktopNotificationRef
  actions?: NotificationAction[]
}

export function notify(input: NotifyInput): HermesNotification {
  const existing = input.key ? $notifications.get().find(n => n.key === input.key) : undefined
  const item: HermesNotification = {
    id: existing?.id ?? `n${Date.now().toString(36)}${(counter++).toString(36)}`,
    title: input.title,
    body: input.body,
    subtitle: input.subtitle,
    level: input.level ?? 'info',
    ts: Date.now(),
    read: false,
    surface: input.surface,
    key: input.key,
    desktop: input.desktop,
    actions: input.actions?.length ? input.actions : undefined
  }
  const rest = $notifications.get().filter(n => n.id !== item.id)
  $notifications.set([item, ...rest].slice(0, MAX))
  // Do not disturb: the bell still collects everything, nothing pops up or makes a sound.
  const quiet = Boolean($prefs.get().doNotDisturb)

  if (input.toast !== false && !quiet) {
    $toasts.set([item, ...$toasts.get().filter(t => t.id !== item.id)].slice(0, 3))
    setTimeout(() => $toasts.set($toasts.get().filter(t => t.id !== item.id)), 6000)
  }

  if (input.native && !quiet && !$windowState.get().focused) {
    void window.heraldOS.notifications.native(item.title, item.body ?? '').catch(logFailure('notifications.native'))
  }

  return item
}

let historyBound = false

/**
 * Keep the notification list across restarts (the Hermes window only): load the last week once,
 * then save after every change. Other apps' notifications come back as plain entries, since the
 * app that sent them can no longer be told what was clicked.
 */
export function bindNotificationHistory(): () => void {
  const history = window.heraldOS?.notificationHistory

  if (historyBound || !history) {
    return () => undefined
  }

  historyBound = true
  let ready = false
  let timer: ReturnType<typeof setTimeout> | null = null

  void history
    .load()
    .then(saved => {
      const known = new Set($notifications.get().map(n => n.id))
      const restored = (saved as HermesNotification[]).filter(n => !known.has(n.id)).map(n => ({ ...n, read: true, desktop: undefined }))
      $notifications.set([...$notifications.get(), ...restored].sort((a, b) => b.ts - a.ts).slice(0, MAX))
    })
    .catch(() => undefined)
    .finally(() => {
      ready = true
    })

  const off = $notifications.listen(items => {
    if (!ready) {
      return
    }

    if (timer) {
      clearTimeout(timer)
    }

    timer = setTimeout(() => void history.save(items.map(({ desktop: _desktop, ...item }) => item)).catch(() => undefined), 800)
  })

  return () => {
    off()
    historyBound = false
  }
}

export function dismissToast(id: string): void {
  $toasts.set($toasts.get().filter(t => t.id !== id))
}

export function markAllRead(): void {
  $notifications.set($notifications.get().map(n => (n.read ? n : { ...n, read: true })))
}

export function clearNotifications(): void {
  // Other apps learn their notification went away when the list is cleared.
  for (const item of $notifications.get()) {
    if (item.desktop) {
      reportDesktopAction(item.desktop, 'dismissed')
    }
  }

  $notifications.set([])
}

/** Remove one notification from the panel (and its toast); desktop ones tell the sender it was dismissed. */
export function dismissNotification(id: string): void {
  const item = $notifications.get().find(n => n.id === id)

  if (item?.desktop) {
    reportDesktopAction(item.desktop, 'dismissed')
  }

  $notifications.set($notifications.get().filter(n => n.id !== id))
  dismissToast(id)
}

/** Tell the sending app which action (or 'default' for a click, 'dismissed' for close) the user chose. */
export function reportDesktopAction(ref: DesktopNotificationRef, actionKey: string): void {
  window.heraldOS?.desktopNotifications?.action(ref.id, actionKey).catch(() => undefined)
}

/** The user activated a desktop notification: report the chosen key and drop it from the list. */
export function activateDesktopNotification(item: HermesNotification, actionKey = 'default'): void {
  if (item.desktop) {
    reportDesktopAction(item.desktop, actionKey)
  }

  $notifications.set($notifications.get().filter(n => n.id !== item.id))
  dismissToast(item.id)
}

const urgencyLevel = (urgency: IncomingNotification['urgency']): NotificationLevel => (urgency === 'critical' ? 'error' : 'info')

/** Push a notification another application sent (panels mode) into the shell's list and toasts. */
export function notifyFromDesktop(incoming: IncomingNotification): HermesNotification {
  const title = incoming.summary.trim() || incoming.appName.trim() || 'Notification'
  const body = incoming.body.trim() || undefined
  // Same app re-sending the same id replaces the earlier entry instead of stacking.
  const key = `desktop:${incoming.id}`

  return notify({
    title,
    body,
    subtitle: incoming.appName.trim() && incoming.appName.trim() !== title ? incoming.appName.trim() : undefined,
    level: urgencyLevel(incoming.urgency),
    key,
    // Low urgency stays in the panel without interrupting.
    toast: incoming.urgency !== 'low',
    desktop: { id: incoming.id, appName: incoming.appName, actions: incoming.actions.filter(([actionKey]) => actionKey !== 'default') }
  })
}

/** Subscribe to desktop notifications when the bridge offers them (panels mode); no-op elsewhere. */
export function bindDesktopNotifications(): () => void {
  const bridge = window.heraldOS?.desktopNotifications

  if (!bridge || typeof bridge.onIncoming !== 'function') {
    return () => undefined
  }

  return bridge.onIncoming(incoming => {
    notifyFromDesktop(incoming)
  })
}

const levelFrom = (value: string | undefined): NotificationLevel =>
  value === 'error' ? 'error' : value === 'warn' || value === 'warning' ? 'warn' : value === 'success' ? 'success' : 'info'

export function bindNotificationEvents(): () => void {
  const offShow = onGatewayEvent('notification.show', event => {
    const payload = event.payload

    if (!payload?.text) {
      return
    }

    notify({ title: 'Hermes', body: payload.text, level: levelFrom(payload.level), key: payload.key ?? undefined, surface: 'chat' })
  })
  const offClear = onGatewayEvent('notification.clear', event => {
    const key = event.payload?.key

    if (key) {
      $notifications.set($notifications.get().filter(n => n.key !== key))
    }
  })
  const offCron = onGatewayEvent('cron.changed', () => {
    notify({ title: 'Tasks updated', body: 'A scheduled task changed', level: 'info', surface: 'tasks', key: 'cron.changed', toast: false })
  })

  return () => {
    offShow()
    offClear()
    offCron()
  }
}
