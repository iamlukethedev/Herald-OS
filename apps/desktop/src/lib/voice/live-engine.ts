// The Live engine: OpenAI `gpt-live-1` owns the microphone and speaker over WebRTC (full duplex,
// natural interruptions) and DELEGATES every real request to Hermes. Herald OS turns each
// `session.delegation.created` into a normal Hermes turn and streams the reply back over the
// `oai-events` data channel as `session.commentary.append`, which the voice paraphrases aloud.
//
// Cost model (why this engine is opt-in): the session bills per second while open, so the engine
// opens it only for a conversation, closes it after `liveIdleSeconds` of silence, and refuses to
// open when today's cap is spent. The OpenAI key stays on the backend (`/api/audio/voice-live/*`).
import { rest } from '../rest.ts'
import { microphoneStream, MicrophoneUnavailableError, setMicrophoneMuted } from './audio-capture.ts'
import { earcons } from './earcons.ts'
import { type ConversationEngine, describeTurnError, silentTurnLine, type VoiceHost } from './engine.ts'
import { $speakLevel } from './speak-stream.ts'
import { chunkForCommentary, isStopPhrase, sanitizeForSpeech, SentenceChunker } from './speech-text.ts'

const CLOSE_TIMEOUT_MS = 15_000
const ICE_GATHER_TIMEOUT_MS = 10_000
const CONTEXT_WINDOW_MS = 5 * 60_000
const CONTEXT_MAX_FRAGMENTS = 80
/** Silence after the user's last words before a stop phrase is acted on. */
const STOP_WORD_SETTLE_MS = 1500
/** How often the meter ticks and the idle rule is evaluated. */
const TICK_MS = 1000

export interface LiveTranscriptFragment {
  speaker: 'assistant' | 'user'
  text: string
  startMs: number
  endMs: number
}

interface LiveServerEvent {
  type: string
  event_id?: string
  client_event_id?: string
  delta?: string
  start_ms?: number
  end_ms?: number
  delegation?: { id: string; type: string; target: string }
  error?: { type?: string; code?: null | string; message?: string }
  usage?: { seconds?: number }
  reason?: string
  session?: { id: string }
}

interface LiveHistoryMessage {
  type: 'message'
  role: 'assistant' | 'user'
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>
}

/** Turn transcript fragments into a Hermes turn: the user's last words plus the spoken exchange. */
export function delegationPrompt(context: LiveTranscriptFragment[]): { prompt: string; voiceContext: string } {
  const turns: Array<{ speaker: 'assistant' | 'user'; text: string }> = []

  for (const fragment of context) {
    const last = turns[turns.length - 1]

    if (last && last.speaker === fragment.speaker) {
      last.text += fragment.text
    } else {
      turns.push({ speaker: fragment.speaker, text: fragment.text })
    }
  }

  const lastUser = [...turns].reverse().find(turn => turn.speaker === 'user')
  const prompt = (lastUser?.text ?? '').replace(/\s+/g, ' ').trim()
  const voiceContext = turns
    .map(turn => `${turn.speaker === 'user' ? 'User' : 'Voice assistant'}: ${turn.text.replace(/\s+/g, ' ').trim()}`)
    .filter(line => !line.endsWith(': '))
    .join('\n')

  return { prompt: prompt || voiceContext.slice(-400), voiceContext }
}

/** Reduce a live data-channel event to what the engine reacts to (pure, unit-tested). */
export type LiveEventAction =
  | { kind: 'started'; sessionId: string | null }
  | { kind: 'transcript'; fragment: LiveTranscriptFragment }
  | { kind: 'delegation'; id: string }
  | { kind: 'error'; message: string; ignorable: boolean }
  | { kind: 'closed'; reason: string; usageSeconds: number | null }
  | { kind: 'ignore' }

