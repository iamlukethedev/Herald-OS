import { ipcMain } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type DiskPasswordFailure, IPC, type KeyringFailure, type KeyringState, type SetupResult, type SetupState } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { run } from '../platform/exec.ts'
import { loadPty } from './terminal.ts'

/*
 * First-boot setup on the Herald OS image: the image's first boot made the account (no password)
 * and installed Hermes; the person names it, sets a password, joins Wi-Fi and signs in to Hermes.
 * The account needs no root: `passwd` changes the person's own password (the current one is empty on
 * a new account), and the name Herald greets with lives in ~/.config/herald-os/name. On a system
 * switched from another bootc system the first boot leaves a login screen instead (firstboot.sh), so
 * the account has a password already and setup asks only for the name.
 * The one step with root is a new owner's disk password, on an encrypted disk: `herald-os password
 * --disk --new-owner` asks sudo, which takes the account password they have just set.
 * The session signs in with no password typed, so nothing unlocks a keyring at login: on an
 * encrypted disk setup makes one with no password of its own, and otherwise offers a keyring password.
 */

const FIRSTBOOT_DONE = '/var/lib/herald-os/firstboot-done'
const LOGIN_SCREEN = '/var/lib/herald-os/login-screen'
// reset-helper leaves this for the account first boot makes next; `herald-os password --disk
// --new-owner` takes it away once the new owner has a disk password of their own.
const NEW_OWNER_RESET = '/var/lib/herald-os/new-owner'
const configDir = () => path.join(os.homedir(), '.config', 'herald-os')
const doneFile = () => path.join(configDir(), 'setup-done')
// Setup finished "for someone else": the same account, a new owner at the next start.
const newOwnerFile = () => path.join(configDir(), 'new-owner')
export const nameFile = (): string => path.join(configDir(), 'name')

export function setupState(): SetupState {
  const image = fs.existsSync(FIRSTBOOT_DONE) || process.env.HERALD_OS_FORCE_SETUP === '1'
  let name = ''

  try {
    name = fs.readFileSync(nameFile(), 'utf8').trim()
  } catch {
    // Not named yet.
  }

  return {
    needed: process.platform === 'linux' && image && !fs.existsSync(doneFile()),
    user: os.userInfo().username,
    name,
    signedIn: fs.existsSync(LOGIN_SCREEN),
    diskEncrypted: null,
    newOwner: fs.existsSync(newOwnerFile()) || fs.existsSync(NEW_OWNER_RESET),
    keyring: null
  }
}

const KEYRING_STATES: readonly KeyringState[] = ['none', 'open', 'password', 'other']

/** The default keyring, from `herald-os keyring --status`; null when that cannot be told, so setup leaves the keyring alone. */
export async function keyringState(): Promise<KeyringState | null> {
  const result = await run('herald-os', ['keyring', '--status'], 15_000)

  try {
    const keyring = result.code === 0 ? (JSON.parse(result.stdout) as { keyring?: unknown }).keyring : null

    return KEYRING_STATES.find(state => state === keyring) ?? null
  } catch {
    return null
  }
}

/** Exit codes of `herald-os keyring setup` (linux/bin/herald-os: KEYRING_EXISTS, KEYRING_NO_SERVICE). */
const KEYRING_EXITS: Record<number, KeyringFailure> = { 3: 'keyringExists', 4: 'noKeyringService' }
// Starting gnome-keyring through D-Bus activation and writing the keyring take well under a second.
const KEYRING_TIMEOUT_MS = 30_000

export function keyringPasswordProblem(password: string): KeyringFailure | null {
  return password.length < 8 || /[\r\n\0]/.test(password) ? 'tooShort' : null
}

/** `herald-os keyring setup`: with the password on stdin, never on the command line; with none, `--no-password`. */
export async function makeKeyring(password: string): Promise<SetupResult> {
  const result = password
    ? await run('herald-os', ['keyring', 'setup', '--password'], KEYRING_TIMEOUT_MS, `${password}\n`)
    : await run('herald-os', ['keyring', 'setup', '--no-password'], KEYRING_TIMEOUT_MS)

  if (result.code === 0) {
    return { ok: true }
  }

  const last = result.stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop() ?? ''
  log('setup', `herald-os keyring setup exited ${result.code}: ${last}`)

  return { ok: false, reason: KEYRING_EXITS[result.code] ?? 'failed' }
}

/**
 * Whether the root filesystem is encrypted, from `herald-os password --disk --status`; null when that
 * cannot be told (the command failed, or could not list the disks), so setup neither asks for a disk
 * password nor says the disk is unencrypted.
 */
