import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Prefix of the temporaries `writeTextAtomic` leaves for an instant before renaming them. */
export const ATOMIC_TMP_PREFIX = '.herald-tmp.'

/**
 * Replace `file` with `content` so a reader sees either the old text or the new, never a
 * truncated file: write and fsync a temporary beside it, then rename it over the target. Follows a
 * symlink to the real file (the link stays a link) and keeps an existing file's permission bits.
 * Hermes rewrites its memory files the same way (`utils.atomic_write_text`).
 */
export async function writeTextAtomic(file: string, content: string): Promise<void> {
  const target = await fs.realpath(file).catch(() => file)
  const dir = path.dirname(target)
  await fs.mkdir(dir, { recursive: true })
  const mode = await fs.stat(target).then(
    stat => stat.mode & 0o7777,
    () => undefined
  )
  const tmp = path.join(dir, `${ATOMIC_TMP_PREFIX}${path.basename(target)}.${randomBytes(6).toString('hex')}`)

  try {
    const handle = await fs.open(tmp, 'wx', mode ?? 0o644)

    try {
      await handle.writeFile(content, 'utf8')

      if (mode !== undefined) {
        // `open` filters the mode through the umask; set the original bits exactly.
        await handle.chmod(mode)
      }

      await handle.sync()
    } finally {
      await handle.close()
    }

    await fs.rename(tmp, target)
  } catch (error) {
    await fs.rm(tmp, { force: true })
    throw error
  }
}
