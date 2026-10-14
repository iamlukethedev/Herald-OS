import fs from 'node:fs/promises'
import path from 'node:path'
import type { AttachmentFile } from '../shared/ipc.ts'

/*
 * Files Herald reads whole and hands to Hermes (`file.attach`) when Hermes does not read this
 * computer's files. Only files the person chose (in the file dialog, or given to the herald-os CLI)
 * and files Herald made for a prompt (a screenshot) can be read this way, so the renderer cannot
 * ship off any file it names.
 */

/** The most Herald uploads in one file: Hermes's own cap for the files it manages. */
export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024
/** Enough for a long session of attaching; the oldest are forgotten first. */
const REMEMBERED = 500

const allowed = new Set<string>()

/** Let these files be uploaded to Hermes, should it need them. */
export function allowAttachments(paths: readonly string[]): void {
  for (const raw of paths) {
    if (typeof raw !== 'string' || !path.isAbsolute(raw)) {
      continue
    }

    const file = path.normalize(raw)
    allowed.delete(file)
    allowed.add(file)
  }

  for (const file of allowed) {
    if (allowed.size <= REMEMBERED) {
      break
    }

    allowed.delete(file)
  }
}

const megabytes = (bytes: number) => `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`

/** One allowed file as a data URL, refused when it is larger than `maxBytes` (at most `ATTACHMENT_MAX_BYTES`). */
export async function readAttachment(target: string, maxBytes: number = ATTACHMENT_MAX_BYTES): Promise<AttachmentFile> {
  const file = path.normalize(String(target))

  if (!allowed.has(file)) {
    throw new Error('Herald OS only uploads files you chose to attach')
  }

  const stat = await fs.stat(file)

  if (!stat.isFile()) {
    throw new Error('it is not a file')
  }

  const limit = Math.min(ATTACHMENT_MAX_BYTES, Math.max(0, Number(maxBytes) || 0))
  const tooLarge = (size: number) => new Error(`it is ${megabytes(size)}, and Hermes takes files up to ${megabytes(limit)}`)

  if (stat.size > limit) {
    throw tooLarge(stat.size)
  }

  const data = await fs.readFile(file)

  // It may have grown since it was measured.
  if (data.length > limit) {
    throw tooLarge(data.length)
  }

  return { name: path.basename(file), size: data.length, dataUrl: `data:application/octet-stream;base64,${data.toString('base64')}` }
}
