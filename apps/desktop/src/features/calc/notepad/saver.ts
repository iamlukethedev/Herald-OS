import type { CalcNote } from '../../../../shared/calc.ts'

/** How long typing rests before the note is saved. */
export const SAVE_DELAY_MS = 400

export interface NoteSaver {
  /** The note as it is on disk (read, created or saved elsewhere), so it is not sent again. */
  known: (note: Pick<CalcNote, 'id' | 'text' | 'updatedAt'>) => void
  /** When this window last saw the note change on disk; a later change came from elsewhere. */
  updatedAt: (id: string) => number | undefined
  /** Save this text a moment after typing rests. */
  schedule: (id: string, text: string) => void
  /** Save what is waiting now; resolves once every save so far is done. */
  flush: () => Promise<void>
  /** Typing is waiting to be saved. */
  pending: () => boolean
}

/**
 * Saves a note's text a moment after typing rests, and at once on flush (blur, hiding, closing,
 * switching notes). Saves go one at a time and in order, so an older text never lands last; the
 * text last sent is not sent again. A failed save waits for the next flush or keystroke.
 */
export function createNoteSaver(options: { save: (note: { id: string; text: string }) => Promise<CalcNote>; onError: (error: unknown) => void; delayMs?: number }): NoteSaver {
  const delay = options.delayMs ?? SAVE_DELAY_MS
  const sent = new Map<string, string>()
  const stamps = new Map<string, number>()
  let waiting: { id: string; text: string } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<void> = Promise.resolve()

  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }

    const note = waiting
    waiting = null

    if (note && sent.get(note.id) !== note.text) {
      sent.set(note.id, note.text)
      chain = chain.then(async () => {
        try {
          const result = await options.save(note)
          stamps.set(note.id, result.updatedAt)
        } catch (error) {
          if (sent.get(note.id) === note.text) {
            sent.delete(note.id)
          }

          waiting ??= note
          options.onError(error)
        }
      })
    }

    return chain
  }

  return {
    known: note => {
      sent.set(note.id, note.text)
      stamps.set(note.id, note.updatedAt)
    },
    updatedAt: id => stamps.get(id),
    schedule: (id, text) => {
      if (waiting && waiting.id !== id) {
        void flush()
      }

      waiting = { id, text }

      if (timer) {
        clearTimeout(timer)
      }

      timer = setTimeout(() => void flush(), delay)
    },
    flush,
    pending: () => waiting !== null
  }
}
