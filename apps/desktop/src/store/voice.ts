import type { VoiceEngine, VoicePrefs } from '../../shared/ipc.ts'
import { atom, computed } from 'nanostores'
import { $micLevel, $micOpen, setMicrophoneMuted } from '../lib/voice/audio-capture.ts'
import { earcons } from '../lib/voice/earcons.ts'
import type { ConversationEndReason, ConversationEngine, TurnHandlers, VoiceCaptions, VoiceHost, VoiceState } from '../lib/voice/engine.ts'
import { matchIntent } from '../lib/voice/intents.ts'
import { rememberFocusedEditable } from './edit-target.ts'
import { runCommand } from './os-commands.ts'
import { withProviderFallback } from '../lib/voice/provider-fallback.ts'
import { $speakLevel, speakOnce, stopFallbackAudio } from '../lib/voice/speak-stream.ts'
import { rest } from '../lib/rest.ts'
import { sanitizeForSpeech } from '../lib/voice/speech-text.ts'
import { type LocalSttConfig, sttTuningPatch } from '../lib/voice/stt-tuning.ts'
import { assistantTextSince, runningToolsSince, textDelta, toolsSince } from '../lib/voice/turn-text.ts'
import { decideVoiceApproval, voiceApprovalFor } from '../lib/voice/approval-answer.ts'
import { withScreenContext } from '../lib/screen-context.ts'
import type { ChatState, SystemMessage } from '../lib/chat-model.ts'
import { $prefs, updatePrefs } from './backend.ts'
import { $activeChatId, $chats, createChat, interruptChat, sendPrompt } from './chat.ts'
import { $gatewayReady, onGatewayEvent } from './gateway.ts'
import { notify } from './notifications.ts'
import { officeContextLine, screenContextLine } from './on-screen.ts'
import { $pendingRequests, resolveRequest } from './requests.ts'
import { isMainSurface, onShellCommand } from './shell.ts'
import { fetchLiveStatus, type LiveStatus } from './voice-live-status.ts'
import { pauseWake, resumeWake } from './wake.ts'

export type VoiceStartReason = 'hotkey' | 'wake' | 'button' | 'command'

export interface VoiceSnapshot {
  state: VoiceState
  /** Engine running the current conversation (null when idle). */
  engine: VoiceEngine | null
  muted: boolean
  captions: VoiceCaptions
  startedBy: VoiceStartReason | null
  /** Last failure, shown on the orb until the next start. */
  error: string | null
  /** Live engine accounting: seconds in the open session and today's total. */
  live: { sessionSeconds: number; todaySeconds: number; status: LiveStatus | null }
}

const EMPTY_CAPTIONS: VoiceCaptions = { user: '', assistant: '' }

export const $voice = atom<VoiceSnapshot>({
  state: 'off',
  engine: null,
  muted: false,
  captions: EMPTY_CAPTIONS,
  startedBy: null,
  error: null,
  live: { sessionSeconds: 0, todaySeconds: 0, status: null }
})

/** True while a conversation is running (any state past armed). */
export const $voiceActive = computed($voice, voice => voice.state !== 'off' && voice.state !== 'armed')
/** The Hermes session the conversation's turns go to: its approval cards can be answered by voice. */
export const $voiceSessionId = atom<string | null>(null)
/** Combined input/output level for the orb, 0..1. */
export const $voiceLevel = computed([$voice, $micLevel, $speakLevel], (voice, mic, speak) => (voice.state === 'speaking' ? speak : Math.min(1, mic * 4)))
export { $micOpen }

let engine: ConversationEngine | null = null
let starting = false

function patch(next: Partial<VoiceSnapshot>): void {
  $voice.set({ ...$voice.get(), ...next })
}

export const LIVE_RATE_PER_MINUTE = 0.05

