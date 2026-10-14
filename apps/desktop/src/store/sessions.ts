import type { SessionListRow } from '@herald-os/client'
import { atom } from 'nanostores'
import { isDefaultProfile, profileParam, sessionKey } from '../lib/bots.ts'
import { gatewayRequest, isGatewayOpen } from './gateway.ts'

export const $sessions = atom<SessionListRow[]>([])
export const $sessionsLoading = atom(false)
/** Each bot's sessions by profile; Hermes's are `$sessions`. */
export const $botSessions = atom<Record<string, SessionListRow[]>>({})

/** stored id -> runtime id, so the sidebar can highlight the live chat; a bot's are keyed by `sessionKey`. */
export const $runtimeIds = atom<Record<string, string>>({})

export function rememberRuntimeId(storedId: string, runtimeId: string, profile?: string): void {
  $runtimeIds.set({ ...$runtimeIds.get(), [sessionKey(storedId, profile)]: runtimeId })
}

/** Merge, don't clobber: keep rows we know about that a truncated list dropped. */
function merge(known: readonly SessionListRow[], incoming: readonly SessionListRow[]): SessionListRow[] {
  const seen = new Set(incoming.map(row => row.id))

  return [...incoming, ...known.filter(row => !seen.has(row.id))].sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
}

let inflight: Promise<void> | null = null

/** Reload Hermes's session list, or a bot's when `profile` names one. */
export function refreshSessions(profile?: string): Promise<void> {
  if (!isDefaultProfile(profile)) {
    return refreshBotSessions(profile)
  }

  if (!isGatewayOpen()) {
    return Promise.resolve()
  }

  if (inflight) {
    return inflight
  }

  $sessionsLoading.set(true)
  inflight = gatewayRequest('session.list', { limit: 60 })
    .then(result => {
      $sessions.set(merge($sessions.get(), result.sessions ?? []))
    })
    .catch(() => {
      // Keep the cached list; the next refresh retries.
    })
    .finally(() => {
      $sessionsLoading.set(false)
      inflight = null
    })

  return inflight
}

/** Bot Mode's group rooms speak to each member in a hidden session titled "Group: …"; the room drives it, so it is no conversation to reopen. */
const ROOM_SESSION = /^Group: /

const botInflight = new Map<string, Promise<void>>()

function refreshBotSessions(profile: string): Promise<void> {
  if (!isGatewayOpen()) {
    return Promise.resolve()
  }

  const running = botInflight.get(profile)

  if (running) {
    return running
  }

  // Hidden rows too: Bot Mode starts a bot's chats, its Bot Chat among them, hidden from Hermes Desktop's own session list.
  const request = gatewayRequest('session.list', { profile, limit: 60, include_hidden: true })
    .then(result => {
      const incoming = (result.sessions ?? []).filter(row => !ROOM_SESSION.test(row.title ?? ''))
      const lists = $botSessions.get()
      $botSessions.set({ ...lists, [profile]: merge(lists[profile] ?? [], incoming) })
    })
    .catch(() => {
      // Keep the cached list; the next refresh retries.
    })
    .finally(() => {
      botInflight.delete(profile)
    })

  botInflight.set(profile, request)

  return request
}

export async function deleteSession(storedId: string, profile?: string): Promise<void> {
  await gatewayRequest('session.delete', { session_id: storedId, ...profileParam(profile) })

  if (isDefaultProfile(profile)) {
    $sessions.set($sessions.get().filter(row => row.id !== storedId))
  } else {
    const lists = $botSessions.get()
    $botSessions.set({ ...lists, [profile]: (lists[profile] ?? []).filter(row => row.id !== storedId) })
  }
}