export async function diskEncrypted(): Promise<boolean | null> {
  const result = await run('herald-os', ['password', '--disk', '--status'], 15_000)

  try {
    const encrypted = result.code === 0 ? (JSON.parse(result.stdout) as { encrypted?: unknown }).encrypted : null

    return typeof encrypted === 'boolean' ? encrypted : null
  } catch {
    return null
  }
}

export interface DiskSecrets {
  current: string
  password: string
  account: string
}

/**
 * What `herald-os password --disk` asks (LANG=C), most specific first: sudo's prompt is the one the
 * command gives it, and "New disk password again:" also ends in "disk password:". `sudo` counts the
 * times sudo has asked, so a refused account password is not typed again.
 */
export function diskReply(screen: string, secrets: DiskSecrets): { reply: string; sudo: boolean } | null {
  const tail = screen.slice(-160).toLowerCase()

  if (/\[sudo\] password for [^:\s]*:\s*$/.test(tail)) {
    return { reply: `${secrets.account}\r`, sudo: true }
  }

  if (/new disk password again:\s*$/.test(tail) || /new disk password:\s*$/.test(tail)) {
    return { reply: `${secrets.password}\r`, sudo: false }
  }

  if (/current disk password:\s*$/.test(tail)) {
    return { reply: `${secrets.current}\r`, sudo: false }
  }

  return null
}

/** Exit codes of `herald-os password --disk` (linux/bin/herald-os: DISK_WRONG and the rest). */
const DISK_EXITS: Record<number, DiskPasswordFailure> = { 3: 'wrongCurrent', 4: 'notEncrypted', 5: 'notAdmin', 6: 'partly', 8: 'notTakenBack', 9: 'recoveryKey' }
// Adding a key slot and checking each passphrase take seconds apiece (argon2id), more with two disks.
const DISK_TIMEOUT_MS = 300_000

/** Printable ASCII only: at start-up there is no input method, and the layout may not be the one it was typed with. */
export function diskPasswordProblem(password: string): DiskPasswordFailure | null {
  if (password.length < 8) {
    return 'tooShort'
  }

  return /^[\x20-\x7e]+$/.test(password) ? null : 'notAscii'
}

/**
 * `herald-os password --disk --new-owner`, answered through a terminal: sudo with the account's
 * password, then the disk password typed at start-up and the new one. The command adds the new one
 * before it removes any other, so stopping it here (the timeout) never leaves the disk without one.
 */
export function changeDiskPassword(secrets: DiskSecrets): Promise<SetupResult> {
  const pty = loadPty()

  if (!pty) {
    return Promise.resolve({ ok: false, reason: 'noTerminal' })
  }

  return new Promise(resolve => {
    const child = pty.spawn('herald-os', ['password', '--disk', '--new-owner'], { name: 'xterm', cols: 100, rows: 24, cwd: os.homedir(), env: { ...process.env, LANG: 'C', LC_ALL: 'C' } })
    let screen = ''
    let asked = 0
    let refused = false
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, reason: 'timeout' })
    }, DISK_TIMEOUT_MS)

    child.onData(data => {
      screen += data
      const answer = diskReply(screen, secrets)

      if (answer === null) {
        return
      }

      if (answer.sudo && ++asked > 1) {
        refused = true
        child.kill()

        return
      }

      screen = ''
      child.write(answer.reply)
    })
    child.onExit(({ exitCode }) => {
      clearTimeout(timer)

      if (exitCode === 0) {
        fs.rmSync(newOwnerFile(), { force: true })
        resolve({ ok: true })
      } else {
        const last = screen.split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop() ?? ''
        log('setup', `herald-os password --disk exited ${exitCode}: ${last}`)
        resolve({ ok: false, reason: refused ? 'notAdmin' : (DISK_EXITS[exitCode] ?? 'failed') })
      }
    })
  })
}

/** What `passwd` asks (LANG=C), most specific first: "Retype new password:" also ends in "new password:". */
export function passwdReply(screen: string, password: string, current: string): string | null {
  const tail = screen.slice(-160).toLowerCase()

  if (/retype new password:\s*$/.test(tail)) {
    return `${password}\r`
  }

  if (/new password:\s*$/.test(tail)) {
    return `${password}\r`
  }

  if (/(current|\(current\) unix|old) password:\s*$/.test(tail) || /password:\s*$/.test(tail)) {
    return `${current}\r`
  }

  return null
}

const DETAIL_MAX = 200

