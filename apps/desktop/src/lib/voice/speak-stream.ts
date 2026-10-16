// Streaming TTS playback over the backend's `/api/audio/speak-stream` WebSocket: text deltas in,
// int16 PCM out, scheduled gaplessly on a WebAudio context. One instance is one spoken reply.
import { atom } from 'nanostores'
import { rest } from '../rest.ts'
import { int16ToFloat } from './pcm.ts'

/** Output level 0..1 while Hermes speaks, for the orb. */
export const $speakLevel = atom(0)

export type SpeakStreamEnd = 'drained' | 'stopped' | 'fallback' | 'error'

export interface SpeakStreamHandlers {
  /** First audio is about to play. */
  onStart?: () => void
  onEnd?: (reason: SpeakStreamEnd, error?: string) => void
}

let sharedContext: AudioContext | null = null

function outputContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') {
    sharedContext = new AudioContext({ latencyHint: 'interactive' })
  }

  if (sharedContext.state === 'suspended') {
    void sharedContext.resume()
  }

  return sharedContext
}

/**
 * Feed assistant text as it streams; the backend cuts sentences and returns PCM per sentence, so
 * speech starts while the model is still writing. `done()` closes the text; `stop()` is barge-in.
 */
export class SpeakStream {
  private socket: WebSocket | null = null
  private sampleRate = 24_000
  private channels = 1
  private nextStart = 0
  private started = false
  private ended = false
  private textDone = false
  private serverDone = false
  private scheduled = 0
  private pending: string[] = []
  private levelTimer: ReturnType<typeof setInterval> | null = null
  private analyser: AnalyserNode | null = null
  private gain: GainNode | null = null
  private readonly ready: Promise<void>

  constructor(private readonly handlers: SpeakStreamHandlers = {}) {
    this.ready = this.open()
  }

  private async open(): Promise<void> {
    let url: string

    try {
      url = await window.heraldOS.voice.audioWsUrl('speak-stream')
    } catch (error) {
      this.finish('error', error instanceof Error ? error.message : String(error))

      return
    }

    await new Promise<void>(resolve => {
      const socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
      this.socket = socket
      socket.onopen = () => {
        for (const text of this.pending.splice(0, this.pending.length)) {
          socket.send(JSON.stringify({ text }))
        }

        if (this.textDone) {
          socket.send(JSON.stringify({ done: true }))
        }

        resolve()
      }
      socket.onmessage = event => this.onMessage(event)
      socket.onerror = () => {
        this.finish('error', 'speak-stream connection failed')
        resolve()
      }
      socket.onclose = () => {
        this.serverDone = true
        this.maybeDrained()
        resolve()
      }
    })
  }

  private onMessage(event: MessageEvent): void {
    if (typeof event.data === 'string') {
      let frame: { type?: string; sample_rate?: number; channels?: number }

      try {
        frame = JSON.parse(event.data)
      } catch {
        return
      }

      if (frame.type === 'start') {
        this.sampleRate = frame.sample_rate ?? this.sampleRate
        this.channels = frame.channels ?? 1
      } else if (frame.type === 'fallback') {
        this.finish('fallback')
      } else if (frame.type === 'end') {
        this.serverDone = true
        this.maybeDrained()
      }

      return
    }

    if (event.data instanceof ArrayBuffer) {
      this.schedule(new Int16Array(event.data.byteLength % 2 === 0 ? event.data : event.data.slice(0, event.data.byteLength - 1)))
    }
  }

  private schedule(pcm: Int16Array): void {
    if (this.ended || pcm.length === 0) {
      return
    }

    const ctx = outputContext()

    if (!this.gain) {
      this.gain = ctx.createGain()
      this.analyser = ctx.createAnalyser()
      this.analyser.fftSize = 256
      this.gain.connect(this.analyser)
      this.analyser.connect(ctx.destination)
      this.levelTimer = setInterval(() => this.sampleLevel(), 50)
    }

    const frames = Math.floor(pcm.length / this.channels)
    const buffer = ctx.createBuffer(1, frames, this.sampleRate)
    const mono = new Float32Array(frames)
    const floats = int16ToFloat(pcm)

    for (let i = 0; i < frames; i++) {
      mono[i] = floats[i * this.channels]
    }

    buffer.copyToChannel(mono, 0)
    const node = ctx.createBufferSource()
    node.buffer = buffer
    node.connect(this.gain)
    const startAt = Math.max(ctx.currentTime + 0.02, this.nextStart)
    node.start(startAt)
    this.nextStart = startAt + buffer.duration
    this.scheduled++
    node.onended = () => {
      this.scheduled--
      this.maybeDrained()
    }

    if (!this.started) {
      this.started = true
      this.handlers.onStart?.()
    }
  }

  private sampleLevel(): void {
    if (!this.analyser) {
      return
    }

    const data = new Uint8Array(this.analyser.fftSize)
    this.analyser.getByteTimeDomainData(data)
    let sum = 0

    for (const sample of data) {
      const centered = (sample - 128) / 128
      sum += centered * centered
    }

    $speakLevel.set(Math.min(1, Math.sqrt(sum / data.length) * 2.5))
  }

