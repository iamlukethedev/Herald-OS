import type { ControlAction, StatusPanelId, StatusPanelState } from '../../shared/ipc.ts'
import { findAudioDevice, isAutomaticDeviceName } from '../lib/audio-devices.ts'
import { ownsSystemAudio } from '../lib/platform-labels.ts'
import { $inputDevices } from '../lib/voice/audio-capture.ts'
import { chooseInputDevice, deviceSummary, refreshAudioDevices } from '../store/audio-devices.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { openStatusPanel, PANEL_TITLES } from '../store/status-panel.ts'

/* The menu bar's quick panels as commands: Wi-Fi, Bluetooth, sound, displays and power. */

const PANEL_NAMES = ['wifi', 'bluetooth', 'audio', 'display', 'power', 'clock'] as const

async function status<P extends Exclude<StatusPanelId, 'clock'>>(panel: P): Promise<Extract<StatusPanelState, { panel: P }>> {
  return (await window.heraldOS.controls.status(panel)) as Extract<StatusPanelState, { panel: P }>
}

const act = (action: ControlAction) => window.heraldOS.controls.act(action)

/** The one entry whose name contains `query` (case-insensitive), preferring an exact name. */
function pick<T extends { name: string }>(items: readonly T[], query: string): T | { error: string } {
  const needle = query.trim().toLowerCase()
  const exact = items.find(item => item.name.toLowerCase() === needle)

  if (exact) {
    return exact
  }

  const matches = items.filter(item => item.name.toLowerCase().includes(needle))

  if (matches.length === 1) {
    return matches[0]
  }

  return { error: matches.length ? `Which one? ${matches.map(item => item.name).join(', ')}` : `Nothing called "${query}"; there is ${items.map(item => item.name).join(', ') || 'nothing'}.` }
}

