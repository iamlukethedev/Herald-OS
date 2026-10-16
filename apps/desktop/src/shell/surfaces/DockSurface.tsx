import { useStore } from '@nanostores/react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InstalledApp, ShellCommand, WmWindow } from '../../../shared/ipc.ts'
import { AppGlyph, AppTile, HermesAvatar } from '../../components/app-icon.tsx'
import { openInCanvas } from '../../features/canvas/open.ts'
import { cn } from '../../lib/cn.ts'
import { $env } from '../../store/backend.ts'
import { useNativeApps } from '../../store/native-apps.ts'
import { notify } from '../../store/notifications.ts'
import { $wm, openSurface, wmAction } from '../../store/shell.ts'
import { openApp, showPage } from '../../store/windows.ts'
import { appById, distinctAppLabel, type FloatingAppId } from '../apps.ts'
import { isOfficeApp, NativeIcon, pinnedFor, useDockMagnification } from '../Dock.tsx'
import { DOCK_MENU_NAME, dockMenuFeatures, dockMenuPlacement, dockRect, menuLosesKeys } from './dock-menu.ts'
import { DockMenu } from './DockMenu.tsx'
import { OUR_MAIN_TITLE, ourFloatingAppId, useShellCommands, windowLabel } from './shell-utils.ts'

/** The dock window is 720 x 84; a gentler magnification keeps swollen icons inside it. */
const PANELS_MAGNIFY_MAX = 0.28
/** Icons are 44px + 8px gap; this many fit in the fixed-width window with the fixed entries. */
const MAX_ITEMS = 13
/** How long a menu waits for main to say its window is over the icon before it shows wherever the window is. */
const PLACE_TIMEOUT_MS = 1500
/** How often an open menu checks whether its window was closed from outside (niri's close-window). */
const CLOSED_POLL_MS = 400

interface DockMenuState {
  /** The entry whose windows it lists. */
  id: string
  /** The name its window opened under, which main sends back once the window is in place. */
  name: string
  win: Window
  listHeight: number
  /** Main has moved the window over the icon; nothing is drawn in it before. */
  placed: boolean
}

let menusOpened = 0

interface DockEntry {
  id: string
  label: string
  render: () => ReactNode
  onClick: () => void
  running?: boolean
  /** Compositor windows behind this entry (running apps); enables cycling, middle-click close and the context menu. */
  windows?: WmWindow[]
}

/** Match a compositor app id (the .desktop id) to an installed app: by desktop id, then by name. */
function appForWindow(apps: readonly InstalledApp[], appId: string): InstalledApp | undefined {
  const needle = appId.toLowerCase()

  if (!needle) {
    return undefined
  }

  return (
    apps.find(app => (app.bundleId ?? '').toLowerCase() === needle) ??
    apps.find(app => app.name.toLowerCase() === needle) ??
    apps.find(app => (app.bundleId ?? '').toLowerCase().endsWith(`.${needle}`)) ??
    apps.find(app => (app.bundleId ?? '').toLowerCase().split('.').pop() === needle.split('.').pop())
  )
}

function LetterTile({ label }: { label: string }) {
  return <span className="icon-tile size-11 rounded-[11px] text-[19px] font-semibold">{(label.trim()[0] ?? '?').toUpperCase()}</span>
}

/** Prefer the group's focused window; otherwise the one after the last focused one, so repeated clicks cycle. */
function nextWindow(windows: WmWindow[], lastId: number | undefined): WmWindow {
  const focusedIndex = windows.findIndex(w => w.focused)

  if (focusedIndex >= 0) {
    return windows[(focusedIndex + 1) % windows.length]
  }

  const lastIndex = windows.findIndex(w => w.id === lastId)

  return windows[lastIndex >= 0 ? (lastIndex + 1) % windows.length : 0]
}

/**
 * Panels mode: the Dock is a transparent 720 x 84 window niri keeps along the bottom edge (a strut
 * reserves the space, so there is no auto-hide). Besides the pinned entries it shows every running
 * compositor window grouped by app; clicking focuses (and cycles), middle-click closes, and a
 * right-click lists the windows, with Close and Close all, in a menu of its own above the Dock
 * (DockMenu.tsx).
 */
