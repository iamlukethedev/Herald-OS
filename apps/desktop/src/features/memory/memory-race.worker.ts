/*
 * One Herald process for memory-race.test.ts: adds `count` entries to MEMORY.md through the real
 * memory store, with the Electron file bridge backed by the real lock helper and atomic write.
 * Run with `node --experimental-strip-types memory-race.worker.ts <hermesHome> <prefix> <count> <lock|nolock>`;
 * `nolock` behaves as if no Python were installed, so only the check before the rename protects writes.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { writeTextAtomic } from '../../../electron/atomic-write.ts'
import { type FileLock, lockFile } from '../../../electron/file-lock.ts'
import type { FileLockResult, WriteTextOptions } from '../../../shared/ipc.ts'

const [hermesHome, prefix, count, mode] = process.argv.slice(2)
const held = new Map<string, FileLock>()
let lockIds = 0

Object.assign(globalThis, {
  window: {
    heraldOS: {
      fs: {
        readDir: async (dir: string) =>
          Promise.all(
            (await fs.readdir(dir)).map(async name => {
              const stat = await fs.stat(path.join(dir, name))

              return { name, path: path.join(dir, name), kind: 'file', size: stat.size, modifiedAt: stat.mtimeMs, hidden: name.startsWith('.'), extension: path.extname(name) }
            })
          ),
        readFile: async (file: string) => {
          const content = await fs.readFile(file, 'utf8')

          return { path: file, kind: 'text', size: content.length, content, truncated: false }
        },
        writeText: (file: string, content: string, options: WriteTextOptions = {}) => writeTextAtomic(file, content, options.expect === undefined ? {} : { expect: options.expect }),
        mkdir: (dir: string) => fs.mkdir(dir, { recursive: true }),
        lock: async (lockPath: string, timeoutMs: number): Promise<FileLockResult> => {
          if (mode === 'nolock') {
            return { status: 'unavailable', reason: 'nolock mode' }
          }

          await fs.mkdir(path.dirname(lockPath), { recursive: true })
          const outcome = await lockFile(lockPath, timeoutMs, () => [process.env.HERALD_OS_PYTHON ?? 'python3'])

          if (outcome.status !== 'locked') {
            return outcome
          }

          const id = String(++lockIds)
          held.set(id, outcome.lock)

          return { status: 'locked', id }
        },
        unlock: async (id: string) => {
          await held.get(id)?.release()
          held.delete(id)
        }
      }
    }
  }
})

const { addEntry } = await import('./memory-store.ts')
const errors: string[] = []

for (let i = 0; i < Number(count); i++) {
  try {
    await addEntry(hermesHome, 'MEMORY.md', `${prefix}-${i}`)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
}

process.stdout.write(`${JSON.stringify({ errors })}\n`)
