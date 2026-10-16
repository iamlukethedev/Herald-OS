import type { GatewayEvent, GatewayEventHub } from '@herald-os/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvInfo, SystemSpeech } from '../../shared/ipc.ts'

// Microsoft's free voice failing while people talk to Hermes, through the voice store, the chained
// engine, the speech chain and the chat store, all real. Fake: Hermes's socket and REST answers, the
// microphone, main's system voice and the speakers.
const edges = vi.hoisted(() => {
  const heraldOS = {
    shell: { surface: 'desktop', mode: 'desktop' },
    prefs: { get: async () => ({}), set: async (patch: Record<string, unknown>) => patch, onChanged: () => () => undefined },
    office: { presence: async () => [] },
    voice: {
      onHotkey: () => () => undefined,
      audioWsUrl: async () => 'ws://speech.invalid',
      systemSpeech: async (text: string): Promise<unknown> => {
        state.systemSaid.push(text)

        return state.system(text)
      }
    },
    backend: {
      rest: async (request: { method: string; path: string }): Promise<unknown> => {
        state.rest.push(`${request.method} ${request.path}`)

        return request.path === '/api/config' ? { tts: { provider: 'edge' }, stt: { provider: 'local' } } : {}
      }
    },
    notifications: { native: async () => undefined }
  }

  const state = {
    heraldOS,
    /** Microsoft's free voice refuses every request, as it did for edge-tts 7.2.7. */
    edgeDown: true,
    system: (_text: string): SystemSpeech => ({ ok: true, audio: new Uint8Array([82, 73, 70, 70]), mimeType: 'audio/wav' }),
    systemSaid: [] as string[],
    rest: [] as string[],
    /** What reached the speakers: Hermes's words, or `system` for a clip of the computer's own voice. */
    played: [] as string[],
    /** Clips keep playing until the test lets them end (or barge-in stops them). */
    holdPlayback: false,
    playing: [] as Array<() => void>,
    silencedAt: 0,
    requests: [] as Array<{ method: string; params: Record<string, unknown> }>,
    microphone: null as null | ((frame: { pcm: Int16Array; level: number; ms: number }) => void)
  }

  Object.assign(globalThis, { window: { innerWidth: 1440, innerHeight: 900, heraldOS }, document: { activeElement: null } })

  return state
})

const EDGE_403 = "POST /api/audio/speak -> 400: TTS generation failed (edge): 403, message='Invalid response status', url='wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'"

vi.mock('./gateway.ts', async () => {
  const { atom } = await import('nanostores')
  const { GatewayEventHub } = await import('@herald-os/client')
  const hub = new GatewayEventHub()
  let sessions = 0

  return {
    hub,
    $connection: atom('open'),
    $gatewayReady: atom({ version: 'test' }),
    $connectionEpoch: atom(0),
    bindGatewayToBackend: () => () => undefined,
    isGatewayOpen: () => false,
    onServerRequest: () => () => undefined,
    onGatewayEvent: (type: string, handler: (event: GatewayEvent) => void) => hub.on(type as GatewayEvent['type'], handler),
    onAnyGatewayEvent: (handler: (event: GatewayEvent) => void) => hub.onAny(handler),
    gatewayRequest: async (method: string, params: Record<string, unknown>) => {
      edges.requests.push({ method, params })

      if (method === 'session.create') {
        sessions += 1

        return { session_id: `runtime-${sessions}`, stored_session_id: `stored-${sessions}`, info: {}, messages: [] }
      }

      if (method === 'prompt.submit') {
        const sessionId = String(params.session_id)
        setTimeout(() => {
          hub.dispatch({ type: 'message.start', session_id: sessionId } as GatewayEvent)
          hub.dispatch({ type: 'message.delta', session_id: sessionId, payload: { text: replyTo(String(params.text)) } } as GatewayEvent)
          hub.dispatch({ type: 'message.complete', session_id: sessionId, payload: { text: replyTo(String(params.text)), status: 'complete' } } as GatewayEvent)
        }, 5)

        return { status: 'streaming' }
      }

      return {}
    }
  }
})

vi.mock('../lib/voice/audio-capture.ts', async () => {
  const { atom } = await import('nanostores')

  return {
    $micOpen: atom(false),
    $micLevel: atom(0),
    $micDevice: atom(null),
    $inputDevices: atom({ devices: [], labelsAvailable: false }),
    $captureNotice: atom(null),
    refreshInputDevices: async () => ({ devices: [], labelsAvailable: false }),
    setCaptureConversing: () => undefined,
    acknowledgeCaptureNotice: () => undefined,
    preferredInputDevice: () => null,
    MicrophoneUnavailableError: class extends Error {},
    setMicrophoneMuted: () => undefined,
    isMicrophoneOpen: () => true,
    holdMicrophoneStream: async () => ({ stream: {}, release: () => undefined }),
    subscribeMicrophone: async (listener: (frame: { pcm: Int16Array; level: number; ms: number }) => void) => {
      edges.microphone = listener

      return () => {
        edges.microphone = null
      }
    }
  }
})

