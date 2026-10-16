import fs from 'node:fs'
import { ipcMain, nativeImage } from 'electron'
import { type HeraldOSPrefs, IPC } from '../../shared/ipc.ts'
import { HERALD_SKIN, type ThemeSpec } from '../../shared/theme.ts'
import type { BackendManager } from '../backend/manager.ts'
import { events } from '../events/bus.ts'
import { assertReadable } from './fs.ts'
import { log } from '../log.ts'
import { run } from '../platform/exec.ts'
import { writePrefs } from '../prefs.ts'
import { findTheme, installTheme, listFonts, listThemes, prefsForTheme, saveTheme, writeHermesSkin } from '../theme/themes.ts'

export interface ThemeIpcDeps {
  panels: boolean
  /** Push new preferences to every window (and the wallpaper service). */
  broadcast: (prefs: HeraldOSPrefs) => void
  backend: BackendManager
}

/**
 * Point Hermes at the Herald skin, unless the person picked another skin themselves (Hermes's
 * `display.skin`); then their choice stands, and the skin file still follows the theme.
 */
export async function selectHermesSkin(backend: BackendManager): Promise<void> {
  if (backend.getState().phase !== 'ready') {
    return
  }

  const saved = await backend.rest<{ display?: { skin?: unknown } }>({ method: 'GET', path: '/api/config', query: { include_defaults: false } })
  const skin = typeof saved?.display?.skin === 'string' ? saved.display.skin : ''

  if (skin === '' || skin === 'default') {
    await backend.rest({ method: 'PUT', path: '/api/config', body: { config: { display: { skin: HERALD_SKIN } } } })
  }
}

/** Dress Hermes in a theme that was just applied (best effort: the theme stands either way). */
export function syncHermesSkin(spec: ThemeSpec, backend: BackendManager): void {
  writeHermesSkin(spec)
  selectHermesSkin(backend).catch(error => log('theme', `could not select the Herald skin: ${(error as Error).message}`))
}

/** Apply an installed theme everywhere it reaches. */
export async function applyTheme(name: string, deps: ThemeIpcDeps): Promise<HeraldOSPrefs> {
  const found = findTheme(name)

  if (!found) {
    throw new Error(`No theme called "${name}"`)
  }

  // Herald OS Linux: the engine recolours the session (niri, GTK, the lock screen, the terminal).
  if (deps.panels && process.platform === 'linux') {
    const result = await run('herald-os-theme', ['set', found.spec.name], 30_000)

    if (result.code !== 0 && result.code !== 127) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'the theme engine failed')
    }
  }

  const next = writePrefs(prefsForTheme(found.spec, found.dir))
  deps.broadcast(next)
  syncHermesSkin(found.spec, deps.backend)
  events.emit('theme-set', { theme: found.spec.name })

  return next
}

const SAMPLE_MAX_BYTES = 80 * 1024 * 1024

/** Shrink an image to a few thousand pixels: enough to find its colours, small enough to send. */
function sampleImage(target: string): string | null {
  const file = target.replace(/^file:\/\//, '')
  const stat = fs.statSync(file, { throwIfNoEntry: false })

  if (!stat?.isFile() || stat.size > SAMPLE_MAX_BYTES) {
    return null
  }

  const image = nativeImage.createFromPath(file)

  if (image.isEmpty()) {
    return null
  }

  const { width, height } = image.getSize()
  const small = width >= height ? image.resize({ width: Math.min(width, 96), quality: 'good' }) : image.resize({ height: Math.min(height, 96), quality: 'good' })

  return small.toDataURL()
}

export function registerThemeIpc(deps: ThemeIpcDeps): void {
  ipcMain.handle(IPC.themeList, () => listThemes())
  ipcMain.handle(IPC.themeSample, async (_event, target: string) => sampleImage((await assertReadable(String(target).replace(/^file:\/\//, ''))).real))
  ipcMain.handle(IPC.themeApply, (_event, name: string) => applyTheme(String(name), deps))
  ipcMain.handle(IPC.themeSave, async (_event, spec: ThemeSpec, imagePath?: string) => saveTheme(spec, imagePath ? (await assertReadable(String(imagePath))).real : undefined))
  ipcMain.handle(IPC.themeInstall, (_event, url: string) => installTheme(String(url)))
  ipcMain.handle(IPC.fontsList, () => listFonts())
}