export function todayKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** Seconds of Live session time already used today (resets when the day changes). */
export function liveSecondsToday(prefs: VoicePrefs = $prefs.get().voice, now = new Date()): number {
  return prefs.liveUsage.day === todayKey(now) ? prefs.liveUsage.seconds : 0
}

/** Seconds of Live time still allowed today; Infinity when uncapped. */
export function liveBudgetRemaining(prefs: VoicePrefs = $prefs.get().voice, now = new Date()): number {
  if (prefs.liveDailyCapMinutes <= 0) {
    return Number.POSITIVE_INFINITY
  }

  return Math.max(0, prefs.liveDailyCapMinutes * 60 - liveSecondsToday(prefs, now))
}

function recordLiveSeconds(seconds: number): void {
  if (seconds <= 0) {
    return
  }

  const prefs = $prefs.get().voice
  const day = todayKey()
  const total = (prefs.liveUsage.day === day ? prefs.liveUsage.seconds : 0) + seconds
  void updatePrefs({ voice: { ...prefs, liveUsage: { day, seconds: Math.round(total) } } })
  patch({ live: { ...$voice.get().live, todaySeconds: Math.round(total) } })
}

/** The last Hermes turn of this conversation used its tools; cleared when a fast-path command runs. */
let hermesActed = false

/** How long a spoken request waits for the turn it interrupted (an Office call cannot stop halfway) to end. */
const SETTLE_MS = 15_000
/** How long a request queued behind an interrupted turn may take to start once that turn has ended. */
const QUEUED_START_MS = 3000

type TurnStatus = 'complete' | 'error' | 'interrupted'

interface TurnEnd {
  status: TurnStatus
  error?: string
}

/** A spoken request sent to Hermes: where its reply starts, and the ends its session reported before anyone followed it. */
interface SentTurn {
  /** Index of the request in the chat; the reply is everything after it. */
  from: number
  /** The session was still running an earlier turn, whose interrupted end comes first. */
  queued: boolean
  ends: TurnEnd[]
  onEnd: ((end: TurnEnd) => void) | null
  release: () => void
}

const sentTurns = new Map<string, SentTurn>()
let requests = 0

/** Collect a session's turn ends from before a request goes out: a refusal or a fast failure can beat the answer to the submit. */
function watchEnds(sessionId: string, queued: boolean): SentTurn {
  const turn: SentTurn = { from: -1, queued, ends: [], onEnd: null, release: () => undefined }
  // After the reducer has applied the event, so the reply includes the final text.
  const report = (end: TurnEnd) => queueMicrotask(() => (turn.onEnd ? turn.onEnd(end) : void turn.ends.push(end)))
  const offComplete = onGatewayEvent('message.complete', event => {
    if (event.session_id === sessionId) {
      const status = event.payload?.status
      const error = event.payload?.error ?? (status === 'error' ? event.payload?.text : undefined)
      report({ status: status === 'error' ? 'error' : status === 'interrupted' ? 'interrupted' : 'complete', error: typeof error === 'string' ? error : undefined })
    }
  })
  const offError = onGatewayEvent('error', event => {
    if (event.session_id === sessionId) {
      // The failure text arrives here before any assistant bubble exists; carry it to the engine.
      report({ status: 'error', error: (event.payload as { message?: string } | undefined)?.message })
    }
  })

  turn.release = () => {
    offComplete()
    offError()
  }

  return turn
}

/** The chat a spoken request goes to: the one the Hermes window shows, or a new one. */
async function voiceSession(): Promise<string> {
  const active = $activeChatId.get()

  return active && $chats.get()[active] ? active : (await createChat()).sessionId
}

/** Wait for the turn still running in a session to end, for a while; true when it is still running. */
async function settle(sessionId: string): Promise<boolean> {
  const until = Date.now() + SETTLE_MS

  while ($chats.get()[sessionId]?.streaming && Date.now() < until) {
    await new Promise(done => setTimeout(done, 100))
  }

  return Boolean($chats.get()[sessionId]?.streaming)
}