export function reduceLiveEvent(raw: string): LiveEventAction {
  let event: LiveServerEvent

  try {
    event = JSON.parse(raw) as LiveServerEvent
  } catch {
    return { kind: 'ignore' }
  }

  switch (event.type) {
    case 'session.started':
      return { kind: 'started', sessionId: event.session?.id ?? null }
    case 'session.input_transcript.delta':
    case 'session.output_transcript.delta':
      return {
        kind: 'transcript',
        fragment: { speaker: event.type === 'session.input_transcript.delta' ? 'user' : 'assistant', text: event.delta ?? '', startMs: event.start_ms ?? 0, endMs: event.end_ms ?? 0 }
      }
    case 'session.delegation.created':
      return event.delegation?.id ? { kind: 'delegation', id: event.delegation.id } : { kind: 'ignore' }
    case 'error':
      return { kind: 'error', message: event.error?.message ?? 'GPT-Live error', ignorable: event.error?.code === 'context_injection_incomplete' }
    case 'session.closed':
      return { kind: 'closed', reason: event.reason ?? 'closed', usageSeconds: event.usage?.seconds ?? null }
    default:
      return { kind: 'ignore' }
  }
}

async function waitForIceGathering(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === 'complete') {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      connection.removeEventListener('icegatheringstatechange', onState)
      // Trickle is fine: the vendor answers with the candidates it has.
      resolve()
    }, ICE_GATHER_TIMEOUT_MS)

    function onState() {
      if (connection.iceGatheringState === 'complete') {
        window.clearTimeout(timeout)
        connection.removeEventListener('icegatheringstatechange', onState)
        resolve()
      }
    }

    connection.addEventListener('icegatheringstatechange', onState)
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'failed') {
        window.clearTimeout(timeout)
        reject(new Error('WebRTC connection failed'))
      }
    })
  })
}

export class LiveEngine implements ConversationEngine {
  readonly kind = 'live' as const

  private peer: RTCPeerConnection | null = null
  private events: RTCDataChannel | null = null
  private readonly audio: HTMLAudioElement
  private analyser: AnalyserNode | null = null
  private audioContext: AudioContext | null = null
  private transcript: LiveTranscriptFragment[] = []
  private eventCounter = 0
  private finalized = false
  private stopping = false
  private closeTimer: ReturnType<typeof setTimeout> | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private openedAt = 0
  private accountedSeconds = 0
  private lastUserSpeechAt = 0
  private lastAssistantSpeechAt = 0
  private stopWordTimer: ReturnType<typeof setTimeout> | null = null
  private pendingUserText = ''

  private activeDelegationId: string | null = null
  private stopObserving: (() => void) | null = null
  private turnBusy = false
  private readonly spoken = new SentenceChunker()

