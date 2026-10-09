import { useStore } from '@nanostores/react'
import {
  IconBattery,
  IconBattery2,
  IconBattery4,
  IconBatteryCharging,
  IconBluetooth,
  IconBluetoothConnected,
  IconCheck,
  IconDeviceDesktop,
  IconDeviceSpeaker,
  IconHeadphones,
  IconLock,
  IconMicrophone,
  IconRefresh,
  IconSettings,
  IconSun,
  IconVolume,
  IconVolumeOff,
  IconWifi,
  IconWifi1,
  IconWifi2,
  IconX
} from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import type { AudioDevice, CalendarEvent, ControlAction, DisplayInfo, StatusPanelId, StatusPanelState } from '../../../shared/ipc.ts'
import { Chips, GlassButton, Toggle } from '../../components/ui/glass.tsx'
import { Meter } from '../../components/ui/primitives.tsx'
import { describeDeviceChoice } from '../../lib/audio-devices.ts'
import { cn } from '../../lib/cn.ts'
import { audioScope } from '../../lib/platform-labels.ts'
import { $inputDevices } from '../../lib/voice/audio-capture.ts'
import { $inputChoice, $micHeldElsewhere, $micLevelPercent, $microphoneTest, chooseInputDevice, startMicrophoneTest, stopMicrophoneTest, watchAudioDevices } from '../../store/audio-devices.ts'
import { $env, $prefs } from '../../store/backend.ts'
import { runCommand } from '../../store/os-commands.ts'
import { $panelStates, loadPanel, PANEL_TITLES, panelAction } from '../../store/status-panel.ts'

/*
 * The menu bar's quick panels: Wi-Fi, Bluetooth, sound, displays, battery and power, and the
 * calendar. On Herald OS Linux they change things; on macOS they only show what Control Center
 * would, plus the volume and — when Herald owns its own audio path — which microphone its voice uses.
 */

type LivePanel = Exclude<StatusPanelId, 'clock'>

const SETTINGS_FOR: Partial<Record<StatusPanelId, string>> = { wifi: 'network', bluetooth: 'network', audio: 'voice', display: 'appearance', power: 'general' }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)
}

