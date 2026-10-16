import { lazy, Suspense, useState } from 'react'
import type { ShellCommand } from '../../../shared/ipc.ts'
import { SurfaceErrorBoundary } from '../../components/error-boundary.tsx'
import { appById, type FloatingAppId, FLOATING_APPS } from '../apps.ts'
import { RequestHost } from '../RequestHost.tsx'
import { Toasts } from '../Toasts.tsx'
import { useShellCommands } from './shell-utils.ts'
import { WidgetWindow } from '../../features/plugins/PluginSlots.tsx'

const TerminalSurface = lazy(() => import('../../features/terminal/TerminalSurface.tsx').then(m => ({ default: m.TerminalSurface })))
const SystemSurface = lazy(() => import('../../features/system/SystemSurface.tsx').then(m => ({ default: m.SystemSurface })))
const ChatPopout = lazy(() => import('../../features/hermes/ChatPopout.tsx').then(m => ({ default: m.ChatPopout })))
const StudioWindow = lazy(() => import('../../features/studio/StudioWindow.tsx').then(m => ({ default: m.StudioWindow })))
const CaptureEditor = lazy(() => import('../../features/capture/CaptureEditor.tsx').then(m => ({ default: m.CaptureEditor })))
const CameraBubble = lazy(() => import('../../features/capture/CameraBubble.tsx').then(m => ({ default: m.CameraBubble })))
const CanvasWindow = lazy(() => import('../../features/canvas/CanvasWindow.tsx').then(m => ({ default: m.CanvasWindow })))
const DocsWindow = lazy(() => import('../../features/office/docs/DocsWindow.tsx').then(m => ({ default: m.DocsWindow })))
const SheetsWindow = lazy(() => import('../../features/office/sheets/SheetsWindow.tsx').then(m => ({ default: m.SheetsWindow })))
const SlidesWindow = lazy(() => import('../../features/office/slides/SlidesWindow.tsx').then(m => ({ default: m.SlidesWindow })))
const RoomWindow = lazy(() => import('../../features/room/RoomWindow.tsx').then(m => ({ default: m.RoomWindow })))
const CalcWindow = lazy(() => import('../../features/calc/CalcWindow.tsx').then(m => ({ default: m.CalcWindow })))

const isFloatingAppId = (value: string): value is FloatingAppId => FLOATING_APPS.some(app => app.id === value)

function FloatingContent({ appId, payload }: { appId: FloatingAppId; payload: Record<string, unknown> }) {
  switch (appId) {
    case 'terminal':
      return <TerminalSurface />
    case 'system':
      return <SystemSurface />
    case 'chat-popout':
      return <ChatPopout sessionId={typeof payload.sessionId === 'string' ? payload.sessionId : undefined} profile={typeof payload.profile === 'string' ? payload.profile : undefined} />
    case 'studio':
      // The compositor owns this window; the preview opens as its own window there.
      return <StudioWindow win={{ id: 'panel-studio', appId: 'studio', title: 'Studio', bounds: { x: 0, y: 0, width: 0, height: 0 }, z: 0, phase: 'open', maximized: true, payload }} />
    case 'capture-editor':
      return <CaptureEditor file={typeof payload.file === 'string' ? payload.file : undefined} />
    case 'camera':
      return <CameraBubble />
    case 'widget':
      return <WidgetWindow pluginId={typeof payload.plugin === 'string' ? payload.plugin : undefined} />
    case 'canvas':
      return <CanvasWindow payload={payload} />
    case 'docs':
      return <DocsWindow payload={payload} />
    case 'sheets':
      return <SheetsWindow payload={payload} />
    case 'slides':
      return <SlidesWindow payload={payload} />
    case 'room':
      return <RoomWindow />
    case 'calc':
      return <CalcWindow payload={payload} />
    default:
      return null
  }
}

/**
 * Panels mode: one floating Hermes app (terminal, system, popped-out chat) in its own compositor
 * window. niri draws the border and handles move/resize, so there is no chrome here: just an opaque
 * glass background and the app. The app payload (e.g. a session id) arrives as a `payload` command.
 */
export function FloatingSurface({ appId }: { appId: string }) {
  const [payload, setPayload] = useState<Record<string, unknown>>({})

  useShellCommands((command: ShellCommand) => {
    if (command.type === 'payload' && command.payload) {
      setPayload(command.payload)
    }
  })

  if (!isFloatingAppId(appId)) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg text-[13px] text-fg-3">
        Unknown Hermes app: {appId}
      </div>
    )
  }

  const def = appById(appId)

  return (
    <div className="relative h-full w-full overflow-hidden bg-bg text-fg">
      <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, var(--color-glass-2), var(--color-glass))' }} />
      <div className="absolute inset-0">
        <SurfaceErrorBoundary label={def.name}>
          <Suspense fallback={<div className="shimmer h-full w-full" />}>
            <FloatingContent appId={appId} payload={payload} />
          </Suspense>
        </SurfaceErrorBoundary>
      </div>
      <RequestHost />
      <Toasts />
    </div>
  )
}
