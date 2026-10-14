import { useStore } from '@nanostores/react'
import { IconCheck, IconChevronDown, IconRefresh } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { WmWorkspace } from '../../../shared/ipc.ts'
import { HeraldLogo } from '../../components/herald-logo.tsx'
import { cn } from '../../lib/cn.ts'
import { useT } from '../../store/i18n.ts'
import { $wm, onShellCommand, openSurface, relayToMain, wmAction } from '../../store/shell.ts'
import { $activeSpace, $spaces, setActiveSpace, spaceLabel } from '../../store/spaces.ts'
import { BackendBadge, MenuBarStatus } from '../MenuBar.tsx'
import { OUR_MAIN_TITLE, windowLabel } from './shell-utils.ts'

/**
 * Panels mode: the 30px bar is its own transparent window along the top edge (niri reserves the
 * strip). Left: brand and the compositor's focused window. Centre: Spaces, which are niri's named
 * workspaces. Right: the shared status cluster; the bell and search ask other surfaces to act.
 */
export function MenuBarSurface() {
  const wm = useStore($wm)

  const focused = wm.windows.find(w => w.id === wm.focusedWindowId)
  // Our own Hermes window is the brand itself; other shell windows (dock, overlay) are not a "title".
  const title = focused ? (focused.ours ? (focused.title === OUR_MAIN_TITLE ? 'Hermes' : null) : windowLabel(focused)) : null

  return (
    <header className="flex h-full w-full items-center justify-between px-3 text-[12.5px] text-fg select-none" style={{ background: 'linear-gradient(180deg, var(--menubar-from, rgba(3,10,40,.72)), var(--menubar-to, rgba(3,10,40,.42)))' }}>
      <div className="flex min-w-0 items-center gap-2.5">
        <HeraldLogo height={12} />
        <span className="font-semibold">Herald OS</span>
        {title && (
          <>
            <span className="text-fg-4">·</span>
            <span className="max-w-[40vw] truncate text-fg-2">{title}</span>
          </>
        )}
        <BackendBadge />
      </div>

      <SpacesSwitcher workspaces={wm.workspaces} available={wm.available} />

      <div className="flex items-center gap-3.5">
        <UpdateIndicator />
        <MenuBarStatus onSearch={() => openSurface('command', { type: 'command' })} onBell={openNotifications} />
      </div>
    </header>
  )
}

function openNotifications(): void {
  relayToMain({ type: 'notifications' })
  // Raise the Hermes window so the panel is actually visible.
  openSurface('main')
}

const UPDATE_KEY = 'herald-os.update-available'

interface UpdateAvailable {
  /** What is pending, e.g. "Herald OS, 192 packages, 3 apps". */
  summary: string
  checkedAt: number
}

/** `{ summary, checkedAt }` while the last update check found something pending; absent means up to date. */
function readUpdateAvailable(): UpdateAvailable | null {
  try {
    const raw = localStorage.getItem(UPDATE_KEY)

    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as Partial<UpdateAvailable> | null

    return parsed && typeof parsed.summary === 'string' && parsed.summary ? { summary: parsed.summary, checkedAt: Number(parsed.checkedAt) || 0 } : null
  } catch {
    return null
  }
}

/** A circular-arrows glyph with an accent dot while an update is pending; clicking runs `herald-os update` through the control menu. */
function UpdateIndicator() {
  const t = useT()
  const [update, setUpdate] = useState<UpdateAvailable | null>(() => readUpdateAvailable())

  useEffect(() => {
    const refresh = () => setUpdate(readUpdateAvailable())
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === UPDATE_KEY) {
        refresh()
      }
    }
    // Other windows fire `storage`; the same window (or a non-DOM writer) is covered by a slow poll.
    window.addEventListener('storage', onStorage)
    const timer = window.setInterval(refresh, 60_000)
    // `herald-os-update --check` reports through the control socket: [pendingCount, summary].
    const offCommand = onShellCommand(command => {
      if (command.type !== 'update-available') {
        return
      }

      const pending = Number(command.args?.[0] ?? 0)

      if (pending > 0) {
        localStorage.setItem(UPDATE_KEY, JSON.stringify({ summary: command.args?.[1] || t('menuBar.updates', { count: pending }), checkedAt: Date.now() }))
      } else {
        localStorage.removeItem(UPDATE_KEY)
      }

      refresh()
    })

    return () => {
      window.removeEventListener('storage', onStorage)
      window.clearInterval(timer)
      offCommand()
    }
  }, [])

  if (!update) {
    return null
  }

  return (
    <button
      type="button"
      aria-label={t('menuBar.updatesAvailable', { summary: update.summary })}
      title={t('menuBar.updatesAvailable', { summary: update.summary })}
      onClick={() => openSurface('command', { type: 'menu', args: ['update-herald-os'] })}
      className="relative flex size-6 items-center justify-center rounded-md hover:bg-white/10"
    >
      <IconRefresh size={15} />
      <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-accent-strong" />
    </button>
  )
}

