import { BrowserWindow, globalShortcut, ipcMain, session, systemPreferences } from 'electron'
import { type AudioWsKind, IPC, type MicPermission, type SystemSpeech } from '../../shared/ipc.ts'
import type { BackendManager } from '../backend/manager.ts'
import { systemLanguages } from '../i18n.ts'
import { log } from '../log.ts'
import { isShellPage } from '../paths.ts'
import { hostPlatform } from '../platform/index.ts'

/**
 * Chromium permission names the shell grants for its own origin; everything else stays denied.
 * `local-fonts` lets Herald Canvas list the fonts on this computer by their real names, and
 * `fullscreen` lets Herald Slides present on the whole screen from a window that does not fill it.
 */
const SHELL_PERMISSIONS = new Set(['media', 'audioCapture', 'speaker-selection', 'local-fonts', 'fullscreen'])

/**
 * Voice plumbing owned by main: the microphone permission gate, tokenized audio WebSocket URLs
 * (so the renderer can dial `/api/audio/speak-stream` the same way it dials the gateway), the
 * computer's own voice for when Hermes cannot speak, and the global hotkey that toggles a
 * conversation from any app.
 */
export function registerVoiceIpc(backend: BackendManager): void {
  installShellPermissions()

  ipcMain.handle(IPC.voiceMicrophoneStatus, (): MicPermission => microphoneStatus())
  ipcMain.handle(IPC.voiceRequestMicrophone, async (): Promise<MicPermission> => {
    if (process.platform !== 'darwin') {
      return 'granted'
    }

    const granted = await systemPreferences.askForMediaAccess('microphone')

    return granted ? 'granted' : microphoneStatus()
  })
  ipcMain.handle(IPC.voiceAudioWsUrl, (_event, kind: AudioWsKind) => backend.audioWsUrl(kind))
  ipcMain.handle(IPC.voiceSystemSpeech, (_event, text: unknown): Promise<SystemSpeech> => hostPlatform().systemSpeech(typeof text === 'string' ? text : '', systemLanguages()[0] ?? ''))
}

function microphoneStatus(): MicPermission {
  if (process.platform !== 'darwin') {
    return 'granted'
  }

  const status = systemPreferences.getMediaAccessStatus('microphone')

  return status === 'granted' || status === 'denied' || status === 'restricted' || status === 'not-determined' ? status : 'unknown'
}

function installShellPermissions(): void {
  const allowed = (permission: string, requestingUrl: string, mediaTypes?: readonly string[]): boolean => {
    if (!SHELL_PERMISSIONS.has(permission)) {
      return false
    }

    // Pinned web apps share this session; only the shell itself may use the microphone, the
    // camera (the camera bubble for screen recordings) or the font list.
    return isShellPage(requestingUrl) && (!mediaTypes || mediaTypes.every(type => type === 'audio' || type === 'video'))
  }

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = webContents?.getURL() ?? details.requestingUrl ?? ''
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    callback(allowed(permission, url, mediaTypes))
  })
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const url = webContents?.getURL() ?? requestingOrigin ?? ''
    const mediaType = 'mediaType' in details ? details.mediaType : undefined

    return allowed(permission, url, mediaType ? [mediaType] : undefined)
  })
}

let registeredHotkey: string | null = null

/**
 * Register (or re-register) the voice hotkey. Unlike the fullscreen shortcut this one stays active
 * while the window is blurred: the whole point is reaching Hermes from inside another app.
 */
export function applyVoiceHotkey(accelerator: string, getWindows: () => BrowserWindow[]): void {
  if (registeredHotkey) {
    globalShortcut.unregister(registeredHotkey)
    registeredHotkey = null
  }

  const next = accelerator.trim()

  if (!next) {
    return
  }

  try {
    const ok = globalShortcut.register(next, () => {
      for (const win of getWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.voiceHotkey)
        }
      }
    })

    if (ok) {
      registeredHotkey = next
    } else {
      log('voice', `hotkey ${next} could not be registered (taken by another app?)`)
    }
  } catch (error) {
    log('voice', `hotkey ${next} rejected: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function currentVoiceHotkey(): string | null {
  return registeredHotkey
}