  private maybeDrained(): void {
    if (!this.ended && this.serverDone && this.scheduled === 0) {
      this.finish('drained')
    }
  }

  private finish(reason: SpeakStreamEnd, error?: string): void {
    if (this.ended) {
      return
    }

    this.ended = true

    if (this.levelTimer) {
      clearInterval(this.levelTimer)
      this.levelTimer = null
    }

    $speakLevel.set(0)
    this.gain?.disconnect()
    this.analyser?.disconnect()

    try {
      this.socket?.close()
    } catch {
      // Already closed.
    }

    this.handlers.onEnd?.(reason, error)
  }

  /** True once the first PCM has been scheduled. */
  get speaking(): boolean {
    return this.started && !this.ended
  }

  feed(text: string): void {
    if (this.ended || !text) {
      return
    }

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ text }))
    } else {
      this.pending.push(text)
    }
  }

  done(): void {
    if (this.ended || this.textDone) {
      return
    }

    this.textDone = true

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ done: true }))
    }
  }

  /** Barge-in: cut audio now and tell the server to stop synthesizing. */
  stop(): void {
    if (this.ended) {
      return
    }

    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ stop: true }))
      } catch {
        // Socket is going away anyway.
      }
    }

    // Silence immediately: ramp the shared gain rather than hunting every scheduled node.
    if (this.gain) {
      const ctx = outputContext()
      this.gain.gain.setValueAtTime(this.gain.gain.value, ctx.currentTime)
      this.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.03)
    }

    this.finish('stopped')
  }

  /** Resolves when the socket is open (or has failed). */
  whenReady(): Promise<void> {
    return this.ready
  }
}

let fallbackAudio: HTMLAudioElement | null = null
/** Bumped by every barge-in, stop and end of conversation. */
let silencedAt = 0

/** False once barge-in, the stop button or the end of the conversation silenced the player after the ticket was taken. */
export type PlaybackTicket = () => boolean

/** Take before a line is synthesized, so a line silenced while it was being made never starts late. */
export function playbackTicket(): PlaybackTicket {
  const taken = silencedAt

  return () => silencedAt === taken
}

/** A whole line synthesized by Hermes's voice, and the provider that spoke it. */
export interface SpokenClip {
  src: string
  provider: string | null
}

/**
 * Whole-utterance TTS through `POST /api/audio/speak` (providers without a chunked API, and short
 * announcements); null when there is nothing to say. Rejects when synthesis fails.
 */
export async function synthesizeOnce(text: string): Promise<SpokenClip | null> {
  const trimmed = text.trim()

  if (!trimmed) {
    return null
  }

  const result = await rest.post<{ ok: boolean; data_url?: string; provider?: string | null }>('/api/audio/speak', { text: trimmed })

  return result?.data_url ? { src: result.data_url, provider: result.provider ?? null } : null
}

/**
 * Play one clip on the whole-utterance player, in place of whatever it was playing. Resolves when
 * the clip ends or is silenced (and at once when `ticket` has gone stale); rejects when it cannot
 * be played. `onPlaying` runs once the clip is audible.
 */
export async function playClip(src: string, ticket?: PlaybackTicket, onPlaying?: () => void): Promise<void> {
  if (ticket && !ticket()) {
    return
  }

  silence()
  const audio = new Audio(src)
  fallbackAudio = audio

  await new Promise<void>((resolve, reject) => {
    settle.set(audio, resolve)
    audio.onended = () => resolve()
    // An error or a refused play() after an intentional stop is not a failure; only a real one rejects.
    audio.onerror = () => (stoppedAudio.has(audio) ? resolve() : reject(new Error('audio playback failed')))
    audio.onpause = () => resolve()
    audio
      .play()
      .then(() => onPlaying?.())
      .catch(error => (stoppedAudio.has(audio) ? resolve() : reject(error)))
  })

  stoppedAudio.delete(audio)

  if (fallbackAudio === audio) {
    fallbackAudio = null
  }
}

/** Synthesize a line with Hermes's voice and play it. Resolves when playback ends; rejects when synthesis fails. */
export async function speakOnce(text: string, signal?: { stopped: boolean }): Promise<void> {
  const ticket = playbackTicket()
  const clip = await synthesizeOnce(text)

  if (clip && !signal?.stopped) {
    await playClip(clip.src, ticket)
  }
}

const stoppedAudio = new WeakSet<HTMLAudioElement>()
/** Ends a clip's wait when it is stopped: once `load()` follows `pause()`, Chromium fires neither `pause` nor `error`. */
const settle = new WeakMap<HTMLAudioElement, () => void>()

/** Stop the clip playing now; lines still being synthesized keep their turn. */
function silence(): void {
  if (fallbackAudio) {
    const audio = fallbackAudio
    fallbackAudio = null
    stoppedAudio.add(audio)
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    settle.get(audio)?.()
  }
}

/** Barge-in / end of conversation: silence the whole-utterance player without reporting an error, and drop lines still being made. */
export function stopFallbackAudio(): void {
  silencedAt++
  silence()
}