const capitalize = (value: string) => (value ? value[0].toUpperCase() + value.slice(1) : value)

/**
 * Spaces are niri workspaces. Named ones map onto the Spaces store by id (personal/work/ideas) so the
 * sidebar and session filters follow the compositor; unnamed ones show their index.
 */
function SpacesSwitcher({ workspaces, available }: { workspaces: WmWorkspace[]; available: boolean }) {
  const t = useT()
  const spaces = useStore($spaces)
  const activeSpace = useStore($activeSpace)
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const ordered = useMemo(() => [...workspaces].filter(ws => ws.name || ws.active).sort((a, b) => a.idx - b.idx), [workspaces])
  const focused = ordered.find(ws => ws.focused) ?? workspaces.find(ws => ws.focused)

  // Keep the Spaces store in step with the compositor: a focused named workspace becomes the active space.
  useEffect(() => {
    const name = focused?.name

    if (name && name !== activeSpace?.id && spaces.some(s => s.id === name)) {
      setActiveSpace(name)
    }
  }, [focused?.name, activeSpace?.id, spaces])

  useEffect(() => {
    if (!menu) {
      return
    }

    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenu(false)
      }
    }
    window.addEventListener('mousedown', onDown)

    return () => window.removeEventListener('mousedown', onDown)
  }, [menu])

  const colorFor = (ws: WmWorkspace) => spaces.find(s => s.id === ws.name)?.color ?? 'var(--color-accent-strong)'
  const labelFor = (ws: WmWorkspace) => {
    const space = spaces.find(s => s.id === ws.name)

    return space ? spaceLabel(space) : ws.name ? capitalize(ws.name) : t('space.numbered', { index: ws.idx })
  }

  const focusWorkspace = (ws: WmWorkspace) => {
    void wmAction({ type: 'focus-workspace', ref: ws.name ?? ws.idx })
    setMenu(false)
  }

  // Without a compositor (or before its first state), fall back to the preference-backed Spaces.
  if (!available || ordered.length === 0) {
    return (
      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={() => setMenu(v => !v)}
          className="flex h-6 items-center gap-1.5 rounded-full border border-line-strong bg-accent/35 px-3 text-[12px] font-medium text-fg shadow-[0_2px_10px_rgba(47,125,255,.35)] hover:bg-accent/50"
        >
          <span className="size-1.5 rounded-full" style={{ background: activeSpace?.color }} />
          {activeSpace ? spaceLabel(activeSpace) : t('space.personal')}
          <IconChevronDown size={13} className="text-fg-2" />
        </button>
        {menu && (
          <div className="float absolute top-8 left-1/2 w-48 -translate-x-1/2 overflow-hidden rounded-xl p-1 animate-pop">
            {spaces.map(s => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setActiveSpace(s.id)
                  setMenu(false)
                }}
                className={cn('flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] hover:bg-white/8', s.id === activeSpace?.id ? 'text-fg' : 'text-fg-2')}
              >
                <span className="size-2 rounded-full" style={{ background: s.color }} />
                <span className="flex-1 text-left">{spaceLabel(s)}</span>
                {s.id === activeSpace?.id && <IconCheck size={14} className="text-accent-strong" />}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-6 items-center gap-0.5 rounded-full border border-line-strong bg-accent/25 p-0.5 shadow-[0_2px_10px_rgba(47,125,255,.3)]" role="tablist" aria-label={t('menuBar.spaces')}>
      {ordered.map(ws => {
        const active = ws.focused

        return (
          <button
            key={ws.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => focusWorkspace(ws)}
            className={cn('flex h-5 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-colors duration-150', active ? 'bg-accent text-accent-fg shadow-[0_2px_10px_rgba(47,125,255,.45)]' : 'text-fg-2 hover:bg-white/10 hover:text-fg')}
          >
            <span className="size-1.5 rounded-full" style={{ background: active ? 'var(--color-fg)' : colorFor(ws) }} />
            {labelFor(ws)}
          </button>
        )
      })}
    </div>
  )
}
