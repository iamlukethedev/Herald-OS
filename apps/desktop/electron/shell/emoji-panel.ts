import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BrowserWindow, BrowserWindow as Window, globalShortcut, ipcMain, screen } from 'electron'
import { IPC, type ShellCommand, type ShellSurface } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { devServerUrl, rendererIndex } from '../paths.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const ACCELERATOR = 'Command+Control+E'
const WIDTH = 640
const HEIGHT = 470

/**
 * macOS: the emoji picker over whatever app you are typing in. It is a non-activating panel, so that
 * app keeps focus and the pick is pasted into it (as dictation types); inside Herald OS, the picker
 * in the Herald window opens instead.
 */
export class EmojiPanel {
  private win: BrowserWindow | null = null

  constructor(private readonly mainWindow: () => BrowserWindow | null) {}

  register(): void {
    // The emoji surface closes itself after a pick or on Escape; nothing else in desktop mode does.
    ipcMain.handle(IPC.shellClose, () => this.hide())
    // After a pick the panel is gone, so a pick left on the clipboard is reported in the Hermes window.
    ipcMain.handle(IPC.shellRelay, (_event, target: ShellSurface, command: ShellCommand) => {
      if (target === 'main') {
        this.mainWindow()?.webContents.send(IPC.shellCommand, command)
      }
    })

    if (!globalShortcut.register(ACCELERATOR, () => this.toggle())) {
      log('emoji', `${ACCELERATOR} is taken by another app; the picker still opens inside Herald OS`)
    }
  }

  stop(): void {
    globalShortcut.unregister(ACCELERATOR)
    this.win?.destroy()
    this.win = null
  }

  private toggle(): void {
    if (this.win?.isVisible()) {
      this.hide()

      return
    }

    const main = this.mainWindow()

    if (main?.isFocused()) {
      main.webContents.send(IPC.shellCommand, { type: 'emoji' } satisfies ShellCommand)

      return
    }

    this.show()
  }

  private show(): void {
    const win = this.win ?? this.create()
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    win.setBounds({ x: Math.round(area.x + (area.width - WIDTH) / 2), y: Math.round(area.y + area.height * 0.16), width: WIDTH, height: HEIGHT })
    // A fresh search every time it opens.
    win.webContents.send(IPC.shellCommand, { type: 'emoji' } satisfies ShellCommand)
    win.show()
    win.focus()
  }

  private hide(): void {
    this.win?.hide()
  }

  private create(): BrowserWindow {
    const win = new Window({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // An NSPanel that does not activate Herald OS: the app underneath stays the one typed into.
      type: 'panel',
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(here, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        additionalArguments: ['--hermes-surface=emoji', '--hermes-shell-mode=desktop']
      }
    })
    win.setAlwaysOnTop(true, 'pop-up-menu')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.on('blur', () => this.hide())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    const dev = devServerUrl()

    if (dev) {
      const url = new URL(dev)
      url.searchParams.set('surface', 'emoji')
      void win.loadURL(url.toString())
    } else {
      void win.loadFile(rendererIndex(), { query: { surface: 'emoji' } })
    }

    this.win = win

    return win
  }
}
