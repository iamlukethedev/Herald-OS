import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceHost } from './engine.ts'

// The Live engine against a hold whose track is replaced after it was taken (a reopen while the
// session was still being set up): the sender must get the track open now, not the stale one.

const capture = vi.hoisted(() => ({
  current: null as unknown,
  release: vi.fn(),
  onTrack: null as ((track: unknown) => void) | null
}))

vi.mock('./audio-capture.ts', () => ({
  MicrophoneUnavailableError: class extends Error {},
  setMicrophoneMuted: () => undefined,
  holdMicrophoneStream: async (onTrack: (track: unknown) => void) => {
    capture.onTrack = onTrack
    const taken = capture.current

    return {
      // The stream as it was when the hold was taken; only `track` follows a reopen.
      stream: { id: 'stream', getAudioTracks: () => [taken] },
      get track() {
        return capture.current
      },
      release: capture.release
    }
  }
}))

const added: unknown[] = []

class FakePeerConnection {
  connectionState = 'new'
  addEventListener() {}
  addTrack(track: unknown) {
    added.push(track)

    return { replaceTrack: vi.fn(async () => undefined) }
  }
  createDataChannel() {
    return { addEventListener: () => undefined, close: () => undefined, readyState: 'connecting' }
  }
  createOffer(): Promise<never> {
    return Promise.reject(new Error('stop here'))
  }
  close() {}
}

beforeEach(() => {
  added.length = 0
  capture.release.mockClear()
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
  vi.stubGlobal(
    'Audio',
    class {
      autoplay = false
      pause() {}
    }
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LiveEngine microphone', () => {
  it('adds the track open at connect time, and releases the hold when setup fails', async () => {
    const { LiveEngine } = await import('./live-engine.ts')
    const host = new Proxy({}, { get: () => vi.fn() }) as unknown as VoiceHost
    const stale = { id: 'stale' }
    const fresh = { id: 'fresh' }
    capture.current = stale

    const engine = new LiveEngine(host)
    const starting = engine.start()

    // The reopen lands after the hold was taken but before the sender exists.
    capture.current = fresh
    capture.onTrack?.(fresh)

    await expect(starting).rejects.toThrow('stop here')
    expect(added).toEqual([fresh])
    expect(capture.release).toHaveBeenCalledTimes(1)
  })
})
