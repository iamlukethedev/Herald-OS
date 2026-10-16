import { useStore } from '@nanostores/react'
import { lazy, Suspense, useEffect } from 'react'
import { $applicationsOpen, $commandBarOpen } from '../store/surface.ts'
import { $prefs } from '../store/backend.ts'
import { $windows, dockAutoHides, ensureMainWindow, MAIN_WINDOW_ID, type OSWindow, relayoutOnResize } from '../store/windows.ts'
import { Window } from './wm/Window.tsx'
import { AskOverlay } from './AskOverlay.tsx'
import { EmojiOverlay } from '../features/emoji/EmojiPicker.tsx'
import { CommandBar } from './CommandBar.tsx'
import { Dock } from './Dock.tsx'
import { MainWindow } from './MainWindow.tsx'
import { MenuBar } from './MenuBar.tsx'
import { NotificationsPanel } from './NotificationsPanel.tsx'
import { RequestHost } from './RequestHost.tsx'
import { StatusPanelPopover } from './StatusPanelPopover.tsx'
import { Toasts } from './Toasts.tsx'
import { Wallpaper } from './Wallpaper.tsx'
import { HermesLoginCard } from '../features/auth/HermesLoginCard.tsx'
import { Screensaver } from '../features/screensaver/Screensaver.tsx'
import { $screensaverUp } from '../store/switches.ts'
import { ActionHud, OsHighlighter } from '../features/voice/ActionHud.tsx'
import { VoiceOrb } from '../features/voice/VoiceOrb.tsx'
import { FirstRunSetup } from '../features/setup/FirstRunSetup.tsx'
import { WidgetWindow } from '../features/plugins/PluginSlots.tsx'
import { PetOverlay } from '../features/pet/PetOverlay.tsx'

const TerminalSurface = lazy(() => import('../features/terminal/TerminalSurface.tsx').then(m => ({ default: m.TerminalSurface })))
const SystemSurface = lazy(() => import('../features/system/SystemSurface.tsx').then(m => ({ default: m.SystemSurface })))
const ChatPopout = lazy(() => import('../features/hermes/ChatPopout.tsx').then(m => ({ default: m.ChatPopout })))
const ApplicationsOverlay = lazy(() => import('../features/applications/ApplicationsOverlay.tsx').then(m => ({ default: m.ApplicationsOverlay })))
const WebWindow = lazy(() => import('../features/web/WebWindow.tsx').then(m => ({ default: m.WebWindow })))
const StudioWindow = lazy(() => import('../features/studio/StudioWindow.tsx').then(m => ({ default: m.StudioWindow })))
const CaptureEditor = lazy(() => import('../features/capture/CaptureEditor.tsx').then(m => ({ default: m.CaptureEditor })))
const CameraBubble = lazy(() => import('../features/capture/CameraBubble.tsx').then(m => ({ default: m.CameraBubble })))
const CanvasWindow = lazy(() => import('../features/canvas/CanvasWindow.tsx').then(m => ({ default: m.CanvasWindow })))
const DocsWindow = lazy(() => import('../features/office/docs/DocsWindow.tsx').then(m => ({ default: m.DocsWindow })))
const SheetsWindow = lazy(() => import('../features/office/sheets/SheetsWindow.tsx').then(m => ({ default: m.SheetsWindow })))
const SlidesWindow = lazy(() => import('../features/office/slides/SlidesWindow.tsx').then(m => ({ default: m.SlidesWindow })))
const RoomWindow = lazy(() => import('../features/room/RoomWindow.tsx').then(m => ({ default: m.RoomWindow })))
const CalcWindow = lazy(() => import('../features/calc/CalcWindow.tsx').then(m => ({ default: m.CalcWindow })))

function FloatingContent({ win }: { win: OSWindow }) {
  switch (win.appId) {
    case 'terminal':
      return <TerminalSurface />
    case 'system':
      return <SystemSurface />
    case 'chat-popout':
      return <ChatPopout sessionId={typeof win.payload?.sessionId === 'string' ? win.payload.sessionId : undefined} profile={typeof win.payload?.profile === 'string' ? win.payload.profile : undefined} />
    case 'web':
      return <WebWindow win={win} />
    case 'studio':
      return <StudioWindow win={win} />
    case 'capture-editor':
      return <CaptureEditor file={typeof win.payload?.file === 'string' ? win.payload.file : undefined} />
    case 'camera':
      return <CameraBubble />
    case 'widget':
      return <WidgetWindow pluginId={typeof win.payload?.plugin === 'string' ? win.payload.plugin : undefined} />
    case 'canvas':
      return <CanvasWindow payload={win.payload} />
    case 'docs':
      return <DocsWindow payload={win.payload} />
    case 'sheets':
      return <SheetsWindow payload={win.payload} />
    case 'slides':
      return <SlidesWindow payload={win.payload} />
    case 'room':
      return <RoomWindow active={win.phase !== 'minimized'} />
    case 'calc':
      return <CalcWindow payload={win.payload} />
    default:
      return null
  }
}

/** The desktop: wallpaper, menu bar, windows, dock, overlays. */
export function Desktop() {
  const windows = useStore($windows)
  const commandBarOpen = useStore($commandBarOpen)
  const applicationsOpen = useStore($applicationsOpen)
  const screensaverUp = useStore($screensaverUp)

  useEffect(() => {
    ensureMainWindow()
    const onResize = () => relayoutOnResize()
    window.addEventListener('resize', onResize)
    // Toggling Dock auto-hide changes the desktop area, so windows re-flow like on a resize.
    let lastAutoHide = dockAutoHides()
    const offPrefs = $prefs.subscribe(() => {
      const next = dockAutoHides()

      if (next !== lastAutoHide) {
        lastAutoHide = next
        relayoutOnResize()
      }
    })

    return () => {
      window.removeEventListener('resize', onResize)
      offPrefs()
    }
  }, [])

  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      <Wallpaper />
      <MenuBar />
      <div className="absolute inset-0 z-(--z-windows)">
        {Object.values(windows).map(win =>
          win.id === MAIN_WINDOW_ID ? (
            <Window key={win.id} win={win} chrome={false}>
              <MainWindow />
            </Window>
          ) : (
            <Window key={win.id} win={win}>
              <Suspense fallback={<div className="shimmer h-full w-full" />}>
                <FloatingContent win={win} />
              </Suspense>
            </Window>
          )
        )}
      </div>
      <Dock />
      <PetOverlay />
      <VoiceOrb offsetClass="bottom-24" />
      <ActionHud offsetClass="top-12" />
      <OsHighlighter />
      <HermesLoginCard />
      <FirstRunSetup />
      <RequestHost />
      <Toasts />
      <NotificationsPanel />
      <StatusPanelPopover />
      {applicationsOpen && (
        <Suspense fallback={null}>
          <ApplicationsOverlay />
        </Suspense>
      )}
      {commandBarOpen && <CommandBar />}
      <AskOverlay />
      <EmojiOverlay />
      {screensaverUp && <Screensaver onDismiss={() => $screensaverUp.set(false)} />}
    </div>
  )
}
