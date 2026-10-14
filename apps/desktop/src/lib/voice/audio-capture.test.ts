import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioDevicePref, HeraldOSPrefs } from '../../../shared/ipc.ts'
import { VOICE_DEFAULTS } from '../../../shared/voice-prefs.ts'

// The capture graph against fake tracks: a getUserMedia that hands out one fake track per call, an
// enumerateDevices the test controls, and stand-ins for the Web Audio nodes it wires up.

const backend = vi.hoisted(() => ({ prefs: null as unknown as ReturnType<typeof atom<HeraldOSPrefs>>, updatePrefs: vi.fn() }))

vi.mock('../../store/backend.ts', () => ({
  get $prefs() {
    return backend.prefs
  },
  updatePrefs: (patch: Partial<HeraldOSPrefs>) => backend.updatePrefs(patch)
}))

interface FakeDevice {
  deviceId: string
  groupId: string
  label: string
}

class FakeTrack {
  enabled = true
  stopped = false
  private readonly handlers = new Map<string, Set<() => void>>()

  constructor(
    readonly deviceId: string,
    readonly groupId: string,
    private readonly reportedId: string = deviceId
  ) {}

  getSettings() {
    return { deviceId: this.reportedId, groupId: this.groupId }
  }

  stop() {
    this.stopped = true
  }

  addEventListener(type: string, handler: () => void) {
    this.handlers.set(type, (this.handlers.get(type) ?? new Set()).add(handler))
  }

  removeEventListener(type: string, handler: () => void) {
    this.handlers.get(type)?.delete(handler)
  }

  /** What Chromium does when the device behind the track goes away. */
  end() {
    for (const handler of this.handlers.get('ended') ?? []) {
      handler()
    }
  }
}

class FakeStream {
  constructor(readonly track: FakeTrack) {}

  getTracks() {
    return [this.track]
  }

  getAudioTracks() {
    return [this.track]
  }
}

let devices: FakeDevice[] = []
let tracks: FakeTrack[] = []
let deviceChange: (() => void) | null = null

function enumerateDevices() {
  const system = devices[0]
  const aliases = system ? [{ deviceId: 'default', groupId: system.groupId, kind: 'audioinput', label: `Default - ${system.label}` }] : []

  return Promise.resolve([...aliases, ...devices.map(device => ({ ...device, kind: 'audioinput' }))])
}

function getUserMedia(constraints: { audio: { deviceId?: { exact: string } } }) {
  const wanted = constraints.audio.deviceId?.exact

  if (wanted) {
    const device = devices.find(one => one.deviceId === wanted)

    if (!device) {
      return Promise.reject(Object.assign(new Error('gone'), { name: 'OverconstrainedError' }))
    }

    const track = new FakeTrack(device.deviceId, device.groupId)
    tracks.push(track)

    return Promise.resolve(new FakeStream(track))
  }

  const system = devices[0]

  if (!system) {
    return Promise.reject(Object.assign(new Error('none'), { name: 'NotFoundError' }))
  }

  // Unconstrained, Chromium reports the `default` alias as the track's device id.
  const track = new FakeTrack(system.deviceId, system.groupId, 'default')
  tracks.push(track)

  return Promise.resolve(new FakeStream(track))
}

class FakeAudioContext {
  sampleRate = 48_000
  audioWorklet = { addModule: () => Promise.resolve() }
  createMediaStreamSource() {
    return { connect: () => undefined, disconnect: () => undefined }
  }
  close() {
    return Promise.resolve()
  }
}

class FakeWorkletNode {
  port = { onmessage: null, close: () => undefined }
  disconnect() {}
}

const userMedia = vi.fn(getUserMedia)

function setChoice(pref: AudioDevicePref | null) {
  backend.prefs.set({ ...backend.prefs.get(), voice: { ...backend.prefs.get().voice, inputDevice: pref } })
}

async function loadCapture() {
  return import('./audio-capture.ts')
}

/** Let the queued examine and reopen promises run. */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }

  await vi.advanceTimersByTimeAsync(0)
}

