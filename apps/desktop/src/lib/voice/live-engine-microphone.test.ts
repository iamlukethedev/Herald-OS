import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceHost } from './engine.ts'

// The Live engine against a hold whose track is replaced after it was taken (a reopen while the
// session was still being set up): the sender must get the track open now, not the stale one.

const capture = vi.hoisted(() => ({
  current: null as unknown,
  release: vi.fn(),
  holder: null as { onTrack: (track: unknown) => void; onFailed: (error: Error) => void } | null,
  /** Resolves the hold once called; set to keep the hold pending until the test lets it go. */
  gate: null as Promise<void> | null
}))

vi.mock('./audio-capture.ts', () => ({
  MicrophoneUnavailableError: class extends Error {},
  setMicrophoneMuted: () => undefined,
  holdMicrophoneStream: async (holder: { onTrack: (track: unknown) => void; onFailed: (error: Error) => void }) => {
    capture.holder = holder
    const taken = capture.current

    if (capture.gate) {
      await capture.gate
    }

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
let offerResult: () => Promise<unknown> = () => Promise.reject(new Error('stop here'))

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
  localDescription = { sdp: 'v=0' }
  closed = false
  createOffer() {
    return offerResult()
  }
  setLocalDescription() {
    return Promise.resolve()
  }
  close() {
    this.closed = true
  }
}

beforeEach(() => {
  added.length = 0
  capture.release.mockClear()
  capture.gate = null
  offerResult = () => Promise.reject(new Error('stop here'))
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
    capture.holder?.onTrack(fresh)

    await expect(starting).rejects.toThrow('stop here')
    expect(added).toEqual([fresh])
    expect(capture.release).toHaveBeenCalledTimes(1)
  })

  it('releases the hold, adds no track and ends quietly when stopped while the mic was opening', async () => {
    const { LiveEngine } = await import('./live-engine.ts')
    const ended = vi.fn()
    const host = new Proxy({}, { get: (_target, key) => (key === 'ended' ? ended : vi.fn()) }) as unknown as VoiceHost
    let open: () => void = () => undefined
    capture.gate = new Promise(resolve => (open = resolve))
    capture.current = { id: 'track' }

    const engine = new LiveEngine(host)
    const starting = engine.start()
    await engine.stop()
    open()

    await expect(starting).resolves.toBeUndefined()
    expect(added).toEqual([])
    expect(capture.release).toHaveBeenCalledTimes(1)
    expect(ended).not.toHaveBeenCalled()
  })

  it('ends the session and releases the mic when the microphone cannot be reopened', async () => {
    const { LiveEngine } = await import('./live-engine.ts')
    const ended = vi.fn()
    const host = new Proxy({}, { get: (_target, key) => (key === 'ended' ? ended : vi.fn()) }) as unknown as VoiceHost
    capture.current = { id: 'track' }
    // Leave the session mid-setup, so the failure arrives while the engine holds the mic.
    offerResult = () => new Promise(() => undefined)

    const engine = new LiveEngine(host)
    void engine.start()
    await vi.waitFor(() => expect(added).toHaveLength(1))

    capture.holder?.onFailed(Object.assign(new Error('Microphone access was denied.'), { name: 'MicrophoneUnavailableError' }))

    expect(capture.release).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledWith('error', 'The microphone stopped working: Microphone access was denied.')
  })
})
