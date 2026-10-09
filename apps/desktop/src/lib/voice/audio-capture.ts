// One microphone graph for every voice consumer (wake detector feed, utterance recorder, barge-in
// monitor, WebRTC sender). Consumers subscribe to 16 kHz mono int16 frames; the mic is opened when
// the first subscriber arrives and released when the last one leaves, so the privacy indicator maps
// 1:1 onto "the mic is actually open".
//
// Which device the graph opens is the person's choice (`voice.inputDevice`) or the system default,
// and a device that disappears never leaves the graph silent: the stream is reopened on whatever the
// choice resolves to now, and the reasons are decided by the pure `capture-policy.ts`. See
// docs/VOICE.md.
import { atom } from 'nanostores'
import type { AudioDevicePref } from '../../../shared/ipc.ts'
import { listAudioDevices, resolveAudioDevice, type AudioDeviceList, type AudioDeviceOption } from '../audio-devices.ts'
import { $prefs } from '../../store/backend.ts'
import { initialCaptureState, reduceCapture, type CaptureAction, type CaptureState, type CaptureTarget } from './capture-policy.ts'
import { floatToInt16, resampleLinear, rms, TARGET_SAMPLE_RATE } from './pcm.ts'

export interface CaptureFrame {
  /** 16 kHz mono int16 samples. */
  pcm: Int16Array
  /** RMS of the frame, 0..1. */
  level: number
  /** Duration of the frame in milliseconds. */
  ms: number
}

type FrameListener = (frame: CaptureFrame) => void

/** True while the microphone is open (drives the menu-bar indicator). */
export const $micOpen = atom(false)
/** Latest input level, 0..1, for the orb. */
export const $micLevel = atom(0)
/** The device the frames come from, once the mic is open. */
export const $micDevice = atom<AudioDeviceOption | null>(null)
/** The microphones the picker offers, refreshed when the mic opens and when the device list changes. */
export const $inputDevices = atom<AudioDeviceList>({ devices: [], labelsAvailable: false })
/** A condition worth telling the person about; the key de-duplicates it in notifications. */
export const $captureNotice = atom<{ key: string; message: string } | null>(null)

export class MicrophoneUnavailableError extends Error {
  constructor(
    readonly reason: 'denied' | 'no-device' | 'unsupported' | 'failed',
    message: string
  ) {
    super(message)
    this.name = 'MicrophoneUnavailableError'
  }
}

/** Quiet period after a device list change, so a burst of Bluetooth events is examined once. */
const DEVICE_CHANGE_DEBOUNCE_MS = 400

let context: AudioContext | null = null
let stream: MediaStream | null = null
let worklet: AudioWorkletNode | null = null
let source: MediaStreamAudioSourceNode | null = null
let opening: Promise<void> | null = null
let reopening: Promise<void> | null = null
let policy: CaptureState = initialCaptureState()
let stopWatching: (() => void) | null = null
let deviceChangeTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<FrameListener>()

async function open(): Promise<void> {
  if (context && stream) {
    return
  }

  if (opening) {
    return opening
  }

  opening = (async () => {
    const permission = await window.heraldOS.voice.microphoneStatus().catch(() => 'unknown' as const)

    if (permission === 'not-determined') {
      const granted = await window.heraldOS.voice.requestMicrophone().catch(() => 'unknown' as const)

      if (granted === 'denied' || granted === 'restricted') {
        throw new MicrophoneUnavailableError('denied', 'Microphone access was denied. Allow Herald OS in System Settings > Privacy & Security > Microphone.')
      }
    } else if (permission === 'denied' || permission === 'restricted') {
      throw new MicrophoneUnavailableError('denied', 'Microphone access is denied. Allow Herald OS in System Settings > Privacy & Security > Microphone.')
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new MicrophoneUnavailableError('unsupported', 'This window cannot capture audio.')
    }

    const { media, device } = await openStream()
    const ctx = new AudioContext({ latencyHint: 'interactive' })

    try {
      await ctx.audioWorklet.addModule(new URL('voice-capture-worklet.js', document.baseURI).toString())
    } catch (error) {
      media.getTracks().forEach(track => track.stop())
      await ctx.close()
      throw new MicrophoneUnavailableError('failed', `Audio worklet failed to load: ${error instanceof Error ? error.message : String(error)}`)
    }

    const node = new AudioWorkletNode(ctx, 'hermes-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 })
    const src = ctx.createMediaStreamSource(media)
    src.connect(node)
    const inputRate = ctx.sampleRate

    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const floats = event.data
      const resampled = resampleLinear(floats, inputRate, TARGET_SAMPLE_RATE)
      const frame: CaptureFrame = { pcm: floatToInt16(resampled), level: rms(floats), ms: (floats.length / inputRate) * 1000 }
      $micLevel.set(frame.level)

      for (const listener of listeners) {
        listener(frame)
      }
    }

    context = ctx
    stream = media
    worklet = node
    source = src
    $micOpen.set(true)
    $micDevice.set(device)
    watchDevices(media)
  })()

  try {
    await opening
  } finally {
    opening = null
  }
}