/** Follow a turn's assistant text through the chat store until it ends; unsubscribes then. */
function observeTurn(sessionId: string, handlers: TurnHandlers): () => void {
  const sent = sentTurns.get(sessionId)
  sentTurns.delete(sessionId)
  const turn = sent ?? watchEnds(sessionId, false)
  const chat = $chats.get()[sessionId]
  // A turn sent some other way: its request is the chat's last message.
  const fromIndex = sent ? sent.from : chat ? chat.messages.length - 1 : -1
  let seen = ''
  let seenTools = new Set<string>()
  let done = false
  let skipped = false
  let starting: ReturnType<typeof setTimeout> | null = null
  hermesActed = false

  /** Stop following; the tools the turn ran, or null when it was over already. */
  const stop = (): string[] | null => {
    if (done) {
      return null
    }

    done = true

    if (starting) {
      clearTimeout(starting)
    }

    offChats()
    turn.release()
    const current = $chats.get()[sessionId]
    const tools = current ? toolsSince(current.messages, fromIndex) : []
    hermesActed = tools.length > 0

    return tools
  }

  const finish = (status: TurnStatus, error?: string) => {
    const tools = stop()

    if (tools) {
      handlers.onComplete(seen, status, error, tools)
    }
  }

  const follow = (current: ChatState) => {
    for (const name of runningToolsSince(current.messages, fromIndex)) {
      if (!seenTools.has(name)) {
        seenTools = new Set([...seenTools, name])
        handlers.onTool?.(name)
      }
    }

    const full = assistantTextSince(current.messages, fromIndex)
    const delta = textDelta(seen, full)

    if (delta) {
      seen = full
      handlers.onDelta(delta, full)
    } else if (full !== seen && full.length > 0) {
      // Authoritative final text replaced the stream (partial payload): re-sync without re-speaking.
      seen = full
    }
  }

  const offChats = $chats.subscribe(chats => {
    const current = chats[sessionId]

    if (!current || done) {
      return
    }

    if (starting && current.streaming) {
      clearTimeout(starting)
      starting = null
    }

    follow(current)
  })

  const onEnd = (end: TurnEnd) => {
    if (done) {
      return
    }

    const current = $chats.get()[sessionId]

    if (current) {
      follow(current)
    }

    if (end.status === 'interrupted' && turn.queued && !skipped) {
      // The turn this request waited behind has ended; the request's own turn starts next, unless the
      // session folded the request into that turn and dropped it with it.
      skipped = true
      starting = setTimeout(() => {
        starting = null

        if (!$chats.get()[sessionId]?.streaming) {
          finish('interrupted')
        }
      }, QUEUED_START_MS)

      return
    }

    finish(end.status, end.error)
  }

  turn.onEnd = onEnd

  for (const end of turn.ends.splice(0)) {
    onEnd(end)
  }

  // A request the gateway refused never starts a turn; sendPrompt leaves the refusal right after it.
  const current = $chats.get()[sessionId]
  const refusal = current && !current.streaming && fromIndex >= 0 ? current.messages.slice(fromIndex + 1).find((message): message is SystemMessage => message.role === 'system' && message.level === 'error') : undefined

  if (refusal) {
    finish('error', refusal.text)
  }

  // The engine has moved on (barge-in, a newer request, the end of the conversation): no end to report.
  return () => void stop()
}

/** Voice fast path: a matching registry command runs immediately; a failed run falls back to Hermes. */
export async function runVoiceIntent(text: string): Promise<{ handled: boolean; spoken: string; ok: boolean }> {
  // Right after Hermes moved or changed something, "undo that" is about its change, not the text field.
  const intent = matchIntent(text, undefined, { afterHermesAction: hermesActed })

  if (!intent) {
    return { handled: false, spoken: '', ok: false }
  }

  const result = await runCommand(intent.command, intent.args, { source: 'voice' })

  if (!result.ok) {
    // The words matched but the OS could not do it (unknown name, nothing selected): let Hermes reason.
    return { handled: false, spoken: result.error ?? result.summary, ok: false }
  }

  hermesActed = false

  return { handled: true, spoken: result.spoken ?? result.summary, ok: true }
}