/** Load a panel's state and change it; failures become a line in the panel, never a crash. */
function usePanel(panel: LivePanel) {
  const states = useStore($panelStates)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      await loadPanel(panel)
      setError(null)
    } catch (reason) {
      setError(errorText(reason))
    }
  }, [panel])

  useEffect(() => {
    void reload()
  }, [reload])

  const act = async (action: ControlAction) => {
    setBusy(true)

    try {
      await panelAction(action)
      setError(null)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  return { state: states[panel] as StatusPanelState | undefined, busy, error, reload, act }
}

export function StatusPanel({ panel, onClose }: { panel: StatusPanelId; onClose?: () => void }) {
  const section = SETTINGS_FOR[panel]

  return (
    <div className="float flex w-full flex-col overflow-hidden rounded-2xl animate-pop" role="dialog" aria-label={PANEL_TITLES[panel]}>
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        <span className="flex-1 text-[13.5px] font-semibold text-fg">{PANEL_TITLES[panel]}</span>
        {onClose && (
          <button type="button" aria-label="Close" onClick={onClose} className="flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-white/10 hover:text-fg">
            <IconX size={14} />
          </button>
        )}
      </div>
      <div className="flex max-h-[460px] min-h-0 flex-col gap-1 overflow-y-auto px-2 pb-2">
        {panel === 'wifi' && <WifiPanel />}
        {panel === 'bluetooth' && <BluetoothPanel />}
        {panel === 'audio' && <AudioPanel />}
        {panel === 'display' && <DisplayPanel />}
        {panel === 'power' && <PowerPanel />}
        {panel === 'clock' && <ClockPanel />}
      </div>
      {section && (
        <button
          type="button"
          onClick={() => {
            void runCommand('settings.open', { section }, { source: 'ui' })
            onClose?.()
          }}
          className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-left text-[12.5px] text-fg-2 hover:bg-white/6 hover:text-fg"
        >
          <IconSettings size={14} />
          {PANEL_TITLES[panel]} settings…
        </button>
      )}
    </div>
  )
}

// ---- Pieces ---------------------------------------------------------------------------------

function Row({ icon, label, detail, active, onClick, right, disabled }: { icon?: React.ReactNode; label: string; detail?: string; active?: boolean; onClick?: () => void; right?: React.ReactNode; disabled?: boolean }) {
  const body = (
    <>
      {icon && <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full [&_svg]:size-4', active ? 'bg-accent text-accent-fg' : 'bg-white/8 text-fg-2')}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-fg">{label}</span>
        {detail && <span className="block truncate text-[11.5px] text-fg-3">{detail}</span>}
      </span>
    </>
  )

  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/6">
      {onClick ? (
        <button type="button" disabled={disabled} onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:opacity-50">
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2.5">{body}</span>
      )}
      {right}
    </div>
  )
}

function Note({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'danger' }) {
  return <div className={cn('px-2 py-2 text-[12px] leading-snug', tone === 'danger' ? 'text-danger' : 'text-fg-3')}>{children}</div>
}

function Loading() {
  return <div className="shimmer mx-2 my-1 h-24 rounded-lg" aria-busy="true" />
}

/** A slider that only applies its value once the person lets go (so pactl is not called per pixel). */
function Slider({ value, onCommit, label, max = 100, disabled }: { value: number; onCommit: (value: number) => void; label: string; max?: number; disabled?: boolean }) {
  const [local, setLocal] = useState(value)

  useEffect(() => setLocal(value), [value])

  return (
    <input
      type="range"
      min={0}
      max={max}
      value={local}
      disabled={disabled}
      aria-label={label}
      onChange={event => setLocal(Number(event.target.value))}
      onPointerUp={() => onCommit(local)}
      onKeyUp={() => onCommit(local)}
      className="h-1.5 w-full cursor-pointer accent-(--color-accent) disabled:opacity-40"
    />
  )
}

const isMac = () => $env.get()?.platform === 'darwin'

// ---- Wi-Fi ----------------------------------------------------------------------------------

function signalIcon(signal: number) {
  return signal >= 67 ? <IconWifi /> : signal >= 34 ? <IconWifi2 /> : <IconWifi1 />
}

function WifiPanel() {
  const { state, busy, error, act } = usePanel('wifi')
  const [asking, setAsking] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const wifi = state?.panel === 'wifi' ? state.wifi : null

  if (!wifi) {
    return error ? <Note tone="danger">{error}</Note> : <Loading />
  }

  if (!wifi.available) {
    return <Note>This computer has no Wi-Fi, or NetworkManager is not running.</Note>
  }

  if (isMac()) {
    return <Note>{wifi.connected ? `Connected to ${wifi.connected}.` : 'Connected through Wi-Fi.'} Change networks in Control Center.</Note>
  }

  const join = (ssid: string, secure: boolean, known: boolean) => {
    if (secure && !known) {
      setAsking(ssid)
      setPassword('')

      return
    }

    void act({ panel: 'wifi', action: 'connect', ssid })
  }

  return (
    <>
      <Row label="Wi-Fi" right={<Toggle checked={wifi.enabled} onChange={enabled => void act({ panel: 'wifi', action: 'enable', enabled })} label="Wi-Fi" disabled={busy} />} />
      {wifi.enabled && (
        <div className="flex items-center justify-between px-2 pt-1.5 text-[11.5px] text-fg-4">
          <span>Networks</span>
          <button type="button" aria-label="Look for networks" disabled={busy} onClick={() => void act({ panel: 'wifi', action: 'scan' })} className="flex size-6 items-center justify-center rounded-md hover:bg-white/10 hover:text-fg disabled:opacity-40">
            <IconRefresh size={13} className={cn(busy && 'animate-spin')} />
          </button>
        </div>
      )}
      {wifi.networks.map(network => (
        <div key={network.ssid} data-os-target={`wifi:${network.ssid}`}>
          <Row
            icon={signalIcon(network.signal)}
            label={network.ssid}
            detail={network.active ? 'Connected' : network.known ? 'Saved' : undefined}
            active={network.active}
            disabled={busy}
            onClick={network.active ? undefined : () => join(network.ssid, network.secure, network.known)}
            right={
              <span className="flex items-center gap-1 text-fg-4">
                {network.secure && <IconLock size={13} aria-label="Secured" />}
                {network.active && (
                  <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void act({ panel: 'wifi', action: 'disconnect' })}>
                    Disconnect
                  </GlassButton>
                )}
                {network.known && !network.active && (
                  <button type="button" aria-label={`Forget ${network.ssid}`} disabled={busy} onClick={() => void act({ panel: 'wifi', action: 'forget', ssid: network.ssid })} className="flex size-6 items-center justify-center rounded-md hover:bg-white/10 hover:text-fg">
                    <IconX size={12} />
                  </button>
                )}
              </span>
            }
          />
          {asking === network.ssid && (
            <form
              className="flex items-center gap-2 px-2 pb-2"
              onSubmit={event => {
                event.preventDefault()
                setAsking(null)
                void act({ panel: 'wifi', action: 'connect', ssid: network.ssid, password })
              }}
            >
              <input type="password" autoFocus value={password} onChange={event => setPassword(event.target.value)} placeholder="Password" aria-label={`Password for ${network.ssid}`} className="glass-input h-8 min-w-0 flex-1 rounded-lg px-2.5 text-[12.5px] outline-none" />
              <GlassButton size="sm" variant="primary" type="submit" disabled={!password}>
                Join
              </GlassButton>
            </form>
          )}
        </div>
      ))}
      {wifi.enabled && wifi.networks.length === 0 && <Note>No networks in range.</Note>}
      {error && <Note tone="danger">{error}</Note>}
    </>
  )
}

