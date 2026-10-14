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

const contexts: FakeAudioContext[] = []

class FakeAudioContext {
  closed = false
  sampleRate = 48_000
  constructor() {
    contexts.push(this)
  }
  audioWorklet = { addModule: () => Promise.resolve() }
  createMediaStreamSource() {
    return { connect: () => undefined, disconnect: () => undefined }
  }
  close() {
    this.closed = true

    return Promise.resolve()
  }
}

const nodes: FakeWorkletNode[] = []

class FakeWorkletNode {
  port: { onmessage: ((event: { data: Float32Array }) => void) | null; close: () => void } = { onmessage: null, close: () => undefined }
  constructor() {
    nodes.push(this)
  }
  /** One block of audio from the worklet, as the real one posts it. */
  emit() {
    this.port.onmessage?.({ data: new Float32Array(128).fill(0.1) })
  }
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

const idleHolder = () => ({ onTrack: () => undefined, onFailed: () => undefined })

/** Make getUserMedia fail for one device (or every request, with `all`), the way Chromium does. */
function failRequests(name: string, which: { deviceId?: string; all?: boolean }) {
  userMedia.mockImplementation(constraints => {
    const wanted = constraints.audio.deviceId?.exact

    if (which.all || wanted === which.deviceId) {
      return Promise.reject(Object.assign(new Error(name), { name }))
    }

    return getUserMedia(constraints)
  })
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
  contexts.length = 0
  nodes.length = 0

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
  userMedia.mockImplementation(getUserMedia)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('audio-capture with a raw-stream holder (Live)', () => {
  it('hands the holder the new track when a new microphone is chosen, and stops the old one', async () => {
    const capture = await loadCapture()
    const onTrack = vi.fn()
    const hold = await capture.holdMicrophoneStream({ onTrack, onFailed: vi.fn() })
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
    await capture.holdMicrophoneStream({ onTrack, onFailed: vi.fn() })

    devices = [BUILT_IN]
    tracks[0].end()
    await settle()

    expect(tracks[1].deviceId).toBe(BUILT_IN.deviceId)
    expect(onTrack).toHaveBeenCalledWith(tracks[1])
  })

  it('keeps the microphone open for a holder after the last frame subscriber leaves', async () => {
    const capture = await loadCapture()
    const hold = await capture.holdMicrophoneStream(idleHolder())
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
    const hold = await capture.holdMicrophoneStream(idleHolder())

    tracks[0].end()
    hold.release()
    await settle()

    expect(userMedia).toHaveBeenCalledTimes(1)
    expect(capture.isMicrophoneOpen()).toBe(false)
  })
})

describe('audio-capture reopen guard', () => {
  const YETI: FakeDevice = { deviceId: 'i-yeti', groupId: 'g-yeti', label: 'Yeti (USB)' }
  const AIRPODS: FakeDevice = { deviceId: 'i-airpods', groupId: 'g-airpods', label: 'AirPods (Bluetooth)' }

  it('does not count four quick picks as a device that keeps changing', async () => {
    devices = [BUILT_IN, TONOR, YETI, AIRPODS]
    const capture = await loadCapture()
    const onTrack = vi.fn()
    await capture.holdMicrophoneStream({ onTrack, onFailed: vi.fn() })
    const frames = vi.fn()
    await capture.subscribeMicrophone(frames)

    for (const device of [TONOR, YETI, AIRPODS, TONOR]) {
      setChoice({ id: device.deviceId, label: device.label })
      await settle()
    }

    const open = tracks.filter(track => !track.stopped)
    expect(open).toHaveLength(1)
    expect(open[0].deviceId).toBe(TONOR.deviceId)
    expect(capture.$micDevice.get()?.id).toBe(TONOR.deviceId)
    expect(onTrack).toHaveBeenLastCalledWith(open[0])
    expect(capture.$captureNotice.get()).toBeNull()
  })

  it('applies a pick made while the stream is being reopened for the previous one', async () => {
    devices = [BUILT_IN, TONOR, YETI, AIRPODS]
    const capture = await loadCapture()
    await capture.subscribeMicrophone(() => undefined)

    let resume: () => void = () => undefined
    userMedia.mockImplementationOnce(constraints => new Promise(resolve => (resume = () => resolve(getUserMedia(constraints)))))

    setChoice({ id: TONOR.deviceId, label: TONOR.label })
    await settle()
    expect(capture.isMicrophoneOpen()).toBe(false)

    // The Tonor is still being opened when the person picks the Yeti.
    setChoice({ id: YETI.deviceId, label: YETI.label })
    resume()
    await settle()
    await settle()

    const open = tracks.filter(track => !track.stopped)
    expect(open).toHaveLength(1)
    expect(open[0].deviceId).toBe(YETI.deviceId)
    expect(capture.$captureNotice.get()).toBeNull()
  })
})

describe('audio-capture reopen failures', () => {
  it('falls back to the system microphone and hands Live its track when the chosen device errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const capture = await loadCapture()
    const holder = { onTrack: vi.fn(), onFailed: vi.fn() }
    await capture.holdMicrophoneStream(holder)

    failRequests('NotReadableError', { deviceId: TONOR.deviceId })
    setChoice({ id: TONOR.deviceId, label: TONOR.label })
    await settle()

    const open = tracks.filter(track => !track.stopped)
    expect(open).toHaveLength(1)
    expect(open[0].deviceId).toBe(BUILT_IN.deviceId)
    expect(holder.onTrack).toHaveBeenCalledWith(open[0])
    expect(holder.onFailed).not.toHaveBeenCalled()
    expect(capture.isMicrophoneOpen()).toBe(true)
    expect(backend.prefs.get().voice.inputDevice?.id).toBe(TONOR.deviceId)
    warn.mockRestore()
  })

  it('falls back to the system microphone when the chosen device is lost and fails to reopen', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setChoice({ id: TONOR.deviceId, label: TONOR.label })
    const capture = await loadCapture()
    const holder = { onTrack: vi.fn(), onFailed: vi.fn() }
    await capture.holdMicrophoneStream(holder)

    failRequests('AbortError', { deviceId: TONOR.deviceId })
    tracks[0].end()
    await settle()

    expect(holder.onTrack).toHaveBeenCalledWith(tracks[tracks.length - 1])
    expect(tracks[tracks.length - 1].deviceId).toBe(BUILT_IN.deviceId)
    expect(holder.onFailed).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('tells the holders, and posts a notice, when permission is revoked and nothing can be opened', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setChoice({ id: TONOR.deviceId, label: TONOR.label })
    const capture = await loadCapture()
    const holder = { onTrack: vi.fn(), onFailed: vi.fn() }
    await capture.holdMicrophoneStream(holder)

    failRequests('NotAllowedError', { all: true })
    tracks[0].end()
    await settle()

    expect(holder.onTrack).not.toHaveBeenCalled()
    expect(holder.onFailed).toHaveBeenCalledTimes(1)
    expect(holder.onFailed.mock.calls[0][0]).toMatchObject({ name: 'MicrophoneUnavailableError', reason: 'denied' })
    expect(capture.$captureNotice.get()?.key).toBe('voice.input-reopen-failed')
    expect(capture.isMicrophoneOpen()).toBe(false)
    expect(tracks.every(track => track.stopped)).toBe(true)
    warn.mockRestore()
  })

  it('tells the holders when the system default fails too after a device error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const capture = await loadCapture()
    const holder = { onTrack: vi.fn(), onFailed: vi.fn() }
    await capture.holdMicrophoneStream(holder)

    failRequests('NotReadableError', { all: true })
    setChoice({ id: TONOR.deviceId, label: TONOR.label })
    await settle()

    expect(holder.onFailed).toHaveBeenCalledTimes(1)
    expect(holder.onFailed.mock.calls[0][0]).toMatchObject({ reason: 'failed' })
    warn.mockRestore()
  })
})