const host: VoiceHost = {
  prefs: () => $prefs.get().voice,
  setState: state => patch({ state }),
  setCaptions: captions => patch({ captions: { ...$voice.get().captions, ...captions } }),
  // The Office and screen lines ride with the spoken context (model input only), so "this folder",
  // "this file" and "this sheet" mean what is open and shown while the person's words stay exactly as said.
  submit: async (text, options) => {
    const request = ++requests
    const target = await voiceSession()
    // Sent while the turn it interrupted still runs, the request would wait behind that turn or be dropped with it.
    const queued = options.interrupted ? await settle(target) : Boolean($chats.get()[target]?.streaming)

    if (request !== requests) {
      return null
    }

    const office = await officeContextLine()
    const turn = watchEnds(target, queued)
    let sessionId: string | null = null

    try {
      sessionId = await sendPrompt(text, { sessionId: target, surface: 'voice-live', voiceContext: withScreenContext(options.voiceContext, screenContextLine(), office), interrupted: options.interrupted })
    } finally {
      // A reconnect can drop the chat meanwhile; sendPrompt then starts another.
      if (sessionId !== target) {
        turn.release()
      }
    }

    if (sessionId) {
      const sent = sessionId === target ? turn : watchEnds(sessionId, false)
      const words = text.trim()
      sent.from = $chats.get()[sessionId]?.messages.findLastIndex(message => message.role === 'user' && message.text === words) ?? -1
      sentTurns.get(sessionId)?.release()
      sentTurns.set(sessionId, sent)
      $voiceSessionId.set(sessionId)
    }

    return sessionId
  },
  runIntent: runVoiceIntent,
  interrupt: () => interruptChat($voiceSessionId.get() ?? undefined).catch(() => undefined),
  approvalPending: () => voiceApprovalFor($pendingRequests.get(), $voiceSessionId.get()) !== null,
  answerApproval: text => {
    const decision = decideVoiceApproval($pendingRequests.get(), $voiceSessionId.get(), text)

    if (!decision) {
      return null
    }

    resolveRequest(decision.requestId, { choice: decision.choice })

    return decision.answer
  },
  observeTurn,
  ended: (reason, detail) => void endConversation(reason, detail),
  notify: (title, body, level = 'info') => {
    notify({ title, body, level, surface: 'chat' })
  },
  recordLiveSeconds,
  setLiveSeconds: setLiveSessionSeconds
}

async function loadEngine(kind: VoiceEngine): Promise<ConversationEngine> {
  if (kind === 'live') {
    const { LiveEngine } = await import('../lib/voice/live-engine.ts')

    return new LiveEngine(host)
  }

  const { ChainedEngine } = await import('../lib/voice/chained-engine.ts')

  return new ChainedEngine(host)
}

/** Which engine a new conversation would use right now, and why not Live when it was asked for. */
export async function resolveEngine(prefs: VoicePrefs = $prefs.get().voice): Promise<{ engine: VoiceEngine; fallbackReason: string | null }> {
  if (prefs.engine !== 'live') {
    return { engine: 'chained', fallbackReason: null }
  }

  if (liveBudgetRemaining(prefs) <= 0) {
    return { engine: 'chained', fallbackReason: `Live daily cap of ${prefs.liveDailyCapMinutes} min reached; using the free engine.` }
  }

  const status = await fetchLiveStatus()
  patch({ live: { ...$voice.get().live, status } })

  if (!status.available) {
    return { engine: 'chained', fallbackReason: status.reason ?? 'GPT-Live is not available; using the free engine.' }
  }

  return { engine: 'live', fallbackReason: null }
}