export function DockSurface() {
  const wm = useStore($wm)
  const { apps, iconFor } = useNativeApps()
  const platform = useStore($env)?.platform ?? 'linux'
  const [bouncing, setBouncing] = useState<string | null>(null)
  const [menu, setMenu] = useState<DockMenuState | null>(null)
  const menuRef = useRef<DockMenuState | null>(null)
  menuRef.current = menu
  /** The window that last had the keys while a menu was open. */
  const keysWith = useRef<number | null>(null)
  const lastFocused = useRef<Record<string, number>>({})
  const barRef = useRef<HTMLDivElement>(null)
  const { onMove, onLeave } = useDockMagnification(barRef, PANELS_MAGNIFY_MAX)
  const trashPath = platform === 'darwin' ? '~/.Trash' : '~/.local/share/Trash/files'

  const closeMenu = useCallback(() => {
    const open = menuRef.current

    if (open && !open.win.closed) {
      open.win.close()
    }

    menuRef.current = null
    setMenu(null)
  }, [])

  const openMenu = (entry: DockEntry, icon: DOMRect) => {
    closeMenu()
    const state = $wm.get()
    const screen = { width: window.screen.width, height: window.screen.height }
    const placement = dockMenuPlacement({
      iconX: icon.left + icon.width / 2,
      barTop: barRef.current?.getBoundingClientRect().top ?? 0,
      dock: dockRect(state, { width: window.innerWidth, height: window.innerHeight }, screen),
      screen,
      count: entry.windows?.length ?? 0
    })
    const name = `${DOCK_MENU_NAME}-${++menusOpened}`
    const win = window.open('about:blank', name, dockMenuFeatures(placement.window))

    if (!win) {
      return
    }

    // The button the right-click focused would take Enter and Space from the menu.
    const focused = document.activeElement

    if (focused instanceof HTMLElement) {
      focused.blur()
    }

    keysWith.current = state.focusedWindowId
    menuRef.current = { id: entry.id, name, win, listHeight: placement.listHeight, placed: false }
    setMenu(menuRef.current)
  }

  useShellCommands((command: ShellCommand) => {
    const name = command.args?.[0]

    if (command.type === 'dock-menu-placed' && name && name === menuRef.current?.name) {
      setMenu(open => (open?.name === name ? { ...open, placed: true } : open))
    }
  })

  useEffect(() => {
    if (!menu || menu.placed) {
      return
    }

    const { name } = menu
    const timer = window.setTimeout(() => setMenu(open => (open?.name === name ? { ...open, placed: true } : open)), PLACE_TIMEOUT_MS)

    return () => window.clearTimeout(timer)
  }, [menu])

  const menuWindow = menu?.win ?? null

  // A right-click on an icon is left to onContextMenu, which opens that icon's menu or closes its own.
  useEffect(() => {
    if (!menuWindow) {
      return
    }

    const onDown = (event: MouseEvent) => {
      if (event.button !== 2 || !(event.target instanceof Element && event.target.closest('.dock-item'))) {
        closeMenu()
      }
    }
    const check = () => {
      if (menuWindow.closed && menuRef.current?.win === menuWindow) {
        menuRef.current = null
        setMenu(null)
      }
    }
    const onHide = () => window.setTimeout(check, 50)
    const poll = window.setInterval(check, CLOSED_POLL_MS)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('pagehide', closeMenu)
    menuWindow.addEventListener('pagehide', onHide)

    return () => {
      window.clearInterval(poll)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('pagehide', closeMenu)
      menuWindow.removeEventListener('pagehide', onHide)
    }
  }, [menuWindow, closeMenu])

  useEffect(() => {
    if (!menu) {
      return
    }

    if (menuLosesKeys(keysWith.current, wm)) {
      closeMenu()
    } else {
      keysWith.current = wm.focusedWindowId
    }
  }, [menu, wm, closeMenu])

  useEffect(() => closeMenu, [closeMenu])

  const launch = async (app: InstalledApp) => {
    setBouncing(app.path)
    setTimeout(() => setBouncing(null), 450)

    try {
      await window.heraldOS.apps.launch(app.path)
    } catch (error) {
      notify({ title: `Could not open ${app.name}`, body: error instanceof Error ? error.message : String(error), level: 'error' })
    }
  }

  const focusGroup = (id: string, windows: WmWindow[]) => {
    const target = nextWindow(windows, lastFocused.current[id])
    lastFocused.current[id] = target.id
    void wmAction({ type: 'focus-window', id: target.id })
  }

  const entries = useMemo<DockEntry[]>(() => {
    const ours = wm.windows.filter(w => w.ours)
    const foreign = wm.windows.filter(w => !w.ours)
    const mainRunning = ours.some(w => w.title === OUR_MAIN_TITLE)

    const list: DockEntry[] = [
      {
        id: 'hermes',
        label: 'Hermes',
        render: () => <HermesAvatar size={44} rounded={11} />,
        onClick: () => showPage('overview'),
        running: mainRunning
      }
    ]

    const findApp = (names: string[]) => names.map(n => apps.find(a => a.name.toLowerCase() === n.toLowerCase())).find(Boolean)
    const pinnedPaths = new Set<string>()

    for (const pin of pinnedFor(platform)) {
      if (pin.label === 'Files') {
        // Files is always Herald OS's own page, in Herald's own tile: a running file manager gets an entry
        // of its own here, and a borrowed icon would make the two look like the same app.
        list.push({ id: 'files', label: 'Files', render: () => <AppTile id="files" size={44} />, onClick: () => showPage('files') })

        continue
      }

      const app = findApp(pin.names)

      if (app) {
        pinnedPaths.add(app.path)
        // A pinned app that is running gets its windows attached so the entry focuses instead of relaunching.
        const windows = foreign.filter(w => appForWindow(apps, w.appId)?.path === app.path)
        list.push({
          id: app.path,
          label: app.name,
          render: () => <NativeIcon src={iconFor(app.path)} fallback="grid" />,
          onClick: () => (windows.length > 0 ? focusGroup(app.path, windows) : void launch(app)),
          running: windows.length > 0,
          windows
        })
      }
    }

    // Shortcuts beside the ones in Applications; an open Pet Room, Canvas or Calc window belongs to its shortcut rather than to an entry of its own.
    const roomWindows = ours.filter(w => ourFloatingAppId(w) === 'room')
    list.push({
      id: 'hermes:room',
      label: 'Pet Room',
      render: () => <AppTile id="room" size={44} />,
      onClick: () => (roomWindows.length > 0 ? focusGroup('hermes:room', roomWindows) : openApp('room')),
      running: roomWindows.length > 0,
      windows: roomWindows
    })

    const canvasWindows = ours.filter(w => ourFloatingAppId(w) === 'canvas')
    list.push({
      id: 'hermes:canvas',
      label: 'Herald Canvas',
      render: () => <AppTile id="canvas" size={44} />,
      onClick: () => (canvasWindows.length > 0 ? focusGroup('hermes:canvas', canvasWindows) : openInCanvas()),
      running: canvasWindows.length > 0,
      windows: canvasWindows
    })

    // Docs, Sheets and Slides share one entry, so three icons do not crowd the Dock; this window is too
    // short for a chooser, so with none open it opens Applications, where the three sit together.
    const officeWindows = ours.filter(w => isOfficeApp(ourFloatingAppId(w) ?? ''))
    list.push({
      id: 'hermes:office',
      label: 'Herald Office',
      render: () => <AppTile id="office" size={44} />,
      onClick: () => (officeWindows.length > 0 ? focusGroup('hermes:office', officeWindows) : void openSurface('command', { type: 'applications' })),
      running: officeWindows.length > 0,
      windows: officeWindows
    })

    const calcWindows = ours.filter(w => ourFloatingAppId(w) === 'calc')
    list.push({
      id: 'hermes:calc',
      label: 'Herald Calc',
      render: () => <AppTile id="calc" size={44} />,
      onClick: () => (calcWindows.length > 0 ? focusGroup('hermes:calc', calcWindows) : openApp('calc')),
      running: calcWindows.length > 0,
      windows: calcWindows
    })

    // Our own floating Hermes apps (terminal, system, popped-out chat) as running entries.
    const floatingGroups = new Map<FloatingAppId, WmWindow[]>()

    for (const win of ours) {
      const appId = ourFloatingAppId(win)

      if (appId && appId !== 'room' && appId !== 'canvas' && appId !== 'calc' && !isOfficeApp(appId)) {
        floatingGroups.set(appId, [...(floatingGroups.get(appId) ?? []), win])
      }
    }

    for (const [appId, windows] of floatingGroups) {
      const def = appById(appId)
      list.push({
        id: `hermes:${appId}`,
        label: def.name,
        render: () => <AppTile id={def.icon} size={44} />,
        onClick: () => focusGroup(`hermes:${appId}`, windows),
        running: true,
        windows
      })
    }

    // Every other running compositor window, grouped by app id.
    const groups = new Map<string, WmWindow[]>()

    for (const win of foreign) {
      const app = appForWindow(apps, win.appId)

      if (app && pinnedPaths.has(app.path)) {
        continue
      }

      const key = (win.appId || win.title || `pid:${win.pid ?? win.id}`).toLowerCase()
      groups.set(key, [...(groups.get(key) ?? []), win])
    }

    const taken = new Set(list.map(entry => entry.label.toLowerCase()))

    for (const [key, windows] of groups) {
      const sample = windows[0]
      const app = appForWindow(apps, sample.appId)
      const label = app ? distinctAppLabel(app, taken) : (sample.appId ?? windowLabel(sample))
      list.push({
        id: `wm:${key}`,
        label,
        render: () => (app ? <NativeIcon src={iconFor(app.path)} fallback="grid" /> : <LetterTile label={label} />),
        onClick: () => focusGroup(`wm:${key}`, windows),
        running: true,
        windows
      })
    }

    const fixed: DockEntry[] = [
      { id: 'applications', label: 'Applications', render: () => <span className="icon-tile size-11 rounded-[11px]"><AppGlyph id="grid" size={22} /></span>, onClick: () => openSurface('command', { type: 'applications' }) },
      { id: 'trash', label: 'Trash', render: () => <span className="flex size-11 items-center justify-center rounded-[11px] bg-white/6 text-fg-2"><AppGlyph id="trash" size={22} /></span>, onClick: () => window.heraldOS.fs.openPath(trashPath).catch(() => undefined) }
    ]

    return [...list.slice(0, MAX_ITEMS - fixed.length), ...fixed]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apps, iconFor, platform, wm.windows, trashPath])

  const menuEntry = menu ? entries.find(e => e.id === menu.id) : undefined
  const menuWindows = menuEntry?.windows ?? []

  useEffect(() => {
    if (menu && menuWindows.length === 0) {
      closeMenu()
    }
  }, [menu, menuWindows.length, closeMenu])

  return (
    <nav className="flex h-full w-full items-end justify-center pb-1" aria-label="Dock">
      <div ref={barRef} data-dock-bar className="glass dock-bar flex items-end gap-2 rounded-2xl px-3 py-2" onMouseMove={onMove} onMouseLeave={onLeave}>
        {entries.map(entry => (
          <button
            key={entry.id}
            type="button"
            aria-label={entry.label}
            onClick={entry.onClick}
            onAuxClick={event => {
              // Middle-click closes the group's current window.
              if (event.button === 1 && entry.windows?.length) {
                event.preventDefault()
                const target = entry.windows.find(w => w.focused) ?? entry.windows[0]
                void wmAction({ type: 'close-window', id: target.id })
              }
            }}
            onContextMenu={event => {
              event.preventDefault()

              if (entry.windows?.length && menuRef.current?.id !== entry.id) {
                openMenu(entry, event.currentTarget.getBoundingClientRect())
              } else {
                closeMenu()
              }
            }}
            className={cn('dock-item group relative flex flex-col items-center active:brightness-90', bouncing === entry.id && 'dock-bounce')}
          >
            <span className="dock-label float pointer-events-none absolute -top-9 left-1/2 rounded-md px-2 py-1 text-[11.5px] font-medium whitespace-nowrap text-fg opacity-0">{entry.label}</span>
            {entry.render()}
            <span className={cn('mt-1 size-1 rounded-full transition-opacity', entry.running ? 'bg-fg opacity-90' : 'opacity-0')} />
          </button>
        ))}
      </div>

      {menu && menuEntry && menuWindows.length > 0 && <DockMenu key={menu.name} win={menu.win} placed={menu.placed} label={menuEntry.label} windows={menuWindows} listHeight={menu.listHeight} onClose={closeMenu} />}
    </nav>
  )
}
