import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InstalledApp } from '../../shared/ipc.ts'
import { OFFICE_APPS, type OfficeApp } from '../../shared/office/files.ts'
import { AppGlyph, HermesAvatar } from '../components/app-icon.tsx'
import { openInCanvas } from '../features/canvas/open.ts'
import { OfficeChooser } from '../features/office/OfficeChooser.tsx'
import { openInOffice } from '../features/office/open.ts'
import { cn } from '../lib/cn.ts'
import { reducedMotion } from '../lib/motion.ts'
import { logFailure } from '../lib/report.ts'
import { $env, $prefs } from '../store/backend.ts'
import { notify } from '../store/notifications.ts'
import { $applicationsOpen } from '../store/surface.ts'
import { $windows, focusWindow, MAIN_WINDOW_ID, showPage } from '../store/windows.ts'
import { useNativeApps } from '../store/native-apps.ts'

interface DockItem {
  id: string
  label: string
  render: () => React.ReactNode
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  running?: boolean
}

interface PinnedNative {
  label: string
  /** Candidate app names in preference order; the first one installed is pinned. */
  names: string[]
}

const PINNED_BY_PLATFORM: Record<'darwin' | 'linux' | 'other', PinnedNative[]> = {
  darwin: [
    { label: 'Files', names: ['Finder'] },
    { label: 'Safari', names: ['Safari', 'Google Chrome', 'Arc'] },
    { label: 'Mail', names: ['Mail'] },
    { label: 'Calendar', names: ['Calendar'] },
    { label: 'Notes', names: ['Notes'] }
  ],
  linux: [
    { label: 'Files', names: ['Files', 'Nautilus', 'Dolphin', 'Thunar'] },
    { label: 'Browser', names: ['Firefox', 'Firefox Web Browser', 'Chromium', 'Google Chrome'] },
    { label: 'Mail', names: ['Thunderbird', 'Geary', 'Evolution'] },
    { label: 'Calendar', names: ['Calendar', 'GNOME Calendar'] },
    { label: 'Notes', names: ['Text Editor', 'gedit', 'Notes'] }
  ],
  other: [{ label: 'Files', names: [] }]
}

export const isOfficeApp = (id: string): id is OfficeApp => (OFFICE_APPS as readonly string[]).includes(id)

export function pinnedFor(platform: string | undefined): PinnedNative[] {
  return platform === 'darwin' ? PINNED_BY_PLATFORM.darwin : platform === 'linux' ? PINNED_BY_PLATFORM.linux : PINNED_BY_PLATFORM.other
}

/**
 * Magnification: every icon reads the cursor's distance from its centre and scales with a smooth falloff,
 * so neighbours swell with the hovered icon like macOS. Written straight to CSS variables to skip React renders.
 */
export function useDockMagnification(barRef: React.RefObject<HTMLDivElement | null>, max = MAGNIFY_MAX) {
  const onMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const bar = barRef.current

    if (!bar || reducedMotion()) {
      return
    }

    const x = event.clientX

    for (const el of bar.querySelectorAll<HTMLElement>('.dock-item')) {
      const rect = el.getBoundingClientRect()
      const distance = Math.abs(x - (rect.left + rect.width / 2))
      const influence = Math.max(0, 1 - distance / MAGNIFY_RADIUS)
      const scale = 1 + max * influence * influence * (3 - 2 * influence)
      el.style.setProperty('--dock-scale', scale.toFixed(3))
    }
  }

  const onLeave = () => {
    for (const el of barRef.current?.querySelectorAll<HTMLElement>('.dock-item') ?? []) {
      el.style.setProperty('--dock-scale', '1')
    }
  }

  return { onMove, onLeave }
}