const TONOR: FakeDevice = { deviceId: 'i-tonor', groupId: 'g-tonor', label: 'Tonor (USB)' }
const BUILT_IN: FakeDevice = { deviceId: 'i-built-in', groupId: 'g-built-in', label: 'MacBook Pro Microphone (Built-in)' }

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  backend.prefs = atom({ voice: { ...VOICE_DEFAULTS, enabled: true } } as HeraldOSPrefs)
  backend.updatePrefs = vi.fn(async (patch: Partial<HeraldOSPrefs>) => backend.prefs.set({ ...backend.prefs.get(), ...patch }))
  devices = [BUILT_IN, TONOR]
  tracks = []
  deviceChange = null
  userMedia.mockClear()

  vi.stubGlobal('window', { heraldOS: { voice: { microphoneStatus: async () => 'granted', requestMicrophone: async () => 'granted' } } })
  vi.stubGlobal('document', { baseURI: 'file:///app/' })
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: userMedia,
      enumerateDevices,
      addEventListener: (_type: string, handler: () => void) => {
        deviceChange = handler
      },
      removeEventListener: () => {
        deviceChange = null
      }
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('audio-capture with a raw-stream holder (Live)', () => {
  it('hands the holder the new track when a new microphone is chosen, and stops the old one', async () => {
    const capture = await loadCapture()
    const onTrack = vi.fn()
    const hold = await capture.holdMicrophoneStream(onTrack)
    const first = tracks[0]

    setChoice({ id: TONOR.deviceId, label: TONOR.label })
    await settle()

    expect(first.stopped).toBe(true)
    expect(tracks).toHaveLength(2)
    expect(tracks[1].deviceId).toBe(TONOR.deviceId)
    expect(onTrack).toHaveBeenCalledWith(tracks[1])
    hold.release()
  })

  it('hands the holder the new track when its device is lost', async () => {
    setChoice({ id: TONOR.deviceId, label: TONOR.label })
    const capture = await loadCapture()
    const onTrack = vi.fn()
    await capture.holdMicrophoneStream(onTrack)

    devices = [BUILT_IN]
    tracks[0].end()
    await settle()

    expect(tracks[1].deviceId).toBe(BUILT_IN.deviceId)
    expect(onTrack).toHaveBeenCalledWith(tracks[1])
  })

  it('keeps the microphone open for a holder after the last frame subscriber leaves', async () => {
    const capture = await loadCapture()
    const hold = await capture.holdMicrophoneStream(() => undefined)
    const unsubscribe = await capture.subscribeMicrophone(() => undefined)

    unsubscribe()
    expect(capture.isMicrophoneOpen()).toBe(true)
    expect(tracks[0].stopped).toBe(false)

    hold.release()
    expect(capture.isMicrophoneOpen()).toBe(false)
    expect(tracks[0].stopped).toBe(true)
  })

  it('does not reopen an idle microphone for a change that arrives after everyone let go', async () => {
    const capture = await loadCapture()
    const hold = await capture.holdMicrophoneStream(() => undefined)

    tracks[0].end()
    hold.release()
    await settle()

    expect(userMedia).toHaveBeenCalledTimes(1)
    expect(capture.isMicrophoneOpen()).toBe(false)
  })
})

describe('audio-capture mute', () => {
  it('keeps the microphone muted across a reopen', async () => {
    const capture = await loadCapture()
    await capture.subscribeMicrophone(() => undefined)

    capture.setMicrophoneMuted(true)
    expect(tracks[0].enabled).toBe(false)

    setChoice({ id: TONOR.deviceId, label: TONOR.label })
    await settle()

    expect(tracks).toHaveLength(2)
    expect(tracks[1].enabled).toBe(false)

    capture.setMicrophoneMuted(false)
    expect(tracks[1].enabled).toBe(true)
  })
})

describe('audio-capture device identity', () => {
  it('rewrites a choice found by its name to the id it has now', async () => {
    setChoice({ id: 'i-tonor-from-the-dev-build', label: TONOR.label })
    const capture = await loadCapture()

    await capture.refreshInputDevices()
    await settle()

    expect(backend.updatePrefs).toHaveBeenCalledTimes(1)
    expect(backend.prefs.get().voice.inputDevice).toEqual({ id: TONOR.deviceId, label: TONOR.label })

    await capture.refreshInputDevices()
    await settle()
    expect(backend.updatePrefs).toHaveBeenCalledTimes(1)
  })

  it('opens the label-matched device and does not reopen once its id is rewritten', async () => {
    setChoice({ id: 'i-tonor-old', label: TONOR.label })
    const capture = await loadCapture()

    await capture.subscribeMicrophone(() => undefined)
    await settle()

    expect(tracks[0].deviceId).toBe(TONOR.deviceId)
    expect(userMedia).toHaveBeenCalledTimes(1)
  })

  it('does not loop reopening on device changes when the device reports no group', async () => {
    devices = [{ ...BUILT_IN, groupId: '' }, { ...TONOR, groupId: '' }]
    const capture = await loadCapture()
    await capture.subscribeMicrophone(() => undefined)

    for (let i = 0; i < 6; i++) {
      deviceChange?.()
      await vi.advanceTimersByTimeAsync(500)
      await settle()
    }

    expect(userMedia).toHaveBeenCalledTimes(1)
    expect(capture.$captureNotice.get()).toBeNull()
  })

  it('does not loop reopening an automatic stream whose track reports `default`', async () => {
    const capture = await loadCapture()
    await capture.subscribeMicrophone(() => undefined)

    deviceChange?.()
    await vi.advanceTimersByTimeAsync(500)
    await settle()

    expect(userMedia).toHaveBeenCalledTimes(1)
  })

  it('falls back to the system microphone without a notice when the chosen one cannot be opened', async () => {
    setChoice({ id: TONOR.deviceId, label: TONOR.label })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const original = userMedia.getMockImplementation()
    userMedia.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('busy'), { name: 'OverconstrainedError' })))
    const capture = await loadCapture()

    await capture.subscribeMicrophone(() => undefined)

    expect(tracks[0].deviceId).toBe(BUILT_IN.deviceId)
    expect(capture.$micDevice.get()?.id).toBe(BUILT_IN.deviceId)
    expect(capture.$captureNotice.get()).toBeNull()
    expect(backend.prefs.get().voice.inputDevice?.id).toBe(TONOR.deviceId)
    expect(warn).toHaveBeenCalled()
    userMedia.mockImplementation(original ?? getUserMedia)
    warn.mockRestore()
  })
})
