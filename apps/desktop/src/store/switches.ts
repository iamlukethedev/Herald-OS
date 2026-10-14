import { atom } from 'nanostores'
import type { TextKey } from '../../shared/i18n.ts'
import type { SwitchName, SwitchState } from '../../shared/ipc.ts'
import { t } from './i18n.ts'

/** Night light, do not disturb, staying awake and the screensaver, as main reports them. */
export const $switches = atom<SwitchState>({ nightLight: null, doNotDisturb: false, stayAwake: false, screensaver: false })
/** Desktop mode: the screensaver is up over the shell. */
export const $screensaverUp = atom(false)

export const SWITCH_LABELS: Record<SwitchName, string> = { nightLight: 'Night light', doNotDisturb: 'Do not disturb', stayAwake: 'Stay awake', screensaver: 'Screensaver' }
const SWITCH_NAMES: Record<SwitchName, TextKey> = { nightLight: 'switch.nightLight', doNotDisturb: 'switch.doNotDisturb', stayAwake: 'switch.stayAwake', screensaver: 'switch.screensaver' }

/** A switch's name in the language shown; SWITCH_LABELS stays English for the commands Hermes reads. */
export const switchLabel = (name: SwitchName): string => t(SWITCH_NAMES[name])

export async function setSwitch(name: SwitchName, enabled: boolean): Promise<SwitchState> {
  const state = await window.heraldOS.switches.set(name, enabled)
  $switches.set(state)

  return state
}

let bound = false

/** Every window keeps its own copy: each menu bar shows the indicators. */
export function bindSwitches(): () => void {
  if (bound || !window.heraldOS?.switches) {
    return () => undefined
  }

  bound = true
  void window.heraldOS.switches
    .get()
    .then(state => $switches.set(state))
    .catch(() => undefined)
  const off = window.heraldOS.switches.onChanged(state => $switches.set(state))

  return () => {
    off()
    bound = false
  }
}
