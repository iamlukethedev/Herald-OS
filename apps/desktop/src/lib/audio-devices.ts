// The device list, the identity of a stored choice, and the name matcher the commands use. Pure on
// purpose: no DOM and no store, so the pickers and the capture path share one answer and it is
// unit-tested in the `node` test environment. See docs/VOICE.md.
import type { AudioDevicePref } from '../../shared/ipc.ts'

export type AudioDeviceKind = 'input' | 'output'

/** What `kind` Chromium reports for each of our device kinds. */
const MEDIA_KIND: Record<AudioDeviceKind, MediaDeviceKind> = { input: 'audioinput', output: 'audiooutput' }

/** The subset of `MediaDeviceInfo` this module needs, so tests can pass plain objects. */
export interface MediaDeviceInfoLike {
  deviceId: string
  groupId: string
  kind: string
  label: string
}

/** One selectable device. */
export interface AudioDeviceOption {
  /** Chromium's `deviceId`, for `getUserMedia` and `setSinkId`. */
  id: string
  /** The device name as Chromium reports it, including its own "(Bluetooth)"/"(Virtual)" suffix. */
  label: string
  /** Groups a device's input and output together; the only stable thing a track reports. */
  groupId: string
  /** The device Chromium's `default` alias points at right now. */
  isSystem: boolean
  /** A virtual device (BlackHole, a screen recorder). Selectable, but ordered last. */
  isVirtual: boolean
}

export interface AudioDeviceList {
  devices: AudioDeviceOption[]
  /** False until microphone permission is granted: without labels, devices cannot be told apart. */
  labelsAvailable: boolean
}

/** Why a device was picked. `missing` means the stored choice is not connected right now. */
export type DeviceChoiceReason = 'automatic' | 'chosen' | 'missing' | 'unavailable'

export interface DeviceChoice {
  /** The device to use, or null when there is nothing to offer. */
  device: AudioDeviceOption | null
  reason: DeviceChoiceReason
  /** True when the stored id was gone but the label matched: the caller may rewrite the stored id. */
  rebind: boolean
  /** The stored choice when it is not connected, so the caller can name it in a notice. */
  absent: AudioDevicePref | null
}

/** Words that mean "follow the system" when someone says or types a device name. */
const AUTOMATIC_WORDS = ['automatic', 'auto', 'default', 'system']

/** Chromium marks a device's transport in the label. Used only for ordering and wording, never to decide. */
const VIRTUAL_LABEL = /\(virtual\)\s*$/i

/** The aliases Chromium adds beside the real devices. `default` is the system default device. */
const SYSTEM_ALIAS = 'default'
const COMMUNICATION_ALIAS = 'communications'

export function isVirtualDeviceLabel(label: string): boolean {
  return VIRTUAL_LABEL.test(label)
}

/**
 * Build the list a picker shows. The aliases come out (the picker offers "Automatic" itself) but
 * they are used first to mark which real device the system default points at.
 */
export function listAudioDevices(raw: readonly MediaDeviceInfoLike[], kind: AudioDeviceKind): AudioDeviceList {
  const wanted = MEDIA_KIND[kind]
  const matching = raw.filter(device => device.kind === wanted)
  const alias = matching.find(device => device.deviceId === SYSTEM_ALIAS)
  const communication = matching.find(device => device.deviceId === COMMUNICATION_ALIAS)
  const devices = matching.filter(device => device.deviceId !== SYSTEM_ALIAS && device.deviceId !== COMMUNICATION_ALIAS)

  const system = devices.find(device => alias !== undefined && device.groupId === alias.groupId) ?? devices.find(device => communication !== undefined && device.groupId === communication.groupId)

  const options = devices
    .map(device => ({
      id: device.deviceId,
      label: device.label,
      groupId: device.groupId,
      isSystem: device.deviceId === system?.deviceId,
      isVirtual: isVirtualDeviceLabel(device.label)
    }))
    .sort((left, right) => Number(left.isVirtual) - Number(right.isVirtual))

  return { devices: options, labelsAvailable: options.every(option => option.label.trim().length > 0) }
}

/** The same list built outside a browser, where there is nothing to enumerate. */
export function emptyDeviceList(): AudioDeviceList {
  return { devices: [], labelsAvailable: false }
}

/**
 * Decide which device to use. A stored choice wins while it is connected; while it is absent the
 * system default is used and the stored choice is kept, so reconnecting brings it back.
 */
export function resolveAudioDevice(pref: AudioDevicePref | null, list: AudioDeviceList): DeviceChoice {
  const system = list.devices.find(device => device.isSystem) ?? null
  // With nothing to choose from the reason is the same whatever was stored: there is no device to
  // open, and saying which one is missing would be beside the point.
  const reason = list.devices.length === 0 ? 'unavailable' : undefined

  if (!pref) {
    return { device: system, reason: reason ?? 'automatic', rebind: false, absent: null }
  }

  const byId = list.devices.find(device => device.id === pref.id)

  if (byId) {
    return { device: byId, reason: 'chosen', rebind: false, absent: null }
  }

  // Device ids are salted per origin, so a cache clear or a packaged build changes them. The label
  // is the fallback identity; a duplicate label resolves to the first match and rebinding rewrites it.
  const byLabel = pref.label ? list.devices.find(device => device.label === pref.label) : undefined

  if (byLabel) {
    return { device: byLabel, reason: 'chosen', rebind: true, absent: null }
  }

  return { device: system, reason: reason ?? 'missing', rebind: false, absent: pref }
}

export type AudioDeviceMatch = { device: AudioDeviceOption } | { error: string }

/**
 * The one device whose name matches `query`, for the voice and command-bar commands. An exact name
 * (case-insensitive) wins; otherwise a single partial match; ambiguous or absent is an error that
 * lists what there is, the same way the Wi-Fi and Bluetooth commands already answer.
 */
export function findAudioDevice(list: AudioDeviceList, query: string): AudioDeviceMatch {
  const needle = query.trim().toLowerCase()

  if (!needle || AUTOMATIC_WORDS.includes(needle)) {
    return { error: 'Say which device, or use the automatic choice.' }
  }

  const exact = list.devices.find(device => device.label.trim().toLowerCase() === needle)

  if (exact) {
    return { device: exact }
  }

  const matches = list.devices.filter(device => device.label.trim().toLowerCase().includes(needle))

  if (matches.length === 1) {
    return { device: matches[0] }
  }

  const known = list.devices.map(device => device.label).join(', ')

  return { error: matches.length ? `Which one? ${matches.map(device => device.label).join(', ')}` : `Nothing called "${query}"; there is ${known || 'nothing'}.` }
}

/** True when a spoken or typed name means "follow the system" rather than a device. */
export function isAutomaticDeviceName(query: string): boolean {
  return AUTOMATIC_WORDS.includes(query.trim().toLowerCase())
}

/**
 * One line for a picker's detail: which device a conversation would open right now, and why. Kept
 * here so the panel, the settings page and the `audio.devices` command answer identically.
 */
export function describeDeviceChoice(choice: DeviceChoice, kind: AudioDeviceKind): string {
  const label = kind === 'input' ? 'Microphone' : 'Speaker'

  switch (choice.reason) {
    case 'automatic':
      return choice.device ? `${label}: ${choice.device.label} (system default)` : `${label}: the system default`

    case 'chosen':
      return choice.device ? `${label}: ${choice.device.label}` : `${label}: not available`

    case 'missing':
      return choice.device ? `${label}: ${choice.device.label} (system default)` : `${label}: the system default`

    case 'unavailable':
      return `No ${kind === 'input' ? 'microphone' : 'speaker'} was found`
  }
}
