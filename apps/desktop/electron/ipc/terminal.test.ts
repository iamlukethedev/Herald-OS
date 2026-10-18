import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc.ts'

const electron = vi.hoisted(() => ({ handle: vi.fn(), readText: vi.fn(), writeText: vi.fn(), focused: true }))

vi.mock('electron', () => ({
  ipcMain: { handle: electron.handle, on: vi.fn() },
  clipboard: { readText: electron.readText, writeText: electron.writeText },
  BrowserWindow: { fromWebContents: () => ({ isFocused: () => electron.focused }) }
}))
vi.mock('../log.ts', () => ({ log: vi.fn() }))
// The real isShellPage, judging the renderer a checkout loads with no dev server named.
delete process.env.HERALD_OS_DEV_SERVER
delete process.env.HERMES_OS_DEV_SERVER

const { ensureSpawnHelperExecutable, registerTerminalIpc, spawnHelperPaths } = await import('./terminal.ts')
const { rendererIndex } = await import('../paths.ts')

describe('spawnHelperPaths', () => {
  it('looks outside app.asar, where a packaged app runs the helper from', () => {
    const resources = '/Applications/Herald OS.app/Contents/Resources'

    expect(spawnHelperPaths(`${resources}/app.asar/node_modules/node-pty/lib/index.js`, 'darwin', 'arm64')).toEqual([
      `${resources}/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper`,
      `${resources}/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`
    ])
  })

  it('keeps the path of a checkout, or one already outside the archive', () => {
    expect(spawnHelperPaths('/Users/sam/Herald-OS/node_modules/node-pty/lib/index.js', 'darwin', 'x64')[1]).toBe('/Users/sam/Herald-OS/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper')
    expect(spawnHelperPaths('/opt/herald-os/resources/app.asar.unpacked/node_modules/node-pty/lib/index.js', 'linux', 'arm64')[0]).toBe('/opt/herald-os/resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper')
  })
})

describe('ensureSpawnHelperExecutable', () => {
  let root = ''

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('gives the prebuilt helper back the execute bit npm strips', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pty-'))
    const pty = path.join(root, 'node_modules', 'node-pty')
    const helper = path.join(pty, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    fs.mkdirSync(path.dirname(helper), { recursive: true })
    fs.writeFileSync(helper, '')
    fs.chmodSync(helper, 0o644)

    ensureSpawnHelperExecutable(path.join(pty, 'lib', 'index.js'))

    expect(fs.statSync(helper).mode & 0o777).toBe(0o755)
  })
})

describe('the Terminal clipboard', () => {
  const page = pathToFileURL(rendererIndex()).href
  const shell = { senderFrame: { url: `${page}?surface=terminal` } }
  const handler = (channel: string) => electron.handle.mock.calls.find(([name]) => name === channel)?.[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>

  beforeEach(() => {
    electron.handle.mockReset()
    electron.readText.mockReset().mockResolvedValue('echo hello')
    electron.writeText.mockReset().mockResolvedValue(undefined)
    electron.focused = true
    registerTerminalIpc(() => null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads and writes the system clipboard for the shell', async () => {
    await expect(handler(IPC.terminalClipboardRead)(shell)).resolves.toEqual({ text: 'echo hello' })
    await handler(IPC.terminalClipboardWrite)(shell, 'selected output')

    expect(electron.writeText).toHaveBeenCalledExactlyOnceWith('selected output')
  })

  it('leaves the clipboard alone when there is nothing to copy', async () => {
    await handler(IPC.terminalClipboardWrite)(shell, '')

    expect(electron.writeText).not.toHaveBeenCalled()
  })

  it('passes on a clipboard that refuses, for the Terminal to report', async () => {
    electron.readText.mockRejectedValue(new Error('no clipboard'))

    await expect(handler(IPC.terminalClipboardRead)(shell)).rejects.toThrow('no clipboard')
  })

  it.each([
    ['another page', { senderFrame: { url: 'https://example.com/' } }],
    ['about:blank', { senderFrame: { url: 'about:blank' } }],
    ['another local file', { senderFrame: { url: 'file:///tmp/index.html' } }],
    ['the renderer path on another host', { senderFrame: { url: page.replace('file:///', 'file://evil.example/') } }],
    ['a frame that is gone', { senderFrame: null }]
  ])('refuses %s', async (_label, event) => {
    await expect(handler(IPC.terminalClipboardRead)(event)).rejects.toThrow()
    await expect(handler(IPC.terminalClipboardWrite)(event, 'secret')).rejects.toThrow()

    expect(electron.readText).not.toHaveBeenCalled()
    expect(electron.writeText).not.toHaveBeenCalled()
  })

  it('keeps a clipboard of more than a mebibyte on this side', async () => {
    electron.readText.mockResolvedValue('a'.repeat(1024 * 1024 + 1))

    await expect(handler(IPC.terminalClipboardRead)(shell)).resolves.toEqual({ tooLarge: true })
  })

  it('copies no more than a mebibyte', async () => {
    await expect(handler(IPC.terminalClipboardWrite)(shell, 'a'.repeat(1024 * 1024 + 1))).rejects.toThrow()

    expect(electron.writeText).not.toHaveBeenCalled()
  })

  it('reads only for the focused window', async () => {
    electron.focused = false

    await expect(handler(IPC.terminalClipboardRead)(shell)).rejects.toThrow()
    expect(electron.readText).not.toHaveBeenCalled()
  })

  it('reads at most five times a second', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const read = handler(IPC.terminalClipboardRead)

    for (let i = 0; i < 5; i++) {
      await expect(read(shell)).resolves.toEqual({ text: 'echo hello' })
    }

    await expect(read(shell)).rejects.toThrow('Too many')
    expect(electron.readText).toHaveBeenCalledTimes(5)

    vi.advanceTimersByTime(1000)
    await expect(read(shell)).resolves.toEqual({ text: 'echo hello' })
  })

  it('copies only text', async () => {
    await expect(handler(IPC.terminalClipboardWrite)(shell, { length: 3 })).rejects.toThrow()

    expect(electron.writeText).not.toHaveBeenCalled()
  })
})
