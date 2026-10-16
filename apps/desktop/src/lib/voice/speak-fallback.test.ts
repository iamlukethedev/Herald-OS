import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvInfo, SystemSpeech } from '../../../shared/ipc.ts'

/** What the renderer saw when Microsoft started asking for a new token and Hermes's edge-tts was too old. */
const EDGE_403 = "POST /api/audio/speak -> 400: TTS generation failed (edge): 403, message='Invalid response status', url='wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'"
const NO_ELEVENLABS_KEY = 'POST /api/audio/speak -> 400: TTS configuration error (elevenlabs): ELEVENLABS_API_KEY not set'
const WAV: SystemSpeech = { ok: true, audio: new Uint8Array([82, 73, 70, 70]), mimeType: 'audio/wav' }

// Hermes (its config and its voice), main's system voice, and the speakers.
const edges = vi.hoisted(() => ({
  configured: 'edge' as string | null,
  puts: [] as unknown[],
  /** Each synthesis takes the next answer: a clip, or an error to throw. */
  synthesis: [] as Array<{ src: string; provider: string } | Error>,
  system: (_text: string): SystemSpeech => ({ ok: false, reason: 'missing', detail: 'unset' }),
  systemSaid: [] as string[],
  played: [] as string[],
  refusePlayback: null as Error | null
}))

vi.mock('./speak-stream.ts', () => {
  let silencedAt = 0

  return {
    playbackTicket: () => {
      const taken = silencedAt

      return () => taken === silencedAt
    },
    stopFallbackAudio: () => {
      silencedAt++
    },
    synthesizeOnce: async () => {
      const next = edges.synthesis.shift() ?? new Error('no synthesis scripted')

      if (next instanceof Error) {
        throw next
      }

      return next
    },
    playClip: async (src: string, ticket?: () => boolean, onPlaying?: () => void) => {
      if (ticket && !ticket()) {
        return
      }

      if (edges.refusePlayback) {
        throw edges.refusePlayback
      }

      edges.played.push(src)
      onPlaying?.()
    }
  }
})

Object.assign(globalThis, {
  window: {
    heraldOS: {
      backend: {
        rest: async (request: { method: string; path: string; body?: { config?: { tts?: { provider?: string } } } }) => {
          if (edges.configured === null) {
            throw new Error('Hermes backend is not ready')
          }

          if (request.method === 'PUT') {
            edges.puts.push(request.body)
            edges.configured = request.body?.config?.tts?.provider ?? edges.configured

            return { ok: true }
          }

          return { tts: { provider: edges.configured } }
        }
      },
      voice: {
        systemSpeech: async (text: string) => {
          edges.systemSaid.push(text)

          return edges.system(text)
        }
      }
    }
  }
})

const { $env, $prefs } = await import('../../store/backend.ts')
const { resetProviderFallback } = await import('./provider-fallback.ts')
const { stopFallbackAudio } = await import('./speak-stream.ts')
const { fallbackNotice, helloReport, resetSpeakFallback, speakWithFallbacks } = await import('./speak-fallback.ts')

const LINE = 'I added speaker notes to all six slides.'
const notices: Array<[string, string, string]> = []
const notify = (title: string, body: string, level: string) => void notices.push([title, body, level])
const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
const onMac = () => $env.set({ platform: 'darwin' } as EnvInfo)
const onLinux = () => $env.set({ platform: 'linux' } as EnvInfo)

beforeEach(() => {
  Object.assign(edges, { configured: 'edge', synthesis: [], system: () => WAV, refusePlayback: null })
  edges.puts.length = 0
  edges.systemSaid.length = 0
  edges.played.length = 0
  notices.length = 0
  warn.mockClear()
  resetProviderFallback()
  resetSpeakFallback()
  onMac()
  $prefs.set({ ...$prefs.get(), language: 'en' })
})

