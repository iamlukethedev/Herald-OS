import { atom } from 'nanostores'
import type { BackendState, EnvInfo, HeraldOSPrefs, PrefsPatch, WindowState } from '../../shared/ipc.ts'
import { LEGACY_NOTIFY_KEYS, NOTIFY_DEFAULTS, readLegacyNotifyFlags } from '../../shared/notify-prefs.ts'
import { PALETTE_PROPERTIES, paletteVars, schemeOf } from '../../shared/theme.ts'
import { VOICE_DEFAULTS } from '../../shared/voice-prefs.ts'
import { logFailure } from '../lib/report.ts'

/** Cache of Electron's backend truth; Electron is authoritative. */
export const $backend = atom<BackendState>({ phase: 'idle', attempt: 0, logTail: [] })
export const $windowState = atom<WindowState>({ fullscreen: false, focused: true })
export const $env = atom<EnvInfo | null>(null)
export const $prefs = atom<HeraldOSPrefs>({
  fullscreenOnLaunch: true,
  reduceMotion: false,
  accent: 'blue',
  theme: 'ocean',
  spaces: [{ id: 'personal', name: 'Personal', color: '#4d92ff' }],
  activeSpace: 'personal',
  favorites: [],
  voice: VOICE_DEFAULTS,
  // Off until the real prefs arrive, so the Overview never flashes the catch-up offer.
  continuity: { enabled: false, exclude: [] },
  crashHelp: { enabled: true, muted: [] },
  notify: NOTIFY_DEFAULTS
})
/** Set once the saved prefs are in and old localStorage switches are migrated; alerts wait for it. */
export const $prefsLoaded = atom(false)

/** A font family as a CSS value (quoted unless it is a generic family). */
const cssFamily = (family: string) => (/^(serif|sans-serif|monospace|system-ui|ui-[a-z-]+)$/.test(family) ? family : JSON.stringify(family.trim()))

export function applyPrefsToDocument(prefs: HeraldOSPrefs): void {
  const root = document.documentElement
  root.dataset.accent = prefs.accent
  root.dataset.theme = prefs.theme
  root.dataset.reduceMotion = String(prefs.reduceMotion)

  // Presets live in styles.css; any other theme's palette is derived from its colours.
  for (const property of PALETTE_PROPERTIES) {
    root.style.removeProperty(property)
  }

  if (prefs.themeColors) {
    const panels = window.heraldOS?.shell?.mode === 'panels'

    for (const [property, value] of Object.entries(paletteVars(prefs.themeColors, { scheme: prefs.themeScheme, panels }))) {
      root.style.setProperty(property, value)
    }
  }

  root.dataset.scheme = prefs.themeColors ? schemeOf(prefs.themeColors, prefs.themeScheme) : 'dark'

  for (const [property, family] of [
    ['--user-font-ui', prefs.fonts?.ui],
    ['--user-font-mono', prefs.fonts?.mono]
  ] as const) {
    if (family?.trim()) {
      root.style.setProperty(property, cssFamily(family))
    } else {
      root.style.removeProperty(property)
    }
  }
}

export async function updatePrefs(patch: PrefsPatch): Promise<void> {
  const next = await window.heraldOS.prefs.set(patch)
  $prefs.set(next)
  applyPrefsToDocument(next)
}

/** Alerts switches the Settings page saved in this window's localStorage before they moved to prefs.json. */
export async function migrateLegacyNotifyFlags(storage: Pick<Storage, 'getItem' | 'removeItem'>): Promise<void> {
  const legacy = readLegacyNotifyFlags(storage)

  if (!legacy) {
    return
  }

  const next = await window.heraldOS.prefs.adoptLegacyNotify(legacy)
  $prefs.set(next)
  applyPrefsToDocument(next)

  // Only once they are saved, so a failed write tries again at the next start.
  for (const key of Object.values(LEGACY_NOTIFY_KEYS)) {
    storage.removeItem(key)
  }
}

export function bindBackendStores(): () => void {
  const offBackend = window.heraldOS.backend.onState(state => $backend.set(state))
  const offWindow = window.heraldOS.window.onState(state => $windowState.set(state))
  void window.heraldOS.backend.getState().then(state => $backend.set(state)).catch(logFailure('backend.getState'))
  void window.heraldOS.window.getState().then(state => $windowState.set(state)).catch(logFailure('window.getState'))
  void window.heraldOS.env().then(info => $env.set(info)).catch(logFailure('env'))
  void window.heraldOS.prefs
    .get()
    .then(async prefs => {
      $prefs.set(prefs)
      applyPrefsToDocument(prefs)

      if (typeof localStorage !== 'undefined') {
        await migrateLegacyNotifyFlags(localStorage).catch(logFailure('prefs.notify.migrate'))
      }
    })
    .catch(logFailure('prefs.get'))
    // Even without saved prefs, alerts follow the defaults rather than staying quiet for good.
    .finally(() => $prefsLoaded.set(true))
  // Preferences changed by another surface window or by the `herald-os` CLI (theme, wallpaper).
  const offPrefs = window.heraldOS.prefs.onChanged?.(prefs => {
    $prefs.set(prefs)
    applyPrefsToDocument(prefs)
  })

  return () => {
    offBackend()
    offWindow()
    offPrefs?.()
  }
}
