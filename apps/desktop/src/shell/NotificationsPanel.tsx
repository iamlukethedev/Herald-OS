import { useStore } from '@nanostores/react'
import { IconBellOff, IconX } from '@tabler/icons-react'
import { useEffect } from 'react'
import { Button } from '../components/ui/button.tsx'
import { Dot, EmptyState } from '../components/ui/primitives.tsx'
import { formatRelative } from '../lib/format.ts'
import { useT } from '../store/i18n.ts'
import { $notifications, $notificationsOpen, activateDesktopNotification, clearNotifications, dismissNotification, type HermesNotification, markAllRead, type NotificationLevel } from '../store/notifications.ts'
import { showSurface } from '../store/surface.ts'
import { CommandActions, DesktopActions } from './Toasts.tsx'

const TONE: Record<NotificationLevel, 'info' | 'ok' | 'warn' | 'danger'> = { info: 'info', success: 'ok', warn: 'warn', error: 'danger' }

export function NotificationsPanel() {
  const t = useT()
  const open = useStore($notificationsOpen)
  const items = useStore($notifications)

  useEffect(() => {
    if (!open) {
      return
    }

    markAllRead()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        $notificationsOpen.set(false)
      }
    }
    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) {
    return null
  }

  const activate = (item: HermesNotification) => {
    if (item.desktop) {
      activateDesktopNotification(item, 'default')

      return
    }

    if (item.surface) {
      showSurface(item.surface)
      $notificationsOpen.set(false)
    }
  }

  return (
    <>
      <button type="button" aria-label={t('notifications.close')} className="absolute inset-0 z-(--z-panel)" onClick={() => $notificationsOpen.set(false)} />
      <aside className="float absolute top-10 right-3 z-(--z-overlay) flex h-[min(70vh,640px)] w-[360px] flex-col rounded-2xl animate-rise">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="text-[13px] font-medium">{t('notifications.title')}</div>
          <Button variant="ghost" size="sm" onClick={clearNotifications} disabled={items.length === 0}>
            {t('notifications.clearAll')}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {items.length === 0 ? (
            <EmptyState icon={<IconBellOff />} title={t('notifications.emptyTitle')} description={t('notifications.emptyHint')} />
          ) : (
            items.map(item => (
              <div key={item.id} className="group flex w-full items-start gap-2.5 rounded-md px-2 py-2 hover:bg-white/5">
                <Dot tone={TONE[item.level]} className="mt-1.5" />
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => activate(item)} className="w-full min-w-0 text-left">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[12.5px] text-fg">{item.title}</span>
                      <span className="shrink-0 text-[11px] text-fg-4">{formatRelative(item.ts)}</span>
                    </div>
                    {item.subtitle && <div className="truncate text-[11px] text-fg-4">{item.subtitle}</div>}
                    {item.body && <div className="mt-0.5 line-clamp-3 text-[12px] text-fg-3">{item.body}</div>}
                  </button>
                  {item.desktop && item.desktop.actions.length > 0 && <DesktopActions item={item} />}
                  {item.actions && <CommandActions item={item} />}
                </div>
                {item.desktop && (
                  <button
                    type="button"
                    aria-label={t('notifications.dismiss')}
                    onClick={() => dismissNotification(item.id)}
                    className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-xs text-fg-4 opacity-0 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
                  >
                    <IconX size={13} />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </aside>
    </>
  )
}
