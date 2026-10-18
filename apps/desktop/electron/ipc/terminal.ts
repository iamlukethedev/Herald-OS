import { BrowserWindow, clipboard, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { IPC, type TerminalClipboardRead, type TerminalCreateOptions, type TerminalHandle } from '../../shared/ipc.ts'
import { overClipboardLimit } from '../../shared/terminal-clipboard.ts'
import { terminalBin } from '../catalog/catalog.ts'
import { log } from '../log.ts'
import { isShellPage } from '../paths.ts'
import { loadCatalog } from './catalog.ts'
import { normalizeUserPath } from './fs.ts'

interface PtyLike {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
}

interface PtyModule {
  spawn(file: string, args: string[], options: Record<string, unknown>): PtyLike
}

let ptyModule: PtyModule | null | undefined

/**
 * The `spawn-helper`s node-pty may start a shell through: beside the pty.node it loads, one it
 * compiled or its prebuild for this machine. In a packaged app it runs them from app.asar.unpacked;
 * the same path inside app.asar can be read but never changed.
 */
export function spawnHelperPaths(ptyEntry: string, platform: string = process.platform, arch: string = process.arch): string[] {
  const root = path.dirname(path.dirname(ptyEntry)).replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked')

  return [path.join(root, 'build', 'Release', 'spawn-helper'), path.join(root, 'prebuilds', `${platform}-${arch}`, 'spawn-helper')]
}

/**
 * npm strips the executable bit from node-pty's prebuilt `spawn-helper` (the tarball ships it
 * 0644), and pty.spawn then fails with `posix_spawnp failed`. Restore it before the first load.
 */
export function ensureSpawnHelperExecutable(ptyEntry: string): void {
  if (process.platform === 'win32') {
    return
  }

  for (const helper of spawnHelperPaths(ptyEntry)) {
    try {
      const mode = fs.statSync(helper).mode

      if ((mode & 0o111) === 0) {
        fs.chmodSync(helper, mode | 0o755)
        log('terminal', `restored executable bit on ${helper}`)
      }
    } catch (error) {
      // node-pty compiles a helper only when it has no prebuild, so one of the two is usually missing.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log('terminal', `could not make ${helper} executable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

export function loadPty(): PtyModule | null {
  if (ptyModule !== undefined) {
    return ptyModule
  }

  try {
    const require = createRequire(import.meta.url)
    ensureSpawnHelperExecutable(require.resolve('node-pty'))
    ptyModule = require('node-pty') as PtyModule
  } catch (error) {
    log('terminal', `node-pty unavailable: ${error instanceof Error ? error.message : String(error)}`)
    ptyModule = null
  }

  return ptyModule
}

const CLIPBOARD_READS_PER_SECOND = 5

/** Real PTYs for the Terminal surface. One id per tab; output is pushed to the owning window. */
export function registerTerminalIpc(getWindow: () => BrowserWindow | null): void {
  const sessions = new Map<string, PtyLike>()
  const owned = new Map<WebContents, Set<string>>()
  let nextId = 1

  const kill = (id: string) => {
    const child = sessions.get(id)
    sessions.delete(id)

    try {
      child?.kill()
    } catch {
      // Already exited.
    }
  }

  const release = (owner: WebContents) => {
    for (const id of owned.get(owner) ?? []) {
      kill(id)
    }

    owned.get(owner)?.clear()
  }

  // A closed or reloaded page can't show its tabs again, so their shells end with it. This waits
  // for the commit: navigations the shell blocks never reach it.
  const adopt = (owner: WebContents, id: string) => {
    if (!owned.has(owner)) {
      owned.set(owner, new Set())
      owner.on('did-navigate', () => release(owner))
      owner.once('destroyed', () => {
        release(owner)
        owned.delete(owner)
      })
    }

    owned.get(owner)?.add(id)
  }

  ipcMain.handle(IPC.terminalCreate, (event, options: TerminalCreateOptions): TerminalHandle => {
    const pty = loadPty()
    // Output goes back to the window that created the PTY (in panels mode each terminal is its own
    // window); the main window is only a fallback.
    const owner = event.sender
    const target = () => (owner.isDestroyed() ? getWindow()?.webContents : owner)

    if (!pty) {
      throw new Error('Terminal is unavailable: node-pty failed to load for this Electron build.')
    }

    const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    const cwd = options.cwd ? normalizeUserPath(options.cwd) : os.homedir()
    const id = `t${nextId++}`
    // A coding agent from the catalog runs first; the tab stays a shell after it exits.
    const program = options.program ? terminalBin(loadCatalog(), options.program) : null

    if (options.program && !program) {
      throw new Error(`${options.program} is not a terminal program from the install catalog`)
    }

    const home = os.homedir()
    const resolved = program ? ([path.join(home, '.local', 'bin', program), path.join(home, '.local', 'share', 'mise', 'shims', program)].find(candidate => fs.existsSync(candidate)) ?? program) : null
    const args = process.platform === 'win32' ? [] : resolved ? ['-l', '-c', `${JSON.stringify(resolved)}; exec ${JSON.stringify(shell)} -l`] : ['-l']
    const child = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: Math.max(2, options.cols),
      rows: Math.max(1, options.rows),
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'HeraldOS', LANG: process.env.LANG || 'en_US.UTF-8' }
    })
    sessions.set(id, child)
    adopt(owner, id)

    child.onData(data => {
      target()?.send(IPC.terminalData, id, data)
    })
    child.onExit(({ exitCode }) => {
      sessions.delete(id)
      owned.get(owner)?.delete(id)
      target()?.send(IPC.terminalExit, id, exitCode)
    })

    return { id, pid: child.pid, shell }
  })

  ipcMain.on(IPC.terminalWrite, (_event, id: string, data: string) => {
    sessions.get(id)?.write(data)
  })
  ipcMain.on(IPC.terminalResize, (_event, id: string, cols: number, rows: number) => {
    try {
      sessions.get(id)?.resize(Math.max(2, cols), Math.max(1, rows))
    } catch {
      // Resizing a dying pty throws; ignore.
    }
  })
  ipcMain.handle(IPC.terminalDispose, (_event, id: string) => {
    kill(id)
  })

  // The shell's session grants no clipboard permission to pages, so Copy and Paste in the Terminal
  // go through main; only the shell's own pages may ask.
  const fromShell = (event: IpcMainInvokeEvent) => {
    if (!event.senderFrame || !isShellPage(event.senderFrame.url)) {
      throw new Error('Only Herald OS itself may use the clipboard')
    }
  }

  // A person pastes into the window in front, and no faster than they can press keys.
  const reads: number[] = []
  ipcMain.handle(IPC.terminalClipboardRead, async (event): Promise<TerminalClipboardRead> => {
    fromShell(event)

    if (!BrowserWindow.fromWebContents(event.sender)?.isFocused()) {
      throw new Error('Only the focused window may read the clipboard')
    }

    const now = Date.now()
    reads.splice(0, reads.length, ...reads.filter(at => now - at < 1000))

    if (reads.length >= CLIPBOARD_READS_PER_SECOND) {
      throw new Error('Too many clipboard reads')
    }

    reads.push(now)
    const text = await clipboard.readText()

    return overClipboardLimit(text) ? { tooLarge: true } : { text }
  })
  ipcMain.handle(IPC.terminalClipboardWrite, async (event, text: unknown): Promise<void> => {
    fromShell(event)

    if (typeof text !== 'string') {
      throw new Error('Only text can be copied from the Terminal')
    }

    if (overClipboardLimit(text)) {
      throw new Error('That is more text than the Terminal copies at once')
    }

    if (text) {
      await clipboard.writeText(text)
    }
  })
}
