import { app, BrowserWindow, screen, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HeraldOSPrefs } from '../shared/ipc.ts'
import { osEnv } from './env.ts'
import { audienceWindow } from './office/presenter.ts'
import { devServerUrl, isShellPage, rendererIndex } from './paths.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The Herald icon: the 1024 px source in a checkout, the renderer's 256 px copy in a package. */
export function appIconPath(): string | undefined {
  const root = app.getAppPath()

  return [path.join(root, 'build', 'icon.png'), path.join(root, 'dist', 'renderer', 'brand', 'herald-icon.png')].find(file => fs.existsSync(file))
}

export function createMainWindow(prefs: HeraldOSPrefs): BrowserWindow {
  const { workAreaSize } = screen.getPrimaryDisplay()
  // Herald OS Linux: the shell is the whole session (cage hands it the only output). Kiosk mode
  // removes every escape hatch a window manager would normally offer.
  const kiosk = osEnv('KIOSK') === '1'
  const darwin = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: workAreaSize.width,
    height: workAreaSize.height,
    minWidth: kiosk ? undefined : 1024,
    minHeight: kiosk ? undefined : 640,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    // Herald OS is its own environment: launch fullscreen on its own Space. `simpleFullscreen`
    // keeps the menu bar hidden without the macOS fullscreen animation on every toggle.
    // HERALD_OS_WINDOWED=1 is a developer escape hatch for automated runs and screenshots.
    fullscreen: kiosk || (prefs.fullscreenOnLaunch && !osEnv('WINDOWED')),
    kiosk,
    simpleFullscreen: false,
    fullscreenable: true,
    backgroundColor: '#07080a',
    // Window vibrancy exists only on macOS; Electron ignores it elsewhere but keep main honest.
    ...(darwin ? { vibrancy: 'under-window' as const, visualEffectState: 'active' as const } : { icon: appIconPath() }),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      // On only where a page asks for it: index.html turns it off for everything else.
      spellcheck: true
    }
  })

  // Links stay outside: the renderer must never navigate away from the shell.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    const audience = audienceWindow(win, { url, frameName })

    if (audience) {
      return audience
    }

    if (/^https?:/i.test(url)) {
      void shell.openExternal(url)
    }

    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isShellPage(url)) {
      event.preventDefault()
    }
  })

  const dev = devServerUrl()

  if (dev) {
    void win.loadURL(dev)
  } else {
    void win.loadFile(rendererIndex())
  }

  // HiDPI on compositors that expose the output at scale 1 (cage in Stage 1): zoom the page instead
  // of forcing Chromium's device scale factor, which would size Wayland buffers wrongly.
  const zoom = Number(osEnv('ZOOM'))

  if (Number.isFinite(zoom) && zoom > 0 && zoom !== 1) {
    const apply = () => win.webContents.setZoomFactor(zoom)
    win.webContents.on('did-finish-load', apply)
    win.webContents.on('did-navigate', apply)
  }

  win.once('ready-to-show', () => win.show())

  return win
}
