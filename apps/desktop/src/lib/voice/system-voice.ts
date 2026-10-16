// The computer's own voice, the last resort when Hermes cannot speak. Electron main renders a line a
// few sentences at a time (`say` on macOS, espeak-ng or flite on Linux) and each clip plays on the
// whole-utterance player Hermes's own speech uses, so barge-in, the stop button, echo cancellation
// and the output device behave as they do for Hermes's voices.
import type { SystemSpeech } from '../../../shared/ipc.ts'
import { type PlaybackTicket, playClip } from './speak-stream.ts'
import { chunkForSystemVoice } from './speech-text.ts'

/** Why the system voice could not say a line: this computer has none for the person's language, or it failed. */
export class SystemVoiceError extends Error {
  constructor(
    readonly reason: 'missing' | 'failed',
    message: string
  ) {
    super(message)
    this.name = 'SystemVoiceError'
  }
}

async function render(text: string): Promise<SystemSpeech> {
  try {
    return await window.heraldOS.voice.systemSpeech(text)
  } catch (error) {
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Say `text` with the computer's own voice. The next piece renders while one plays; `onPlaying`
 * runs once the first is audible. Resolves true when any of it was heard, false when the ticket
 * went stale before it was; rejects with SystemVoiceError when the first piece could not be said.
 */
export async function speakWithSystemVoice(text: string, ticket: PlaybackTicket, onPlaying?: () => void): Promise<boolean> {
  const pieces = chunkForSystemVoice(text)
  let pending: Promise<SystemSpeech> | null = pieces.length > 0 ? render(pieces[0]) : null
  let heard = false
  const audible = () => {
    if (!heard) {
      heard = true
      onPlaying?.()
    }
  }

  for (let index = 0; pending; index++) {
    const clip: SystemSpeech = await pending

    if (!ticket()) {
      return heard
    }

    if (!clip.ok && !heard) {
      throw new SystemVoiceError(clip.reason, clip.detail)
    }

    pending = index + 1 < pieces.length ? render(pieces[index + 1]) : null

    if (!clip.ok) {
      console.warn(`[voice] the system voice left out part of a reply: ${clip.detail}`)
      continue
    }

    const url = URL.createObjectURL(new Blob([clip.audio], { type: clip.mimeType }))

    try {
      await playClip(url, ticket, audible)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)

      if (!heard) {
        throw new SystemVoiceError('failed', `its audio could not be played: ${reason}`)
      }

      console.warn(`[voice] the system voice stopped partway through a reply: ${reason}`)

      return heard
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  return heard
}
