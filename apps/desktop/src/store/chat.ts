import type { GatewayEvent, SessionCreateResult, SessionResumeResult } from '@herald-os/client'
import { atom, computed, map } from 'nanostores'
import { appendSystem, appendUser, type ChatState, emptyChat, fromTranscript, reduceChatEvent } from '../lib/chat-model.ts'
import { $env, $prefs } from './backend.ts'
import { gatewayRequest, onAnyGatewayEvent } from './gateway.ts'
import { notify } from './notifications.ts'
import { refreshSessions, rememberRuntimeId } from './sessions.ts'

export const SESSION_SOURCE = 'herald_os'
/** Sessions this shell lists: its own (including those saved before the rename) and other interactive clients. */
export const LISTED_SESSION_SOURCES: ReadonlySet<string> = new Set([SESSION_SOURCE, 'hermes_os', 'desktop', 'cli', 'tui'])

/** Live chat state per runtime session id. */
export const $chats = map<Record<string, ChatState>>({})
export const $activeChatId = atom<string | null>(null)
export const $activeChat = computed([$chats, $activeChatId], (chats, id) => (id ? (chats[id] ?? null) : null))

const CHAT_EVENTS = new Set<GatewayEvent['type']>([
  'message.start',
  'message.delta',
  'message.interim',
  'message.complete',
  'thinking.delta',
  'reasoning.delta',
  'tool.start',
  'tool.complete',
  'status.update',
  'session.title',
  'session.info',
  'session.usage',
  'error'
])

function adopt(result: SessionCreateResult | SessionResumeResult, fallbackStored?: string): ChatState {
  const stored = result.stored_session_id ?? fallbackStored ?? result.session_id
  const state = emptyChat(result.session_id, stored, result.info)
  state.messages = fromTranscript(result.messages ?? [])
  state.title = result.info?.title ?? state.title
  const inflight = 'inflight' in result ? result.inflight : null

  if (inflight?.assistant) {
    state.messages.push({ id: `inflight-${result.session_id}`, role: 'assistant', text: inflight.assistant, reasoning: '', streaming: Boolean(inflight.streaming), ts: Date.now() })
    state.openAssistantId = inflight.streaming ? `inflight-${result.session_id}` : null
  }

  state.streaming = Boolean(result.info?.running || ('running' in result && result.running))
  rememberRuntimeId(stored, result.session_id)

  return state
}

export function bindChatEvents(): () => void {
  return onAnyGatewayEvent(event => {
    const sid = event.session_id

    if (!sid || !CHAT_EVENTS.has(event.type)) {
      return
    }

    const current = $chats.get()[sid]

    if (!current) {
      return
    }

    const next = reduceChatEvent(current, event)

    if (next !== current) {
      $chats.setKey(sid, next)
    }

    if (event.type === 'message.complete' && $activeChatId.get() !== sid) {
      notify({ title: next.title || 'Hermes', body: 'Finished a turn in another session', level: 'info', surface: 'chat' })
    }

    if (event.type === 'session.title') {
      void refreshSessions()
    }
  })
}

/** A new chat; it becomes the one the Hermes window shows unless `activate` is false. */
export async function createChat(options: { cwd?: string; title?: string; activate?: boolean } = {}): Promise<ChatState> {
  const cwd = options.cwd ?? $prefs.get().defaultCwd ?? $env.get()?.homeDir ?? null
  const result = await gatewayRequest('session.create', { source: SESSION_SOURCE, cwd, title: options.title ?? null })
  const state = adopt(result)
  $chats.setKey(state.sessionId, state)

  if (options.activate !== false) {
    $activeChatId.set(state.sessionId)
  }

  void refreshSessions()

  return state
}

export async function openStoredSession(storedId: string): Promise<ChatState> {
  const existing = Object.values($chats.get()).find(chat => chat.storedSessionId === storedId)

  if (existing) {
    $activeChatId.set(existing.sessionId)

    return existing
  }

  const result = await gatewayRequest('session.resume', { session_id: storedId, source: SESSION_SOURCE })
  const state = adopt(result, storedId)
  $chats.setKey(state.sessionId, state)
  $activeChatId.set(state.sessionId)

  return state
}

export interface SendPromptOptions {
  sessionId?: string
  cwd?: string
  /**
   * Client surface the turn comes from. `voice-live` makes the backend prepend its spoken-reply
   * note (short, no markdown) and accept `voiceContext`; the default is the shell itself.
   */
  surface?: 'voice-live'
  /** Recent spoken exchange (newest last) so "yes" or "Thursday, not Friday" has its referent. */
  voiceContext?: string
  /** The user spoke over an in-flight reply; the backend notes the interruption for the model. */
  interrupted?: boolean
}

/** Send a prompt to the active chat, creating one when none exists. Resolves with the session id used. */
export async function sendPrompt(text: string, options: SendPromptOptions = {}): Promise<string | null> {
  const trimmed = text.trim()

  if (!trimmed) {
    return null
  }

  let sid = options.sessionId ?? $activeChatId.get()

  if (!sid || !$chats.get()[sid]) {
    sid = (await createChat({ cwd: options.cwd })).sessionId
  }

  const before = $chats.get()[sid]

  if (before) {
    $chats.setKey(sid, appendUser(before, trimmed))
  }

  try {
    await gatewayRequest('prompt.submit', {
      session_id: sid,
      text: trimmed,
      surface: options.surface ?? SESSION_SOURCE,
      ...(options.surface && options.voiceContext ? { voice_context: options.voiceContext } : {}),
      ...(options.interrupted ? { interrupted: true } : {})
    })
  } catch (error) {
    const current = $chats.get()[sid]

    if (current) {
      $chats.setKey(sid, { ...appendSystem(current, error instanceof Error ? error.message : String(error), 'error'), streaming: false })
    }
  }

  return sid
}

export async function runSlash(command: string, sessionId?: string): Promise<void> {
  let sid = sessionId ?? $activeChatId.get()

  if (!sid || !$chats.get()[sid]) {
    sid = (await createChat()).sessionId
  }

  const chat = $chats.get()[sid]

  if (chat) {
    $chats.setKey(sid, appendUser(chat, command))
  }

  try {
    const result = await gatewayRequest('slash.exec', { session_id: sid, command })
    const current = $chats.get()[sid]

    if (!current) {
      return
    }

    if (result.type === 'send' || result.type === 'skill') {
      // The command resolved to a message the agent should receive.
      $chats.setKey(sid, { ...current, streaming: true })
      await gatewayRequest('prompt.submit', { session_id: sid, text: result.message ?? command, surface: SESSION_SOURCE })

      return
    }

    const text = [result.display ?? result.output ?? '', result.notice ?? '', result.warning ?? ''].filter(Boolean).join('\n\n')
    $chats.setKey(sid, { ...appendSystem(current, text || `${command} done`), streaming: false })
  } catch (error) {
    const current = $chats.get()[sid]

    if (current) {
      $chats.setKey(sid, { ...appendSystem(current, error instanceof Error ? error.message : String(error), 'error'), streaming: false })
    }
  }
}

export async function interruptChat(sessionId?: string): Promise<void> {
  const sid = sessionId ?? $activeChatId.get()

  if (!sid) {
    return
  }

  await gatewayRequest('session.interrupt', { session_id: sid })
}

export function forgetChat(sessionId: string): void {
  const next = { ...$chats.get() }
  delete next[sessionId]
  $chats.set(next)

  if ($activeChatId.get() === sessionId) {
    $activeChatId.set(null)
  }
}

export function resetChats(): void {
  $chats.set({})
  $activeChatId.set(null)
}