export function Dock() {
  const windows = useStore($windows)
  const prefs = useStore($prefs)
  const { apps, iconFor } = useNativeApps()
  const [bouncing, setBouncing] = useState<string | null>(null)
  const autoHide = prefs.dockAutoHide !== false
  const revealed = useDockReveal(autoHide)
  const platform = useStore($env)?.platform ?? 'darwin'
  const trashPath = platform === 'darwin' ? '~/.Trash' : '~/.local/share/Trash/files'

  const main = windows[MAIN_WINDOW_ID]
  const canvasOpen = Object.values(windows).some(w => w.appId === 'canvas')
  const officeKey = Object.values(windows)
    .map(w => w.appId)
    .filter(isOfficeApp)
    .sort()
    .join(',')
  const [chooser, setChooser] = useState<number | null>(null)
  const closeChooser = useCallback(() => setChooser(null), [])
  const openHermes = () => {
    if (main && main.phase !== 'minimized') {
      focusWindow(MAIN_WINDOW_ID)
    } else {
      showPage('overview')
    }
  }

  const launch = async (app: InstalledApp) => {
    setBouncing(app.path)
    setTimeout(() => setBouncing(null), 450)

    try {
      await window.heraldOS.apps.launch(app.path)
    } catch (error) {
      notify({ title: `Could not open ${app.name}`, body: error instanceof Error ? error.message : String(error), level: 'error' })
    }
  }

  const items = useMemo<DockItem[]>(() => {
    const list: DockItem[] = [
      {
        id: 'hermes',
        label: 'Hermes',
        render: () => <HermesAvatar size={44} rounded={11} />,
        onClick: openHermes,
        running: Boolean(main) && main.phase !== 'minimized'
      }
    ]

    const findApp = (names: string[]) => names.map(n => apps.find(a => a.name.toLowerCase() === n.toLowerCase())).find(Boolean)

    for (const pin of pinnedFor(platform)) {
      if (pin.label === 'Files') {
        // Files is always Herald OS's own page; borrow the host file manager's icon when it has one.
        list.push({ id: 'files', label: 'Files', render: () => <NativeIcon src={iconFor(findApp(pin.names)?.path)} fallback="files" />, onClick: () => showPage('files') })

        continue
      }

      const app = findApp(pin.names)

      if (app) {
        list.push({ id: app.path, label: app.name, render: () => <NativeIcon src={iconFor(app.path)} fallback="grid" />, onClick: () => void launch(app) })
      }
    }

    // A shortcut beside the one in Applications.
    list.push({ id: 'canvas', label: 'Herald Canvas', render: () => <span className="icon-tile size-11 rounded-[11px]"><AppGlyph id="canvas" size={22} /></span>, onClick: () => openInCanvas(), running: canvasOpen })
    // Docs, Sheets and Slides share one entry, so three icons do not crowd the Dock.
    list.push({
      id: 'office',
      label: 'Herald Office',
      render: () => <span className="icon-tile size-11 rounded-[11px]"><AppGlyph id="office" size={22} /></span>,
      onClick: event => {
        const rect = event.currentTarget.getBoundingClientRect()
        setChooser(open => (open === null ? rect.left + rect.width / 2 : null))
      },
      running: officeKey !== ''
    })
    list.push({ id: 'applications', label: 'Applications', render: () => <span className="icon-tile size-11 rounded-[11px]"><AppGlyph id="grid" size={22} /></span>, onClick: () => $applicationsOpen.set(true) })
    list.push({ id: 'trash', label: 'Trash', render: () => <span className="flex size-11 items-center justify-center rounded-[11px] bg-white/6 text-fg-2"><AppGlyph id="trash" size={22} /></span>, onClick: () => void window.heraldOS.fs.openPath(trashPath).catch(logFailure('fs.openPath')) })

    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apps, iconFor, main?.phase, platform, canvasOpen, officeKey])

  const barRef = useRef<HTMLDivElement>(null)
  const { onMove, onLeave } = useDockMagnification(barRef)

  const hidden = autoHide && !revealed

  return (
    <nav className="pointer-events-none absolute inset-x-0 bottom-0 z-(--z-dock) flex h-(--dock-h) items-end justify-center pb-3" aria-label="Dock" data-hidden={hidden || undefined}>
      {/* Invisible strip along the bottom edge that wakes the Dock, like macOS. */}
      {autoHide && <div data-dock-trigger className="pointer-events-auto absolute inset-x-0 bottom-0 h-1.5" aria-hidden="true" />}
      <div
        ref={barRef}
        data-dock-bar
        className={cn('glass dock-bar pointer-events-auto flex items-end gap-2 rounded-2xl px-3 py-2', hidden && 'dock-bar-hidden')}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        aria-hidden={hidden}
      >
        {items.map(item => (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            data-dock-item={item.id}
            onClick={item.onClick}
            className={cn('dock-item group relative flex flex-col items-center active:brightness-90', bouncing === item.id && 'dock-bounce')}
          >
            <span className="dock-label float pointer-events-none absolute -top-9 left-1/2 rounded-md px-2 py-1 text-[11.5px] font-medium whitespace-nowrap text-fg opacity-0">
              {item.label}
            </span>
            {item.render()}
            <span className={cn('mt-1 size-1 rounded-full transition-opacity', item.running ? 'bg-fg opacity-90' : 'opacity-0')} />
          </button>
        ))}
      </div>
      {chooser !== null && (
        <OfficeChooser
          x={chooser}
          running={new Set(officeKey.split(',').filter(isOfficeApp))}
          onClose={closeChooser}
          onChoose={app => {
            setChooser(null)
            openInOffice(app)
          }}
        />
      )}
    </nav>
  )
}