// ---- Bluetooth ------------------------------------------------------------------------------

function deviceIcon(icon: string | undefined) {
  return /audio|headset|headphone/i.test(icon ?? '') ? <IconHeadphones /> : /speaker/i.test(icon ?? '') ? <IconDeviceSpeaker /> : <IconBluetooth />
}

function BluetoothPanel() {
  const { state, busy, error, act } = usePanel('bluetooth')
  const bluetooth = state?.panel === 'bluetooth' ? state.bluetooth : null
  const mac = isMac()

  if (!bluetooth) {
    return error ? <Note tone="danger">{error}</Note> : <Loading />
  }

  if (!bluetooth.available) {
    return <Note>This computer has no Bluetooth adapter.</Note>
  }

  return (
    <>
      <Row
        icon={bluetooth.powered ? <IconBluetoothConnected /> : <IconBluetooth />}
        label="Bluetooth"
        active={bluetooth.powered}
        right={mac ? undefined : <Toggle checked={bluetooth.powered} onChange={enabled => void act({ panel: 'bluetooth', action: 'power', enabled })} label="Bluetooth" disabled={busy} />}
      />
      {bluetooth.powered &&
        bluetooth.devices.map(device => (
          <div key={device.address} data-os-target={`bluetooth:${device.address}`}>
            <Row
              icon={deviceIcon(device.icon)}
              label={device.name}
              detail={[device.connected ? 'Connected' : device.paired ? 'Not connected' : 'Nearby', device.battery !== undefined ? `${device.battery}% battery` : null].filter(Boolean).join(' · ')}
              active={device.connected}
              right={
                mac ? undefined : (
                  <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void act({ panel: 'bluetooth', action: device.connected ? 'disconnect' : device.paired ? 'connect' : 'pair', address: device.address })}>
                    {device.connected ? 'Disconnect' : device.paired ? 'Connect' : 'Pair'}
                  </GlassButton>
                )
              }
            />
          </div>
        ))}
      {bluetooth.powered && !mac && (
        <div className="px-2 pt-1">
          <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void act({ panel: 'bluetooth', action: 'scan' })}>
            <IconRefresh className={cn(busy && 'animate-spin')} />
            {busy ? 'Looking for devices…' : 'Look for devices'}
          </GlassButton>
        </div>
      )}
      {mac && <Note>Pair and connect devices in Control Center.</Note>}
      {error && <Note tone="danger">{error}</Note>}
    </>
  )
}

// ---- Sound ----------------------------------------------------------------------------------