// The speakers and Hermes's voice. With Edge down the speech socket gives up on its first sentence
// (Hermes sends `fallback`) and POST /api/audio/speak fails with Microsoft's 403.
vi.mock('../lib/voice/speak-stream.ts', async () => {
  const { atom } = await import('nanostores')

  class SpeakStream {
    private text = ''
    private ended = false

    constructor(private readonly handlers: { onStart?: () => void; onEnd?: (reason: string, error?: string) => void } = {}) {}

    get speaking() {
      return false
    }

    feed(text: string) {
      this.text += text

      if (edges.edgeDown) {
        queueMicrotask(() => this.finish('fallback'))
      }
    }

    done() {
      queueMicrotask(() => {
        if (!this.ended && this.text.trim()) {
          this.handlers.onStart?.()
          edges.played.push(this.text.trim())
        }

        this.finish('drained')
      })
    }

    stop() {
      this.finish('stopped')
    }

    private finish(reason: string) {
      if (!this.ended) {
        this.ended = true
        this.handlers.onEnd?.(reason)
      }
    }
  }

  return {
    $speakLevel: atom(0),
    SpeakStream,
    stopFallbackAudio: () => {
      edges.silencedAt++

      for (const stop of edges.playing.splice(0)) {
        stop()
      }
    },
    playbackTicket: () => {
      const taken = edges.silencedAt

      return () => taken === edges.silencedAt
    },
    synthesizeOnce: async (text: string) => {
      if (edges.edgeDown) {
        throw new Error(EDGE_403)
      }

      return text.trim() ? { src: text.trim(), provider: 'edge' } : null
    },
    playClip: async (src: string, ticket?: () => boolean, onPlaying?: () => void) => {
      if (ticket && !ticket()) {
        return
      }

      edges.played.push(src.startsWith('blob:') ? 'system' : src)
      onPlaying?.()

      if (edges.holdPlayback) {
        await new Promise<void>(resolve => edges.playing.push(resolve))
      }
    }
  }
})

vi.mock('../lib/voice/earcons.ts', () => ({ earcons: new Proxy({}, { get: () => () => undefined }) }))

const { $env, $prefs } = await import('./backend.ts')
const { bindChatEvents, resetChats } = await import('./chat.ts')
const { hub } = (await import('./gateway.ts')) as unknown as { hub: GatewayEventHub }
const { $notifications } = await import('./notifications.ts')
const { resetProviderFallback } = await import('../lib/voice/provider-fallback.ts')
const { helloReport, resetSpeakFallback } = await import('../lib/voice/speak-fallback.ts')
const { $voice, bindVoice, endConversation, interruptSpeech, speakWithFreeFallback, startVoice, submitVoiceTranscript } = await import('./voice.ts')

