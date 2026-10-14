import { IconX } from '@tabler/icons-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WmWindow } from '../../../shared/ipc.ts'
import { cn } from '../../lib/cn.ts'
import { mirrorStyles } from '../../lib/mirror-styles.ts'
import { wmAction } from '../../store/shell.ts'
import { DOCK_MENU_PAD, nextItem } from './dock-menu.ts'
import { windowLabel } from './shell-utils.ts'

interface MenuItem {
  key: string
  label: string
  /** A window's row; the others are Close and Close all. */
  window?: WmWindow
  select: () => void
}

/**
 * The Dock's menu for a running app, drawn into the window the Dock opened for it (`win`): an empty
 * page holding copies of the Dock's style sheets. Nothing shows there until main has moved that window
 * over the icon (`placed`). Its keys work from the Dock's window, which keeps them as the menu opens,
 * and from the menu's own, which niri gives them when the pointer moves onto it.
 */
export function DockMenu({ win, placed, label, windows, listHeight, onClose }: { win: Window; placed: boolean; label: string; windows: WmWindow[]; listHeight: number; onClose: () => void }) {
  const [page, setPage] = useState(() => win.document)
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const [active, setActive] = useState(-1)
  const onKey = useRef<(event: KeyboardEvent) => void>(() => undefined)

  useLayoutEffect(() => {
    const stop = mirrorStyles(document, page)
    page.body.style.cssText = 'margin: 0; background: transparent; overflow: hidden;'
    const element = page.createElement('div')
    page.body.append(element)
    setRoot(element)

    return () => {
      stop()
      element.remove()
      setRoot(null)
    }
  }, [page])

  // Chromium may replace a new window's empty page; the menu then goes into the new one.
  useEffect(() => {
    const poll = window.setInterval(() => {
      if (!win.closed && win.document !== page) {
        setPage(win.document)
      }
    }, 400)

    return () => window.clearInterval(poll)
  }, [win, page])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey.current(event)
    const own = page.defaultView
    window.addEventListener('keydown', listener, true)
    own?.addEventListener('keydown', listener, true)

    return () => {
      window.removeEventListener('keydown', listener, true)
      own?.removeEventListener('keydown', listener, true)
    }
  }, [page])

  const choose = (action: () => void) => () => {
    action()
    onClose()
  }
  const target = windows.find(w => w.focused) ?? windows[0]
  const items: MenuItem[] = [
    ...windows.map(w => ({ key: `window:${w.id}`, label: windowLabel(w), window: w, select: choose(() => void wmAction({ type: 'focus-window', id: w.id })) })),
    { key: 'close', label: 'Close', select: choose(() => void (target && wmAction({ type: 'close-window', id: target.id }))) },
    ...(windows.length > 1 ? [{ key: 'close-all', label: 'Close all', select: choose(() => windows.forEach(w => void wmAction({ type: 'close-window', id: w.id }))) }] : [])
  ]
  const highlighted = active < items.length ? active : -1

  onKey.current = event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()

      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      items[highlighted]?.select()

      return
    }

    const next = nextItem(highlighted, items.length, event.key)

    if (next !== null) {
      event.preventDefault()
      setActive(next)
    }
  }

  useEffect(() => {
    root?.querySelector(`[data-item="${highlighted}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [root, highlighted])

  if (!root || !placed) {
    return null
  }

  const row = (item: MenuItem, index: number) => (
    <button
      key={item.key}
      type="button"
      role="menuitem"
      data-item={index}
      onClick={item.select}
      onMouseEnter={() => setActive(index)}
      className={cn('flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[12.5px]', index === highlighted && 'bg-white/8', index === highlighted || item.window?.focused ? 'text-fg' : 'text-fg-2')}
    >
      {item.window ? (
        <>
          <span className={cn('size-1.5 shrink-0 rounded-full', item.window.focused ? 'bg-accent-strong' : 'bg-fg-4')} />
          <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
        </>
      ) : (
        <>
          <IconX size={14} className="text-fg-3" />
          <span className="flex-1 text-left">{item.label}</span>
        </>
      )}
    </button>
  )

  return createPortal(
    <div className="fixed inset-0 flex items-end justify-center" style={{ padding: DOCK_MENU_PAD }} onMouseDown={onClose}>
      <div role="menu" aria-label={`${label} windows`} className="float dock-menu w-60 overflow-hidden rounded-xl p-1 animate-pop" onMouseDown={event => event.stopPropagation()} onMouseLeave={() => setActive(-1)}>
        <div className="overflow-y-auto" style={{ maxHeight: listHeight }}>
          {items.slice(0, windows.length).map(row)}
        </div>
        <div className="my-1 h-px bg-line" />
        {items.slice(windows.length).map((item, index) => row(item, windows.length + index))}
      </div>
    </div>,
    root
  )
}
