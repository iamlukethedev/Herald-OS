// The renderer's view of the sound devices: which microphones exist, which one a conversation would
// open, and the microphone test. The device list and the microphone graph live in
// lib/voice/audio-capture.ts; this is the glue the two pickers share, so the Sound panel and
// Settings stay thin and answer the same questions the same way.
import { atom, computed } from 'nanostores'
import type { AudioDevicePref } from '../../shared/ipc.ts'
import { describeDeviceChoice, resolveAudioDevice, type AudioDeviceKind } from '../lib/audio-devices.ts'
import { $inputDevices, $micLevel, $micOpen, refreshInputDevices, subscribeMicrophone } from '../lib/voice/audio-capture.ts'
import { $prefs, updatePrefs } from './backend.ts'
import { notify } from './notifications.ts'

export { audioScope, ownsSystemAudio } from '../lib/platform-labels.ts'

/** What the microphone picker would open right now, and why. */
export const $inputChoice = computed([$prefs, $inputDevices], (prefs, list) => resolveAudioDevice(prefs.voice.inputDevice, list))

/** One line describing the current device choice, for a row's detail or a command's answer. */
export function deviceSummary(kind: AudioDeviceKind): string {
  return describeDeviceChoice(resolveAudioDevice($prefs.get().voice[kind === 'input' ? 'inputDevice' : 'outputDevice'], $inputDevices.get()), kind)
}

/** Re-read the device list. Called when a picker mounts, which is usually while the mic is closed. */
export async function refreshAudioDevices(): Promise<void> {
  await refreshInputDevices().catch(() => undefined)
}

/** Keep the list current while a picker is on screen. Returns the unsubscribe function. */
export function watchAudioDevices(): () => void {
  const onChange = () => void refreshAudioDevices()

  navigator.mediaDevices?.addEventListener('devicechange', onChange)
  void refreshAudioDevices()

  return () => navigator.mediaDevices?.removeEventListener('devicechange', onChange)
}

/**
 * Choose the microphone, or `null` to follow the system. The open microphone graph notices the
 * preference by itself and reapplies it, so this only writes the choice.
 */
export async function chooseInputDevice(pref: AudioDevicePref | null): Promise<void> {
  await updatePrefs({ voice: { ...$prefs.get().voice, inputDevice: pref } })
}

/** How long the microphone test listens before releasing the mic. */
export const MICROPHONE_TEST_MS = 5000

/** True while the microphone test is listening. */
export const $microphoneTest = atom(false)

/**
 * True when the microphone is open for something other than the test: a conversation, the armed wake
 * word or dictation. The level meter is live then, and the test button would only be in the way.
 */
export const $micHeldElsewhere = computed([$micOpen, $microphoneTest], (open, testing) => open && !testing)

/** The level meter's fill, 0 to 100. Frames carry RMS, so a quiet room reads nearly empty. */
export const $micLevelPercent = computed($micLevel, level => Math.min(100, Math.round(level * 500)))

let stopTest: (() => void) | null = null
let testTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Open the microphone for a few seconds so the level meter has something to show. The mic is only
 * ever opened on an explicit request: "voice off" must keep meaning the mic is never opened.
 */
export async function startMicrophoneTest(): Promise<void> {
  if (stopTest) {
    return
  }

  try {
    stopTest = await subscribeMicrophone(() => undefined)
    $microphoneTest.set(true)
    testTimer = setTimeout(stopMicrophoneTest, MICROPHONE_TEST_MS)
  } catch (error) {
    stopTest = null
    $microphoneTest.set(false)
    notify({ title: 'Microphone', body: error instanceof Error ? error.message : String(error), level: 'error' })
  }
}

export function stopMicrophoneTest(): void {
  if (testTimer) {
    clearTimeout(testTimer)
    testTimer = null
  }

  stopTest?.()
  stopTest = null
  $microphoneTest.set(false)
}
