import { BrowserWindow } from 'electron'
import type { WmState, WmWindow } from '../../shared/ipc.ts'
import { DOCK_MENU_TITLE } from './mode.ts'

/*
 * Panels mode: the Dock's menu for a running app (src/shell/surfaces/DockMenu.tsx). The Dock's own
 * window is 84 px tall, so the menu has a window of its own above it, which the Dock opens on an empty
 * page with `window.open`, naming it `herald-dock-menu-<n>` and giving where it goes and its size as
 * the features, and then draws into. Main lets only that open, transparent and frameless at that
 * size; PanelShell moves it into place through niri before the Dock draws anything in it.
 */

const NAME = /^herald-dock-menu-\d+$/
/** No menu's window is bigger than this. */
const MAX_SIDE = 2000

export interface DockMenuBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Where a menu's window goes and its size, in whole logical pixels, from its `window.open` features; null when they do not say. */
export function dockMenuBounds(features: string): DockMenuBounds | null {
  const values = new Map<string, string>()

  for (const part of features.split(',')) {
    const [key, value = ''] = part.split('=')
    values.set(key.trim(), value.trim())
  }

  const read = (key: string): number | null => {
    const value = Number(values.get(key) || Number.NaN)

    return Number.isFinite(value) ? Math.round(value) : null
  }
  const x = read('left')
  const y = read('top')
  const width = read('width')
  const height = read('height')

  if (x === null || y === null || width === null || height === null || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) {
    return null
  }

  return { x, y, width, height }
}

/**
 * The answer to the Dock's `window.open` for one of its menus, which `opened` gets once its window
 * exists; null for every other window, which the caller answers as it always has.
 */
export function dockMenuWindow(details: Pick<Electron.HandlerDetails, 'url' | 'frameName' | 'features'>, opened: (win: BrowserWindow, bounds: DockMenuBounds) => void): Electron.WindowOpenHandlerResponse | null {
  if (details.url !== 'about:blank' || !NAME.test(details.frameName)) {
    return null
  }

  const bounds = dockMenuBounds(details.features)

  if (!bounds) {
    return { action: 'deny' }
  }

  return {
    action: 'allow',
    outlivesOpener: false,
    overrideBrowserWindowOptions: {
      width: bounds.width,
      height: bounds.height,
      title: DOCK_MENU_TITLE,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false }
    },
    createWindow: options => {
      const win = new BrowserWindow(options)
      win.removeMenu()
      // niri's rule for the menu keys on its title.
      win.on('page-title-updated', event => event.preventDefault())
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('will-navigate', event => event.preventDefault())
      opened(win, bounds)

      return win.webContents
    }
  }
}

/** The niri window a new window of ours with this title became: the newest one that was not there before it opened. */
export function freshWindow(state: WmState, title: string, before: ReadonlySet<number>): WmWindow | null {
  let newest: WmWindow | null = null

  for (const win of state.windows) {
    if (win.ours && win.title === title && !before.has(win.id) && (!newest || win.id > newest.id)) {
      newest = win
    }
  }

  return newest
}
