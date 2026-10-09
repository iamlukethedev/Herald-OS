import { useStore } from '@nanostores/react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { afterExit, motion } from '../../lib/motion.ts'
import { $backend, $prefs } from '../../store/backend.ts'
import { bindDesktopNotifications } from '../../store/notifications.ts'
import { toggleSidebar } from '../../store/sidebar.ts'
import { $applicationsOpen, $commandBarOpen, toggleCommandBar } from '../../store/surface.ts'
import { ensureMainWindow, openApp } from '../../store/windows.ts'
import { HERMES_APPS } from '../apps.ts'
import { BootScreen } from '../BootScreen.tsx'
import { CommandBar } from '../CommandBar.tsx'
import { MainWindow } from '../MainWindow.tsx'
import { NotificationsPanel } from '../NotificationsPanel.tsx'
import { RequestHost } from '../RequestHost.tsx'
import { Toasts } from '../Toasts.tsx'
import { drawWallpaperFrame, tintFor } from '../Wallpaper.tsx'
import { HermesLoginCard } from '../../features/auth/HermesLoginCard.tsx'
import { ActionHud, OsHighlighter } from '../../features/voice/ActionHud.tsx'
import { VoiceOrb } from '../../features/voice/VoiceOrb.tsx'
import { FirstRunSetup } from '../../features/setup/FirstRunSetup.tsx'

const ApplicationsOverlay = lazy(() => import('../../features/applications/ApplicationsOverlay.tsx').then(m => ({ default: m.ApplicationsOverlay })))

/**
 * Panels mode: the Hermes window. niri tiles it like any other client, so it is just the sidebar and
 * pages filling the window plus the overlays that belong to it. Other surfaces and the `herald-os` CLI
 * drive it through `ShellCommand`s.
 */
export function MainSurface() {
  const backend = useStore($backend)
  const commandBarOpen = useStore($commandBarOpen)
  const applicationsOpen = useStore($applicationsOpen)

  useEffect(() => {
    ensureMainWindow()
  }, [])

  // Notifications other apps send over D-Bus land in the shell's list and toasts (panels mode only).
  useEffect(() => bindDesktopNotifications(), [])

  // Commands from the CLI, the overlay and the control server are handled by store/shell-commands.ts
  // (bound once at boot), shared with the macOS desktop window.

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()

      if (meta && key === 'k') {
        event.preventDefault()
        toggleCommandBar()

        return
      }

      if (meta && event.shiftKey && key === 'a') {
        event.preventDefault()
        $applicationsOpen.set(!$applicationsOpen.get())

        return
      }

      if (meta && event.key === '\\') {
        event.preventDefault()
        toggleSidebar()

        return
      }

      if (meta && !event.shiftKey && !event.altKey) {
        const target = HERMES_APPS.find(a => a.shortcut === event.key)

        if (target) {
          event.preventDefault()
          openApp(target.id)

          return
        }
      }

      if (event.key === 'Escape') {
        if ($commandBarOpen.get()) {
          toggleCommandBar(false)
        } else if ($applicationsOpen.get()) {
          $applicationsOpen.set(false)
        }
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const bootOnly = backend.phase === 'idle' || backend.phase === 'resolving' || backend.phase === 'waiting' || (backend.phase === 'starting' && backend.attempt === 0) || backend.phase === 'failed'
  const bootVisible = useExitTransition(bootOnly, motion.slow + 120)

  return (
    <div className="h-full w-full bg-bg text-fg">
      <div className="relative h-full w-full overflow-hidden bg-bg">
        <StillWallpaper />
        <div className="absolute inset-0 z-(--z-windows)">
          <MainWindow />
        </div>
        <VoiceOrb offsetClass="bottom-6" />
        <ActionHud offsetClass="top-4" />
        <OsHighlighter />
        <HermesLoginCard />
        <FirstRunSetup />
        <RequestHost />
        <Toasts />
        <NotificationsPanel />
        {applicationsOpen && (
          <Suspense fallback={null}>
            <ApplicationsOverlay />
          </Suspense>
        )}
        {commandBarOpen && <CommandBar />}
      </div>
      {bootVisible && <BootScreen state={backend} leaving={!bootOnly} />}
    </div>
  )
}

/** One still frame of the wallpaper behind the sidebar and page so the glass has something to sit on. */
function StillWallpaper() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const prefs = useStore($prefs)
  const tint = useMemo(() => tintFor(prefs), [prefs.themeColors, prefs.themeScheme])

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas) {
      return
    }

    const ctx = canvas.getContext('2d', { alpha: false })

    if (!ctx) {
      return
    }

    const scale = 0.5
    const draw = () => {
      canvas.width = Math.max(1, Math.floor(window.innerWidth * scale))
      canvas.height = Math.max(1, Math.floor(window.innerHeight * scale))
      drawWallpaperFrame(ctx, canvas.width, canvas.height, 137.5, scale, tint)
    }

    draw()
    window.addEventListener('resize', draw)

    return () => window.removeEventListener('resize', draw)
  }, [tint])

  return <canvas ref={canvasRef} className="absolute inset-0 z-(--z-wallpaper) h-full w-full opacity-70" style={{ filter: 'blur(1.5px)' }} aria-hidden="true" />
}

/** Keep `true` for `ms` after `open` turns false so an exit animation can play (skipped under reduced motion). */
function useExitTransition(open: boolean, ms: number): boolean {
  const [visible, setVisible] = useState(open)

  useEffect(() => {
    if (open) {
      setVisible(true)

      return
    }

    let cancelled = false
    afterExit(() => {
      if (!cancelled) {
        setVisible(false)
      }
    }, ms)

    return () => {
      cancelled = true
    }
  }, [open, ms])

  return visible
}
