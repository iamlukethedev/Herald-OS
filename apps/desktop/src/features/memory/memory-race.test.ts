import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from './memory-store.ts'

/*
 * Separate processes writing MEMORY.md back to back: Herald processes running the real memory store
 * (memory-race.worker.ts) and Python writers taking Hermes's lock (memory-race.writer.py, through
 * Hermes's own MemoryStore when the upstream checkout is there). No entry may go missing.
 */

const WORKER = fileURLToPath(new URL('./memory-race.worker.ts', import.meta.url))
const WRITER = fileURLToPath(new URL('./memory-race.writer.py', import.meta.url))
const HERMES_CHECKOUT = fileURLToPath(new URL('../../../../../upstream/hermes-agent', import.meta.url))
const COUNT = 60

const hasPython = (() => {
  try {
    execFileSync('python3', ['-c', 'import fcntl'], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
})()
const hasHermes = hasPython && fs.existsSync(path.join(HERMES_CHECKOUT, 'tools', 'memory_tool_store.py'))

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-race-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

const run = (command: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(command, args, { env: { ...process.env, HERMES_HOME: home }, timeout: 60_000 }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)))
  })

const herald = async (prefix: string, mode: 'lock' | 'nolock' = 'lock') => {
  const { errors } = JSON.parse(await run(process.execPath, ['--experimental-strip-types', '--no-warnings', WORKER, home, prefix, String(COUNT), mode])) as { errors: string[] }

  expect(errors).toEqual([])
}

const expected = (...prefixes: string[]) => prefixes.flatMap(prefix => Array.from({ length: COUNT }, (_, i) => `${prefix}-${i}`)).sort()
const onDisk = () => parse(fs.readFileSync(path.join(home, 'memories', 'MEMORY.md'), 'utf8')).sort()

describe.skipIf(!hasPython)('MEMORY.md written from several processes at once', () => {
  it('loses nothing between two Herald processes', async () => {
    await Promise.all([herald('a'), herald('b')])

    expect(onDisk()).toEqual(expected('a', 'b'))
  }, 60_000)

  it('loses nothing between Herald and a Python writer holding the lock with flock', async () => {
    await Promise.all([herald('a'), run('python3', [WRITER, 'h', String(COUNT)])])

    expect(onDisk()).toEqual(expected('a', 'h'))
    expect(fs.readdirSync(path.join(home, 'memories')).sort()).toEqual(['MEMORY.md', 'MEMORY.md.lock'])
  }, 60_000)

  it.skipIf(!hasHermes)("loses nothing between Herald and Hermes's own MemoryStore", async () => {
    await Promise.all([herald('a'), run('python3', [WRITER, 'h', String(COUNT), HERMES_CHECKOUT])])

    expect(onDisk()).toEqual(expected('a', 'h'))
  }, 60_000)
})
