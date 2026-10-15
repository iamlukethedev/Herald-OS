import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hermesHome } from './paths.ts'

/*
 * Hermes's memory tool holds an exclusive lock on `MEMORY.md.lock` / `USER.md.lock` across its read,
 * drift check and write (tools/memory_tool_store.py `_file_lock`): fcntl.flock on POSIX, msvcrt.locking
 * of the first byte on Windows. Node has neither call, so a few lines of Python take the lock with the
 * very same calls and hold it until Herald closes their stdin. Any Python 3 will do; Hermes's own
 * venv is tried first. If Herald dies, the pipe closes, the helper exits and the OS drops the lock, so
 * a crash can never leave Hermes waiting.
 */

const HELPER = String.raw`
import os, sys, time
path, timeout = sys.argv[1], float(sys.argv[2])
fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
if hasattr(os, "fchmod"):
    os.fchmod(fd, 0o600)
try:
    import fcntl
    def take():
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            return False
except ImportError:
    import msvcrt
    def take():
        os.lseek(fd, 0, 0)
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False
deadline = time.monotonic() + timeout
while not take():
    if time.monotonic() >= deadline:
        sys.exit(3)
    time.sleep(0.005)
sys.stdout.write("locked\n")
sys.stdout.flush()
sys.stdin.read()
`

const TIMEOUT_EXIT = 3

export interface FileLock {
  /** Let the lock go; resolves once the helper has exited and the lock is free. Safe to call twice. */
  release(): Promise<void>
}

export type LockOutcome = { status: 'locked'; lock: FileLock } | { status: 'timeout' } | { status: 'unavailable'; reason: string }

/** Python interpreters to try, Hermes's own first. Never macOS's /usr/bin/python3: without the developer tools it opens an install dialog. */
export function lockPythons(): string[] {
  const win = process.platform === 'win32'
  const venvPython = (root: string) => path.join(root, 'venv', win ? 'Scripts/python.exe' : 'bin/python')
  const roots = [process.env.HERALD_OS_HERMES_ROOT?.trim(), path.join(hermesHome(), 'hermes-agent')].filter((root): root is string => Boolean(root))
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean)
  const names = win ? ['python.exe', 'python3.exe'] : ['python3', 'python']
  const onPath = dirs.flatMap(dir => names.map(name => path.join(dir, name))).filter(file => !(process.platform === 'darwin' && file.startsWith('/usr/bin/')))
  const explicit = process.env.HERALD_OS_PYTHON?.trim()

  return [...new Set([...(explicit ? [explicit] : []), ...roots.map(venvPython), ...onPath])].filter(file => {
    try {
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  })
}

let knownGood: string | undefined

/**
 * Take the exclusive lock Hermes takes on `lockPath`, waiting up to `timeoutMs`. `unavailable` means
 * no helper could run (no Python, or the lock file can't be opened), not that someone holds the lock.
 */
export async function lockFile(lockPath: string, timeoutMs: number, pythons: () => string[] = lockPythons): Promise<LockOutcome> {
  const found = pythons()
  const candidates = knownGood && found.includes(knownGood) ? [knownGood, ...found.filter(file => file !== knownGood)] : found
  let reason = 'no Python 3 interpreter found'

  for (const python of candidates) {
    const outcome = await lockWith(python, lockPath, timeoutMs)

    if (outcome.status !== 'unavailable') {
      knownGood = python

      return outcome
    }

    reason = outcome.reason
  }

  return { status: 'unavailable', reason }
}

function lockWith(python: string, lockPath: string, timeoutMs: number): Promise<LockOutcome> {
  return new Promise(resolve => {
    let child: ChildProcess

    try {
      child = spawn(python, ['-I', '-S', '-c', HELPER, lockPath, String(timeoutMs / 1000)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ status: 'unavailable', reason: `${python}: ${error instanceof Error ? error.message : String(error)}` })

      return
    }

    let settled = false
    let stdout = ''
    let stderr = ''
    const exited = new Promise<void>(done => child.once('close', () => done()))
    const settle = (outcome: LockOutcome) => {
      if (!settled) {
        settled = true
        clearTimeout(guard)
        resolve(outcome)
      }
    }
    // Python's own deadline ends the wait; this only catches an interpreter that never starts.
    const guard = setTimeout(() => {
      child.kill()
      settle({ status: 'timeout' })
    }, timeoutMs + 10_000)

    child.on('error', error => settle({ status: 'unavailable', reason: `${python}: ${error.message}` }))
    child.stdin?.on('error', () => undefined)
    child.stderr?.on('data', chunk => {
      stderr += String(chunk)
    })
    child.stdout?.on('data', chunk => {
      stdout += String(chunk)

      if (stdout.includes('locked\n')) {
        let released: Promise<void> | undefined
        settle({
          status: 'locked',
          lock: {
            release: () => {
              released ??= (async () => {
                child.stdin?.end()
                const killer = setTimeout(() => child.kill(), 2000)
                await exited
                clearTimeout(killer)
              })()

              return released
            }
          }
        })
      }
    })
    child.once('exit', code => {
      if (code === TIMEOUT_EXIT) {
        settle({ status: 'timeout' })
      } else {
        settle({ status: 'unavailable', reason: `${python} exited with ${code}: ${stderr.trim().split('\n').pop() ?? ''}` })
      }
    })
  })
}
