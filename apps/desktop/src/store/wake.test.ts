import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_DEFAULTS } from '../../shared/voice-prefs.ts'

// The wake word's microphone feed after the capture graph could not reopen the microphone: it is
// told, says why it cannot hear, and clears that once frames arrive again.

const mic = vi.hoisted(() => ({
  frame: null as ((frame: { pcm: Int16Array; level: number; ms: number }) => void) | null,
  failed: null as ((error: Error) => void) | null
}))

vi.mock('../lib/voice/audio-capture.ts', () => ({
  MicrophoneUnavailableError: class extends Error {},
  subscribeMicrophone: async (frame: typeof mic.frame, failed: typeof mic.failed) => {
    mic.frame = frame
    mic.failed = failed

    return () => undefined
  }
}))
vi.mock('../lib/voice/earcons.ts', () => ({ earcons: { wake: () => undefined } }))
vi.mock('./backend.ts', () => ({ $prefs: atom({ voice: { ...VOICE_DEFAULTS, enabled: true, wakeWord: true } }), updatePrefs: async () => undefined }))
vi.mock('./gateway.ts', () => ({
  $gatewayReady: atom(true),
  gatewayRequest: vi.fn(async (method: string) => (method === 'wake.start' ? { started: true, capture: 'client', phrase: 'hey hermes' } : {})),
  onGatewayEvent: () => () => undefined
}))
vi.mock('./notifications.ts', () => ({ notify: () => undefined }))
vi.mock('./shell.ts', () => ({ isMainSurface: true }))
vi.mock('./voice.ts', () => ({ startVoice: async () => undefined }))

beforeEach(() => {
  mic.frame = null
  mic.failed = null
})

describe('wake word after a failed microphone reopen', () => {
  it('reports that it cannot hear, and recovers when frames come back', async () => {
    vi.resetModules()
    const { $wake, bindWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect(mic.failed).not.toBeNull())
    expect($wake.get()).toMatchObject({ listening: true, error: null })

    mic.failed?.(new Error('Microphone access was denied.'))
    expect($wake.get().error).toBe('Wake word cannot hear: Microphone access was denied.')

    mic.frame?.({ pcm: new Int16Array(1280), level: 0.1, ms: 80 })
    expect($wake.get().error).toBeNull()
  })

  it('keeps an error that did not come from the microphone when frames resume', async () => {
    vi.resetModules()
    const { $wake, bindWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect(mic.failed).not.toBeNull())

    const owned = 'Another Hermes client (tui) owns the wake word.'
    $wake.set({ ...$wake.get(), error: owned })
    mic.frame?.({ pcm: new Int16Array(1280), level: 0.1, ms: 80 })
    expect($wake.get().error).toBe(owned)

    // A microphone failure that something else then overrides: frames resuming leave the newer error.
    mic.failed?.(new Error('Microphone access was denied.'))
    $wake.set({ ...$wake.get(), error: owned })
    mic.frame?.({ pcm: new Int16Array(1280), level: 0.1, ms: 80 })
    expect($wake.get().error).toBe(owned)
  })
})
