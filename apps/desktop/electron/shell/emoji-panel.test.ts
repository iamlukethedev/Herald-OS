import { describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  BrowserWindow: class {},
  globalShortcut: { register: () => true, unregister: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
  screen: {}
}))
vi.mock('../log.ts', () => ({ log: vi.fn() }))
vi.mock('../paths.ts', () => ({ devServerUrl: () => null, rendererIndex: () => 'index.html' }))

const { IPC } = await import('../../shared/ipc.ts')
const { EmojiPanel } = await import('./emoji-panel.ts')

describe('the macOS emoji panel', () => {
  it('passes a command for the Hermes window on, and nothing for another surface', async () => {
    const send = vi.fn()
    new EmojiPanel(() => ({ webContents: { send } }) as never).register()
    const relay = handlers.get(IPC.shellRelay)!
    const command = { type: 'notify', args: ['Copied 🎉', 'Paste it where you want it.'] }

    await relay({}, 'main', command)
    await relay({}, 'menubar', { type: 'dictation-state', args: ['idle'] })

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(IPC.shellCommand, command)
  })

  it('does nothing before the Hermes window exists', async () => {
    new EmojiPanel(() => null).register()

    await expect(Promise.resolve(handlers.get(IPC.shellRelay)!({}, 'main', { type: 'notify', args: ['x'] }))).resolves.toBeUndefined()
  })
})
