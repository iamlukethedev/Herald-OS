// The free engine: microphone -> endpointed utterance -> `/api/audio/transcribe` -> Hermes turn
// (`surface: voice-live` for spoken-style replies) -> `/api/audio/speak-stream` sentence by
// sentence while the reply streams. Barge-in cuts speech and interrupts the turn.
import { rest } from '../rest.ts'
import { type CaptureFrame, MicrophoneUnavailableError, subscribeMicrophone } from './audio-capture.ts'
import { earcons } from './earcons.ts'
import { type ConversationEngine, describeTurnError, silentTurnLine, type VoiceHost } from './engine.ts'
import { bytesToBase64, concatInt16, encodeWav } from './pcm.ts'
import { withProviderFallback } from './provider-fallback.ts'
import { SpeakStream, speakOnce, stopFallbackAudio } from './speak-stream.ts'
import { isNoiseTranscript, isStopPhrase, sanitizeForSpeech } from './speech-text.ts'
import { BARGE_IN_ENDPOINTER, DEFAULT_ENDPOINTER, Endpointer } from './vad.ts'

// monitor: a turn runs and speech over it is barge-in; answer: an approval card is up, so the words
// are heard out first (a "yes" or "no" decides the card instead of interrupting).
type Mode = 'idle' | 'listen' | 'monitor' | 'answer'

const PRE_ROLL_MS = 400
const MAX_CONTEXT_EXCHANGES = 6
/** Silence before a stray tone tells the user Hermes is still working. */
const THINKING_TICK_MS = 1800

interface TranscribeResult {
  ok: boolean
  transcript?: string
  provider?: string | null
}

export class ChainedEngine implements ConversationEngine {
  readonly kind = 'chained' as const

  private mode: Mode = 'idle'
  private unsubscribeMic: (() => void) | null = null
  private endpointer = new Endpointer(DEFAULT_ENDPOINTER)
  private preRoll: Int16Array[] = []
  private preRollMs = 0
  private utterance: Int16Array[] = []
  private muted = false
  private stopped = false
  private followUp = false

  private speak: SpeakStream | null = null
  private stopObserving: (() => void) | null = null
  private turnDone = false
  private replyText = ''
  private fallbackText: string | null = null
  private speechEnded = false
  private speechStarted = false
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null
  private readonly exchanges: Array<{ user: string; hermes: string }> = []

  constructor(private readonly host: VoiceHost) {}

