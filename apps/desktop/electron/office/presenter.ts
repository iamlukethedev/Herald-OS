import { BrowserWindow, screen } from 'electron'

/*
 * Herald Slides' audience window: while the presenter view stays in Herald's window, the slides go
 * full screen on another display, in a window the presenter view opens and draws into itself (an
 * empty page of Herald's own, so nothing loads in it and it needs no preload).
 */

/** The name Herald Slides opens its audience window under. */
export const AUDIENCE_WINDOW_NAME = 'herald-slides-audience'

/** Fixed, so that compositor rules can match it. */
const AUDIENCE_TITLE = 'Herald Slides Audience'

/**
 * The answer to a page's `window.open` when it asks for Herald Slides' audience window: allowed, full
 * screen on a display other than the opener's, or refused when there is none. Null for every other
 * window, which the caller answers as it always has.
 */
export function audienceWindow(opener: BrowserWindow, { url, frameName }: Pick<Electron.HandlerDetails, 'url' | 'frameName'>): Electron.WindowOpenHandlerResponse | null {
  if (url !== 'about:blank' || frameName !== AUDIENCE_WINDOW_NAME) {
    return null
  }

  const own = screen.getDisplayMatching(opener.getBounds())
  const other = screen.getAllDisplays().find(display => display.id !== own.id)

  if (!other) {
    return { action: 'deny' }
  }

  return {
    action: 'allow',
    outlivesOpener: false,
    overrideBrowserWindowOptions: {
      ...other.bounds,
      title: AUDIENCE_TITLE,
      frame: false,
      fullscreen: true,
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false }
    },
    createWindow: options => {
      const win = new BrowserWindow(options)
      win.removeMenu()
      win.on('page-title-updated', event => event.preventDefault())
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('will-navigate', event => event.preventDefault())

      const close = () => {
        if (!win.isDestroyed()) {
          win.close()
        }
      }

      opener.once('closed', close)
      win.once('closed', () => opener.removeListener('closed', close))

      return win.webContents
    }
  }
}