describe('the spoken-output chain', () => {
  it("speaks with Hermes's voice when it works, and says nothing about it", async () => {
    edges.synthesis = [{ src: 'data:edge', provider: 'edge' }]

    expect(await speakWithFallbacks(LINE, { notify })).toEqual({ spokenBy: 'provider', provider: 'edge' })
    expect(edges.played).toEqual(['data:edge'])
    expect(edges.systemSaid).toEqual([])
    expect(notices).toEqual([])
  })

  it("has the Mac's voice say the line when Microsoft's free voice fails, and says so once a session", async () => {
    edges.synthesis = [new Error(EDGE_403), new Error(EDGE_403)]

    expect(await speakWithFallbacks(LINE, { notify })).toEqual({ spokenBy: 'system', failed: 'edge' })
    expect(edges.systemSaid).toEqual([LINE])
    expect(edges.played).toHaveLength(1)
    expect(notices).toEqual([['Voice', "Microsoft's free voice isn't working right now, so Herald OS is using your Mac's voice. Updating Hermes usually fixes it.", 'info']])
    expect(warn.mock.calls.flat().join('\n')).toContain('TTS generation failed (edge): 403')

    expect(await speakWithFallbacks('And here is the second reply.', { notify })).toEqual({ spokenBy: 'system', failed: 'edge' })
    expect(edges.systemSaid).toEqual([LINE, 'And here is the second reply.'])
    expect(notices).toHaveLength(1)
    expect(edges.puts).toEqual([])
  })

  it('calls it the system voice on Linux', async () => {
    onLinux()
    edges.synthesis = [new Error(EDGE_403)]

    await speakWithFallbacks(LINE, { notify })

    expect(notices).toEqual([['Voice', "Microsoft's free voice isn't working right now, so Herald OS is using the system voice. Updating Hermes usually fixes it.", 'info']])
  })

  it('says once, plainly, that nothing can speak when the computer has no voice of its own', async () => {
    onLinux()
    edges.system = () => ({ ok: false, reason: 'missing', detail: 'espeak-ng, espeak, flite are not installed' })
    edges.synthesis = [new Error(EDGE_403), new Error(EDGE_403)]

    expect(await speakWithFallbacks(LINE, { notify })).toEqual({ spokenBy: 'none', failed: 'edge', system: 'missing' })
    expect(await speakWithFallbacks(LINE, { notify })).toEqual({ spokenBy: 'none', failed: 'edge', system: 'missing' })
    expect(edges.played).toEqual([])
    expect(notices).toEqual([['Voice', "Microsoft's free voice isn't working right now, and there's no system voice on this computer that can stand in. Updating Hermes usually fixes it.", 'warn']])
    expect(warn.mock.calls.flat().join('\n')).toContain('espeak-ng, espeak, flite are not installed')
  })

  it('says so when the system voice fails as well', async () => {
    edges.system = () => ({ ok: false, reason: 'failed', detail: 'say exited with 1' })
    edges.synthesis = [new Error(EDGE_403)]

    expect(await speakWithFallbacks(LINE, { notify })).toEqual({ spokenBy: 'none', failed: 'edge', system: 'failed' })
    expect(notices).toEqual([['Voice', "Microsoft's free voice isn't working right now, and your Mac's voice couldn't speak either. Updating Hermes usually fixes it.", 'warn']])
  })

  it('still switches a missing ElevenLabs key to the free voice, which then speaks', async () => {
    edges.configured = 'elevenlabs'
    edges.synthesis = [new Error(NO_ELEVENLABS_KEY), { src: 'data:edge', provider: 'edge' }]
    const onSwitched = vi.fn()

    expect(await speakWithFallbacks(LINE, { notify, onSwitched })).toEqual({ spokenBy: 'provider', provider: 'edge' })
    expect(onSwitched).toHaveBeenCalledWith('elevenlabs', 'edge')
    expect(edges.systemSaid).toEqual([])
    expect(notices).toEqual([])
  })

  it('goes on to the system voice when the free voice it switched to fails too', async () => {
    edges.configured = 'elevenlabs'
    edges.synthesis = [new Error(NO_ELEVENLABS_KEY), new Error(EDGE_403)]

    expect(await speakWithFallbacks(LINE, { notify, onSwitched: () => undefined })).toEqual({ spokenBy: 'system', failed: 'edge' })
    expect(edges.puts).toEqual([{ config: { tts: { provider: 'edge' } } }])
  })

  it('names another provider plainly, with what to do about it', async () => {
    edges.configured = 'openai'
    edges.synthesis = [new Error('POST /api/audio/speak -> 400: TTS generation failed (openai): Connection error.')]

    expect(await speakWithFallbacks(LINE, { notify })).toEqual({ spokenBy: 'system', failed: 'openai' })
    expect(notices[0][1]).toBe("The OpenAI voice isn't working right now, so Herald OS is using your Mac's voice. You can choose another voice in Settings > Voice.")
  })

  it("speaks with the Mac's voice when Hermes cannot be reached at all", async () => {
    edges.configured = null
    edges.synthesis = [new Error('Hermes backend is not ready')]

    expect(await speakWithFallbacks(LINE, { notify })).toEqual({ spokenBy: 'system', failed: null })
    expect(notices[0][1]).toBe("Hermes's voice isn't working right now, so Herald OS is using your Mac's voice.")
  })

  it('says nothing at all for a line barge-in silenced while it was being made', async () => {
    edges.synthesis = [new Error(EDGE_403)]
    const spoken = speakWithFallbacks(LINE, { notify })
    stopFallbackAudio()

    expect(await spoken).toEqual({ spokenBy: 'skipped' })
    expect(edges.systemSaid).toEqual([])
    expect(notices).toEqual([])
  })

  it("lets a caller that reports the outcome itself count as the session's notice", async () => {
    edges.synthesis = [new Error(EDGE_403), new Error(EDGE_403)]

    expect(await speakWithFallbacks('Hello. This is Hermes, speaking from Herald OS.')).toEqual({ spokenBy: 'system', failed: 'edge' })
    await speakWithFallbacks(LINE, { notify })

    expect(edges.systemSaid).toHaveLength(2)
    expect(notices).toEqual([])
  })

  it("rejects when Hermes's own clip cannot be played, as before", async () => {
    edges.synthesis = [{ src: 'data:edge', provider: 'edge' }]
    edges.refusePlayback = new Error('audio playback failed')

    await expect(speakWithFallbacks(LINE, { notify })).rejects.toThrow('audio playback failed')
    expect(edges.systemSaid).toEqual([])
  })
})

