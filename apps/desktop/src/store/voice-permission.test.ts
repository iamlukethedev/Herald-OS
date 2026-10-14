import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_DEFAULTS } from '../../shared/voice-prefs.ts'

// Starting a conversation when the microphone will not open: the notification says why, and on macOS
// offers to open the pane where the switch is when the reason is the permission.

const edges = vi.hoisted(() => {
  Object.assign(globalThis, { window: { innerWidth: 1440, innerHeight: 900, heraldOS: {} }, document: { activeElement: null } })

  return {
    notified: [] as Array<{ title: string; body?: string; actions?: unknown }>,
    refuse: null as Error | null,
    platform: 'darwin' as NodeJS.Platform
  }
})

vi.mock('./backend.ts', () => ({
  $prefs: atom({ voice: { ...VOICE_DEFAULTS, enabled: true, engine: 'chained' } }),
  get $env() {
    return atom({ platform: edges.platform })
  },
  $windowState: atom({ fullscreen: false, focused: true }),
  updatePrefs: async () => undefined
}))
vi.mock('./gateway.ts', () => ({ $gatewayReady: atom({ version: 'test' }), gatewayRequest: async () => ({}), onGatewayEvent: () => () => undefined }))
vi.mock('./notifications.ts', async importOriginal => ({ ...(await importOriginal<object>()), notify: (input: (typeof edges.notified)[number]) => void edges.notified.push(input) }))
vi.mock('./wake.ts', () => ({ pauseWake: async () => undefined, resumeWake: async () => undefined }))
vi.mock('./shell.ts', () => ({ isMainSurface: true, onShellCommand: () => () => undefined }))
vi.mock('../lib/voice/earcons.ts', () => ({ earcons: new Proxy({}, { get: () => () => undefined }) }))
vi.mock('../lib/voice/chained-engine.ts', () => ({
  ChainedEngine: class {
    async start() {
      throw edges.refuse
    }
  }
}))

const { MicrophoneUnavailableError } = await import('../lib/voice/audio-capture.ts')
const { $voice, startVoice } = await import('./voice.ts')

beforeEach(() => {
  edges.notified.length = 0
  edges.platform = 'darwin'
})

describe('a conversation that cannot open the microphone', () => {
  it('offers to open the Microphone pane when access is denied', async () => {
    edges.refuse = new MicrophoneUnavailableError('denied', 'Microphone access is denied. Allow Herald OS in System Settings > Privacy & Security > Microphone.')
    await startVoice('button')

    expect(edges.notified).toEqual([
      {
        title: 'Voice could not start',
        body: 'Microphone access is denied. Allow Herald OS in System Settings > Privacy & Security > Microphone.',
        level: 'error',
        actions: [{ label: 'Open System Settings', command: 'privacy.openPane', args: { pane: 'microphone' } }]
      }
    ])
    expect($voice.get().error).toBe(edges.refuse.message)
  })

  it('offers no button for another failure, or off macOS', async () => {
    edges.refuse = new MicrophoneUnavailableError('no-device', 'No microphone was found.')
    await startVoice('button')

    edges.platform = 'linux'
    edges.refuse = new MicrophoneUnavailableError('denied', 'Microphone access was denied.')
    await startVoice('button')

    expect(edges.notified.map(entry => entry.actions)).toEqual([undefined, undefined])
  })
})
