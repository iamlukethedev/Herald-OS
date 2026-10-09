import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { afterExit, motion } from '../lib/motion.ts'
import { $backend } from '../store/backend.ts'
import { openEmojiPicker } from '../store/emoji.ts'
import { runCommand } from '../store/os-commands.ts'
import { toggleSidebar } from '../store/sidebar.ts'
import { $applicationsOpen, $commandBarOpen, toggleCommandBar } from '../store/surface.ts'
import { $focusedWindowId, closeWindow, MAIN_WINDOW_ID, minimizeWindow, openApp } from '../store/windows.ts'
import { HERMES_APPS } from './apps.ts'
import { BootScreen } from './BootScreen.tsx'
import { Desktop } from './Desktop.tsx'

export function App() {
  const backend = useStore($backend)

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

      // Cmd+Shift+S: select part of the screen and ask Hermes about it (Mod+Shift+S on Linux).
      if (meta && event.shiftKey && key === 's') {
        event.preventDefault()
        void runCommand('screen.askRegion', {}, { source: 'shortcut' })

        return
      }

      // Cmd+Ctrl+E: the emoji picker (Mod+Ctrl+E in niri on Linux).
      if (event.metaKey && event.ctrlKey && key === 'e') {
        event.preventDefault()
        openEmojiPicker()

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

        const focused = $focusedWindowId.get()

        if (key === 'w' && focused && focused !== MAIN_WINDOW_ID) {
          event.preventDefault()
          closeWindow(focused)
        } else if (key === 'm' && focused) {
          event.preventDefault()
          minimizeWindow(focused)
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
      <Desktop />
      {bootVisible && <BootScreen state={backend} leaving={!bootOnly} />}
    </div>
  )
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
