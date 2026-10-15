import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Prefix of the temporaries `writeTextAtomic` leaves for an instant before renaming them. */
export const ATOMIC_TMP_PREFIX = '.herald-tmp.'

/** Windows refuses a rename while another process has the target open (an editor, an indexer, Hermes reading it). */
const RENAME_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 6

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to)

      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code

      if (process.platform !== 'win32' || attempt >= RENAME_ATTEMPTS || !code || !RENAME_RETRYABLE.has(code)) {
        throw error
      }

      await sleep(20 * 2 ** (attempt - 1))
    }
  }
}

/** Make the rename itself durable. Best effort: some filesystems refuse to fsync a folder. */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }

  try {
    const handle = await fs.open(dir, 'r')

    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // The file is already in place; only its durability across a power cut is less certain.
  }
}

/**
 * Replace `file` with `content` so a reader sees either the old text or the new, never a
 * truncated file: write and fsync a temporary beside it, rename it over the target, then fsync the
 * folder. Follows a symlink to the real file (the link stays a link), keeps an existing file's
 * permission bits and creates a new one owner-only (0600). Hermes rewrites its memory files the
 * same way (`utils.atomic_write_text`).
 */
export async function writeTextAtomic(file: string, content: string): Promise<void> {
  const target = await fs.realpath(file).catch(() => file)
  const dir = path.dirname(target)
  await fs.mkdir(dir, { recursive: true })
  const mode = await fs.stat(target).then(
    stat => stat.mode & 0o7777,
    () => 0o600
  )
  const tmp = path.join(dir, `${ATOMIC_TMP_PREFIX}${path.basename(target)}.${randomBytes(6).toString('hex')}`)

  try {
    const handle = await fs.open(tmp, 'wx', mode)

    try {
      await handle.writeFile(content, 'utf8')
      // `open` filters the mode through the umask; set the bits exactly.
      await handle.chmod(mode)
      await handle.sync()
    } finally {
      await handle.close()
    }

    await renameRetrying(tmp, target)
  } catch (error) {
    await fs.rm(tmp, { force: true })
    throw error
  }

  await syncDir(dir)
}
