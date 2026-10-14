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
import { $prefs, updatePrefs } from '../../store/backend.ts'
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

/** Told the new track whenever the stream is reopened on another device, so it can swap it in. */
type TrackListener = (track: MediaStreamTrack) => void

/** A consumer of the raw stream (the WebRTC sender) and the way to let go of it. */
export interface MicrophoneHold {
  /** The stream open right now; a reopen replaces it, and it is null while one is in progress. */
  readonly stream: MediaStream | null
  /** The audio track open right now. Read this when adding the track, never a copy taken earlier. */
  readonly track: MediaStreamTrack | null
  release: () => void
}

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
/** Kept here rather than on the tracks, so a reopened stream comes back as muted as the old one. */
let muted = false
const listeners = new Set<FrameListener>()
const holders = new Set<TrackListener>()

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
    media.getAudioTracks().forEach(track => {
      track.enabled = !muted
    })
    let ctx: AudioContext | null = null
    let node: AudioWorkletNode
    let src: MediaStreamAudioSourceNode

    // Anything failing from here on must not leave the tracks running: the privacy indicator would
    // stay on with nobody listening.
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' })

      try {
        await ctx.audioWorklet.addModule(new URL('voice-capture-worklet.js', document.baseURI).toString())
      } catch (error) {
        throw new MicrophoneUnavailableError('failed', `Audio worklet failed to load: ${error instanceof Error ? error.message : String(error)}`)
      }

      node = new AudioWorkletNode(ctx, 'hermes-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 })
      src = ctx.createMediaStreamSource(media)
      src.connect(node)
    } catch (error) {
      media.getTracks().forEach(track => track.stop())
      await ctx?.close().catch(closeError => console.warn('[voice] Could not close the audio context', closeError))
      throw error instanceof MicrophoneUnavailableError ? error : new MicrophoneUnavailableError('failed', `Audio capture could not start: ${error instanceof Error ? error.message : String(error)}`)
    }

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
    watchDevices(media, device)
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
 * quietly handing back a different one. The fallback posts no notice, the same as a chosen device
 * that is not connected: the panel's line names the device in use, and the choice is kept.
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
        console.warn(`[voice] ${wanted.label} could not be opened; using the system microphone`, error)

        return { media: await requestStream(null), device: list.devices.find(device => device.isSystem) ?? null }
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
 *
 * The binding takes what the track reports, and the device it was opened for where the track says
 * less: a stream opened without a constraint reports `default`, and some devices report no group.
 */
function watchDevices(media: MediaStream, device: AudioDeviceOption | null): void {
  const track = media.getAudioTracks()[0]
  const settings = track?.getSettings() ?? {}
  const reportedId = typeof settings.deviceId === 'string' && settings.deviceId && settings.deviceId !== 'default' ? settings.deviceId : null
  const reportedGroup = typeof settings.groupId === 'string' ? settings.groupId : ''
  const deviceId = reportedId ?? device?.id ?? 'default'
  const groupId = reportedGroup || device?.groupId || ''

  policy = reduceCapture(policy, { kind: 'opened', deviceId, groupId }, Date.now()).state

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

let examining: Promise<void> = Promise.resolve()

/** Re-resolve the choice and let the policy decide whether that means reopening the stream. */
async function examine(trigger: 'lost' | 'chosen' | 'devices'): Promise<void> {
  examining = examining.then(() => examineNow(trigger)).catch(error => console.warn(`[voice] Could not re-check the microphone (${trigger})`, error))

  return examining
}

async function examineNow(trigger: 'lost' | 'chosen' | 'devices'): Promise<void> {
  // Queued behind an earlier examine, the mic may have been closed since; never reopen an idle one.
  if (!stream || !inUse()) {
    return
  }

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

    // Everyone may have let go while the device was being reopened.
    if (!inUse()) {
      close()

      return
    }

    const track = stream?.getAudioTracks()[0]

    if (track) {
      for (const holder of holders) {
        holder(track)
      }
    }
  })()

  try {
    await reopening
  } catch (error) {
    console.warn('[voice] The microphone could not be reopened', error)
    $captureNotice.set({ key: 'voice.input-reopen-failed', message: `The microphone could not be reopened: ${error instanceof Error ? error.message : String(error)}` })
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
  rebindChoice(list)

  return list
}

let rebinding: string | null = null

/**
 * A stored choice found by its name under a new id (a cache clear, a dev build against a packaged
 * one) is rewritten to that id, so the pickers mark it as chosen and the next lookup is by id.
 */
function rebindChoice(list: AudioDeviceList): void {
  const choice = resolveAudioDevice($prefs.get().voice.inputDevice, list)

  if (!choice.rebind || !choice.device || rebinding === choice.device.id) {
    return
  }

  const device = choice.device
  rebinding = device.id
  void updatePrefs({ voice: { ...$prefs.get().voice, inputDevice: { id: device.id, label: device.label } } })
    .catch(error => console.warn('[voice] Could not remember the microphone under its new id', error))
    .finally(() => {
      rebinding = null
    })
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
    closeIfUnused()

    throw error
  }

  let active = true

  return () => {
    if (!active) {
      return
    }

    active = false
    listeners.delete(listener)
    closeIfUnused()
  }
}

function inUse(): boolean {
  return listeners.size > 0 || holders.size > 0
}

function closeIfUnused(): void {
  if (!inUse()) {
    close()
  }
}

/**
 * The raw MediaStream for consumers that need a track (WebRTC). Opens the mic if needed and keeps it
 * open until `release`. Reopening on another device stops the old tracks, so `onTrack` is handed the
 * new one (a sender's `replaceTrack`); without it a Live session would be left on a dead track.
 */
export async function holdMicrophoneStream(onTrack: TrackListener): Promise<MicrophoneHold> {
  holders.add(onTrack)

  try {
    await open()
  } catch (error) {
    holders.delete(onTrack)
    closeIfUnused()

    throw error
  }

  if (!stream) {
    holders.delete(onTrack)
    closeIfUnused()

    throw new MicrophoneUnavailableError('failed', 'Microphone stream unavailable.')
  }

  let held = true

  return {
    get stream() {
      return stream
    },
    get track() {
      return stream?.getAudioTracks()[0] ?? null
    },
    release: () => {
      if (!held) {
        return
      }

      held = false
      holders.delete(onTrack)
      closeIfUnused()
    }
  }
}

/** Mute at the track level so every consumer (including a WebRTC sender) goes silent, reopened or not. */
export function setMicrophoneMuted(next: boolean): void {
  muted = next
  stream?.getAudioTracks().forEach(track => {
    track.enabled = !next
  })
}

export function isMicrophoneOpen(): boolean {
  return $micOpen.get()
}

/** The chosen microphone while the graph is idle, so a picker can describe what it would open. */
export function preferredInputDevice(): AudioDevicePref | null {
  return $prefs.get().voice.inputDevice
}
