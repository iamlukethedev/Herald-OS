import { atom } from 'nanostores'
import { attachedLine, attachmentFailure, fileName, uploadLimit } from '../lib/attachments.ts'
import { $backend } from './backend.ts'
import { gatewayRequest } from './gateway.ts'

/*
 * Getting a prompt's files to Hermes (see lib/attachments.ts). A backend that may not read this
 * computer's files (`localFiles` false: an attached one that did not read back Herald's probe)
 * gets each file uploaded into the session with `file.attach`, read by main, which only reads
 * files the person chose or Herald made for a prompt.
 */

/** A slow link to another computer is allowed this long per file. */
const UPLOAD_TIMEOUT_MS = 10 * 60_000

/** The upload under way, for a composer to say which file it is waiting on. */
export const $uploading = atom<{ name: string; index: number; count: number } | null>(null)

/** Whether Hermes reads this computer's files at their own paths. */
export function hermesReadsLocalFiles(): boolean {
  return $backend.get().localFiles !== false
}

/**
 * The line that brings `paths` to Hermes in session `sessionId`: the paths themselves when Hermes
 * reads this computer's files, else those of copies uploaded into the session first. Rejects,
 * naming the file, when one cannot be sent, so no prompt goes out without its files.
 */
export async function attachFiles(sessionId: string, paths: readonly string[], contract?: unknown): Promise<string> {
  if (paths.length === 0) {
    return ''
  }

  if (hermesReadsLocalFiles()) {
    return attachedLine(paths, false)
  }

  const limit = uploadLimit(contract)
  const copies: string[] = []

  try {
    for (const [index, file] of paths.entries()) {
      $uploading.set({ name: fileName(file), index, count: paths.length })

      try {
        const data = await window.heraldOS.fs.attachment(file, limit)
        // No `path`: Hermes would take a file of its own that happens to live at the same path.
        const staged = await gatewayRequest('file.attach', { session_id: sessionId, name: data.name, data_url: data.dataUrl }, UPLOAD_TIMEOUT_MS)
        // Its path, not its `@file:` reference: Hermes refuses to expand one outside the session's folder, where its attachments usually are.
        copies.push(staged.path)
      } catch (error) {
        throw new Error(attachmentFailure(file, error))
      }
    }
  } finally {
    $uploading.set(null)
  }

  return attachedLine(copies, true)
}