/**
 * Ask for the chosen device, and fall back to the system default when it cannot be opened. `exact`
 * rather than `ideal`, so a device that is away fails here where it is noticed, instead of Chromium
 * quietly handing back a different one; the fallback itself stays quiet — the panel's line names
 * the device in use, and the picker's list notes that a chosen device comes back on its own.
 */
async function openStream(): Promise<{ media: MediaStream; device: AudioDeviceOption | null }> {
  const list = await refreshInputDevices()
  const choice = resolveAudioDevice($prefs.get().voice.inputDevice, list)
  const wanted = choice.reason === 'chosen' ? choice.device : null

  try {
    return { media: await requestStream(wanted?.id ?? null), device: wanted ?? choice.device }
  } catch (error) {
    const name = error instanceof Error ? error.name : ''

    if (name === 'OverconstrainedError') {
      if (wanted) {
        $captureNotice.set({ key: 'voice.input-unusable', message: `${wanted.label} could not be opened, so the system microphone is used.` })

        return { media: await requestStream(null), device: null }
      }

      throw new MicrophoneUnavailableError('no-device', 'No microphone was found.')
    }

    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new MicrophoneUnavailableError('denied', 'Microphone access was denied.')
    }

    if (name === 'NotFoundError') {
      throw new MicrophoneUnavailableError('no-device', 'No microphone was found.')
    }

    throw new MicrophoneUnavailableError('failed', error instanceof Error ? error.message : String(error))
  }
}

async function requestStream(deviceId: string | null): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
    video: false
  })
}

function close(): void {
  stopWatching?.()
  stopWatching = null
  source?.disconnect()
  worklet?.port.close()
  worklet?.disconnect()
  stream?.getTracks().forEach(track => track.stop())
  void context?.close().catch(() => undefined)
  source = null
  worklet = null
  stream = null
  context = null
  $micOpen.set(false)
  $micLevel.set(0)
  $micDevice.set(null)
  policy = reduceCapture(policy, { kind: 'closed' }, Date.now()).state
}

/**
 * Watch the open stream: the track ending means the device was lost (a deliberate `track.stop()`
 * never fires it), and a device list change means the choice may resolve to somewhere else now.
 */
function watchDevices(media: MediaStream): void {
  const track = media.getAudioTracks()[0]
  const settings = track?.getSettings() ?? {}
  const deviceId = typeof settings.deviceId === 'string' ? settings.deviceId : 'default'
  const groupId = typeof settings.groupId === 'string' ? settings.groupId : ''

  policy = reduceCapture(policy, { kind: 'opened', deviceId, groupId: groupId || null }, Date.now()).state

  const onEnded = () => void examine('lost')

  track?.addEventListener('ended', onEnded)

  const onDeviceChange = () => {
    if (deviceChangeTimer) {
      clearTimeout(deviceChangeTimer)
    }

    deviceChangeTimer = setTimeout(() => {
      deviceChangeTimer = null
      void examine('devices')
    }, DEVICE_CHANGE_DEBOUNCE_MS)
  }

  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)

  const unsubscribePrefs = $prefs.subscribe((prefs, previous) => {
    // Subscribe fires once with the current value and no previous one; there is nothing to apply then.
    if (previous && prefs.voice.inputDevice !== previous.voice.inputDevice) {
      void examine('chosen')
    }
  })

  stopWatching = () => {
    track?.removeEventListener('ended', onEnded)
    navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
    unsubscribePrefs()

    if (deviceChangeTimer) {
      clearTimeout(deviceChangeTimer)
      deviceChangeTimer = null
    }
  }
}

