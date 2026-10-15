import { useStore } from '@nanostores/react'
import { IconX } from '@tabler/icons-react'
import { Dot } from '../components/ui/primitives.tsx'
import { $toasts, activateDesktopNotification, dismissNotification, dismissToast, type HermesNotification, type NotificationLevel } from '../store/notifications.ts'
import { runCommand } from '../store/os-commands.ts'
import { showSurface } from '../store/surface.ts'

const TONE: Record<NotificationLevel, 'info' | 'ok' | 'warn' | 'danger'> = { info: 'info', success: 'ok', warn: 'warn', error: 'danger' }

export function Toasts() {
  const toasts = useStore($toasts)

  if (toasts.length === 0) {
    return null
  }

  const open = (toast: HermesNotification) => {
    if (toast.desktop) {
      activateDesktopNotification(toast, 'default')

      return
    }

    if (toast.surface) {
      showSurface(toast.surface)
    }

    dismissToast(toast.id)
  }

  // Closing a desktop notification's toast tells the sender; closing our own just hides the toast.
  const close = (toast: HermesNotification) => (toast.desktop ? dismissNotification(toast.id) : dismissToast(toast.id))

  return (
    <div className="pointer-events-none absolute top-11 right-3 z-(--z-overlay) flex w-80 flex-col gap-2">
      {toasts.map(toast => (
        <div key={toast.id} className="float pointer-events-auto flex items-start gap-2.5 rounded-xl px-3 py-2.5 animate-rise">
          <Dot tone={TONE[toast.level]} className="mt-1.5" />
          <div className="min-w-0 flex-1">
            <button type="button" className="w-full min-w-0 text-left" onClick={() => open(toast)}>
              <div className="truncate text-[12.5px] font-medium text-fg">{toast.title}</div>
              {toast.subtitle && <div className="truncate text-[11px] text-fg-4">{toast.subtitle}</div>}
              {toast.body && <div className="mt-0.5 text-[12px] break-words text-fg-2">{toast.body}</div>}
            </button>
            {toast.desktop && toast.desktop.actions.length > 0 && <DesktopActions item={toast} />}
            {toast.actions && <CommandActions item={toast} />}
          </div>
          <button type="button" aria-label="Dismiss" onClick={() => close(toast)} className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-xs text-fg-3 hover:text-fg">
            <IconX size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

/** Buttons on Herald OS's own notifications: each runs its OS command, then the notification goes. */
export function CommandActions({ item, className }: { item: HermesNotification; className?: string }) {
  const actions = item.actions ?? []

  if (actions.length === 0) {
    return null
  }

  return (
    <div className={className ?? 'mt-2 flex flex-wrap gap-1.5'}>
      {actions.map(action => (
        <button
          key={`${action.command}:${action.label}`}
          type="button"
          onClick={event => {
            event.stopPropagation()
            dismissNotification(item.id)
            void runCommand(action.command, action.args, { source: 'ui' })
          }}
          className="h-6 rounded-md border border-line bg-white/6 px-2 text-[11.5px] text-fg-2 hover:bg-white/10 hover:text-fg"
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}

/** The buttons another app attached to its notification; each reports its key back through D-Bus. */
export function DesktopActions({ item, className }: { item: HermesNotification; className?: string }) {
  const actions = item.desktop?.actions ?? []

  if (actions.length === 0) {
    return null
  }

  return (
    <div className={className ?? 'mt-2 flex flex-wrap gap-1.5'}>
      {actions.map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={event => {
            event.stopPropagation()
            activateDesktopNotification(item, key)
          }}
          className="h-6 rounded-md border border-line bg-white/6 px-2 text-[11.5px] text-fg-2 hover:bg-white/10 hover:text-fg"
        >
          {label || key}
        </button>
      ))}
    </div>
  )
}