export async function startVoice(reason: VoiceStartReason = 'button'): Promise<void> {
  const prefs = $prefs.get().voice

  if (engine || starting) {
    return
  }

  if (!$gatewayReady.get()) {
    notify({ title: 'Voice', body: 'Hermes is still connecting; try again in a moment.', level: 'warn' })

    return
  }

  starting = true
  // "Type …" should land in the field the user was in before the mic took focus.
  rememberFocusedEditable()

  // Turning voice on by using it: the first conversation flips the master switch.
  if (!prefs.enabled) {
    void updatePrefs({ voice: { ...prefs, enabled: true } })
  }

  patch({ state: 'connecting', startedBy: reason, error: null, captions: EMPTY_CAPTIONS, muted: false, live: { ...$voice.get().live, sessionSeconds: 0, todaySeconds: liveSecondsToday(prefs) } })

  try {
    const resolved = await resolveEngine(prefs)

    if (resolved.fallbackReason) {
      notify({ title: 'Voice', body: resolved.fallbackReason, level: 'info' })
    }

    await pauseWake()
    const next = await loadEngine(resolved.engine)
    engine = next
    patch({ engine: resolved.engine })
    await next.start()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    engine = null
    patch({ state: idleState(), engine: null, error: message })
    earcons.error()
    notify({ title: 'Voice could not start', body: message, level: 'error' })
    void resumeWake()
  } finally {
    starting = false
  }
}

function idleState(): VoiceState {
  const prefs = $prefs.get().voice

  return prefs.enabled && prefs.wakeWord ? 'armed' : 'off'
}

export async function endConversation(reason: ConversationEndReason = 'user', detail?: string): Promise<void> {
  const current = engine
  engine = null
  hermesActed = false
  $voiceSessionId.set(null)
  stopFallbackAudio()

  for (const turn of sentTurns.values()) {
    turn.release()
  }

  sentTurns.clear()

  if (current) {
    try {
      await current.stop()
    } catch {
      // Teardown is best effort.
    }
  }

  const error = reason === 'error' || reason === 'connection-lost' ? (detail ?? 'The conversation ended unexpectedly.') : null
  patch({ state: idleState(), engine: null, muted: false, error, startedBy: null })

  if (error) {
    earcons.error()
    notify({ title: 'Voice ended', body: error, level: 'warn' })
  } else if (reason === 'cap') {
    earcons.end()
    notify({ title: 'Live paused for today', body: detail ?? 'The Live daily cap was reached; the free engine still works.', level: 'info' })
  } else if (reason !== 'silence') {
    earcons.end()
  }

  void resumeWake()
}

export function stopVoice(): Promise<void> {
  return endConversation('user')
}

/**
 * Hand a final transcript to the running conversation, exactly where the microphone path hands its
 * own (typed fallback, tests). False when no conversation runs or its engine hears only by itself.
 */
export async function submitVoiceTranscript(text: string): Promise<boolean> {
  if (!engine?.submitTranscript) {
    return false
  }

  await engine.submitTranscript(text)

  return true
}

export function toggleVoice(reason: VoiceStartReason = 'button'): Promise<void> {
  return engine || starting ? endConversation('user') : startVoice(reason)
}

export function toggleMute(): void {
  const muted = !$voice.get().muted
  setMicrophoneMuted(muted)
  engine?.setMuted(muted)
  patch({ muted })
}

/** The orb's "stop talking" button: cut speech, keep the conversation. */
export function interruptSpeech(): void {
  engine?.interrupt()
}

/** Live engine progress: seconds in the current paid session. */
export function setLiveSessionSeconds(seconds: number): void {
  patch({ live: { ...$voice.get().live, sessionSeconds: seconds } })
}

