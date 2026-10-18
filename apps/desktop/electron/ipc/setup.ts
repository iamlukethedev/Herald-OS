import { ipcMain } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IPC, type SetupResult, type SetupState } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { loadPty } from './terminal.ts'

/*
 * First-boot setup on the Herald OS image: the image's first boot made the account (no password)
 * and installed Hermes; the person names it, sets a password, joins Wi-Fi and signs in to Hermes.
 * Nothing here needs root: `passwd` changes the person's own password (the current one is empty on
 * a new account), and the name Herald greets with lives in ~/.config/herald-os/name. On a system
 * switched from another bootc system the first boot leaves a login screen instead (firstboot.sh), so
 * the account has a password already and setup asks only for the name.
 */

const FIRSTBOOT_DONE = '/var/lib/herald-os/firstboot-done'
const LOGIN_SCREEN = '/var/lib/herald-os/login-screen'
const configDir = () => path.join(os.homedir(), '.config', 'herald-os')
const doneFile = () => path.join(configDir(), 'setup-done')
export const nameFile = (): string => path.join(configDir(), 'name')

export function setupState(): SetupState {
  const image = fs.existsSync(FIRSTBOOT_DONE) || process.env.HERALD_OS_FORCE_SETUP === '1'
  let name = ''

  try {
    name = fs.readFileSync(nameFile(), 'utf8').trim()
  } catch {
    // Not named yet.
  }

  return { needed: process.platform === 'linux' && image && !fs.existsSync(doneFile()), user: os.userInfo().username, name, signedIn: fs.existsSync(LOGIN_SCREEN) }
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
  ipcMain.handle(IPC.setupState, () => setupState())
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
  // `later`: set up for someone else; setup shows again for them at the next start.
  ipcMain.handle(IPC.setupFinish, (_event, options: { later?: boolean } = {}) => {
    if (!options.later) {
      fs.mkdirSync(configDir(), { recursive: true })
      fs.writeFileSync(doneFile(), `${new Date().toISOString()}\n`)
    }

    return { ok: true } satisfies SetupResult
  })
}
