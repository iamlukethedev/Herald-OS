import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ pty: null as unknown, handlers: new Map<string, (...args: unknown[]) => unknown>() }))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => host.handlers.set(channel, handler)) } }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))
vi.mock('./terminal.ts', () => ({ loadPty: () => host.pty }))

const { IPC } = await import('../../shared/ipc.ts')
const { log } = await import('../log.ts')
const { changePassword, passwdReply, registerSetupIpc, setupState } = await import('./setup.ts')

/** A terminal running `passwd` that prints `lines` once the password is typed, then exits with `exitCode`. */
function fakePasswd(lines: string[], exitCode: number | null) {
  let onData: (data: string) => void = () => undefined
  let onExit: (event: { exitCode: number }) => void = () => undefined
  const child = {
    onData: (listener: typeof onData) => {
      onData = listener
      queueMicrotask(() => onData('Changing password for user hermes.\r\nNew password: '))
    },
    onExit: (listener: typeof onExit) => {
      onExit = listener
    },
    write: vi.fn(() => {
      queueMicrotask(() => {
        for (const line of lines) {
          onData(line)
        }

        if (exitCode !== null) {
          onExit({ exitCode })
        }
      })
    }),
    kill: vi.fn(() => queueMicrotask(() => onExit({ exitCode: 1 })))
  }
  host.pty = { spawn: vi.fn(() => child) }

  return child
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  host.pty = null
})

describe('setupState', () => {
  it('knows the account signed in at a login screen on a switched system', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation(file => file === '/var/lib/herald-os/firstboot-done' || file === '/var/lib/herald-os/login-screen')
    expect(setupState().signedIn).toBe(true)
  })

  it('leaves the password to setup on an install from the image', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation(file => file === '/var/lib/herald-os/firstboot-done')
    expect(setupState().signedIn).toBe(false)
  })
})

describe('passwdReply', () => {
  it('answers the current password (empty on a new account) and the new one twice', () => {
    expect(passwdReply('Changing password for user hermes.\r\nCurrent password: ', 'hunter22!', '')).toBe('\r')
    expect(passwdReply('New password: ', 'hunter22!', '')).toBe('hunter22!\r')
    expect(passwdReply('Retype new password: ', 'hunter22!', '')).toBe('hunter22!\r')
  })

  it('knows the older prompts', () => {
    expect(passwdReply('(current) UNIX password: ', 'x', 'old')).toBe('old\r')
  })

  it('waits while passwd is still talking', () => {
    expect(passwdReply('Changing password for user hermes.\r\n', 'x', '')).toBeNull()
    expect(passwdReply('passwd: all authentication tokens updated successfully.\r\n', 'x', '')).toBeNull()
  })
})

describe('changePassword', () => {
  it('says the password was set', async () => {
    fakePasswd(['\r\npasswd: all authentication tokens updated successfully.\r\n'], 0)
    await expect(changePassword('correct horse')).resolves.toEqual({ ok: true })
  })

  it("gives pwquality's reason apart from the code when it refuses", async () => {
    const child = fakePasswd(['\r\nBAD PASSWORD: The password fails the dictionary check - it is based on a dictionary word\r\n'], null)

    await expect(changePassword('password1')).resolves.toEqual({ ok: false, reason: 'refused', detail: 'The password fails the dictionary check - it is based on a dictionary word' })
    expect(child.kill).toHaveBeenCalled()
  })

  it("never passes on passwd's own last line", async () => {
    fakePasswd(['\r\npasswd: Authentication token manipulation error\r\npasswd: password unchanged\r\n'], 10)

    await expect(changePassword('correct horse')).resolves.toEqual({ ok: false, reason: 'failed' })
    expect(log).toHaveBeenCalledWith('setup', expect.stringContaining('password unchanged'))
  })

  it('says it took too long when passwd does not finish', async () => {
    vi.useFakeTimers()
    const child = fakePasswd([], null)
    const result = changePassword('correct horse')

    await vi.advanceTimersByTimeAsync(30_000)
    await expect(result).resolves.toEqual({ ok: false, reason: 'timeout' })
    expect(child.kill).toHaveBeenCalled()
  })

  it('says there is no terminal to run passwd in', async () => {
    await expect(changePassword('correct horse')).resolves.toEqual({ ok: false, reason: 'noTerminal' })
  })
})

describe('the setup password handler', () => {
  it('turns down a short password before running passwd', async () => {
    fakePasswd([], 0)
    registerSetupIpc()
    const handler = host.handlers.get(IPC.setupPassword)

    expect(await handler?.({}, 'short')).toEqual({ ok: false, reason: 'tooShort' })
    expect(await handler?.({}, 'long enough\nreally')).toEqual({ ok: false, reason: 'tooShort' })
    expect((host.pty as { spawn: ReturnType<typeof vi.fn> }).spawn).not.toHaveBeenCalled()
  })
})
