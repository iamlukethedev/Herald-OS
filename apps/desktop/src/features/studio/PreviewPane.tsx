import { IconAppWindow, IconRefresh, IconWorld } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { logFailure } from '../../lib/report.ts'
import { openWebWindow } from '../../store/web-windows.ts'
import type { OSWindow } from '../../store/windows.ts'
import { useNativeView } from '../web/native-view.ts'

const RETRY_MS = 1500
const MAX_RETRIES = 40
const RELOAD_DEBOUNCE_MS = 700

const isWeb = (target: string): boolean => /^https?:\/\//i.test(target)

/**
 * The site Hermes is building, live: its dev server, or the project's `index.html` for a static
 * site. Waits while the server is still starting and refreshes after Hermes changes files.
 */
export function PreviewPane({ win, target, root, contentKey, compact = false }: { win: OSWindow; target: string | null; root: string | null; contentKey: number; compact?: boolean }) {
  const [viewId, setViewId] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const retries = useRef(0)
  const idRef = useRef<string | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const { covered, occluded } = useNativeView(viewId, host, win, { active: !error, followFrameRadius: false })

  useEffect(() => {
    const off = window.heraldOS.web.onEvent(event => {
      if (event.id !== idRef.current) {
        return
      }

      if (event.type === 'loading') {
        setLoading(event.loading)
      } else if (event.type === 'url') {
        setUrl(event.url)
        setError(null)
      } else if (event.type === 'error') {
        setError(event.error)
      } else if (event.type === 'closed') {
        idRef.current = null
        setViewId(null)
      }
    })

    return () => {
      off()

      if (idRef.current) {
        void window.heraldOS.web.close(idRef.current).catch(logFailure('web.close'))
        idRef.current = null
      }
    }
  }, [])

  // Open the preview once, then point it wherever the target moves (a new port, the static page).
  useEffect(() => {
    if (!target) {
      return
    }

    retries.current = 0
    setError(null)

    if (idRef.current) {
      void window.heraldOS.web.navigate(idRef.current, target).catch(err => setError(err instanceof Error ? err.message : String(err)))
      return
    }

    void window.heraldOS.web
      .openPreview(target, { root: root ?? undefined, title: 'Preview' })
      .then(id => {
        idRef.current = id
        setViewId(id)
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [target, root])

  // A dev server that is still starting refuses connections: try again for a while.
  useEffect(() => {
    if (!error || !target || !idRef.current || retries.current >= MAX_RETRIES) {
      return
    }

    const timer = setTimeout(() => {
      retries.current += 1

      if (idRef.current) {
        void window.heraldOS.web.navigate(idRef.current, target).catch(() => undefined)
      }
    }, RETRY_MS)

    return () => clearTimeout(timer)
  }, [error, target])

  // Hermes changed files: refresh (dev servers with hot reload simply repaint).
  useEffect(() => {
    if (!contentKey || !idRef.current) {
      return
    }

    const timer = setTimeout(() => {
      if (idRef.current) {
        void window.heraldOS.web.reload(idRef.current).catch(logFailure('web.reload'))
      }
    }, RELOAD_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [contentKey])

  const shown = url || target || ''
  const label = shown.startsWith('file://') ? decodeURIComponent(shown.slice('file://'.length)).replace(`${root ?? ''}/`, '') : shown

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2">
        <div className="glass-input flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-[11.5px]" title={shown}>
          <IconWorld size={12} className="shrink-0 text-fg-3" />
          <span className="truncate text-fg-2">{label || 'No preview yet'}</span>
          {loading && <Spinner className="ml-auto shrink-0" />}
        </div>
        <button type="button" disabled={!viewId} onClick={() => viewId && void window.heraldOS.web.reload(viewId).catch(logFailure('web.reload'))} className="flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg disabled:opacity-40" title="Reload" aria-label="Reload preview">
          <IconRefresh size={14} />
        </button>
        <button type="button" disabled={!target || !isWeb(target)} onClick={() => target && void openWebWindow(url || target)} className="flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg disabled:opacity-40" title="Open in its own window" aria-label="Open preview in its own window">
          <IconAppWindow size={14} />
        </button>
      </div>
      <div ref={host} className={cn('relative min-h-0 flex-1 bg-white/[0.03]', compact && 'hidden')}>
        {!compact && (!target || error || covered || occluded || !viewId) && (
          <div className={cn('absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-[12.5px] text-fg-3')}>
            {error && target ? <Spinner /> : <IconWorld size={26} className="text-fg-4" />}
            <span>
              {!target
                ? 'The site appears here once Hermes starts it or writes an index.html.'
                : error
                  ? retries.current >= MAX_RETRIES
                    ? `The site did not load: ${error}`
                    : 'Waiting for the site to start…'
                  : covered
                    ? 'The preview is hidden while a Hermes panel is open.'
                    : occluded
                      ? 'Bring the Studio forward to see the preview.'
                      : 'Opening…'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
