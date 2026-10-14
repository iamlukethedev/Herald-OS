import type { GatewayEvent, SessionCreateResult, SessionResumeResult } from '@herald-os/client'
import { atom, computed, map } from 'nanostores'
import { ELSEWHERE_NOTE } from '../lib/attachments.ts'
import { isDefaultProfile, profileParam, sameProfile } from '../lib/bots.ts'
import { appendSystem, appendUser, type ChatState, emptyChat, fromTranscript, reduceChatEvent } from '../lib/chat-model.ts'
import { currentModelText } from '../lib/model-provider.ts'
import { attachFiles, hermesReadsLocalFiles } from './attachments.ts'
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

/** Chats started in the background for a surface that shows their replies itself (an Office window's Ask Hermes bar). */
const quietChats = new Set<string>()

function adopt(result: SessionCreateResult | SessionResumeResult, fallbackStored?: string, profile?: string): ChatState {
  const stored = result.stored_session_id ?? fallbackStored ?? result.session_id
  const state = emptyChat(result.session_id, stored, result.info)
  state.messages = fromTranscript(result.messages ?? [])
  state.title = result.info?.title ?? state.title
  const inflight = 'inflight' in result ? result.inflight : null

  if (!isDefaultProfile(profile)) {
    state.profile = profile
  }

  if (inflight?.assistant) {
    state.messages.push({ id: `inflight-${result.session_id}`, role: 'assistant', text: inflight.assistant, reasoning: '', streaming: Boolean(inflight.streaming), ts: Date.now() })
    state.openAssistantId = inflight.streaming ? `inflight-${result.session_id}` : null
  }

  state.streaming = Boolean(result.info?.running || ('running' in result && result.running))
  rememberRuntimeId(stored, result.session_id, profile)

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

    if (event.type === 'message.complete' && $activeChatId.get() !== sid && !quietChats.has(sid)) {
      notify({ title: next.title || 'Hermes', body: 'Finished a turn in another session', level: 'info', surface: 'chat', category: 'toolCompletion' })
    }

    if (event.type === 'session.title') {
      void refreshSessions(next.profile)
    }
  })
}

/** A new chat; it becomes the one the Hermes window shows unless `activate` is false, and then its turns end without a notification. */
export async function createChat(options: { cwd?: string; title?: string; activate?: boolean; profile?: string } = {}): Promise<ChatState> {
  const local = hermesReadsLocalFiles()
  // A Hermes that cannot read this computer's files works in its own folders, and knows the person's files are elsewhere.
  const cwd = options.cwd ?? (local ? ($prefs.get().defaultCwd ?? $env.get()?.homeDir ?? null) : null)
  const seed = local ? {} : { messages: [{ role: 'user', content: ELSEWHERE_NOTE, display_kind: 'hidden' }] }
  const result = await gatewayRequest('session.create', { source: SESSION_SOURCE, cwd, title: options.title ?? null, ...seed, ...profileParam(options.profile) })
  const state = adopt(result, undefined, options.profile)
  $chats.setKey(state.sessionId, state)

  if (options.activate !== false) {
    $activeChatId.set(state.sessionId)
  } else {
    quietChats.add(state.sessionId)
  }

  void refreshSessions(options.profile)

  return state
}

/** Reopen a stored session; a bot's needs its `profile`, since each profile keeps its own sessions. */
export async function openStoredSession(storedId: string, profile?: string): Promise<ChatState> {
  const existing = Object.values($chats.get()).find(chat => chat.storedSessionId === storedId && sameProfile(chat.profile, profile))

  if (existing) {
    $activeChatId.set(existing.sessionId)

    return existing
  }

  const result = await gatewayRequest('session.resume', { session_id: storedId, source: SESSION_SOURCE, ...profileParam(profile) })
  const state = adopt(result, storedId, profile)
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
  /** Files on this computer (absolute paths) for Hermes to receive with the prompt; see store/attachments.ts. */
  attachments?: readonly string[]
}

/**
 * Send a prompt to the active chat, creating one when none exists. Resolves with the session id
 * used. Rejects, before anything is sent, when an attachment cannot reach Hermes.
 */
export async function sendPrompt(text: string, options: SendPromptOptions = {}): Promise<string | null> {
  const trimmed = text.trim()
  const files = options.attachments ?? []

  if (!trimmed && files.length === 0) {
    return null
  }

  let sid = options.sessionId ?? $activeChatId.get()

  if (!sid || !$chats.get()[sid]) {
    sid = (await createChat({ cwd: options.cwd })).sessionId
  }

  const attached = await attachFiles(sid, files, $chats.get()[sid]?.info.desktop_contract)
  const message = [trimmed, attached].filter(Boolean).join('\n')
  const before = $chats.get()[sid]

  if (before) {
    $chats.setKey(sid, appendUser(before, message))
  }

  try {
    await gatewayRequest('prompt.submit', {
      session_id: sid,
      text: message,
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
    // Hermes answers a bare /model from the session's agent, which it builds once the session is
    // open, seconds later, and says "(unknown)" until then; model.options knows the model either way.
    const model = /^\/model\s*$/i.test(command.trim()) ? currentModelText(await gatewayRequest('model.options', { session_id: sid }).catch(() => null)) : null

    if (model) {
      const current = $chats.get()[sid]

      if (current) {
        $chats.setKey(sid, { ...appendSystem(current, model), streaming: false })
      }

      return
    }

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