/** Speak a line, switching the Hermes TTS provider to the free one when the configured one cannot run. */
export function speakWithFreeFallback(text: string, signal?: { stopped: boolean }): Promise<void> {
  return withProviderFallback(
    'tts',
    () => speakOnce(text, signal),
    (from, to) => notify({ title: 'Text to speech switched', body: `${from ?? 'The configured provider'} is not set up; using the free ${to} voice. Change it in Settings > Voice.`, level: 'info' })
  )
}

let announcing: { stopped: boolean } | null = null

/** Speak a notification body when the user opted in and nothing else is talking. */
async function announce(text: string): Promise<void> {
  const prefs = $prefs.get().voice

  if (!prefs.enabled || !prefs.announceNotifications || $prefs.get().doNotDisturb || engine || announcing) {
    return
  }

  const spoken = sanitizeForSpeech(text).slice(0, 600)

  if (!spoken) {
    return
  }

  announcing = { stopped: false }

  try {
    await speakWithFreeFallback(spoken, announcing)
  } catch {
    // Announcements are optional; the toast already showed the text.
  } finally {
    announcing = null
  }
}

/** Handle a voice command from the CLI, another surface, or the global hotkey. */
export function handleVoiceCommand(action: string, reason: VoiceStartReason): void {
  switch (action) {
    case 'toggle':
      void toggleVoice(reason)
      break
    case 'start':
      void startVoice(reason)
      break
    case 'stop':
      void endConversation('user')
      break
    case 'mute':
      toggleMute()
      break
    default:
      break
  }
}

let bound = false

let tuningStt = false

/** Once per install: switch local transcription to the accurate model and teach it Herald OS words. */
async function tuneLocalStt(): Promise<void> {
  const voice = $prefs.get().voice

  if (tuningStt || voice.sttTuned || !voice.enabled) {
    return
  }

  tuningStt = true

  try {
    const patch = sttTuningPatch(await rest.get<LocalSttConfig>('/api/config'))

    if (patch) {
      await rest.put('/api/config', { config: patch })
    }

    await updatePrefs({ voice: { ...$prefs.get().voice, sttTuned: true } })
  } catch (error) {
    console.warn('[voice] could not tune local speech recognition', error)
  } finally {
    tuningStt = false
  }
}

/** Wire the voice layer once per renderer window; only the Hermes window runs conversations. */
export function bindVoice(): () => void {
  if (bound || !isMainSurface) {
    return () => undefined
  }

  bound = true
  patch({ state: idleState(), live: { ...$voice.get().live, todaySeconds: liveSecondsToday() } })

  const offPrefs = $prefs.subscribe(prefs => {
    if (!engine && !starting) {
      const next = prefs.voice.enabled && prefs.voice.wakeWord ? 'armed' : 'off'

      if ($voice.get().state !== next) {
        patch({ state: next })
      }
    }

    if (!prefs.voice.enabled && engine) {
      void endConversation('user')
    }

    if (prefs.voice.enabled && !prefs.voice.sttTuned && $gatewayReady.get()) {
      void tuneLocalStt()
    }
  })
  const offHotkey = window.heraldOS.voice?.onHotkey?.(() => handleVoiceCommand('toggle', 'hotkey')) ?? (() => undefined)
  const offCommand = onShellCommand(command => {
    if (command.type === 'voice') {
      handleVoiceCommand(command.args?.[0] ?? 'toggle', 'command')
    } else if (command.type.startsWith('voice-')) {
      handleVoiceCommand(command.type.slice('voice-'.length), 'command')
    }
  })
  const offNotify = onGatewayEvent('notification.show', event => {
    const text = event.payload?.text

    if (text) {
      void announce(text)
    }
  })
  const offReady = $gatewayReady.subscribe(ready => {
    if (!ready && engine) {
      void endConversation('connection-lost', 'Lost the connection to Hermes.')
    }

    if (ready) {
      void tuneLocalStt()
    }
  })

  return () => {
    offPrefs()
    offHotkey()
    offCommand()
    offNotify()
    offReady()
    bound = false
  }
}