function AudioPanel() {
  const { state, busy, error, act } = usePanel('audio')
  const audio = state?.panel === 'audio' ? state.audio : null

  if (!audio) {
    return error ? <Note tone="danger">{error}</Note> : <Loading />
  }

  if (!audio.available) {
    return <Note>No sound devices (PipeWire is not running).</Note>
  }

  const output = audio.outputs.find(device => device.isDefault) ?? audio.outputs[0]
  const input = audio.inputs.find(device => device.isDefault) ?? audio.inputs[0]

  const devices = (kind: 'output' | 'input', list: AudioDevice[]) =>
    list.length > 1 &&
    list.map(device => (
      <Row key={device.id} icon={kind === 'output' ? <IconDeviceSpeaker /> : <IconMicrophone />} label={device.name} active={device.isDefault} disabled={busy || device.isDefault} onClick={() => void act({ panel: 'audio', action: 'default', kind, id: device.id })} />
    ))

  return (
    <>
      {output && (
        <div className="flex items-center gap-2.5 px-2 py-2">
          <button type="button" aria-label={output.muted ? 'Unmute' : 'Mute'} onClick={() => void act({ panel: 'audio', action: 'volume', kind: 'output', id: output.id === 'default' ? undefined : output.id, muted: !output.muted })} className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/8 text-fg-2 hover:text-fg">
            {output.muted ? <IconVolumeOff size={16} /> : <IconVolume size={16} />}
          </button>
          <Slider value={output.volume} max={100} label="Output volume" disabled={busy} onCommit={percent => void act({ panel: 'audio', action: 'volume', kind: 'output', id: output.id === 'default' ? undefined : output.id, percent })} />
          <span className="w-9 text-right text-[12px] tabular-nums text-fg-3">{output.volume}%</span>
        </div>
      )}
      {devices('output', audio.outputs)}
      {input && (
        <>
          <div className="px-2 pt-2 text-[11.5px] text-fg-4">Microphone</div>
          <div className="flex items-center gap-2.5 px-2 py-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/8 text-fg-2">
              <IconMicrophone size={16} />
            </span>
            <Slider value={input.volume} max={100} label="Microphone level" disabled={busy} onCommit={percent => void act({ panel: 'audio', action: 'volume', kind: 'input', id: input.id, percent })} />
            <span className="w-9 text-right text-[12px] tabular-nums text-fg-3">{input.volume}%</span>
          </div>
          {devices('input', audio.inputs)}
        </>
      )}
      {audioScope() === 'app' && <HeraldVoiceRows />}
      {error && <Note tone="danger">{error}</Note>}
    </>
  )
}

/**
 * The microphone Herald's own voice uses, shown only where Herald owns its audio path (macOS and the
 * other desktop hosts). On Herald OS Linux the rows above already set the machine's devices, and the
 * shell is the session there, so a second set of rows would be the same control twice.
 */
function HeraldVoiceRows() {
  const prefs = useStore($prefs)
  const devices = useStore($inputDevices)
  const choice = useStore($inputChoice)
  const level = useStore($micLevelPercent)
  const testing = useStore($microphoneTest)
  const held = useStore($micHeldElsewhere)

  useEffect(() => watchAudioDevices(), [])

  const automatic = devices.devices.find(device => device.isSystem)
  const chosen = prefs.voice.inputDevice

  return (
    <>
      <div className="px-2 pt-3 pb-1 text-[11.5px] text-fg-4">Herald voice</div>
      {!prefs.voice.enabled ? (
        <Note>Voice is off, so the microphone is never opened. Turn it on in Settings &gt; Voice.</Note>
      ) : !devices.labelsAvailable ? (
        <Note>Allow microphone access in Settings &gt; Voice to see the microphones by name.</Note>
      ) : (
        <>
          <Row
            icon={<IconMicrophone />}
            label="Microphone"
            detail={describeDeviceChoice(choice, 'input')}
            right={
              <>
                <Meter value={level} className="w-[90px] shrink-0" />
                <GlassButton
                  size="sm"
                  onClick={() => (testing ? stopMicrophoneTest() : void startMicrophoneTest())}
                  disabled={held}
                  title={held ? 'The microphone is already open' : 'Hear the microphone for a few seconds'}
                  aria-label={testing ? 'Stop the microphone test' : 'Test the microphone'}
                >
                  {testing ? 'Stop' : 'Test'}
                </GlassButton>
              </>
            }
          />
          <Row label="Automatic" detail={automatic ? `Follow the system: ${automatic.label}` : 'Follow the system'} active={!chosen} disabled={!chosen} onClick={() => void chooseInputDevice(null)} right={!chosen ? <IconCheck size={14} className="text-accent-strong" /> : undefined} />
          {devices.devices.map(device => {
            const selected = chosen?.id === device.id || (!chosen && device.isSystem)

            return (
              <Row
                key={device.id}
                label={device.label}
                active={selected}
                disabled={selected}
                onClick={() => void chooseInputDevice({ id: device.id, label: device.label })}
                right={selected ? <IconCheck size={14} className="text-accent-strong" /> : undefined}
              />
            )
          })}
          {chosen && choice.reason === 'missing' && <Note>{choice.absent?.label} is not connected. It is used again the moment it comes back.</Note>}
        </>
      )}
    </>
  )
}

