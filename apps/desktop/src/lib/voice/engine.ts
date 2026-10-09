// Contract between the voice store and a conversation engine (chained or live). The store owns
// the user-visible state and Hermes sessions; an engine owns audio transport for one conversation.
import type { VoiceEngine, VoicePrefs } from '../../../shared/ipc.ts'

export type VoiceState = 'off' | 'armed' | 'connecting' | 'listening' | 'transcribing' | 'thinking' | 'speaking'

export interface VoiceCaptions {
  /** What the user last said (final transcript). */
  user: string
  /** What Hermes is saying / said in this turn. */
  assistant: string
  /** Live engine: the model's own words when it answers without delegating. */
  interim?: string
}

export type ConversationEndReason = 'user' | 'stop-phrase' | 'idle' | 'cap' | 'silence' | 'error' | 'connection-lost' | 'unavailable'

export interface TurnHandlers {
  /** New assistant text (already appended to `full`). */
  onDelta(delta: string, full: string): void
  /** A tool started running; `name` is the tool id/name for progress notes. */
  onTool?(name: string): void
  /**
   * The turn finished (message.complete or error); `error` carries the backend's message when it failed,
   * `tools` names the tools the turn ran.
   */
  onComplete(full: string, status: 'complete' | 'error' | 'interrupted', error?: string, tools?: readonly string[]): void
}

/**
 * What to say when a turn ended with nothing to say: Hermes did the work without a word, stopped
 * before it finished, or answered nothing at all. Null when the reply has words to speak.
 */
export function silentTurnLine(spoken: string, status: 'complete' | 'interrupted', tools: readonly string[] = []): { spoken: string; problem: boolean } | null {
  if (spoken.trim()) {
    return null
  }

  if (status === 'interrupted') {
    return { spoken: 'Hermes stopped before it finished. Please ask again.', problem: true }
  }

  return tools.length > 0 ? { spoken: 'Done.', problem: false } : { spoken: 'Hermes did not answer that. Please ask again.', problem: true }
}

export interface TurnErrorDescription {
  kind: 'auth' | 'provider' | 'rate-limit' | 'other'
  spoken: string
  title: string
  body: string
  /** The user can fix it (sign in, configure a provider); retrying as-is will fail again. */
  fixable: boolean
}

/** What to say and show when a Hermes turn fails; recognises the errors a user can fix themselves. */
export function describeTurnError(error: string | undefined): TurnErrorDescription {
  const text = (error ?? '').trim()

  if (/access token|logged out|not logged in|login|relogin|Nous Portal|oauth|unauthori[sz]ed|\b401\b|invalid_grant|refresh session/i.test(text)) {
    // The shell opens its sign-in card for this (store/hermes-auth.ts); the voice just says so.
    return { kind: 'auth', spoken: 'Hermes is signed out, so I cannot answer yet. I have opened the sign-in for you on screen.', title: 'Hermes is signed out', body: text || 'No access token for the model provider.', fixable: true }
  }

  if (/api key|no credentials|not configured|no model|provider/i.test(text)) {
    return { kind: 'provider', spoken: 'Hermes has no working model provider configured. Please check the Hermes settings.', title: 'Model provider not configured', body: text || 'Hermes could not reach a model provider.', fixable: true }
  }

  if (/rate limit|quota|429|insufficient/i.test(text)) {
    return { kind: 'rate-limit', spoken: 'The model provider is rate limiting Hermes right now. Please try again in a moment.', title: 'Provider rate limit', body: text, fixable: false }
  }

  return { kind: 'other', spoken: 'Sorry, that request failed.', title: 'Hermes turn failed', body: text || 'The turn ended with an error.', fixable: false }
}

/** What an engine may ask of the shell. */
export interface VoiceHost {
  prefs(): VoicePrefs
  setState(state: VoiceState): void
  setCaptions(patch: Partial<VoiceCaptions>): void
  /** Submit a spoken utterance as a Hermes turn; resolves with the session id or null when empty. */
  submit(text: string, options: { voiceContext?: string; interrupted?: boolean }): Promise<string | null>
  /**
   * The fast path: run the utterance as an OS command when it matches one (open a page, show
   * memory, pause an automation) without a Hermes turn. `handled: false` means "send it to Hermes".
   */
  runIntent(text: string): Promise<{ handled: boolean; spoken: string; ok: boolean }>
  /** Stop the in-flight Hermes turn (barge-in). */
  interrupt(): Promise<void>
  /** One of this conversation's approval cards is waiting for an answer. */
  approvalPending(): boolean
  /**
   * Words heard while a card waits: a short "yes" or "no" decides this conversation's card (allow
   * once, or deny) and returns the answer; null when no card waits or the words are no answer.
   */
  answerApproval(text: string): 'approve' | 'deny' | null
  /** Follow the assistant text of a turn on `sessionId`; the returned function stops following without reporting an end. */
  observeTurn(sessionId: string, handlers: TurnHandlers): () => void
  /** The engine ended the conversation on its own (idle, stop phrase, error). */
  ended(reason: ConversationEndReason, detail?: string): void
  notify(title: string, body: string, level?: 'info' | 'warn' | 'error'): void
  /** Live engine: account paid session seconds (persisted for the daily cap). */
  recordLiveSeconds(seconds: number): void
  /** Live engine: seconds the current paid session has been open (for the orb meter). */
  setLiveSeconds(seconds: number): void
}

export interface ConversationEngine {
  readonly kind: VoiceEngine
  start(): Promise<void>
  /** Graceful end requested by the user or the shell. */
  stop(): Promise<void>
  setMuted(muted: boolean): void
  /** The user asked Hermes to stop talking (orb button); listening continues. */
  interrupt(): void
  /** A final transcript handed in rather than heard (typed fallback, tests); the microphone's own path. */
  submitTranscript?(text: string): Promise<void>
}
