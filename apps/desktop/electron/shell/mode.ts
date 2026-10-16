import type { ShellMode, ShellSurface } from '../../shared/ipc.ts'
import { osEnv } from '../env.ts'

/** `panels` only when the session asks for it (niri); everything else is the single-window desktop. */
export function shellMode(): ShellMode {
  return osEnv('SHELL_MODE') === 'panels' ? 'panels' : 'desktop'
}

/** Window titles double as the identity niri window rules match on; keep them stable. */
export const SURFACE_TITLE: Record<Exclude<ShellSurface, `window:${string}`>, string> = {
  desktop: 'Herald OS',
  main: 'Herald OS',
  menubar: 'Herald OS · Menu Bar',
  dock: 'Herald OS · Dock',
  command: 'Herald OS · Command',
  panel: 'Herald OS · Panel',
  screensaver: 'Herald OS · Screensaver',
  wallpaper: 'Herald OS · Wallpaper',
  emoji: 'Herald OS · Emoji',
  pet: 'Herald OS · Pet'
}

/** The Dock's menu for a running app: a window the Dock opens and draws into (electron/shell/dock-menu.ts). */
export const DOCK_MENU_TITLE = 'Herald OS · Dock Menu'

/** Floating Hermes apps that may open as their own window in panels mode. */
export const FLOATING_APPS: Record<string, { title: string; width: number; height: number }> = {
  terminal: { title: 'Herald OS · Terminal', width: 900, height: 560 },
  system: { title: 'Herald OS · System', width: 980, height: 640 },
  'chat-popout': { title: 'Herald OS · Chat', width: 520, height: 720 },
  studio: { title: 'Herald OS · Studio', width: 1280, height: 800 },
  'capture-editor': { title: 'Herald OS · Markup', width: 960, height: 680 },
  camera: { title: 'Herald OS · Camera', width: 240, height: 240 },
  widget: { title: 'Herald OS · Widget', width: 360, height: 280 },
  canvas: { title: 'Herald OS · Canvas', width: 1320, height: 840 },
  docs: { title: 'Herald OS · Docs', width: 1120, height: 840 },
  sheets: { title: 'Herald OS · Sheets', width: 1280, height: 820 },
  slides: { title: 'Herald OS · Slides', width: 1280, height: 820 },
  room: { title: 'Herald OS · Pet Room', width: 1100, height: 720 },
  calc: { title: 'Herald OS · Calc', width: 780, height: 560 }
}

export function surfaceTitle(surface: ShellSurface): string {
  if (surface.startsWith('window:')) {
    return FLOATING_APPS[surface.slice('window:'.length)]?.title ?? 'Herald OS'
  }

  return SURFACE_TITLE[surface as keyof typeof SURFACE_TITLE]
}

export function parseSurface(value: string | null | undefined): ShellSurface {
  if (!value) {
    return 'desktop'
  }

  if (value.startsWith('window:') || value in SURFACE_TITLE) {
    return value as ShellSurface
  }

  return 'desktop'
}
