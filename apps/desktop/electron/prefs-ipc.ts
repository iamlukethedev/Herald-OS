import { type HeraldOSPrefs, IPC } from '../shared/ipc.ts'
import { adoptLegacyNotify } from './prefs.ts'

/** What these handlers need of a BrowserWindow, so they run without Electron in tests. */
export interface PrefsWindow {
  webContents: { send: (channel: string, payload: unknown) => void }
}

/** Every window but the one that made the change hears the new prefs. */
export function sendPrefsToOthers(windows: readonly PrefsWindow[], sender: unknown, next: HeraldOSPrefs): void {
  for (const win of windows) {
    if (win.webContents !== sender) {
      win.webContents.send(IPC.prefsChanged, next)
    }
  }
}

/** `prefs.adoptLegacyNotify`: save the switches prefs.json lacks, then tell the other windows. */
export function handleAdoptLegacyNotify(windows: readonly PrefsWindow[], sender: unknown, flags: unknown): HeraldOSPrefs {
  const next = adoptLegacyNotify(flags)
  sendPrefsToOthers(windows, sender, next)

  return next
}
