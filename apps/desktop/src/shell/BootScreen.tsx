import { useState } from 'react'
import type { BackendState } from '../../shared/ipc.ts'
import { HeraldLogo } from '../components/herald-logo.tsx'
import { cn } from '../lib/cn.ts'
import { Button } from '../components/ui/button.tsx'
import { Spinner } from '../components/ui/primitives.tsx'
import { StatusPanel } from '../features/status/StatusPanel.tsx'

const PHASE_COPY: Record<BackendState['phase'], string> = {
  idle: 'Preparing',
  resolving: 'Locating your Hermes runtime',
  waiting: 'Waiting for Hermes Agent',
  starting: 'Starting Hermes',
  ready: 'Ready',
  restarting: 'Restarting Hermes',
  failed: 'Hermes could not start',
  stopped: 'Hermes stopped'
}

export function BootScreen({ state, leaving = false }: { state: BackendState; leaving?: boolean }) {
  const [showLog, setShowLog] = useState(false)
  const failed = state.phase === 'failed'
  const waiting = state.phase === 'waiting'

  return (
    <div
      className={cn('drag-region absolute inset-0 z-(--z-boot) flex flex-col items-center justify-center', leaving ? 'boot-leave pointer-events-none' : 'animate-fade-in')}
      style={{ background: 'radial-gradient(circle at 50% 45%, #1240c8 0%, #0a2a96 45%, #04113f 100%)' }}
      aria-hidden={leaving}
    >
      <div className={cn('no-drag glass flex w-[440px] flex-col items-center gap-6 rounded-2xl px-8 py-10 text-center', leaving && 'boot-card-leave')}>
        <HeraldLogo height={44} />
        <div className="flex flex-col gap-1.5">
          <div className="text-[22px] font-medium tracking-tight">Herald OS</div>
          <div className="flex items-center justify-center gap-2 text-[13px] text-fg-2">
            {!failed && <Spinner />}
            <span>{PHASE_COPY[state.phase]}</span>
          </div>
          {state.runtime && !failed && <div className="text-[12px] text-fg-3">{state.runtime.label}</div>}
        </div>

        {failed && (
          <div className="flex w-full flex-col gap-3">
            <div className="selectable rounded-md bg-danger/10 px-3 py-2 text-left text-[12px] text-danger">{state.error}</div>
            <div className="flex justify-center gap-2">
              <Button variant="primary" onClick={() => void window.heraldOS.backend.restart()}>
                Try again
              </Button>
              <Button variant="ghost" onClick={() => setShowLog(v => !v)}>
                {showLog ? 'Hide log' : 'Show log'}
              </Button>
              <Button variant="ghost" onClick={() => void window.heraldOS.window.quit()}>
                Quit
              </Button>
            </div>
          </div>
        )}

        {waiting && (
          <div className="flex w-full flex-col gap-3">
            <p className="selectable text-left text-[12.5px] leading-relaxed text-fg-2">{state.error}</p>
            {/* On the image a network is what ends the wait, and first-run setup's Wi-Fi step is behind this screen. */}
            {state.install && (
              <div className="max-h-[260px] overflow-y-auto rounded-xl text-left">
                <StatusPanel panel="wifi" />
              </div>
            )}
            <div className="flex justify-center gap-2">
              <Button variant="ghost" onClick={() => setShowLog(v => !v)}>
                {showLog ? 'Hide log' : 'Show log'}
              </Button>
              <Button variant="ghost" onClick={() => void window.heraldOS.window.quit()}>
                Quit
              </Button>
            </div>
          </div>
        )}

        {showLog && (
          <pre className="selectable max-h-56 w-full overflow-auto rounded-md bg-surface p-3 text-left font-mono text-[11px] leading-relaxed text-fg-2 hairline">
            {state.logTail.slice(-80).join('\n') || 'No output yet.'}
          </pre>
        )}
      </div>
    </div>
  )
}