export const controlCommands: readonly OsCommand[] = [
  {
    id: 'panel.open',
    title: 'Open a quick panel',
    description: 'Open the menu bar panel for Wi-Fi, Bluetooth, sound (audio), displays, battery and power, or the calendar (clock).',
    tier: 'read',
    args: [{ name: 'panel', type: 'string', description: 'wifi, bluetooth, audio, display, power or clock', required: true, enum: PANEL_NAMES }],
    phrases: [
      { phrase: 'show wi-fi', args: { panel: 'wifi' } },
      { phrase: 'open the wi-fi panel', args: { panel: 'wifi' } },
      { phrase: 'show bluetooth', args: { panel: 'bluetooth' } },
      { phrase: 'show sound settings', args: { panel: 'audio' } },
      { phrase: 'show the calendar', args: { panel: 'clock' } }
    ],
    run: ({ panel }) => {
      openStatusPanel(panel as StatusPanelId)

      return ok(`Opened ${PANEL_TITLES[panel as StatusPanelId]}`)
    }
  },
  {
    id: 'wifi.list',
    title: 'Wi-Fi networks',
    description: 'List the Wi-Fi networks in range and say which one is connected.',
    tier: 'read',
    args: [],
    phrases: ['what wi-fi am i on', 'list wi-fi networks', 'which networks are nearby'],
    run: async () => {
      const { wifi } = await status('wifi')

      if (!wifi.available) {
        return fail('This computer has no Wi-Fi.')
      }

      return ok(wifi.connected ? `Connected to ${wifi.connected}; ${wifi.networks.length} networks in range` : `Not connected; ${wifi.networks.length} networks in range`, { items: wifi.networks, data: { enabled: wifi.enabled, connected: wifi.connected } })
    }
  },
  {
    id: 'wifi.connect',
    title: 'Join a Wi-Fi network',
    description: 'Connect to a Wi-Fi network by name (Herald OS Linux); a password is needed the first time for a secured network.',
    tier: 'mutate',
    args: [
      { name: 'network', type: 'string', description: 'Network name', required: true },
      { name: 'password', type: 'string', description: 'The password, for a network not joined before' }
    ],
    phrases: ['join the wi-fi {network}', 'connect to the wi-fi {network}'],
    run: async ({ network, password }) => {
      const { wifi } = await status('wifi')
      const match = pick(
        wifi.networks.map(n => ({ ...n, name: n.ssid })),
        String(network)
      )

      if ('error' in match) {
        return fail(match.error)
      }

      if (match.secure && !match.known && !password) {
        openStatusPanel('wifi')

        return fail(`${match.ssid} needs its password; type it in the Wi-Fi panel.`)
      }

      await act({ panel: 'wifi', action: 'connect', ssid: match.ssid, password: password ? String(password) : undefined })

      return ok(`Connected to ${match.ssid}`)
    }
  },
  {
    id: 'wifi.power',
    title: 'Wi-Fi on or off',
    description: 'Turn Wi-Fi on or off (Herald OS Linux).',
    tier: 'mutate',
    args: [{ name: 'enabled', type: 'boolean', description: 'true for on', required: true }],
    phrases: [
      { phrase: 'turn on wi-fi', args: { enabled: true } },
      { phrase: 'turn off wi-fi', args: { enabled: false } }
    ],
    run: async ({ enabled }) => {
      await act({ panel: 'wifi', action: 'enable', enabled: Boolean(enabled) })

      return ok(`Wi-Fi ${enabled ? 'on' : 'off'}`)
    }
  },
  {
    id: 'bluetooth.list',
    title: 'Bluetooth devices',
    description: 'List Bluetooth devices: connected, paired and nearby.',
    tier: 'read',
    args: [],
    phrases: ['what bluetooth devices are connected', 'list bluetooth devices'],
    run: async () => {
      const { bluetooth } = await status('bluetooth')

      if (!bluetooth.available) {
        return fail('This computer has no Bluetooth.')
      }

      const connected = bluetooth.devices.filter(device => device.connected)

      return ok(bluetooth.powered ? `${connected.length ? `Connected: ${connected.map(d => d.name).join(', ')}` : 'Nothing connected'}; ${bluetooth.devices.length} known` : 'Bluetooth is off', { items: bluetooth.devices, data: { powered: bluetooth.powered } })
    }
  },
  {
    id: 'bluetooth.power',
    title: 'Bluetooth on or off',
    description: 'Turn Bluetooth on or off (Herald OS Linux).',
    tier: 'mutate',
    args: [{ name: 'enabled', type: 'boolean', description: 'true for on', required: true }],
    phrases: [
      { phrase: 'turn on bluetooth', args: { enabled: true } },
      { phrase: 'turn off bluetooth', args: { enabled: false } }
    ],
    run: async ({ enabled }) => {
      await act({ panel: 'bluetooth', action: 'power', enabled: Boolean(enabled) })

      return ok(`Bluetooth ${enabled ? 'on' : 'off'}`)
    }
  },
  {
    id: 'bluetooth.connect',
    title: 'Connect a Bluetooth device',
    description: 'Connect (or with connected=false disconnect) a Bluetooth device by name; a nearby unpaired one is paired first.',
    tier: 'act',
    args: [
      { name: 'device', type: 'string', description: 'Device name', required: true },
      { name: 'connected', type: 'boolean', description: 'false to disconnect' }
    ],
    phrases: ['connect my {device}', 'connect the {device}', { phrase: 'disconnect my {device}', args: { connected: false } }],
    run: async ({ device, connected }) => {
      const { bluetooth } = await status('bluetooth')
      const match = pick(bluetooth.devices, String(device))

      if ('error' in match) {
        return fail(match.error)
      }

      const action = connected === false ? 'disconnect' : match.paired ? 'connect' : 'pair'
      await act({ panel: 'bluetooth', action, address: match.address })

      return ok(`${action === 'disconnect' ? 'Disconnected' : 'Connected'} ${match.name}`)
    }
  },
  {
    id: 'audio.output',
    title: 'Choose the sound output',
    description: 'Send sound to a device (speakers, headphones, HDMI) by name.',
    tier: 'act',
    args: [{ name: 'device', type: 'string', description: 'Part of the device name', required: true }],
    phrases: ['play sound through {device}', 'switch audio to {device}', 'use the {device} for sound'],
    run: async ({ device }) => {
      const { audio } = await status('audio')
      const match = pick(audio.outputs, String(device))

      if ('error' in match) {
        return fail(match.error)
      }

      await act({ panel: 'audio', action: 'default', kind: 'output', id: match.id })

      return ok(`Sound now plays through ${match.name}`)
    }
  },
  {
    id: 'audio.input',
    title: 'Choose the microphone',
    description: 'Pick the microphone the voice listens through, by name. On Herald OS Linux this sets the machine default; elsewhere it applies to Herald only.',
    tier: 'act',
    args: [{ name: 'device', type: 'string', description: 'Part of the device name, or automatic', required: true }],
    phrases: ['use the {device} microphone', 'switch the microphone to {device}', 'listen through the {device}', { phrase: 'use the automatic microphone', args: { device: 'automatic' } }],
    run: async ({ device }) => {
      const name = String(device)

      // Herald OS Linux owns the session, so there the choice is the machine's default microphone.
      if (ownsSystemAudio()) {
        const { audio } = await status('audio')
        const match = pick(audio.inputs, name)

        if ('error' in match) {
          return fail(match.error)
        }

        await act({ panel: 'audio', action: 'default', kind: 'input', id: match.id })

        return ok(`The microphone is ${match.name}`)
      }

      await refreshAudioDevices()

      if (isAutomaticDeviceName(name)) {
        await chooseInputDevice(null)

        return ok(`The microphone follows the system: ${deviceSummary('input')}`)
      }

      const match = findAudioDevice($inputDevices.get(), name)

      if ('error' in match) {
        return fail(match.error)
      }

      await chooseInputDevice({ id: match.device.id, label: match.device.label })

      return ok(`The microphone is ${match.device.label}`)
    }
  },
  {
    id: 'audio.devices',
    title: 'Which microphone is in use',
    description: 'Say which microphone the voice listens through, and why that one.',
    tier: 'read',
    args: [],
    phrases: ['which microphone am i using', 'what microphone is herald using', 'microphone status'],
    run: async () => {
      if (ownsSystemAudio()) {
        const { audio } = await status('audio')
        const input = audio.inputs.find(device => device.isDefault) ?? audio.inputs[0]

        return ok(input ? `This machine's microphone is ${input.name}` : 'No microphone was found', { data: { input } })
      }

      await refreshAudioDevices()

      return ok(deviceSummary('input'), { data: { devices: $inputDevices.get().devices } })
    }
  },
  {
    id: 'audio.volume',
    title: 'Set the volume',
    description: 'Set the output volume (0-100) and/or mute it.',
    tier: 'act',
    args: [
      { name: 'percent', type: 'number', description: '0 to 100' },
      { name: 'muted', type: 'boolean', description: 'true to mute, false to unmute' }
    ],
    phrases: ['set the volume to {percent}', 'volume {percent}', { phrase: 'mute the sound', args: { muted: true } }, { phrase: 'unmute the sound', args: { muted: false } }],
    run: async ({ percent, muted }) => {
      if (percent === undefined && muted === undefined) {
        return fail('Give a volume (0 to 100) or say mute or unmute.')
      }

      await act({ panel: 'audio', action: 'volume', kind: 'output', percent: percent === undefined ? undefined : Number(percent), muted: muted === undefined ? undefined : Boolean(muted) })

      return ok(percent !== undefined ? `Volume ${Number(percent)}%` : muted ? 'Muted' : 'Unmuted')
    }
  },
  {
    id: 'display.brightness',
    title: 'Set the brightness',
    description: "Set the built-in screen's brightness (1-100, Herald OS Linux).",
    tier: 'act',
    args: [{ name: 'percent', type: 'number', description: '1 to 100', required: true }],
    phrases: ['set the brightness to {percent}', 'brightness {percent}'],
    run: async ({ percent }) => {
      await act({ panel: 'display', action: 'brightness', percent: Number(percent) })

      return ok(`Brightness ${Number(percent)}%`)
    }
  },
  {
    id: 'display.scale',
    title: 'Set the display scale',
    description: 'Make everything on a display bigger or smaller (scale 1 to 3, e.g. 1.25; Herald OS Linux).',
    tier: 'mutate',
    args: [
      { name: 'scale', type: 'number', description: '1 to 3', required: true },
      { name: 'display', type: 'string', description: 'Which display (default: the first)' }
    ],
    phrases: ['set the display scale to {scale}', 'scale the screen to {scale}', { phrase: 'make everything bigger', args: { scale: 1.25 } }],
    run: async ({ scale, display }) => {
      const value = Number(scale)

      if (!(value >= 1 && value <= 3)) {
        return fail('The scale goes from 1 to 3.')
      }

      const { display: state } = await status('display')
      const target = display ? pick(state.displays, String(display)) : state.displays.find(d => d.enabled)

      if (!target || 'error' in target) {
        return fail(target && 'error' in target ? target.error : 'No display found.')
      }

      await act({ panel: 'display', action: 'scale', name: target.name, scale: value })

      return ok(`${target.label} scale ${value}`)
    }
  },
  {
    id: 'power.profile',
    title: 'Set the power mode',
    description: 'Choose performance, balanced or power-saver (Herald OS Linux, with power-profiles-daemon).',
    tier: 'act',
    args: [{ name: 'profile', type: 'string', description: 'performance, balanced or power-saver', required: true, enum: ['performance', 'balanced', 'power-saver'] }],
    phrases: [{ phrase: 'save power', args: { profile: 'power-saver' } }, { phrase: 'performance mode', args: { profile: 'performance' } }, { phrase: 'balanced power mode', args: { profile: 'balanced' } }],
    run: async ({ profile }) => {
      await act({ panel: 'power', action: 'profile', profile: String(profile) })

      return ok(`Power mode: ${String(profile)}`)
    }
  },
  {
    id: 'power.status',
    title: 'Battery status',
    description: 'How much battery is left, whether it is charging, and the power mode.',
    tier: 'read',
    args: [],
    phrases: ['how much battery is left', 'battery status', 'am i charging'],
    run: async () => {
      const { power } = await status('power')
      const { battery } = power

      if (!battery.present) {
        return ok('No battery; this computer runs on mains power', { data: { ...power } })
      }

      return ok(`Battery ${battery.percent}%${battery.charging ? ', charging' : ''}${power.timeRemaining ? `, ${power.timeRemaining}` : ''}`, { data: { ...power } })
    }
  }
]
