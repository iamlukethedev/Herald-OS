import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  shortcut: null as null | (() => void),
  windows: [] as Array<{ webContents: Record<string, unknown> }>
}))

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = { send: vi.fn(), setWindowOpenHandler: vi.fn() }
    constructor() {
      electron.windows.push(this)
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    on() {}
    loadFile() {}
    setBounds() {}
    show() {}
    focus() {}
    hide() {}
    isVisible() {
      return false
    }
  },
  globalShortcut: {
    register: (_accelerator: string, callback: () => void) => {
      electron.shortcut = callback

      return true
    },
    unregister: vi.fn()
  },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => electron.handlers.set(channel, handler) },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) }
}))
vi.mock('../log.ts', () => ({ log: vi.fn() }))
vi.mock('../paths.ts', () => ({ devServerUrl: () => null, rendererIndex: () => 'index.html' }))

const { IPC } = await import('../../shared/ipc.ts')
const { EmojiPanel } = await import('./emoji-panel.ts')

const notice = { type: 'notify', args: ['Copied 🎉', 'Paste it where you want it.'] }
const relay = (sender: unknown, target: string, command: unknown) => electron.handlers.get(IPC.shellRelay)!({ sender }, target, command)

let send: ReturnType<typeof vi.fn>

/** Registers a panel over an unfocused Hermes window and opens it with its shortcut; returns the panel's webContents. */
function openPanel(): Record<string, unknown> {
  new EmojiPanel(() => ({ isFocused: () => false, webContents: { send } }) as never).register()
  electron.shortcut!()

  return electron.windows[electron.windows.length - 1].webContents
}

beforeEach(() => {
  electron.handlers.clear()
  electron.windows.length = 0
  send = vi.fn()
})

describe('the macOS emoji panel’s relay', () => {
  it('passes the panel’s own notice on to the Hermes window', async () => {
    const panel = openPanel()

    await relay(panel, 'main', notice)

    expect(send).toHaveBeenCalledWith(IPC.shellCommand, notice)
  })

  it('ignores every other window', async () => {
    openPanel()

    await relay({ id: 'another window' }, 'main', notice)

    expect(send).not.toHaveBeenCalled()
  })

  it('ignores anything before the panel has opened', async () => {
    new EmojiPanel(() => ({ isFocused: () => false, webContents: { send } }) as never).register()

    await relay(undefined, 'main', notice)

    expect(send).not.toHaveBeenCalled()
  })

  it('passes on only notices, and only to the Hermes window', async () => {
    const panel = openPanel()

    await relay(panel, 'main', { type: 'os', args: ['quit'] })
    await relay(panel, 'main', { type: 'show-page', args: ['settings'] })
    await relay(panel, 'menubar', notice)
    await relay(panel, 'main', null)

    expect(send).not.toHaveBeenCalled()
  })
})
