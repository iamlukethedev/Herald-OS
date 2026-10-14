import type { StatusPanelId } from '../../shared/ipc.ts'

/** What `herald-os restart` brings back when it stopped working, and the quick panel that offers it. */
export type RestartDevice = 'wifi' | 'bluetooth' | 'sound' | 'touchpad'

export interface RestartTarget {
  device: RestartDevice
  label: string
  hint: string
  panel?: StatusPanelId
}

export const RESTART_TARGETS: readonly RestartTarget[] = [
  { device: 'wifi', label: 'Wi-Fi', hint: 'Unblock it, turn it back on and look for networks', panel: 'wifi' },
  { device: 'bluetooth', label: 'Bluetooth', hint: 'Unblock it and turn the adapter back on', panel: 'bluetooth' },
  { device: 'sound', label: 'Sound', hint: 'Restart PipeWire and WirePlumber', panel: 'audio' },
  { device: 'touchpad', label: 'Touchpad', hint: 'Rebind its driver; asks for your password' }
]

export const restartArgv = (device: RestartDevice): string[] => ['restart', device]

export const restartForPanel = (panel: StatusPanelId): RestartTarget | undefined => RESTART_TARGETS.find(target => target.panel === panel)