describe('audio-capture frame subscribers after a failed reopen', () => {
  async function failedReopen() {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const capture = await loadCapture()
    const frames = vi.fn()
    const onFailed = vi.fn()
    await capture.subscribeMicrophone(frames, onFailed)

    failRequests('NotReadableError', { all: true })
    tracks[0].end()
    await settle()

    return { capture, frames, onFailed, warn }
  }

  async function deviceListChanges() {
    deviceChange?.()
    await vi.advanceTimersByTimeAsync(500)
    await settle()
  }

  it('tells a subscriber the reopen failed and keeps it subscribed, still watching the device list', async () => {
    const { capture, onFailed, warn } = await failedReopen()

    expect(onFailed).toHaveBeenCalledTimes(1)
    expect(onFailed.mock.calls[0][0]).toMatchObject({ name: 'MicrophoneUnavailableError', reason: 'failed' })
    expect(capture.isMicrophoneOpen()).toBe(false)
    expect(deviceChange).not.toBeNull()
    warn.mockRestore()
  })

  it('reopens on the next device change, and the subscriber gets frames again', async () => {
    const { capture, frames, warn } = await failedReopen()

    userMedia.mockImplementation(getUserMedia)
    await deviceListChanges()

    expect(capture.isMicrophoneOpen()).toBe(true)
    expect(tracks.filter(track => !track.stopped)).toHaveLength(1)

    nodes[nodes.length - 1].emit()
    expect(frames).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('reopens when the person picks a microphone after the failure', async () => {
    const { capture, warn } = await failedReopen()

    userMedia.mockImplementation(getUserMedia)
    setChoice({ id: TONOR.deviceId, label: TONOR.label })
    await settle()

    expect(capture.isMicrophoneOpen()).toBe(true)
    expect(capture.$micDevice.get()?.id).toBe(TONOR.deviceId)
    warn.mockRestore()
  })

  it('keeps retrying under the guard: three tries, a pause, then again once the window has passed', async () => {
    const { capture, onFailed, warn } = await failedReopen()
    onFailed.mockClear()
    userMedia.mockClear()

    for (let i = 0; i < 4; i++) {
      await deviceListChanges()
    }

    // The lost device's own reopen used one of the three; two more retries (one request each, as
    // nothing is chosen), then the pause.
    expect(userMedia).toHaveBeenCalledTimes(2)
    expect(capture.$captureNotice.get()?.key).toBe('voice.input-retry-paused')

    userMedia.mockImplementation(getUserMedia)
    await vi.advanceTimersByTimeAsync(10_000)
    await deviceListChanges()

    expect(capture.isMicrophoneOpen()).toBe(true)
    warn.mockRestore()
  })

  it('stops watching the device list once the last subscriber leaves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const capture = await loadCapture()
    const unsubscribe = await capture.subscribeMicrophone(() => undefined, () => undefined)

    failRequests('NotReadableError', { all: true })
    tracks[0].end()
    await settle()
    unsubscribe()

    expect(deviceChange).toBeNull()
    userMedia.mockClear()
    userMedia.mockImplementation(getUserMedia)
    await deviceListChanges()
    expect(userMedia).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('audio-capture hold', () => {
  it('reads the current track and stream, not the ones it was taken with', async () => {
    const capture = await loadCapture()
    const hold = await capture.holdMicrophoneStream(idleHolder())
    const first = hold.track

    expect(first).toBe(tracks[0])

    setChoice({ id: TONOR.deviceId, label: TONOR.label })
    await settle()

    expect(hold.track).toBe(tracks[1])
    expect(hold.stream?.getAudioTracks()[0]).toBe(tracks[1])
    expect((first as unknown as FakeTrack).stopped).toBe(true)
    hold.release()
  })
})

describe('audio-capture open failures', () => {
  const failures: [string, () => void][] = [
    [
      'AudioContext',
      () =>
        vi.stubGlobal(
          'AudioContext',
          class {
            constructor() {
              throw new Error('no audio')
            }
          }
        )
    ],
    [
      'AudioWorkletNode',
      () =>
        vi.stubGlobal(
          'AudioWorkletNode',
          class {
            constructor() {
              throw new Error('no worklet')
            }
          }
        )
    ],
    [
      'createMediaStreamSource',
      () =>
        vi.stubGlobal(
          'AudioContext',
          class extends FakeAudioContext {
            override createMediaStreamSource(): never {
              throw new Error('no source')
            }
          }
        )
    ]
  ]

  for (const [name, breakIt] of failures) {
    it(`stops the tracks and closes the context when ${name} throws`, async () => {
      breakIt()
      const capture = await loadCapture()

      await expect(capture.subscribeMicrophone(() => undefined)).rejects.toMatchObject({ name: 'MicrophoneUnavailableError', reason: 'failed' })

      expect(tracks).toHaveLength(1)
      expect(tracks[0].stopped).toBe(true)
      expect(contexts.every(context => context.closed)).toBe(true)
      expect(capture.isMicrophoneOpen()).toBe(false)
    })
  }

  it('stops the tracks when the worklet module fails to load', async () => {
    vi.stubGlobal(
      'AudioContext',
      class extends FakeAudioContext {
        override audioWorklet = { addModule: () => Promise.reject(new Error('404')) }
      }
    )
    const capture = await loadCapture()

    await expect(capture.subscribeMicrophone(() => undefined)).rejects.toThrow('Audio worklet failed to load: 404')
    expect(tracks[0].stopped).toBe(true)
    expect(contexts[0].closed).toBe(true)
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

  it('does not rebind when two devices share the chosen name', async () => {
    devices = [BUILT_IN, { ...TONOR, deviceId: 'i-tonor-a', groupId: 'g-tonor-a' }, { ...TONOR, deviceId: 'i-tonor-b', groupId: 'g-tonor-b' }]
    setChoice({ id: 'i-tonor-old', label: TONOR.label })
    const capture = await loadCapture()

    await capture.subscribeMicrophone(() => undefined)
    await settle()

    expect(backend.updatePrefs).not.toHaveBeenCalled()
    expect(backend.prefs.get().voice.inputDevice).toEqual({ id: 'i-tonor-old', label: TONOR.label })
    expect(tracks[0].deviceId).toBe(BUILT_IN.deviceId)
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

describe('microphoneDenied', () => {
  it('is true when macOS refuses Herald OS the microphone', async () => {
    vi.stubGlobal('window', { heraldOS: { voice: { microphoneStatus: async () => 'denied', requestMicrophone: async () => 'denied' } } })
    const capture = await loadCapture()
    const error = await capture.subscribeMicrophone(() => undefined).catch((reason: unknown) => reason)

    expect(error).toMatchObject({ name: 'MicrophoneUnavailableError', reason: 'denied' })
    expect(capture.microphoneDenied(error)).toBe(true)
    expect(tracks).toHaveLength(0)
  })

  it('is false for any other reason the microphone did not open', async () => {
    const capture = await loadCapture()

    expect(capture.microphoneDenied(new capture.MicrophoneUnavailableError('no-device', 'No microphone was found.'))).toBe(false)
    expect(capture.microphoneDenied(new capture.MicrophoneUnavailableError('failed', 'Audio capture could not start.'))).toBe(false)
    expect(capture.microphoneDenied(new Error('Microphone access was denied.'))).toBe(false)
    expect(capture.microphoneDenied('denied')).toBe(false)
  })
})