const MAGNIFY_RADIUS = 110
const MAGNIFY_MAX = 0.42

/** Cursor must rest on the bottom edge this long before the Dock rises (filters accidental brushes). */
const REVEAL_DELAY = 140
/** Grace period after the cursor leaves the Dock before it slides away. */
const HIDE_DELAY = 420
/** Shown briefly at boot so the user learns where it lives. */
const INTRO_VISIBLE = 1800

/**
 * macOS-style auto-hide: the Dock is revealed while the cursor is on the bottom edge or over the bar,
 * and slides away shortly after it leaves. Keyboard focus inside the Dock also keeps it up.
 */
function useDockReveal(enabled: boolean): boolean {
  const [revealed, setRevealed] = useState(true)

  useEffect(() => {
    if (!enabled) {
      setRevealed(true)

      return
    }

    let showTimer = 0
    let hideTimer = 0
    let over = false

    const show = () => {
      window.clearTimeout(hideTimer)

      if (!showTimer) {
        showTimer = window.setTimeout(() => {
          showTimer = 0
          setRevealed(true)
        }, REVEAL_DELAY)
      }
    }

    const hide = () => {
      window.clearTimeout(showTimer)
      showTimer = 0
      window.clearTimeout(hideTimer)
      hideTimer = window.setTimeout(() => setRevealed(false), HIDE_DELAY)
    }

    const onMove = (event: MouseEvent) => {
      const target = event.target
      const inDock = target instanceof Element && Boolean(target.closest('[data-dock-bar], [data-dock-trigger]'))
      const atEdge = event.clientY >= window.innerHeight - 2

      if (inDock || atEdge) {
        if (!over) {
          over = true
          show()
        }
      } else if (over) {
        over = false
        hide()
      }
    }

    const onLeaveWindow = () => {
      over = false
      hide()
    }

    const onFocusIn = (event: FocusEvent) => {
      if ((event.target as Element | null)?.closest('[data-dock-bar]')) {
        window.clearTimeout(hideTimer)
        setRevealed(true)
      }
    }

    hideTimer = window.setTimeout(() => setRevealed(false), INTRO_VISIBLE)
    window.addEventListener('mousemove', onMove, { passive: true })
    document.addEventListener('mouseleave', onLeaveWindow)
    document.addEventListener('focusin', onFocusIn)

    return () => {
      window.clearTimeout(showTimer)
      window.clearTimeout(hideTimer)
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeaveWindow)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [enabled])

  return revealed
}

export function NativeIcon({ src, fallback }: { src?: string; fallback: 'files' | 'grid' }) {
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [src])

  if (!src || failed) {
    return (
      <span className="icon-tile size-11 rounded-[11px]">
        <AppGlyph id={fallback} size={22} />
      </span>
    )
  }

  return <img src={src} alt="" width={44} height={44} draggable={false} onError={() => setFailed(true)} className="size-11 drop-shadow-[0_4px_10px_rgba(0,10,60,.5)]" />
}