// ---- Displays -------------------------------------------------------------------------------

const SCALES = [1, 1.25, 1.5, 1.75, 2]

function DisplayPanel() {
  const { state, busy, error, act } = usePanel('display')
  const display = state?.panel === 'display' ? state.display : null
  const mac = isMac()

  if (!display) {
    return error ? <Note tone="danger">{error}</Note> : <Loading />
  }

  return (
    <>
      {display.brightness !== undefined && (
        <div className="flex items-center gap-2.5 px-2 py-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/8 text-fg-2">
            <IconSun size={16} />
          </span>
          <Slider value={display.brightness} label="Brightness" disabled={busy || mac} onCommit={percent => void act({ panel: 'display', action: 'brightness', percent: Math.max(1, percent) })} />
          <span className="w-9 text-right text-[12px] tabular-nums text-fg-3">{display.brightness}%</span>
        </div>
      )}
      {display.displays.map(screen => (
        <DisplayRow key={screen.name} screen={screen} readOnly={mac} canTurnOff={display.displays.filter(d => d.enabled).length > 1} busy={busy} act={act} />
      ))}
      {!display.available && <Note>No display information from the compositor.</Note>}
      {mac && <Note>Arrange displays and change resolutions in System Settings.</Note>}
      {error && <Note tone="danger">{error}</Note>}
    </>
  )
}

function DisplayRow({ screen, readOnly, canTurnOff, busy, act }: { screen: DisplayInfo; readOnly: boolean; canTurnOff: boolean; busy: boolean; act: (action: ControlAction) => Promise<void> }) {
  const modes = screen.modes.filter((mode, index, all) => all.findIndex(other => other.width === mode.width && other.height === mode.height && Math.round(other.refresh) === Math.round(mode.refresh)) === index)
  const current = `${screen.width}x${screen.height}@${Math.round(screen.refresh)}`

  return (
    <div className="flex flex-col gap-1.5 rounded-lg px-2 py-2 hover:bg-white/4" data-os-target={`display:${screen.name}`}>
      <Row
        icon={<IconDeviceDesktop />}
        label={screen.label}
        detail={screen.enabled ? `${screen.width} × ${screen.height}${screen.refresh ? ` at ${Math.round(screen.refresh)} Hz` : ''}${screen.scale !== 1 ? `, scale ${screen.scale}` : ''}` : 'Off'}
        active={screen.enabled}
        right={!readOnly && (canTurnOff || !screen.enabled) ? <Toggle checked={screen.enabled} onChange={enabled => void act({ panel: 'display', action: 'enable', name: screen.name, enabled })} label={`${screen.label} on`} disabled={busy} /> : undefined}
      />
      {!readOnly && screen.enabled && (
        <div className="flex items-center gap-2 pl-11">
          {modes.length > 0 && (
            <select
              aria-label={`Resolution of ${screen.label}`}
              value={current}
              disabled={busy}
              onChange={event => {
                const mode = modes.find(m => `${m.width}x${m.height}@${Math.round(m.refresh)}` === event.target.value)

                if (mode) {
                  void act({ panel: 'display', action: 'mode', name: screen.name, mode })
                }
              }}
              className="glass-input h-7 min-w-0 flex-1 rounded-md px-1.5 text-[12px] outline-none"
            >
              {modes.map(mode => (
                <option key={`${mode.width}x${mode.height}@${mode.refresh}`} value={`${mode.width}x${mode.height}@${Math.round(mode.refresh)}`}>
                  {mode.width} × {mode.height} · {Math.round(mode.refresh)} Hz
                </option>
              ))}
            </select>
          )}
          <select aria-label={`Scale of ${screen.label}`} value={String(screen.scale)} disabled={busy} onChange={event => void act({ panel: 'display', action: 'scale', name: screen.name, scale: Number(event.target.value) })} className="glass-input h-7 w-20 rounded-md px-1.5 text-[12px] outline-none">
            {[...new Set([...SCALES, screen.scale])]
              .sort((a, b) => a - b)
              .map(scale => (
                <option key={scale} value={String(scale)}>
                  {Math.round(scale * 100)}%
                </option>
              ))}
          </select>
        </div>
      )}
    </div>
  )
}

