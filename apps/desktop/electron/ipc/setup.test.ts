import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({
  pty: null as unknown,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  run: { stdout: '', stderr: '', code: 0 }
}))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => host.handlers.set(channel, handler)) } }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))
vi.mock('./terminal.ts', () => ({ loadPty: () => host.pty }))
vi.mock('../platform/exec.ts', () => ({ run: vi.fn(async () => host.run) }))

const { IPC } = await import('../../shared/ipc.ts')
const { log } = await import('../log.ts')
const { run } = await import('../platform/exec.ts')
const { changeDiskPassword, changePassword, diskEncrypted, diskPasswordProblem, diskReply, passwdReply, refusalDetail, registerSetupIpc, setupState } = await import('./setup.ts')

/** A terminal running `passwd` that prints `lines` (each its own chunk) once the password is first typed, then exits with `exitCode`. */
function fakePasswd(lines: string[], exitCode: number | null) {
  let typed = false
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
      if (typed) {
        return
      }

      typed = true
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

  it('waits for the whole refusal when it comes in pieces', async () => {
    fakePasswd(['\r\nBAD PASSWORD: ', 'The password is shorter', ' than 8 characters', '\r', '\nNew password: '], 1)

    await expect(changePassword('short1')).resolves.toEqual({ ok: false, reason: 'refused', detail: 'The password is shorter than 8 characters' })
  })

  it("strips control characters from pwquality's reason and keeps it short", async () => {
    fakePasswd(['\r\nBAD PASSWORD: The password\u0007 is \u001b[1mtoo\u0000 simple\u007f\r\n'], null)
    await expect(changePassword('aaaaaaaa')).resolves.toEqual({ ok: false, reason: 'refused', detail: 'The password is [1mtoo simple' })

    fakePasswd([`\r\nBAD PASSWORD: ${'x'.repeat(500)}\r\n`], null)
    const long = await changePassword('aaaaaaaa')
    expect(long.detail).toBe('x'.repeat(200))
  })

  it('runs passwd in the C locale, so its prompts and BAD PASSWORD line are the English ones it answers and reads', async () => {
    vi.stubEnv('LANG', 'pt_BR.UTF-8')
    vi.stubEnv('LC_ALL', 'zh_CN.UTF-8')
    fakePasswd([], 0)
    await changePassword('correct horse')

    const spawn = (host.pty as { spawn: ReturnType<typeof vi.fn> }).spawn
    expect(spawn).toHaveBeenCalledWith('passwd', [], expect.objectContaining({ env: expect.objectContaining({ LANG: 'C', LC_ALL: 'C' }) }))
    vi.unstubAllEnvs()
  })

  it('says it was refused, without a reason, when the reason was only control characters', async () => {
    fakePasswd(['\r\nBAD PASSWORD: \u001b\u0007\r\n'], null)

    await expect(changePassword('aaaaaaaa')).resolves.toEqual({ ok: false, reason: 'refused' })
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

/**
 * A terminal running `herald-os password --disk --new-owner`: it shows each prompt in turn, the next
 * once something is typed, and exits with `exitCode` after the last.
 */
function fakeDisk(prompts: string[], exitCode: number | null) {
  let onData: (data: string) => void = () => undefined
  let onExit: (event: { exitCode: number }) => void = () => undefined
  const pending = [...prompts]
  const typed: string[] = []
  const next = () =>
    queueMicrotask(() => {
      const prompt = pending.shift()

      if (prompt !== undefined) {
        onData(prompt)
      } else if (exitCode !== null) {
        onExit({ exitCode })
      }
    })
  const child = {
    onData: (listener: typeof onData) => {
      onData = listener
      queueMicrotask(() => onData('The disk password unlocks /dev/vda3 when the computer starts.\r\n'))
      next()
    },
    onExit: (listener: typeof onExit) => {
      onExit = listener
    },
    write: vi.fn((text: string) => {
      typed.push(text)
      next()
    }),
    kill: vi.fn(() => queueMicrotask(() => onExit({ exitCode: 1 })))
  }
  host.pty = { spawn: vi.fn(() => child) }

  return { child, typed }
}

const SECRETS = { current: 'given at start-up', password: 'my own disk pass', account: 'account pass' }
const PROMPTS = ['[sudo] password for hermes: ', 'Current disk password: ', 'New disk password: ', 'New disk password again: ']

describe('the disk password', () => {
  it('answers sudo with the account password, then the current disk password and the new one twice', async () => {
    const { typed } = fakeDisk(PROMPTS, 0)
    vi.spyOn(fs, 'rmSync').mockImplementation(() => undefined)

    await expect(changeDiskPassword(SECRETS)).resolves.toEqual({ ok: true })
    expect(typed).toEqual(['account pass\r', 'given at start-up\r', 'my own disk pass\r', 'my own disk pass\r'])
    const spawn = (host.pty as { spawn: ReturnType<typeof vi.fn> }).spawn
    expect(spawn).toHaveBeenCalledWith('herald-os', ['password', '--disk', '--new-owner'], expect.objectContaining({ env: expect.objectContaining({ LANG: 'C', LC_ALL: 'C' }) }))
    expect(fs.rmSync).toHaveBeenCalledWith(expect.stringMatching(/\.config\/herald-os\/new-owner$/), { force: true })
  })

  it('needs no account password when sudo still remembers it', async () => {
    const { typed } = fakeDisk(PROMPTS.slice(1), 0)
    vi.spyOn(fs, 'rmSync').mockImplementation(() => undefined)

    await expect(changeDiskPassword(SECRETS)).resolves.toEqual({ ok: true })
    expect(typed).toHaveLength(3)
  })

  it('says why from the exit code', async () => {
    for (const [code, reason] of [
      [3, 'wrongCurrent'],
      [4, 'notEncrypted'],
      [5, 'notAdmin'],
      [6, 'partly'],
      [8, 'notTakenBack'],
      [7, 'failed'],
      [1, 'failed'],
      [2, 'failed']
    ] as const) {
      fakeDisk(PROMPTS, code)
      await expect(changeDiskPassword(SECRETS)).resolves.toEqual({ ok: false, reason })
    }
  })

  it('does not type a refused account password again', async () => {
    const { child, typed } = fakeDisk(['[sudo] password for hermes: ', 'Sorry, try again.\r\n[sudo] password for hermes: '], null)

    await expect(changeDiskPassword(SECRETS)).resolves.toEqual({ ok: false, reason: 'notAdmin' })
    expect(typed).toEqual(['account pass\r'])
    expect(child.kill).toHaveBeenCalled()
  })

  it('says it took too long', async () => {
    vi.useFakeTimers()
    const { child } = fakeDisk([], null)
    const result = changeDiskPassword(SECRETS)

    await vi.advanceTimersByTimeAsync(300_000)
    await expect(result).resolves.toEqual({ ok: false, reason: 'timeout' })
    expect(child.kill).toHaveBeenCalled()
  })

  it('says there is no terminal', async () => {
    await expect(changeDiskPassword(SECRETS)).resolves.toEqual({ ok: false, reason: 'noTerminal' })
  })

  it('tells the prompts apart, most specific first', () => {
    expect(diskReply('New disk password again: ', SECRETS)).toEqual({ reply: 'my own disk pass\r', sudo: false })
    expect(diskReply('Current disk password: ', SECRETS)).toEqual({ reply: 'given at start-up\r', sudo: false })
    expect(diskReply('[sudo] password for someone-else: ', SECRETS)).toEqual({ reply: 'account pass\r', sudo: true })
    expect(diskReply('Adding the new disk password and checking it…\r\n', SECRETS)).toBeNull()
  })

  it('takes only printable ASCII of 8 characters or more', () => {
    expect(diskPasswordProblem('my own disk pass')).toBeNull()
    expect(diskPasswordProblem('short')).toBe('tooShort')
    expect(diskPasswordProblem('coração do disco')).toBe('notAscii')
    expect(diskPasswordProblem('磁盘密码磁盘密码磁盘')).toBe('notAscii')
  })

  it('turns down a short, non-ASCII or multi-line password before running anything', async () => {
    fakeDisk(PROMPTS, 0)
    registerSetupIpc()
    const handler = host.handlers.get(IPC.setupDiskPassword)

    expect(await handler?.({}, { ...SECRETS, password: 'short' })).toEqual({ ok: false, reason: 'tooShort' })
    expect(await handler?.({}, { ...SECRETS, password: 'senha do coração' })).toEqual({ ok: false, reason: 'notAscii' })
    expect(await handler?.({}, { ...SECRETS, current: '' })).toEqual({ ok: false, reason: 'wrongCurrent' })
    expect(await handler?.({}, { ...SECRETS, account: 'two\nlines' })).toEqual({ ok: false, reason: 'wrongCurrent' })
    expect((host.pty as { spawn: ReturnType<typeof vi.fn> }).spawn).not.toHaveBeenCalled()
  })

  it('reads whether the disk is encrypted from the command, and anything it cannot tell as unknown', async () => {
    host.run = { stdout: '{"encrypted": true, "devices": ["/dev/vda3"], "newOwner": false, "error": null}\n', stderr: '', code: 0 }
    await expect(diskEncrypted()).resolves.toBe(true)
    expect(run).toHaveBeenCalledWith('herald-os', ['password', '--disk', '--status'], expect.any(Number))
    host.run = { stdout: '{"encrypted": false, "devices": [], "newOwner": false, "error": null}', stderr: '', code: 0 }
    await expect(diskEncrypted()).resolves.toBe(false)
    host.run = { stdout: '{"encrypted": null, "devices": [], "newOwner": true, "error": "lsblk could not list the disks"}', stderr: '', code: 0 }
    await expect(diskEncrypted()).resolves.toBeNull()
    host.run = { stdout: '', stderr: 'herald-os: not found', code: 127 }
    await expect(diskEncrypted()).resolves.toBeNull()
    host.run = { stdout: 'not json', stderr: '', code: 0 }
    await expect(diskEncrypted()).resolves.toBeNull()
    host.run = { stdout: '{"encrypted": "yes"}', stderr: '', code: 0 }
    await expect(diskEncrypted()).resolves.toBeNull()
  })
})

describe('a new owner', () => {
  it('is someone setup was finished for, or the account after a reset', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation(file => String(file).endsWith('/.config/herald-os/new-owner'))
    expect(setupState().newOwner).toBe(true)
    vi.spyOn(fs, 'existsSync').mockImplementation(file => file === '/var/lib/herald-os/new-owner')
    expect(setupState().newOwner).toBe(true)
    vi.spyOn(fs, 'existsSync').mockImplementation(() => false)
    expect(setupState().newOwner).toBe(false)
  })

  it('is marked when setup is finished for someone else, and the mark goes when it is finished for good', async () => {
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined)
    const written = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined)
    const removed = vi.spyOn(fs, 'rmSync').mockImplementation(() => undefined)
    registerSetupIpc()
    const finish = host.handlers.get(IPC.setupFinish)

    await finish?.({}, { later: true })
    expect(written.mock.calls.map(([file]) => String(file))).toEqual([expect.stringMatching(/herald-os\/new-owner$/)])
    written.mockClear()
    await finish?.({}, {})
    expect(removed).toHaveBeenCalledWith(expect.stringMatching(/herald-os\/new-owner$/), { force: true })
    expect(written.mock.calls.map(([file]) => String(file))).toEqual([expect.stringMatching(/herald-os\/setup-done$/)])
  })
})

describe('refusalDetail', () => {
  it('drops every control character and cuts the reason to 200 characters', () => {
    expect(refusalDetail('\u0000a\tb\u001fc\u0085d ')).toBe('abcd')
    expect(refusalDetail(`${'y'.repeat(199)}  ${'z'.repeat(10)}`)).toBe('y'.repeat(199))
    expect(refusalDetail('é'.repeat(300))).toHaveLength(200)
  })
})
