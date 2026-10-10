import { describe, expect, it } from 'vitest'
import { describeDeviceChoice, findAudioDevice, isAutomaticDeviceName, listAudioDevices, resolveAudioDevice, type AudioDeviceList, type MediaDeviceInfoLike } from './audio-devices.ts'

/*
 * Fixtures follow what Chromium reports on macOS: an alias entry per kind whose `groupId` points at
 * the real device, transport suffixes in the labels, and virtual devices mixed in. Ids are shortened.
 */
const input = (deviceId: string, groupId: string, label: string): MediaDeviceInfoLike => ({ deviceId, groupId, kind: 'audioinput', label })

const RAW: MediaDeviceInfoLike[] = [
  input('default', 'g-airpods', 'Default - AirPods (Bluetooth)'),
  input('i-airpods', 'g-airpods', 'AirPods (Bluetooth)'),
  input('i-blackhole', 'g-blackhole', 'BlackHole 2ch (Virtual)'),
  input('i-builtin', 'g-builtin', 'Microfono MacBook Air (Built-in)'),
  { deviceId: 'o-airpods', groupId: 'g-airpods', kind: 'audiooutput', label: 'AirPods (Bluetooth)' }
]

const list = (raw: MediaDeviceInfoLike[] = RAW) => listAudioDevices(raw, 'input')

describe('listAudioDevices', () => {
  it('drops the alias entries and keeps only the asked-for kind', () => {
    expect(list().devices.map(device => device.id)).toEqual(['i-airpods', 'i-builtin', 'i-blackhole'])
  })

  it('marks the device the system default points at, through the group, not the alias id', () => {
    const { devices } = list()
    expect(devices.filter(device => device.isSystem).map(device => device.id)).toEqual(['i-airpods'])
  })

  it('orders virtual devices last and keeps the rest in the order Chromium gave', () => {
    expect(list().devices.at(-1)?.id).toBe('i-blackhole')
  })

  it('reports when labels are missing, because devices cannot be told apart then', () => {
    expect(list([input('default', 'g', ''), input('i1', 'g', '')]).labelsAvailable).toBe(false)
    expect(list().labelsAvailable).toBe(true)
  })

  it('has no system device when Chromium offers no alias', () => {
    expect(list([input('i1', 'g1', 'Tonor (USB)')]).devices.every(device => !device.isSystem)).toBe(true)
  })

  it('falls back to the communications alias for the system device', () => {
    const raw = [{ deviceId: 'communications', groupId: 'g1', kind: 'audioinput', label: 'communications' }, input('i1', 'g1', 'Tonor (USB)')]
    expect(list(raw).devices.find(device => device.isSystem)?.id).toBe('i1')
  })
})

describe('resolveAudioDevice', () => {
  const devices = list()

  it('follows the system when nothing was chosen', () => {
    const choice = resolveAudioDevice(null, devices)
    expect(choice).toMatchObject({ reason: 'automatic', rebind: false, absent: null })
    expect(choice.device?.id).toBe('i-airpods')
  })

  it('uses the chosen device while it is connected', () => {
    const choice = resolveAudioDevice({ id: 'i-blackhole', label: 'BlackHole 2ch (Virtual)' }, devices)
    expect(choice).toMatchObject({ reason: 'chosen', rebind: false })
    expect(choice.device?.id).toBe('i-blackhole')
  })

  it('falls back to the system when the chosen device is gone, and keeps the choice', () => {
    const pref = { id: 'i-tonor', label: 'Tonor (USB)' }
    const choice = resolveAudioDevice(pref, devices)
    expect(choice).toMatchObject({ reason: 'missing', rebind: false, absent: pref })
    expect(choice.device?.id).toBe('i-airpods')
  })

  it('recognises the chosen device by label when the id changed, and says the id needs rewriting', () => {
    const choice = resolveAudioDevice({ id: 'i-old-id', label: 'Microfono MacBook Air (Built-in)' }, devices)
    expect(choice).toMatchObject({ reason: 'chosen', rebind: true })
    expect(choice.device?.id).toBe('i-builtin')
  })

  it('does not match by label when the labels are missing', () => {
    const anonymised: AudioDeviceList = { devices: devices.devices.map(device => ({ ...device, label: '' })), labelsAvailable: false }
    expect(resolveAudioDevice({ id: 'i-old-id', label: 'Microfono MacBook Air (Built-in)' }, anonymised).reason).toBe('missing')
  })

  it('says unavailable when there are no devices at all', () => {
    expect(resolveAudioDevice({ id: 'x', label: 'y' }, { devices: [], labelsAvailable: false })).toMatchObject({ reason: 'unavailable', device: null })
  })
})

describe('findAudioDevice', () => {
  const devices = list()

  it('prefers an exact name, whatever the case', () => {
    expect(findAudioDevice(devices, 'airpods (bluetooth)')).toEqual({ device: devices.devices[0] })
  })

  it('accepts a single partial name', () => {
    const match = findAudioDevice(devices, 'macbook')
    expect('device' in match && match.device.id).toBe('i-builtin')
  })

  it('answers with the devices it knows when nothing matches', () => {
    const match = findAudioDevice(devices, 'tonor')
    expect('error' in match && match.error).toContain('AirPods (Bluetooth)')
  })

  it('asks which one when several match', () => {
    const match = findAudioDevice(devices, '(')
    expect('error' in match && match.error.startsWith('Which one?')).toBe(true)
  })

  it('refuses an empty query and the automatic words', () => {
    expect('error' in findAudioDevice(devices, '  ')).toBe(true)
    expect('error' in findAudioDevice(devices, 'automatic')).toBe(true)
  })
})

describe('isAutomaticDeviceName', () => {
  it('recognises the words that mean following the system', () => {
    expect(isAutomaticDeviceName('Automatic')).toBe(true)
    expect(isAutomaticDeviceName(' system ')).toBe(true)
    expect(isAutomaticDeviceName('Tonor')).toBe(false)
  })
})

describe('describeDeviceChoice', () => {
  const devices = list()

  it('names the device the system default points at', () => {
    expect(describeDeviceChoice(resolveAudioDevice(null, devices), 'input')).toBe('Microphone: AirPods (Bluetooth) (system default)')
  })

  it('names a chosen device', () => {
    expect(describeDeviceChoice(resolveAudioDevice({ id: 'i-builtin', label: 'Microfono MacBook Air (Built-in)' }, devices), 'input')).toBe('Microphone: Microfono MacBook Air (Built-in)')
  })

  it('names the device in use, quietly, while a chosen device is away', () => {
    expect(describeDeviceChoice(resolveAudioDevice({ id: 'i-tonor', label: 'Tonor (USB)' }, devices), 'input')).toBe('Microphone: AirPods (Bluetooth) (system default)')
  })

  it('says when there is nothing to use', () => {
    expect(describeDeviceChoice(resolveAudioDevice(null, { devices: [], labelsAvailable: false }), 'output')).toBe('No speaker was found')
  })
})