  async start(): Promise<void> {
    this.stopped = false

    try {
      this.unsubscribeMic = await subscribeMicrophone(frame => this.onFrame(frame))
    } catch (error) {
      throw error instanceof MicrophoneUnavailableError ? error : new Error(`Microphone failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    this.beginListening(false)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.mode = 'idle'
    this.clearThinkingTimer()
    this.unsubscribeMic?.()
    this.unsubscribeMic = null
    this.speak?.stop()
    this.speak = null
    stopFallbackAudio()
    this.stopObserving?.()
    this.stopObserving = null
  }

  setMuted(muted: boolean): void {
    this.muted = muted

    if (muted) {
      this.utterance = []
      this.preRoll = []
      this.preRollMs = 0
      this.endpointer.reset()
    }
  }

  interrupt(): void {
    if (this.mode === 'monitor') {
      this.bargeIn(false)
    }
  }

  // ---- listening -------------------------------------------------------------------------------

  private beginListening(followUp: boolean): void {
    if (this.stopped) {
      return
    }

    this.followUp = followUp
    this.mode = 'listen'
    this.utterance = []
    this.endpointer = new Endpointer({
      ...DEFAULT_ENDPOINTER,
      maxWaitMs: followUp ? Math.max(1000, this.host.prefs().followUpSeconds * 1000) : DEFAULT_ENDPOINTER.maxWaitMs
    })
    this.host.setState('listening')

    if (!followUp) {
      earcons.listen()
    }
  }

  private onFrame(frame: CaptureFrame): void {
    if (this.stopped || this.muted) {
      return
    }

    if (this.mode === 'listen') {
      this.onListenFrame(frame)
    } else if (this.mode === 'monitor') {
      this.onMonitorFrame(frame)
    } else if (this.mode === 'answer') {
      this.onAnswerFrame(frame)
    }
  }

  private onListenFrame(frame: CaptureFrame): void {
    const event = this.endpointer.feed(frame.level, frame.ms)

    if (this.endpointer.isSpeaking) {
      this.utterance.push(frame.pcm)
    } else {
      this.preRoll.push(frame.pcm)
      this.preRollMs += frame.ms

      while (this.preRollMs > PRE_ROLL_MS && this.preRoll.length > 1) {
        this.preRollMs -= frame.ms
        this.preRoll.shift()
      }
    }

    if (event === 'speech-start') {
      // Keep the syllable that tripped the detector.
      this.utterance = [...this.preRoll, ...this.utterance]
      this.preRoll = []
      this.preRollMs = 0
    } else if (event === 'speech-end') {
      const pcm = concatInt16(this.utterance)
      this.utterance = []
      this.mode = 'idle'
      void this.handleUtterance(pcm)
    } else if (event === 'timeout') {
      if (this.followUp || this.exchanges.length > 0) {
        this.host.ended('silence')
      } else {
        this.host.ended('silence')
        this.host.notify('Voice', 'Heard nothing; conversation closed.', 'info')
      }
    }
  }

  private onMonitorFrame(frame: CaptureFrame): void {
    const event = this.endpointer.feed(frame.level, frame.ms)
    this.preRoll.push(frame.pcm)
    this.preRollMs += frame.ms

    while (this.preRollMs > PRE_ROLL_MS && this.preRoll.length > 1) {
      this.preRollMs -= frame.ms
      this.preRoll.shift()
    }

    if (event === 'speech-start') {
      if (this.host.approvalPending()) {
        this.captureAnswer()
      } else {
        this.bargeIn(true)
      }
    }
  }

  /** Record the words spoken over the turn without stopping it: they may answer the approval card. */
  private captureAnswer(): void {
    this.mode = 'answer'
    this.endpointer = new Endpointer(DEFAULT_ENDPOINTER)
    this.endpointer.markSpeaking()
    this.utterance = [...this.preRoll]
    this.preRoll = []
    this.preRollMs = 0
  }

  private onAnswerFrame(frame: CaptureFrame): void {
    const event = this.endpointer.feed(frame.level, frame.ms)
    this.utterance.push(frame.pcm)

    if (event === 'speech-end' || event === 'timeout') {
      const pcm = concatInt16(this.utterance)
      this.utterance = []
      this.mode = 'idle'
      void this.transcribe(pcm)
        .catch(() => '')
        .then(transcript => (this.stopped ? undefined : this.handleOverTurn(transcript)))
    }
  }

  /**
   * Words said while a turn runs (heard over it while a card was up, or handed in): a short answer to
   * the conversation's approval card decides it and the turn carries on; anything else interrupts
   * the turn and becomes the next request, as barge-in always has.
   */
  private async handleOverTurn(transcript: string): Promise<void> {
    const words = transcript && !isNoiseTranscript(transcript) ? transcript : ''
    const answer = words ? this.host.answerApproval(words) : null

    if (!words || answer) {
      if (answer) {
        this.host.setCaptions({ user: words, assistant: answer === 'approve' ? 'Approved.' : 'Denied.' })
      }

      this.resumeTurn()

      return
    }

    this.bargeIn(false)
    await this.handleTranscript(words)
  }

  /** Back to watching the turn after hearing words out; when it ended meanwhile, listen instead. */
  private resumeTurn(): void {
    if (this.mode !== 'idle') {
      // Still monitoring (the words were handed in), or the turn finished and listening began.
      return
    }

    if (!this.speak) {
      this.beginListening(true)

      return
    }

    this.mode = 'monitor'
    this.endpointer = new Endpointer(BARGE_IN_ENDPOINTER)
    this.preRoll = []
    this.preRollMs = 0
    this.host.setState(this.speak.speaking ? 'speaking' : 'thinking')
  }

  /** The user spoke over Hermes (or pressed stop): cut speech, interrupt the turn, listen. */
  private bargeIn(fromSpeech: boolean): void {
    this.clearThinkingTimer()
    this.speak?.stop()
    this.speak = null
    stopFallbackAudio()
    this.stopObserving?.()
    this.stopObserving = null

    if (!this.turnDone) {
      void this.host.interrupt()
    }

    this.turnDone = true
    this.beginListening(true)

    if (fromSpeech) {
      // The barge-in detector already heard speech: carry the utterance over without waiting for
      // the listen detector to confirm it a second time.
      this.endpointer.markSpeaking()
      this.utterance = [...this.preRoll]
      this.preRoll = []
      this.preRollMs = 0
    }
  }

  // ---- utterance -> turn -----------------------------------------------------------------------

  private async handleUtterance(pcm: Int16Array): Promise<void> {
    this.host.setState('transcribing')
    earcons.captured()
    let transcript = ''

    try {
      transcript = await this.transcribe(pcm)
    } catch (error) {
      this.host.notify('Transcription failed', error instanceof Error ? error.message : String(error), 'warn')

      if (!this.stopped) {
        this.sayInstead('Sorry, I could not make that out. Please say it again.')
      }

      return
    }

    if (this.stopped) {
      return
    }

    await this.handleTranscript(transcript)
  }

  /** A final transcript handed in rather than heard (typed fallback, tests): the microphone's own path from here. */
  async submitTranscript(text: string): Promise<void> {
    if (this.stopped) {
      return
    }

    if (this.mode === 'monitor' || this.mode === 'answer') {
      await this.handleOverTurn(text.trim())
    } else {
      await this.handleTranscript(text.trim())
    }
  }

  /** What a final transcript becomes: an answer to a waiting card, the end, an OS command, or a Hermes turn. */
  private async handleTranscript(transcript: string): Promise<void> {
    if (!transcript || isNoiseTranscript(transcript)) {
      this.beginListening(true)

      return
    }

    // Before stop phrases: while a card waits, "stop" and "cancel" answer it rather than end the conversation.
    const answer = this.host.answerApproval(transcript)

    if (answer) {
      this.host.setCaptions({ user: transcript, assistant: answer === 'approve' ? 'Approved.' : 'Denied.' })
      this.beginListening(true)

      return
    }

    if (isStopPhrase(transcript)) {
      this.host.setCaptions({ user: transcript })
      this.host.ended('stop-phrase')

      return
    }

    this.host.setCaptions({ user: transcript, assistant: '' })

    // OS commands ("open missions", "show my memory") run here, instantly and for free.
    this.host.setState('thinking')
    const intent = await this.host.runIntent(transcript)

    if (this.stopped) {
      return
    }

    if (intent.handled) {
      this.exchanges.push({ user: transcript, hermes: intent.spoken })
      this.host.setCaptions({ assistant: intent.spoken })
      this.host.setState('speaking')
      this.mode = 'monitor'
      this.endpointer = new Endpointer(BARGE_IN_ENDPOINTER)
      const signal = { stopped: false }
      this.speakWithFallback(intent.spoken, signal)
        .catch(() => undefined)
        .finally(() => {
          if (!this.stopped && this.mode === 'monitor') {
            this.beginListening(true)
          }
        })

      return
    }

    await this.runTurn(transcript)
  }

  private async transcribe(pcm: Int16Array): Promise<string> {
    const wav = encodeWav(pcm)
    const body = { data_url: `data:audio/wav;base64,${bytesToBase64(wav)}`, mime_type: 'audio/wav' }
    const result = await withProviderFallback(
      'stt',
      () => rest.post<TranscribeResult>('/api/audio/transcribe', body),
      (from, to) => this.host.notify('Speech to text switched', `${from ?? 'The configured provider'} is not set up; using the free ${to} provider. Change it in Settings > Voice.`, 'info')
    )

    return (result?.transcript ?? '').trim()
  }

  /** Whole-utterance speech with the same free-provider fallback. */
  private speakWithFallback(text: string, signal: { stopped: boolean }): Promise<void> {
    return withProviderFallback(
      'tts',
      () => speakOnce(text, signal),
      (from, to) => this.host.notify('Text to speech switched', `${from ?? 'The configured provider'} is not set up; using the free ${to} voice. Change it in Settings > Voice.`, 'info')
    )
  }

  private voiceContext(): string | undefined {
    if (this.exchanges.length === 0) {
      return undefined
    }

    return this.exchanges
      .slice(-MAX_CONTEXT_EXCHANGES)
      .flatMap(({ user, hermes }) => [`User: ${user}`, hermes ? `Hermes: ${hermes}` : null])
      .filter((line): line is string => Boolean(line))
      .join('\n')
      .slice(-5000)
  }

  private async runTurn(text: string): Promise<void> {
    this.host.setState('thinking')
    this.turnDone = false
    this.replyText = ''
    this.fallbackText = null
    this.speechEnded = false
    this.speechStarted = false
    const interrupted = this.exchanges.length > 0 && !this.exchanges[this.exchanges.length - 1].hermes
    this.exchanges.push({ user: text, hermes: '' })

    // Open the speech socket before the model answers so the first sentence plays immediately.
    const speak = new SpeakStream({
      onStart: () => {
        this.clearThinkingTimer()

        if (!this.stopped && this.speak === speak) {
          this.speechStarted = true
          this.host.setState('speaking')
        }
      },
      onEnd: (reason, error) => {
        if (this.speak !== speak) {
          return
        }

        this.speechEnded = true

        if (reason === 'error' && error) {
          this.host.notify('Speech unavailable', error, 'warn')
        }

        // Provider has no chunked API, or the stream ended while Hermes was still working (its socket
        // closed): speak the whole reply once the turn completes.
        if (reason === 'fallback' || (reason !== 'stopped' && !this.turnDone)) {
          this.fallbackText = ''
        }

        this.maybeFinishTurn()
      }
    })
    this.speak = speak
    this.mode = 'monitor'
    this.endpointer = new Endpointer(BARGE_IN_ENDPOINTER)
    this.armThinkingTimer()

    let sessionId: string | null = null
    let failure = ''

    try {
      sessionId = await this.host.submit(text, { voiceContext: this.voiceContext(), interrupted })
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    if (this.stopped || this.speak !== speak) {
      return
    }

    if (!sessionId) {
      this.host.notify('Hermes could not take that', failure || 'The request did not reach Hermes.', 'warn')
      this.sayInstead('Sorry, I could not reach Hermes for that request.')

      return
    }

    this.stopObserving = this.host.observeTurn(sessionId, {
      onDelta: (delta, full) => {
        this.clearThinkingTimer()
        this.replyText = full
        this.host.setCaptions({ assistant: sanitizeForSpeech(full).slice(-400) })

        if (this.fallbackText === null) {
          speak.feed(delta)
        }
      },
      onTool: () => {
        this.armThinkingTimer()
      },
      onComplete: (full, status, error, tools = []) => {
        this.clearThinkingTimer()
        this.replyText = full || this.replyText
        this.turnDone = true
        const last = this.exchanges[this.exchanges.length - 1]

        if (last) {
          last.hermes = sanitizeForSpeech(this.replyText).slice(0, 800)
        }

        // The backend answered with an error (or the assistant text is itself the error): say what
        // went wrong in plain words and show the real message, instead of a generic failure.
        if (status === 'error' || (!full.trim() && error) || /^Error:/i.test(this.replyText.trim())) {
          const described = describeTurnError(error || this.replyText)

          // Sign-in problems surface as the OS sign-in card (opened by the auth store); no second toast.
          if (described.kind !== 'auth') {
            this.host.notify(described.title, described.body, described.fixable ? 'error' : 'warn')
          }

          // A fixable setup problem will fail every turn; do not sit there listening for one.
          // Already reported above; 'unavailable' ends quietly without a second toast.
          this.sayInstead(described.spoken, described.fixable ? () => this.host.ended('unavailable', described.body) : undefined)

          return
        }

        // Nothing came back to say (the work done without a word, a turn that stopped short): say so.
        const silent = silentTurnLine(sanitizeForSpeech(this.replyText), status, tools)

        if (silent) {
          if (silent.problem) {
            this.host.notify('Hermes', silent.spoken, 'warn')
          } else if (last) {
            last.hermes = silent.spoken
          }

          this.sayInstead(silent.spoken)

          return
        }

        speak.done()
        this.maybeFinishTurn()
      }
    })
  }

  /**
   * Say a line instead of the reply (a failure, or a turn that ended with nothing to say), then
   * listen; `ended` closes the conversation instead, once the line is said.
   */
  private sayInstead(line: string, ended?: () => void): void {
    const stream = this.speak
    this.speak = null
    stream?.stop()
    this.stopObserving?.()
    this.stopObserving = null
    this.clearThinkingTimer()
    this.turnDone = true
    this.mode = 'monitor'
    this.endpointer = new Endpointer(BARGE_IN_ENDPOINTER)
    this.host.setCaptions({ assistant: line })
    this.host.setState('speaking')
    const signal = { stopped: false }
    this.speakWithFallback(line, signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.stopped) {
          return
        }

        if (ended) {
          ended()
        } else if (this.mode === 'monitor') {
          this.beginListening(true)
        }
      })
  }

  /** Once the turn is complete and speech has drained (or fell back), listen for a follow-up. */
  private maybeFinishTurn(): void {
    if (this.stopped || !this.turnDone || !this.speechEnded) {
      return
    }

    this.speak = null
    this.stopObserving?.()
    this.stopObserving = null

    // Speech fell back, or the stream never said a word: speak the reply in one go.
    if (this.fallbackText !== null || !this.speechStarted) {
      const text = sanitizeForSpeech(this.replyText)
      this.fallbackText = null

      if (text) {
        this.host.setState('speaking')
        const signal = { stopped: false }
        this.speakWithFallback(text, signal)
          .catch(error => this.host.notify('Speech unavailable', error instanceof Error ? error.message : String(error), 'warn'))
          .finally(() => {
            if (!this.stopped && this.mode === 'monitor') {
              this.beginListening(true)
            }
          })

        return
      }
    }

    this.beginListening(true)
  }

  private armThinkingTimer(): void {
    this.clearThinkingTimer()
    this.thinkingTimer = setTimeout(() => {
      this.thinkingTimer = null

      if (!this.stopped && !this.turnDone && !this.speak?.speaking) {
        earcons.captured()
      }
    }, THINKING_TICK_MS)
  }

  private clearThinkingTimer(): void {
    if (this.thinkingTimer) {
      clearTimeout(this.thinkingTimer)
      this.thinkingTimer = null
    }
  }
}