// ---- Power ----------------------------------------------------------------------------------

const PROFILE_LABELS: Record<string, string> = { performance: 'Performance', balanced: 'Balanced', 'power-saver': 'Power saver' }

function PowerPanel() {
  const { state, busy, error, act } = usePanel('power')
  const power = state?.panel === 'power' ? state.power : null

  if (!power) {
    return error ? <Note tone="danger">{error}</Note> : <Loading />
  }

  const { battery } = power
  const icon = battery.charging ? <IconBatteryCharging /> : (battery.percent ?? 0) > 60 ? <IconBattery4 /> : (battery.percent ?? 0) > 25 ? <IconBattery2 /> : <IconBattery />

  return (
    <>
      {battery.present ? (
        <Row icon={icon} label={`${battery.percent ?? '?'}%${battery.charging ? ', charging' : ''}`} detail={power.timeRemaining} active={battery.charging} />
      ) : (
        <Note>Plugged in; this computer has no battery.</Note>
      )}
      {power.profiles.length > 0 && (
        <div className="flex flex-col gap-1.5 px-2 pt-2 pb-1">
          <span className="text-[11.5px] text-fg-4">Power mode</span>
          <Chips items={power.profiles.map(profile => ({ id: profile, label: PROFILE_LABELS[profile] ?? profile }))} value={power.profile ?? ''} onChange={profile => !busy && void act({ panel: 'power', action: 'profile', profile })} />
        </div>
      )}
      {error && <Note tone="danger">{error}</Note>}
    </>
  )
}

// ---- Calendar -------------------------------------------------------------------------------

function ClockPanel() {
  const [now, setNow] = useState(() => new Date())
  const [events, setEvents] = useState<CalendarEvent[] | null>(null)

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000)
    void window.heraldOS.calendar
      .today()
      .then(result => setEvents(result.events))
      .catch(() => setEvents([]))

    return () => clearInterval(timer)
  }, [])

  const first = new Date(now.getFullYear(), now.getMonth(), 1)
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  // Weeks start on Monday.
  const lead = (first.getDay() + 6) % 7
  const cells = [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, i) => i + 1)]

  return (
    <div className="flex flex-col gap-3 px-2 pb-1">
      <div>
        <div className="text-[26px] leading-tight font-semibold tabular-nums text-fg">{now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</div>
        <div className="text-[12.5px] text-fg-3">{now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center text-[11.5px]" aria-label={now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, i) => (
          <span key={`${day}${i}`} className="py-1 text-fg-4">
            {day}
          </span>
        ))}
        {cells.map((day, i) => (
          <span key={i} className={cn('rounded-md py-1 tabular-nums', day === now.getDate() ? 'bg-accent font-semibold text-accent-fg' : day ? 'text-fg-2' : '')}>
            {day ?? ''}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[11.5px] text-fg-4">Today</span>
        {events === null ? (
          <div className="shimmer h-10 rounded-lg" />
        ) : events.length === 0 ? (
          <span className="text-[12px] text-fg-3">Nothing on the calendar.</span>
        ) : (
          events.slice(0, 6).map(event => (
            <div key={event.id} className="flex items-baseline gap-2 text-[12px]">
              <span className="w-12 shrink-0 tabular-nums text-fg-3">{event.allDay ? 'All day' : new Date(event.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
              <span className="min-w-0 flex-1 truncate text-fg">{event.title}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