describe('the words', () => {
  it('reports what Say hello heard', () => {
    expect(helloReport({ spokenBy: 'provider', provider: 'edge' })).toEqual({ tone: 'info', text: "Microsoft's free voice said hello." })
    expect(helloReport({ spokenBy: 'provider', provider: 'elevenlabs' })).toEqual({ tone: 'info', text: 'The ElevenLabs voice said hello.' })
    expect(helloReport({ spokenBy: 'system', failed: 'edge' })).toEqual({ tone: 'warn', text: "Microsoft's free voice failed, so your Mac's voice said hello instead. Updating Hermes usually fixes it." })
    expect(helloReport({ spokenBy: 'none', failed: 'edge', system: 'failed' })).toEqual({ tone: 'danger', text: "Microsoft's free voice failed, and your Mac's voice couldn't speak either. Updating Hermes usually fixes it." })
    expect(helloReport({ spokenBy: 'skipped' })).toBeNull()

    onLinux()
    expect(helloReport({ spokenBy: 'system', failed: 'edge' })?.text).toBe("Microsoft's free voice failed, so the system voice said hello instead. Updating Hermes usually fixes it.")
    expect(helloReport({ spokenBy: 'none', failed: 'edge', system: 'missing' })?.text).toBe("Microsoft's free voice failed, and there's no system voice on this computer that can stand in. Updating Hermes usually fixes it.")
  })

  it('reads in the language Herald OS is shown in', () => {
    $prefs.set({ ...$prefs.get(), language: 'pt-BR' })

    expect(fallbackNotice({ spokenBy: 'system', failed: 'edge' })).toBe('A voz gratuita da Microsoft não está funcionando agora, então o Herald OS está usando a voz do seu Mac. Atualizar o Hermes costuma resolver.')
  })
})