const REPLY = 'Your next meeting is at three with the design team.'
const LONG_REPLY = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i + 1} of a long reply from Hermes, said by the system voice.`).join(' ')
const replies = new Map<string, string>()
const replyTo = (text: string) => replies.get(text) ?? REPLY
const toasts = () => $notifications.get().map(notification => `${notification.title}: ${notification.body ?? ''}`)
const STANDING_IN = "Voice: Microsoft's free voice isn't working right now, so Herald OS is using your Mac's voice. Updating Hermes usually fixes it."
const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

bindChatEvents()

beforeEach(() => {
  Object.assign(edges, { edgeDown: true, holdPlayback: false, system: () => ({ ok: true, audio: new Uint8Array([82, 73, 70, 70]), mimeType: 'audio/wav' }) })
  edges.systemSaid.length = 0
  edges.played.length = 0
  edges.playing.length = 0
  edges.requests.length = 0
  edges.rest.length = 0
  replies.clear()
  resetChats()
  resetProviderFallback()
  resetSpeakFallback()
  warn.mockClear()
  $notifications.set([])
  $env.set({ platform: 'darwin' } as EnvInfo)
  $prefs.set({ ...$prefs.get(), language: 'en', doNotDisturb: false, voice: { ...$prefs.get().voice, enabled: true, engine: 'chained', wakeWord: false, followUpSeconds: 8, announceNotifications: true, sttTuned: true } })
})

afterEach(async () => {
  edges.holdPlayback = false

  for (const stop of edges.playing.splice(0)) {
    stop()
  }

  await endConversation('user')
})

describe("a conversation while Microsoft's free voice is down", () => {
  it("says the reply with the Mac's voice, tells the person once, and listens again", async () => {
    await startVoice('button')
    await submitVoiceTranscript("What's next on my calendar?")

    await vi.waitFor(() => expect(edges.played).toEqual(['system']))
    expect(edges.systemSaid).toEqual([REPLY])
    expect($voice.get().captions.assistant).toBe(REPLY)
    expect(toasts()).toEqual([STANDING_IN])
    await vi.waitFor(() => expect($voice.get().state).toBe('listening'))

    await submitVoiceTranscript('And after that?')

    await vi.waitFor(() => expect(edges.played).toEqual(['system', 'system']))
    expect(toasts()).toEqual([STANDING_IN])
    expect(toasts().join('\n')).not.toMatch(/403|POST|Speech unavailable/)
    expect(warn.mock.calls.flat().join('\n')).toContain('TTS generation failed (edge): 403')
  })

  it('lets the stop button and speaking over it cut the system voice off, as with any other voice', async () => {
    replies.set('Read me the long version.', LONG_REPLY)
    edges.holdPlayback = true
    await startVoice('button')
    await submitVoiceTranscript('Read me the long version.')

    await vi.waitFor(() => expect(edges.played).toEqual(['system']))
    expect($voice.get().state).toBe('speaking')

    interruptSpeech()

    await vi.waitFor(() => expect($voice.get().state).toBe('listening'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(edges.played).toEqual(['system'])

    replies.set('Now read it again.', LONG_REPLY)
    await submitVoiceTranscript('Now read it again.')
    await vi.waitFor(() => expect(edges.played).toEqual(['system', 'system']))
    expect($voice.get().state).toBe('speaking')

    await submitVoiceTranscript('Actually, never mind that.')

    await vi.waitFor(() => expect(edges.played).toHaveLength(3))
    expect(edges.requests.filter(request => request.method === 'prompt.submit').map(request => request.params.text)).toEqual(['Read me the long version.', 'Now read it again.', 'Actually, never mind that.'])
    expect(edges.systemSaid.at(-1)).toBe(REPLY)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(edges.played).toEqual(['system', 'system', 'system'])
  })

  it('ends the system voice with the conversation', async () => {
    replies.set('Read me the long version.', LONG_REPLY)
    edges.holdPlayback = true
    await startVoice('button')
    await submitVoiceTranscript('Read me the long version.')
    await vi.waitFor(() => expect(edges.played).toEqual(['system']))

    await endConversation('user')

    expect(edges.playing).toHaveLength(0)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(edges.played).toEqual(['system'])
  })

  it('says once that replies cannot be spoken on a Linux computer with no voice of its own', async () => {
    $env.set({ platform: 'linux' } as EnvInfo)
    edges.system = () => ({ ok: false, reason: 'missing', detail: 'espeak-ng, espeak, flite are not installed' })
    await startVoice('button')
    await submitVoiceTranscript("What's next on my calendar?")

    await vi.waitFor(() => expect(toasts()).toEqual(["Voice: Microsoft's free voice isn't working right now, and there's no system voice on this computer that can stand in. Updating Hermes usually fixes it."]))
    expect(edges.played).toEqual([])
    expect($voice.get().captions.assistant).toBe(REPLY)
    await vi.waitFor(() => expect($voice.get().state).toBe('listening'))

    await submitVoiceTranscript('And after that?')
    await vi.waitFor(() => expect(edges.systemSaid).toHaveLength(2))
    expect(toasts()).toHaveLength(1)
  })

  it('speaks with Hermes as before once Microsoft answers again', async () => {
    edges.edgeDown = false
    await startVoice('button')
    await submitVoiceTranscript("What's next on my calendar?")

    await vi.waitFor(() => expect(edges.played).toEqual([REPLY]))
    expect(edges.systemSaid).toEqual([])
    expect(toasts()).toEqual([])
  })
})

describe('spoken notifications and Say hello', () => {
  it('read a notification with the system voice, sharing the one notice with conversations', async () => {
    const unbind = bindVoice()

    try {
      hub.dispatch({ type: 'notification.show', payload: { text: 'Your mission is ready for review.' } } as GatewayEvent)

      await vi.waitFor(() => expect(edges.played).toEqual(['system']))
      expect(edges.systemSaid).toEqual(['Your mission is ready for review.'])
      expect(toasts()).toEqual([STANDING_IN])

      await startVoice('button')
      await submitVoiceTranscript("What's next on my calendar?")
      await vi.waitFor(() => expect(edges.played).toEqual(['system', 'system']))
      expect(toasts()).toEqual([STANDING_IN])
    } finally {
      unbind()
    }
  })

  it('report what Say hello heard in plain words, without a toast', async () => {
    const outcome = await speakWithFreeFallback('Hello. This is Hermes, speaking from Herald OS.', undefined, { notice: false })

    expect(outcome).toEqual({ spokenBy: 'system', failed: 'edge' })
    expect(helloReport(outcome)?.text).toBe("Microsoft's free voice failed, so your Mac's voice said hello instead. Updating Hermes usually fixes it.")
    expect(edges.played).toEqual(['system'])
    expect(toasts()).toEqual([])

    await startVoice('button')
    await submitVoiceTranscript("What's next on my calendar?")
    await vi.waitFor(() => expect(edges.played).toEqual(['system', 'system']))
    expect(toasts()).toEqual([])
  })
})
