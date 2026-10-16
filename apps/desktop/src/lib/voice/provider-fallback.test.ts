import { beforeEach, describe, expect, it, vi } from 'vitest'
import { failedProvider, isProviderConfigError, resetProviderFallback, withProviderFallback } from './provider-fallback.ts'

/** What the renderer saw when Microsoft started asking for a new token and Hermes's edge-tts was too old. */
const EDGE_403 = "POST /api/audio/speak -> 400: TTS generation failed (edge): 403, message='Invalid response status', url='wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'"
const NO_ELEVENLABS_KEY = 'POST /api/audio/speak -> 400: TTS configuration error (elevenlabs): ELEVENLABS_API_KEY not set'

const restCalls: Array<{ method: string; path: string; body?: unknown }> = []
let configured = 'openai'

beforeEach(() => {
  restCalls.length = 0
  configured = 'openai'
  resetProviderFallback()
  // The renderer bridge: GET /api/config reports the provider, PUT /api/config records the switch.
  ;(globalThis as unknown as { window: unknown }).window = {
    heraldOS: {
      backend: {
        rest: async (request: { method: string; path: string; body?: { config?: { tts?: { provider?: string }; stt?: { provider?: string } } } }) => {
          restCalls.push(request)

          if (request.method === 'GET') {
            return { tts: { provider: configured }, stt: { provider: configured } }
          }

          configured = request.body?.config?.tts?.provider ?? request.body?.config?.stt?.provider ?? configured

          return { ok: true }
        }
      }
    }
  }
})

describe('isProviderConfigError', () => {
  it('recognises setup failures and ignores audio failures', () => {
    expect(isProviderConfigError(new Error('TTS configuration error (openai): neither tts.openai.api_key in config nor OPENAI_API_KEY is set'))).toBe(true)
    expect(isProviderConfigError(new Error('the Nous Tool Gateway is not available (not entitled or unreachable)'))).toBe(true)
    expect(isProviderConfigError(new Error('Audio recording is empty'))).toBe(false)
  })

  it('never counts a failure of the free provider, which needs no setup', () => {
    expect(isProviderConfigError(new Error(EDGE_403))).toBe(false)
    expect(isProviderConfigError(new Error(EDGE_403), 'tts')).toBe(false)
    expect(isProviderConfigError(new Error('TTS dependency missing (edge): No module named edge_tts'))).toBe(false)
    expect(isProviderConfigError(new Error(NO_ELEVENLABS_KEY))).toBe(true)
    expect(isProviderConfigError(new Error('TTS generation failed (openai): Error code: 403 - unsupported_country_region_territory'))).toBe(true)
  })
})

describe('failedProvider', () => {
  it('names the provider a Hermes speech error names', () => {
    expect(failedProvider(new Error(EDGE_403))).toBe('edge')
    expect(failedProvider(new Error(NO_ELEVENLABS_KEY))).toBe('elevenlabs')
    expect(failedProvider(new Error('Hermes backend is not ready'))).toBeNull()
  })
})

describe('withProviderFallback', () => {
  it('switches to the free provider once and retries', async () => {
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('OPENAI_API_KEY is not set')).mockResolvedValue('spoken')
    const switched = vi.fn()

    await expect(withProviderFallback('tts', attempt, switched)).resolves.toBe('spoken')
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(switched).toHaveBeenCalledWith('openai', 'edge')
    expect(restCalls.some(call => call.method === 'PUT' && JSON.stringify(call.body).includes('"edge"'))).toBe(true)
  })

  it('does not loop when the free provider itself fails', async () => {
    configured = 'edge'
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('edge-tts is not installed'))

    await expect(withProviderFallback('tts', attempt)).rejects.toThrow('not installed')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(restCalls.filter(call => call.method === 'PUT')).toHaveLength(0)
  })

  it('rethrows non-configuration errors untouched', async () => {
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('Audio recording is empty'))

    await expect(withProviderFallback('stt', attempt)).rejects.toThrow('empty')
    expect(restCalls).toHaveLength(0)
  })

  it('leaves the config alone when Microsoft refuses the free Edge voice', async () => {
    configured = 'edge'
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(new Error(EDGE_403))
    const switched = vi.fn()

    await expect(withProviderFallback('tts', attempt, switched)).rejects.toThrow('403')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(switched).not.toHaveBeenCalled()
    expect(restCalls).toHaveLength(0)
  })

  it('still switches a missing ElevenLabs key to the free voice', async () => {
    configured = 'elevenlabs'
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error(NO_ELEVENLABS_KEY)).mockResolvedValue('spoken')
    const switched = vi.fn()

    await expect(withProviderFallback('tts', attempt, switched)).resolves.toBe('spoken')
    expect(switched).toHaveBeenCalledWith('elevenlabs', 'edge')
    expect(restCalls.filter(call => call.method === 'PUT').map(call => call.body)).toEqual([{ config: { tts: { provider: 'edge' } } }])
  })

  it('counts an unset provider as the free one Hermes uses by default', async () => {
    configured = ''
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('edge-tts is not installed'))

    await expect(withProviderFallback('tts', attempt)).rejects.toThrow('not installed')
    expect(restCalls.filter(call => call.method === 'PUT')).toHaveLength(0)
  })
})
