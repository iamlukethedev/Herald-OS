import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lockFile } from './file-lock.ts'

const python = (() => {
  try {
    execFileSync('python3', ['-c', 'import fcntl'], { stdio: 'ignore' })

    return 'python3'
  } catch {
    return null
  }
})()

/** Whether another process could take the lock right now, the way Hermes's `_file_lock` would (non-blocking). */
const freeForHermes = (lockPath: string) =>
  execFileSync('python3', ['-c', 'import fcntl, os, sys\nfd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT)\ntry:\n    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)\n    print("free")\nexcept BlockingIOError:\n    print("held")', lockPath], { encoding: 'utf8' }).trim() === 'free'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-lock-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!python)('lockFile', () => {
  const pythons = () => [python!]

  it("takes the same lock Hermes's memory tool takes, until released", async () => {
    const lockPath = path.join(dir, 'MEMORY.md.lock')
    const outcome = await lockFile(lockPath, 2000, pythons)

    expect(outcome.status).toBe('locked')
    expect(freeForHermes(lockPath)).toBe(false)
    expect(fs.statSync(lockPath).mode & 0o777).toBe(0o600)

    if (outcome.status === 'locked') {
      await outcome.lock.release()
      await outcome.lock.release()
    }

    expect(freeForHermes(lockPath)).toBe(true)
  })

  it('waits for Hermes to let go, then gives up cleanly after the timeout', async () => {
    const lockPath = path.join(dir, 'USER.md.lock')
    const hermes = spawn('python3', ['-c', 'import fcntl, os, sys, time\nfd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT)\nfcntl.flock(fd, fcntl.LOCK_EX)\nprint("held", flush=True)\ntime.sleep(float(sys.argv[2]))', lockPath, '0.6'])
    await new Promise(resolve => hermes.stdout.once('data', resolve))

    const started = Date.now()
    const timedOut = await lockFile(lockPath, 200, pythons)

    expect(timedOut).toEqual({ status: 'timeout' })
    expect(Date.now() - started).toBeLessThan(3000)

    const waited = await lockFile(lockPath, 5000, pythons)

    expect(waited.status).toBe('locked')
    expect(hermes.exitCode).toBe(0)

    if (waited.status === 'locked') {
      await waited.lock.release()
    }
  })

  it('lets the lock go when Herald goes away without releasing it', async () => {
    const lockPath = path.join(dir, 'MEMORY.md.lock')
    const script = `import { lockFile } from ${JSON.stringify(fileURLToPath(new URL('./file-lock.ts', import.meta.url)))}\nconst o = await lockFile(process.argv[1], 2000, () => ['python3'])\nconsole.log(o.status)\nprocess.exit(0)`
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script, lockPath], { encoding: 'utf8' })

    expect(out.trim()).toBe('locked')

    for (let i = 0; i < 50 && !freeForHermes(lockPath); i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    expect(freeForHermes(lockPath)).toBe(true)
  })
})

describe('lockFile without Python', () => {
  it('reports the lock as unavailable rather than taken', async () => {
    expect(await lockFile(path.join(dir, 'MEMORY.md.lock'), 200, () => [])).toEqual({ status: 'unavailable', reason: 'no Python 3 interpreter found' })
    expect((await lockFile(path.join(dir, 'MEMORY.md.lock'), 200, () => [path.join(dir, 'no-python')])).status).toBe('unavailable')
  })

  it.skipIf(!python)('reports a lock file it cannot open as unavailable', async () => {
    const outcome = await lockFile(path.join(dir, 'missing', 'MEMORY.md.lock'), 200, () => [python!])

    expect(outcome.status).toBe('unavailable')
  })
})