  constructor(private readonly host: VoiceHost) {
    this.audio = new Audio()
    this.audio.autoplay = true
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  async start(): Promise<void> {
    this.host.setState('connecting')
    const connection = new RTCPeerConnection()
    this.peer = connection

    connection.addEventListener('track', event => {
      const stream = new MediaStream([event.track])
      this.audio.srcObject = stream
      void this.audio.play().catch(() => undefined)
      this.armLevelProbe(stream)
    })
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') {
        this.finish('connection_lost', null)
      }
    })

    let microphone: MediaStream

    try {
      microphone = await microphoneStream()
    } catch (error) {
      connection.close()
      this.peer = null
      throw error instanceof MicrophoneUnavailableError ? error : new Error(`Microphone failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    for (const track of microphone.getAudioTracks()) {
      connection.addTrack(track, microphone)
    }

    // Register the data channel before the offer so its m-line is negotiated.
    const events = connection.createDataChannel('oai-events')
    this.events = events
    events.addEventListener('message', ({ data }) => this.onEvent(String(data)))
    events.addEventListener('close', () => {
      if (!this.finalized) {
        this.finish('connection_lost', null)
      }
    })

    const offer = await connection.createOffer()
    await connection.setLocalDescription(offer)
    await waitForIceGathering(connection)
    const sdp = connection.localDescription?.sdp

    if (!sdp) {
      throw new Error('Missing local SDP offer')
    }

    let response: { ok?: boolean; session?: { id: string }; transport?: { sdp: string; type: string } }

    try {
      response = await rest.post('/api/audio/voice-live/session', { sdp, history: this.seedHistory() })
    } catch (error) {
      connection.close()
      this.peer = null
      throw new Error(`GPT-Live session could not be created: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!response?.transport?.sdp) {
      connection.close()
      this.peer = null
      throw new Error('GPT-Live session creation returned no answer')
    }

    await connection.setRemoteDescription({ sdp: response.transport.sdp, type: 'answer' })
    this.openedAt = Date.now()
    this.lastUserSpeechAt = this.openedAt
    this.lastAssistantSpeechAt = this.openedAt
    this.ticker = setInterval(() => this.tick(), TICK_MS)
    this.host.setState('listening')
    earcons.listen()
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.close()
  }

  setMuted(muted: boolean): void {
    setMicrophoneMuted(muted)
    this.send({ event_id: this.nextEventId(muted ? 'mute' : 'unmute'), type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute' })
  }

  /** The user pressed stop: cut Hermes's in-flight work; the live model handles its own speech. */
  interrupt(): void {
    if (this.turnBusy) {
      this.stopObserving?.()
      this.stopObserving = null
      this.turnBusy = false
      void this.host.interrupt()
      this.host.setState('listening')
    }

    this.send({ content: 'The user asked you to stop; stop speaking and wait.', delegation_id: null, event_id: this.nextEventId('instr'), type: 'session.instructions.append' })
  }

  // ---- transport -------------------------------------------------------------------------------

  private nextEventId(prefix: string): string {
    this.eventCounter += 1

    return `${prefix}_${this.eventCounter}`
  }

  private send(event: Record<string, unknown>): boolean {
    if (!this.events || this.events.readyState !== 'open') {
      return false
    }

    this.events.send(JSON.stringify(event))

    return true
  }

  private seedHistory(): LiveHistoryMessage[] {
    // Herald OS starts each spoken conversation fresh; Hermes itself carries memory across sessions.
    return []
  }

  private contextWindow(): LiveTranscriptFragment[] {
    const last = this.transcript[this.transcript.length - 1]

    if (!last) {
      return []
    }

    const floor = last.endMs - CONTEXT_WINDOW_MS

    return this.transcript.filter(fragment => fragment.endMs >= floor).slice(-CONTEXT_MAX_FRAGMENTS)
  }

  private onEvent(raw: string): void {
    const action = reduceLiveEvent(raw)

    switch (action.kind) {
      case 'started':
        return
      case 'transcript':
        this.onTranscript(action.fragment)

        return
      case 'delegation':
        void this.onDelegation(action.id)

        return
      case 'error':
        if (!action.ignorable) {
          this.host.notify('GPT-Live', action.message, 'warn')
        }

        return
      case 'closed':
        this.finish(action.reason, action.usageSeconds)

        return
      default:
        return
    }
  }

  private onTranscript(fragment: LiveTranscriptFragment): void {
    this.transcript.push(fragment)

    if (this.transcript.length > 2000) {
      this.transcript.splice(0, this.transcript.length - 1500)
    }

    const now = Date.now()

    if (fragment.speaker === 'user') {
      this.lastUserSpeechAt = now
      this.pendingUserText += fragment.text
      this.host.setCaptions({ user: this.pendingUserText.replace(/\s+/g, ' ').trim().slice(-200) })

      if (!this.turnBusy) {
        this.host.setState('listening')
      }

      // Stop phrases end the conversation once the user's utterance has settled.
      if (this.stopWordTimer) {
        clearTimeout(this.stopWordTimer)
      }

      this.stopWordTimer = setTimeout(() => {
        this.stopWordTimer = null
        const utterance = this.pendingUserText
        this.pendingUserText = ''

        if (isStopPhrase(utterance)) {
          this.host.ended('stop-phrase')
        }
      }, STOP_WORD_SETTLE_MS)
    } else {
      this.lastAssistantSpeechAt = now
      this.host.setCaptions({ interim: this.assistantTail().slice(-240) })
    }
  }

  private assistantTail(): string {
    let text = ''

    for (let i = this.transcript.length - 1; i >= 0 && this.transcript[i].speaker === 'assistant'; i--) {
      text = this.transcript[i].text + text
    }

    return text.replace(/\s+/g, ' ').trim()
  }

  // ---- delegation -> Hermes turn -> commentary -------------------------------------------------

  private async onDelegation(delegationId: string): Promise<void> {
    const { prompt, voiceContext } = delegationPrompt(this.contextWindow())

    if (!prompt) {
      this.speak(delegationId, 'I did not catch that. Could you say it again?')

      return
    }

    // A short "yes" or "no" while this conversation's approval card is up decides the card; the
    // running turn carries on instead of being superseded. Before stop phrases: "stop" answers it.
    const answer = this.host.answerApproval(prompt)

    if (answer) {
      this.host.setCaptions({ user: prompt, assistant: answer === 'approve' ? 'Approved.' : 'Denied.', interim: '' })
      this.speak(delegationId, answer === 'approve' ? 'Approved.' : 'Okay, cancelled.')

      return
    }

    if (isStopPhrase(prompt)) {
      this.host.ended('stop-phrase')

      return
    }

    this.activeDelegationId = delegationId
    this.host.setCaptions({ user: prompt, assistant: '', interim: '' })

    // OS commands run locally and the result is handed to the voice to say; no Hermes turn needed.
    const intent = await this.host.runIntent(prompt)

    if (this.finalized || this.activeDelegationId !== delegationId) {
      return
    }

    if (intent.handled) {
      this.host.setCaptions({ assistant: intent.spoken })
      this.speak(delegationId, intent.spoken)

      return
    }

    // A newer request supersedes an in-flight turn: the answer should be for what was asked last.
    const interrupted = this.turnBusy
    this.stopObserving?.()
    this.stopObserving = null

    if (interrupted) {
      void this.host.interrupt()
    }

    this.turnBusy = true
    this.spoken.reset()
    this.pendingUserText = ''
    this.host.setState('thinking')
    this.think(delegationId, 'Hermes is working on it.')

    void this.host
      .submit(prompt, { voiceContext, interrupted })
      .then(sessionId => {
        if (this.finalized || this.activeDelegationId !== delegationId) {
          return
        }

        if (!sessionId) {
          this.turnBusy = false
          this.speak(delegationId, 'Sorry, I could not reach Hermes for that request.')
          this.host.setState('listening')

          return
        }

        this.stopObserving = this.host.observeTurn(sessionId, {
          onDelta: (delta, full) => {
            if (this.activeDelegationId !== delegationId) {
              return
            }

            this.host.setCaptions({ assistant: sanitizeForSpeech(full).slice(-400) })

            // Speak completed sentences while the model is still writing; the remainder goes on complete.
            for (const sentence of this.spoken.feed(delta)) {
              this.speak(delegationId, sentence)
            }
          },
          onTool: name => {
            if (this.activeDelegationId === delegationId) {
              this.think(delegationId, `Hermes is using ${name.replace(/_/g, ' ')}.`)
            }
          },
          onComplete: (full, status, error, tools = []) => {
            if (this.activeDelegationId !== delegationId) {
              return
            }

            this.turnBusy = false
            this.stopObserving = null

            if (status === 'error' || (!full.trim() && error) || /^Error:/i.test(full.trim())) {
              const described = describeTurnError(error || full)

              if (described.kind !== 'auth') {
                this.host.notify(described.title, described.body, described.fixable ? 'error' : 'warn')
              }

              this.speak(delegationId, described.spoken)
              this.host.setState('listening')

              return
            }

            for (const sentence of this.spoken.flush()) {
              this.speak(delegationId, sentence)
            }

            const silent = silentTurnLine(sanitizeForSpeech(full), status, tools)

            if (silent) {
              if (silent.problem) {
                this.host.notify('Hermes', silent.spoken, 'warn')
              }

              this.host.setCaptions({ assistant: silent.spoken })
              this.speak(delegationId, silent.spoken)
            }

            this.host.setState('listening')
          }
        })
      })
      .catch(error => {
        if (this.activeDelegationId === delegationId) {
          this.turnBusy = false
          this.host.notify('Voice', error instanceof Error ? error.message : String(error), 'warn')
          this.speak(delegationId, 'Sorry, I could not reach Hermes for that request.')
          this.host.setState('listening')
        }
      })
  }

  /** Quiet progress for the live model. */
  private think(delegationId: string | null, content: string): void {
    const text = content.replace(/\s+/g, ' ').trim().slice(0, 1400)

    if (text) {
      this.send({ content: text, delegation_id: delegationId, event_id: this.nextEventId('think'), type: 'session.thinking.append' })
    }
  }

  /** A result the voice should say aloud (paraphrased), chunked to the vendor's append cap. */
  private speak(delegationId: string | null, content: string): void {
    for (const chunk of chunkForCommentary(content)) {
      this.send({ content: chunk, delegation_id: delegationId, event_id: this.nextEventId('say'), type: 'session.commentary.append' })
    }
  }

  // ---- meter, idle rule, cap -------------------------------------------------------------------

  private tick(): void {
    if (this.finalized || !this.openedAt) {
      return
    }

    const now = Date.now()
    const sessionSeconds = Math.floor((now - this.openedAt) / 1000)
    // Bill as we go so a crash or force-quit still leaves today's usage roughly right.
    const unaccounted = sessionSeconds - this.accountedSeconds

    if (unaccounted >= 5) {
      this.host.recordLiveSeconds(unaccounted)
      this.accountedSeconds = sessionSeconds
    }

    this.host.setLiveSeconds(sessionSeconds)

    const prefs = this.host.prefs()
    const idleFor = now - Math.max(this.lastUserSpeechAt, this.lastAssistantSpeechAt)

    if (!this.turnBusy && idleFor >= prefs.liveIdleSeconds * 1000) {
      this.host.ended('idle')

      return
    }

    if (prefs.liveDailyCapMinutes > 0) {
      const usedToday = prefs.liveUsage.seconds + unaccounted

      if (usedToday >= prefs.liveDailyCapMinutes * 60) {
        this.host.ended('cap', `Live daily cap of ${prefs.liveDailyCapMinutes} minutes reached.`)
      }
    }
  }

  private armLevelProbe(stream: MediaStream): void {
    try {
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      this.audioContext = context
      this.analyser = analyser
      const buffer = new Uint8Array(analyser.fftSize)
      let speaking = false

      const probe = () => {
        if (this.finalized) {
          return
        }

        analyser.getByteTimeDomainData(buffer)
        let sum = 0

        for (const sample of buffer) {
          const centered = (sample - 128) / 128
          sum += centered * centered
        }

        const level = Math.min(1, Math.sqrt(sum / buffer.length) * 2.5)
        $speakLevel.set(level)
        const loud = level > 0.04

        if (loud !== speaking) {
          speaking = loud

          if (!this.turnBusy) {
            this.host.setState(loud ? 'speaking' : 'listening')
          }
        }

        setTimeout(probe, 80)
      }

      probe()
    } catch {
      // No analyser: the orb just will not react to the voice's level.
    }
  }

  // ---- teardown --------------------------------------------------------------------------------

  private close(): void {
    if (this.finalized) {
      return
    }

    if (!this.send({ type: 'session.close' })) {
      this.finish('close_requested', null)

      return
    }

    this.closeTimer = setTimeout(() => this.finish('close_requested', null), CLOSE_TIMEOUT_MS)
  }

  private finish(reason: string, usageSeconds: number | null): void {
    if (this.finalized) {
      return
    }

    this.finalized = true

    if (this.closeTimer) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }

    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }

    if (this.stopWordTimer) {
      clearTimeout(this.stopWordTimer)
      this.stopWordTimer = null
    }

    this.stopObserving?.()
    this.stopObserving = null

    // Settle the bill: the vendor's own count when it sent one, else our clock.
    const sessionSeconds = usageSeconds ?? (this.openedAt ? (Date.now() - this.openedAt) / 1000 : 0)
    const remainder = sessionSeconds - this.accountedSeconds

    if (remainder > 0) {
      this.host.recordLiveSeconds(remainder)
    }

    this.analyser?.disconnect()
    void this.audioContext?.close().catch(() => undefined)
    this.events?.close()
    this.peer?.close()
    this.audio.srcObject = null
    this.audio.pause()
    $speakLevel.set(0)

    // The store already knows when it asked us to stop; everything else is the engine ending itself.
    if (!this.stopping) {
      const detail = reason === 'connection_lost' ? 'Lost the connection to GPT-Live.' : undefined
      this.host.ended(
        reason === 'connection_lost' ? 'connection-lost' : reason === 'closed' || reason === 'close_requested' ? 'user' : /idle|timeout|inactiv/i.test(reason) ? 'idle' : 'error',
        detail ?? (reason && !/closed|close_requested/.test(reason) ? `GPT-Live closed the session (${reason}).` : undefined)
      )
    }
  }
}
