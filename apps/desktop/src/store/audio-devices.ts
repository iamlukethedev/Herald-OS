// The renderer's view of the sound devices: which microphones exist, which one a conversation would
// open, and the level the meter shows. The device list and the microphone graph live in
// lib/voice/audio-capture.ts; this is the glue both pickers share, so the Sound panel and Settings
// stay thin and answer the same questions the same way.
import type { AudioDevicePref } from '../../shared/ipc.ts'
import { computed } from 'nanostores'
import { describeDeviceChoice, resolveAudioDevice, type AudioDeviceKind } from '../lib/audio-devices.ts'
import { $inputDevices, $micLevel, refreshInputDevices } from '../lib/voice/audio-capture.ts'
import { $prefs, updatePrefs } from './backend.ts'

export { audioScope, ownsSystemAudio } from '../lib/platform-labels.ts'

/** What the microphone picker would open right now, and why. */
export const $inputChoice = computed([$prefs, $inputDevices], (prefs, list) => resolveAudioDevice(prefs.voice.inputDevice, list))

/** The level meter's fill, 0 to 100. Frames carry RMS, so a quiet room reads nearly empty. */
export const $micLevelPercent = computed($micLevel, level => Math.min(100, Math.round(level * 500)))

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