/** pwquality's reason as the renderer may show it: no control characters (a terminal's escapes), and short. */
export function refusalDetail(line: string): string {
  return line.replace(/\p{Cc}/gu, '').trim().slice(0, DETAIL_MAX).trim()
}

/**
 * `passwd` for this account, answered through a terminal; why it failed as a reason code, with
 * pwquality's reason when it refused (too short, too simple). passwd's own last line goes only to
 * the log: it is English and may be anything.
 */
export function changePassword(password: string, current = ''): Promise<SetupResult> {
  const pty = loadPty()

  if (!pty) {
    return Promise.resolve({ ok: false, reason: 'noTerminal' })
  }

  return new Promise(resolve => {
    const child = pty.spawn('passwd', [], { name: 'xterm', cols: 100, rows: 24, cwd: os.homedir(), env: { ...process.env, LANG: 'C', LC_ALL: 'C' } })
    let screen = ''
    // pwquality's reason once it refused; blank when the reason was nothing but control characters.
    let refusal: string | null = null
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, reason: 'timeout' })
    }, 30_000)

    child.onData(data => {
      if (refusal !== null) {
        return
      }

      screen += data
      const bad = /BAD PASSWORD: ([^\r\n]+)\r?\n/.exec(screen)

      if (bad) {
        // pwquality refused it and would ask again; stop and say why.
        refusal = refusalDetail(bad[1])
        child.kill()

        return
      }

      // The rest of the refusal is still to come; "BAD PASSWORD: " alone would pass for a prompt.
      if (/BAD PASSWORD:[^\n]*$/.test(screen)) {
        return
      }

      const reply = passwdReply(screen, password, current)

      if (reply !== null) {
        screen = ''
        child.write(reply)
      }
    })
    child.onExit(({ exitCode }) => {
      clearTimeout(timer)

      if (exitCode === 0) {
        resolve({ ok: true })
      } else {
        const last = screen.split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop() ?? ''
        log('setup', `passwd exited ${exitCode}: ${refusal || last}`)
        resolve(refusal === null ? { ok: false, reason: 'failed' } : { ok: false, reason: 'refused', ...(refusal && { detail: refusal }) })
      }
    })
  })
}

export function registerSetupIpc(): void {
  ipcMain.handle(IPC.setupState, async () => {
    const state = setupState()

    if (!state.needed) {
      return state
    }

    const [encrypted, keyring] = await Promise.all([diskEncrypted(), keyringState()])

    return { ...state, diskEncrypted: encrypted, keyring }
  })
  ipcMain.handle(IPC.setupName, (_event, name: string) => {
    const clean = String(name ?? '').replace(/[\r\n:]/g, ' ').trim().slice(0, 64)
    fs.mkdirSync(configDir(), { recursive: true })
    fs.writeFileSync(nameFile(), `${clean}\n`)

    return { ok: true } satisfies SetupResult
  })
  ipcMain.handle(IPC.setupPassword, (_event, password: string) => {
    const value = String(password ?? '')

    if (value.length < 8 || /[\r\n]/.test(value)) {
      return { ok: false, reason: 'tooShort' } satisfies SetupResult
    }

    return changePassword(value)
  })
  ipcMain.handle(IPC.setupDiskPassword, (_event, request: Partial<DiskSecrets> = {}) => {
    const secrets = { current: String(request.current ?? ''), password: String(request.password ?? ''), account: String(request.account ?? '') }
    const problem = diskPasswordProblem(secrets.password)

    if (problem) {
      return { ok: false, reason: problem } satisfies SetupResult
    }

    if (Object.values(secrets).some(value => /[\r\n]/.test(value)) || !secrets.current) {
      return { ok: false, reason: 'wrongCurrent' } satisfies SetupResult
    }

    return changeDiskPassword(secrets)
  })
  ipcMain.handle(IPC.setupKeyring, (_event, request: { password?: string } = {}) => {
    const password = String(request.password ?? '')
    const problem = password ? keyringPasswordProblem(password) : null

    return problem ? ({ ok: false, reason: problem } satisfies SetupResult) : makeKeyring(password)
  })
  // `later`: set up for someone else; setup shows again for them at the next start, as a new owner.
  ipcMain.handle(IPC.setupFinish, (_event, options: { later?: boolean } = {}) => {
    fs.mkdirSync(configDir(), { recursive: true })

    if (options.later) {
      fs.writeFileSync(newOwnerFile(), `${new Date().toISOString()}\n`)
    } else {
      fs.rmSync(newOwnerFile(), { force: true })
      fs.writeFileSync(doneFile(), `${new Date().toISOString()}\n`)
    }

    return { ok: true } satisfies SetupResult
  })
}