/** Re-resolve the choice and let the policy decide whether that means reopening the stream. */
async function examine(trigger: 'lost' | 'chosen' | 'devices'): Promise<void> {
  examining = examining.then(() => examineNow(trigger)).catch(() => undefined)

  return examining
}

let examining: Promise<void> = Promise.resolve()

async function examineNow(trigger: 'lost' | 'chosen' | 'devices'): Promise<void> {
  const list = await refreshInputDevices()
  const choice = resolveAudioDevice($prefs.get().voice.inputDevice, list)
  const target: CaptureTarget = { deviceId: choice.device?.id ?? null, groupId: choice.device?.groupId ?? null, reason: choice.reason }
  const { action, state } = reduceCapture(policy, { kind: trigger, target }, Date.now())
  policy = state

  await apply(action)
}

async function apply(action: CaptureAction): Promise<void> {
  if (action.kind === 'none' || action.kind === 'defer') {
    return
  }

  if (action.kind === 'giveUp') {
    $captureNotice.set({ key: 'voice.input-flapping', message: 'The microphone keeps changing device, so the current one is kept. Choose a microphone in Settings > Voice.' })

    return
  }

  if (reopening) {
    return reopening
  }

  reopening = (async () => {
    close()
    await open()
  })()

  try {
    await reopening
  } catch {
    // The subscription that opened the mic reports a device that cannot be opened; nothing to add.
  } finally {
    reopening = null
  }
}

/** Re-read the microphones: when the mic opens, when the device list changes, and by the picker. */
export async function refreshInputDevices(): Promise<AudioDeviceList> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return $inputDevices.get()
  }

  const list = listAudioDevices(await navigator.mediaDevices.enumerateDevices(), 'input')
  $inputDevices.set(list)

  return list
}

/**
 * Tell the graph whether a conversation is listening. A change caused by the system waits for a
 * conversation to end; that wait is applied here, by examining again with the new state.
 */
export function setCaptureConversing(listening: boolean): void {
  if (policy.conversing === listening) {
    return
  }

  policy = reduceCapture(policy, { kind: 'conversation', conversing: listening }, Date.now()).state

  if (!listening && $micOpen.get()) {
    void examine('devices')
  }
}

/** Forget the last notice once it has been shown, so the same condition can be reported again later. */
export function acknowledgeCaptureNotice(): void {
  $captureNotice.set(null)
}

/**
 * Start receiving microphone frames. Resolves once the mic is open; the returned function stops
 * this subscription and closes the mic when nobody else listens.
 */
export async function subscribeMicrophone(listener: FrameListener): Promise<() => void> {
  listeners.add(listener)

  try {
    await open()
  } catch (error) {
    listeners.delete(listener)

    if (listeners.size === 0) {
      close()
    }

    throw error
  }

  let active = true

  return () => {
    if (!active) {
      return
    }

    active = false
    listeners.delete(listener)

    if (listeners.size === 0) {
      close()
    }
  }
}

/**
 * The raw MediaStream for consumers that need a track (WebRTC). Opens the mic if needed. A consumer
 * holding one keeps it for as long as it runs: a change of device applies to the next stream.
 */
export async function microphoneStream(): Promise<MediaStream> {
  await open()

  if (!stream) {
    throw new MicrophoneUnavailableError('failed', 'Microphone stream unavailable.')
  }

  return stream
}

/** Mute at the track level so every consumer (including a WebRTC sender) goes silent. */
export function setMicrophoneMuted(muted: boolean): void {
  stream?.getAudioTracks().forEach(track => {
    track.enabled = !muted
  })
}

export function isMicrophoneOpen(): boolean {
  return $micOpen.get()
}

/** The chosen microphone while the graph is idle, so a picker can describe what it would open. */
export function preferredInputDevice(): AudioDevicePref | null {
  return $prefs.get().voice.inputDevice
}
