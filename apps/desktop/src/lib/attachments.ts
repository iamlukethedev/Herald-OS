import { JSON_RPC_METHOD_NOT_FOUND } from '@herald-os/client'

/*
 * Files attached to a prompt, as Hermes receives them (pure; tested). When Hermes reads this
 * computer's files, the prompt names each file by its own path. When it does not (a backend on
 * another computer), each file is uploaded into the session first, and the prompt names the copy
 * Hermes keeps, by its path on Hermes's computer. Either way Hermes opens them with its tools.
 */

/** Below desktop contract 5 Hermes's WebSocket takes 16 MiB frames, which an upload over 11 MiB overflows as base64. */
const SMALL_FRAME_BYTES = 11 * 1024 * 1024

/** The largest file to upload to a backend with this `desktop_contract` (Herald's own cap applies on top). */
export function uploadLimit(contract: unknown): number {
  return Number(contract) >= 5 ? Number.MAX_SAFE_INTEGER : SMALL_FRAME_BYTES
}

/** The line that names a prompt's files: their paths, or those of the copies Hermes received. */
export function attachedLine(paths: readonly string[], uploaded: boolean): string {
  return paths.length ? `${uploaded ? 'Attached (uploaded from my computer)' : 'Attached'}: ${paths.join(', ')}` : ''
}

export const fileName = (file: string): string => file.split(/[\\/]/).pop() || file

/** Why a file did not reach Hermes, said so that the person knows what to do. */
export function attachmentFailure(file: string, error: unknown): string {
  const name = fileName(file)

  if ((error as { code?: unknown } | null)?.code === JSON_RPC_METHOD_NOT_FOUND) {
    return `${name} was not sent: this Hermes cannot take files from another computer. Update it with \`hermes update\`.`
  }

  const reason = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')

  return `${name} was not sent to Hermes: ${reason}`
}

/**
 * What Hermes is told, unseen, at the start of a session when it runs where this computer's files
 * are out of reach: whose "Desktop" a message means, and to ask for an attachment rather than search.
 */
export const ELSEWHERE_NOTE =
  'Herald OS note: I am using Herald OS on a different computer from the one you run on, and the two do not share files. ' +
  'Paths, folders and places such as my Desktop or my Downloads in my messages are on my computer, which your tools cannot reach, so do not search for them on yours. ' +
  'A file I attach is uploaded to you, and my message names the copy. When I refer to a file of mine that is not attached, ask me to attach it.'
