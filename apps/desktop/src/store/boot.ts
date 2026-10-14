import { registerOsCommands } from '../commands/index.ts'
import { bindAgentEvents } from './agents.ts'
import { bindRecording } from './capture.ts'
import { bindEditTarget } from './edit-target.ts'
import { bindBackendStores } from './backend.ts'
import { refreshBots } from './bots.ts'
import { bindChatEvents, resetChats } from './chat.ts'
import { bindContinuity } from './continuity.ts'
import { bindDictation } from './dictation.ts'
import { bindBranding } from './branding.ts'
import { bindPlugins } from './plugins.ts'
import { $connectionEpoch, bindGatewayToBackend } from './gateway.ts'
import { bindFollow } from './follow.ts'
import { bindHermesAuth } from './hermes-auth.ts'
import { bindLanguage } from './i18n.ts'
import { bindMissionEvents } from './missions.ts'
import { bindSidebarPrefs } from './sidebar.ts'
import { bindNotificationEvents, bindNotificationHistory } from './notifications.ts'
import { bindOsControl } from './os-control.ts'
import { bindServerRequests } from './requests.ts'
import { refreshSessions } from './sessions.ts'
import { bindShell } from './shell.ts'
import { bindShellCommands } from './shell-commands.ts'
import { bindStudioEvents } from './studio.ts'
import { isMainSurface } from './shell.ts'
import { bindSwitches } from './switches.ts'
import { bindThemes } from './themes.ts'
import { bindBridgeSetupNotice } from './tool-search.ts'
import { bindUsage } from './usage.ts'
import { bindVoice } from './voice.ts'
import { bindWake } from './wake.ts'
import { surface } from './shell.ts'
import { bindPetBrain } from '../features/pet/brain.ts'
import { bindPetInfo, bindPetSheet } from '../features/pet/info.ts'
import { bindPetSnapshots } from '../features/pet/transport.ts'

const BOOT_FLAG = '__heraldOSBooted'

/** Wire every store to its source exactly once, before React mounts (guard survives dev HMR re-evaluation). */
export function bootRenderer(): void {
  const global = window as unknown as Record<string, unknown>

  if (global[BOOT_FLAG]) {
    return
  }

  global[BOOT_FLAG] = true

  // The pet's own window (panels mode) only draws what the Hermes window sends it: no gateway of its own.
  if (surface === 'pet') {
    bindShell()
    bindBackendStores()
    bindLanguage()
    bindBranding()
    bindPetInfo()
    bindPetSheet()
    bindPetSnapshots()

    return
  }

  registerOsCommands()
  bindEditTarget()
  bindShell()
  bindBackendStores()
  bindLanguage()
  bindGatewayToBackend()
  bindChatEvents()
  bindServerRequests()
  bindNotificationEvents()
  bindAgentEvents()
  bindMissionEvents()
  bindSidebarPrefs()
  bindVoice()
  bindWake()
  bindHermesAuth()
  bindShellCommands()
  bindOsControl()
  bindFollow()
  bindStudioEvents()
  bindContinuity()
  bindThemes()
  bindUsage()
  bindSwitches()
  bindRecording()
  bindDictation()
  bindPlugins()
  bindBranding()
  bindPetInfo()

  // The Hermes window owns the notification list; the history follows it. It is the pet's brain too.
  if (isMainSurface) {
    bindNotificationHistory()
    bindBridgeSetupNotice()
    bindPetBrain()
  }

  if (surface === 'desktop') {
    bindPetSheet()
  }

  let lastEpoch = 0
  $connectionEpoch.subscribe(epoch => {
    if (epoch === 0) {
      return
    }

    // A fresh backend process (restart) invalidates every runtime session id we hold.
    if (lastEpoch !== 0) {
      resetChats()
    }

    lastEpoch = epoch
    void refreshSessions()
    void refreshBots()
  })

  if (import.meta.env.DEV) {
    // Dev-only hook so automated runs (CDP) can drive the stores; never present in production.
    void import('./debug.ts').then(m => m.installDebugHook())
  }
}
