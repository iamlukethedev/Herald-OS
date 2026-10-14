import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_DEFAULTS } from '../../shared/voice-prefs.ts'

// The wake word's microphone feed after the capture graph could not reopen the microphone: it is
// told, says why it cannot hear, and clears that once frames arrive again.

const mic = vi.hoisted(() => ({
  frame: null as ((frame: { pcm: Int16Array; level: number; ms: number }) => void) | null,
  failed: null as ((error: Error) => void) | null,
  /** Why opening the microphone fails, or null when it opens. */
  refuse: null as Error | null
}))
const notified = vi.hoisted(() => [] as Array<{ title: string; actions?: unknown }>)

vi.mock('../lib/voice/audio-capture.ts', () => {
  class MicrophoneUnavailableError extends Error {
    constructor(
      readonly reason: string,
      message: string
    ) {
      super(message)
    }
  }

  return {
    MicrophoneUnavailableError,
    microphoneDenied: (error: unknown) => error instanceof MicrophoneUnavailableError && error.reason === 'denied',
    subscribeMicrophone: async (frame: typeof mic.frame, failed: typeof mic.failed) => {
      if (mic.refuse) {
        throw mic.refuse
      }

      mic.frame = frame
      mic.failed = failed

      return () => undefined
    }
  }
})
vi.mock('../lib/voice/earcons.ts', () => ({ earcons: { wake: () => undefined } }))
vi.mock('./backend.ts', () => ({
  $prefs: atom({ voice: { ...VOICE_DEFAULTS, enabled: true, wakeWord: true } }),
  $env: atom({ platform: 'darwin' }),
  updatePrefs: async () => undefined
}))
vi.mock('./gateway.ts', () => ({
  $gatewayReady: atom(true),
  gatewayRequest: vi.fn(async (method: string) => (method === 'wake.start' ? { started: true, capture: 'client', phrase: 'hey hermes' } : {})),
  onGatewayEvent: () => () => undefined
}))
vi.mock('./notifications.ts', () => ({ notify: (input: { title: string; actions?: unknown }) => void notified.push(input) }))
vi.mock('./shell.ts', () => ({ isMainSurface: true }))
vi.mock('./voice.ts', () => ({ startVoice: async () => undefined }))

beforeEach(() => {
  mic.frame = null
  mic.failed = null
  mic.refuse = null
  notified.length = 0
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

describe('wake word when the microphone is refused', () => {
  it('offers to open the Microphone pane in System Settings', async () => {
    vi.resetModules()
    const { MicrophoneUnavailableError } = await import('../lib/voice/audio-capture.ts')
    mic.refuse = new MicrophoneUnavailableError('denied', 'Microphone access is denied. Allow Herald OS in System Settings > Privacy & Security > Microphone.')
    const { $wake, bindWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect(notified).toHaveLength(1))

    expect(notified[0]).toMatchObject({ title: 'Wake word', actions: [{ label: 'Open System Settings', command: 'privacy.openPane', args: { pane: 'microphone' } }] })
    expect($wake.get()).toMatchObject({ listening: false, error: mic.refuse.message })
  })

  it('offers no button when the microphone failed for another reason', async () => {
    vi.resetModules()
    const { MicrophoneUnavailableError } = await import('../lib/voice/audio-capture.ts')
    mic.refuse = new MicrophoneUnavailableError('no-device', 'No microphone was found.')
    const { bindWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect(notified).toHaveLength(1))

    expect(notified[0].actions).toBeUndefined()
  })
})
