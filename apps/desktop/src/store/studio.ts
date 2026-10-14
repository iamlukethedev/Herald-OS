import { atom, map } from 'nanostores'
import { logFailure } from '../lib/report.ts'
import { emptyStudio, noteDiskChange, reduceStudioEvent, setStudioPreview, type StudioState } from '../lib/studio-model.ts'
import { $env } from './backend.ts'
import { $chats } from './chat.ts'
import { onAnyGatewayEvent } from './gateway.ts'
import { $windows, desktopArea, focusWindow, openApp } from './windows.ts'

/*
 * The Studio's live model of each Hermes session: files written and edited, commands, background
 * processes, the site to preview. Fed by the same gateway events the chat uses, for every session
 * the shell knows, so "show me the code" works for a build that is already under way.
 */

const STUDIO_EVENTS = new Set(['session.info', 'message.start', 'message.complete', 'status.update', 'tool.generating', 'tool.start', 'tool.complete', 'agent.terminal.output', 'terminal.close', 'preview.open'])

export const $studios = map<Record<string, StudioState>>({})

/** Sessions started with "build …": their Studio opens by itself when Hermes starts working. */
export const $buildSessions = atom<ReadonlySet<string>>(new Set())

const home = (): string => $env.get()?.homeDir ?? ''

export function studioFor(sessionId: string): StudioState {
  const existing = $studios.get()[sessionId]

  if (existing) {
    return existing
  }

  const created = emptyStudio(sessionId, home(), $chats.get()[sessionId]?.info.cwd ?? null)
  $studios.setKey(sessionId, created)

  return created
}

function update(sessionId: string, change: (state: StudioState) => StudioState): void {
  const current = studioFor(sessionId)
  const next = change(current)

  if (next !== current) {
    $studios.setKey(sessionId, next)
  }
}

/** The Studio window already showing this session, if any. */
export function studioWindowFor(sessionId: string): string | null {
  return Object.values($windows.get()).find(w => w.appId === 'studio' && w.payload?.sessionId === sessionId && w.phase !== 'closing')?.id ?? null
}

/** Open (or bring forward) the Studio for a session; it takes most of the desktop so everything fits. */
export function openStudio(sessionId: string, title?: string): string {
  studioFor(sessionId)
  const existing = studioWindowFor(sessionId)

  if (existing) {
    focusWindow(existing)

    return existing
  }

  const area = desktopArea()
  const width = Math.round(area.width * 0.94)
  const height = Math.round(area.height * 0.92)
  const bounds = { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height }

  // The stored id lets a Studio in another renderer (panels mode) resume the same session.
  const storedSessionId = $chats.get()[sessionId]?.storedSessionId

  return openApp('studio', { payload: { sessionId, storedSessionId }, title: title ? `Studio · ${title}` : 'Studio', bounds, singleton: false })
}

export function markBuildSession(sessionId: string): void {
  $buildSessions.set(new Set([...$buildSessions.get(), sessionId]))
}

export function setPreview(sessionId: string, url: string): void {
  update(sessionId, state => setStudioPreview(state, url))
}

export function focusStudioFile(sessionId: string, path: string): void {
  update(sessionId, state => ({ ...state, activeFile: path }))
}

let bound = false

export function bindStudioEvents(): () => void {
  if (bound) {
    return () => undefined
  }

  bound = true
  const off = onAnyGatewayEvent(event => {
    const sid = event.session_id

    if (!sid || !STUDIO_EVENTS.has(event.type) || (!$chats.get()[sid] && !$studios.get()[sid])) {
      return
    }

    update(sid, state => reduceStudioEvent(state, event))
  })

  return () => {
    off()
    bound = false
  }
}

const release = (watchId: string | null): void => {
  if (watchId) {
    void window.heraldOS.fs.unwatchTree(watchId).catch(logFailure('fs.unwatchTree'))
  }
}

const watches = new Map<string, { watchId: Promise<string | null>; users: number; root: string }>()
let treeListenerBound = false

/** Keep a session's project folder watched while a Studio shows it (reference counted). */
export function watchStudioFolder(sessionId: string, root: string): () => void {
  if (!treeListenerBound) {
    treeListenerBound = true
    window.heraldOS.fs.onTreeChanged(event => {
      for (const [sid, watch] of watches) {
        void watch.watchId.then(id => {
          if (id === event.watchId) {
            update(sid, state => noteDiskChange(state, event.paths))
          }
        })
      }
    })
  }

  const key = sessionId
  const existing = watches.get(key)

  if (existing && existing.root === root) {
    existing.users += 1
  } else {
    if (existing) {
      void existing.watchId.then(release)
    }

    watches.set(key, { watchId: window.heraldOS.fs.watchTree(root).catch(() => null), users: 1, root })
  }

  return () => {
    const watch = watches.get(key)

    if (!watch || watch.root !== root) {
      return
    }

    watch.users -= 1

    if (watch.users <= 0) {
      watches.delete(key)
      void watch.watchId.then(release)
    }
  }
}
