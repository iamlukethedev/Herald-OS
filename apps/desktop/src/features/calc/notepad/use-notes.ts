import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type CalcNoteSummary, noteTitle } from '../../../../shared/calc.ts'
import { logFailure } from '../../../lib/report.ts'
import { notify } from '../../../store/notifications.ts'
import { messageOf } from './format.ts'
import { createNoteSaver } from './saver.ts'
import { WELCOME_NOTE } from './welcome.ts'

const OPEN_KEY = 'herald-calc:open-note'
const WELCOMED_KEY = 'herald-calc:welcomed'
/** A save that keeps failing is told once in this long. */
const SAVE_ERROR_QUIET_MS = 15_000

export interface NoteText {
  id: string
  text: string
}

export interface DeletedNote {
  title: string
  text: string
}

export interface Notes {
  /** Newest first; null until first listed. */
  notes: CalcNoteSummary[] | null
  failed: boolean
  /** The first list is in and the note to show is open. */
  ready: boolean
  note: NoteText | null
  setText: (text: string) => void
  select: (id: string | null) => Promise<boolean>
  /** A new note, open; New note on a blank one keeps that one. Resolves to its id. */
  create: (text?: string) => Promise<string | null>
  /** Resolves to what the note held, for an undo. */
  remove: (id: string) => Promise<DeletedNote | null>
  flush: () => Promise<void>
  retry: () => void
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Without storage the note opened last is just not remembered.
  }
}

const newestFirst = (notes: CalcNoteSummary[]) => [...notes].sort((a, b) => b.updatedAt - a.updatedAt)

/** The note to open in place of `id`, gone from `list`: the one that sat at its place. */
function neighbour(previous: readonly CalcNoteSummary[], list: readonly CalcNoteSummary[], id: string): string | null {
  const index = Math.max(0, previous.findIndex(note => note.id === id))

  return list[Math.min(index, list.length - 1)]?.id ?? null
}

let welcoming: Promise<void> | null = null

/** The Welcome note, made once however many times the first run asks. */
function welcome(): Promise<void> {
  welcoming ??= window.heraldOS.calc.saveNote({ text: WELCOME_NOTE }).then(
    () => remember(WELCOMED_KEY, '1'),
    error => {
      welcoming = null
      throw error
    }
  )

  return welcoming
}

/**
 * The notes and the one in the editor: listed, opened, created and deleted through main, saved a
 * moment after typing rests and at once whenever the note could be left (switching, hiding,
 * closing). `editing` says whether the person is in the editor, so a change from another window
 * does not replace what they are typing.
 */
export function useNotes(editing: () => boolean): Notes {
  const [notes, setNotes] = useState<CalcNoteSummary[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [ready, setReady] = useState(false)
  const [note, setNote] = useState<NoteText | null>(null)
  const [attempt, setAttempt] = useState(0)
  const noteRef = useRef(note)
  const readyRef = useRef(false)
  const listRef = useRef<CalcNoteSummary[]>([])
  const editingRef = useRef(editing)
  editingRef.current = editing
  // Blank notes New note made here: left blank, they are not kept.
  const blank = useRef(new Set<string>())
  const reading = useRef(0)
  const saveToldAt = useRef(Number.NEGATIVE_INFINITY)

  const saver = useMemo(
    () =>
      createNoteSaver({
        save: next => window.heraldOS.calc.saveNote(next),
        onError: error => {
          if (Date.now() - saveToldAt.current > SAVE_ERROR_QUIET_MS) {
            saveToldAt.current = Date.now()
            notify({ title: 'Could not save the note', body: messageOf(error), level: 'error' })
          }
        }
      }),
    []
  )

  const show = useCallback((next: NoteText | null) => {
    noteRef.current = next
    setNote(next)

    if (next) {
      remember(OPEN_KEY, next.id)
    }
  }, [])

  const refresh = useCallback(async () => {
    const list = newestFirst(await window.heraldOS.calc.listNotes())
    listRef.current = list
    setNotes(list)
    setFailed(false)

    return list
  }, [])

  /** Leaving the open note for `next`: a blank one New note made goes. */
  const leave = useCallback((next: string | null) => {
    const current = noteRef.current

    if (current && current.id !== next && blank.current.has(current.id) && !current.text.trim()) {
      blank.current.delete(current.id)
      void window.heraldOS.calc.deleteNote(current.id).catch(logFailure('calc.deleteNote'))
    }
  }, [])

  const select = useCallback(
    async (id: string | null): Promise<boolean> => {
      const mine = ++reading.current
      await saver.flush()

      if (mine !== reading.current) {
        return false
      }

      leave(id)

      if (id === null) {
        show(null)

        return false
      }

      const loaded = await window.heraldOS.calc.readNote(id)

      if (mine !== reading.current) {
        return false
      }

      if (loaded) {
        saver.known(loaded)
      }

      show(loaded ? { id: loaded.id, text: loaded.text } : null)

      return loaded !== null
    },
    [saver, leave, show]
  )

  const setText = useCallback(
    (text: string) => {
      const current = noteRef.current

      if (!current || current.text === text) {
        return
      }

      noteRef.current = { id: current.id, text }
      setNote(noteRef.current)
      saver.schedule(current.id, text)
    },
    [saver]
  )

  const create = useCallback(
    async (text = ''): Promise<string | null> => {
      const current = noteRef.current

      if (!text && current && !current.text.trim()) {
        return current.id
      }

      const mine = ++reading.current

      try {
        await saver.flush()
        const made = await window.heraldOS.calc.saveNote({ text })
        saver.known(made)

        if (mine === reading.current) {
          leave(made.id)

          if (!text) {
            blank.current.add(made.id)
          }

          show({ id: made.id, text: made.text })
        }

        void refresh().catch(logFailure('calc.listNotes'))

        return made.id
      } catch (error) {
        notify({ title: 'Could not start a note', body: messageOf(error), level: 'error' })

        return null
      }
    },
    [saver, leave, show, refresh]
  )

  const remove = useCallback(
    async (id: string): Promise<DeletedNote | null> => {
      const current = noteRef.current
      const before = listRef.current

      try {
        let text: string

        if (current?.id === id) {
          await saver.flush()
          text = noteRef.current?.id === id ? noteRef.current.text : current.text
        } else {
          text = (await window.heraldOS.calc.readNote(id))?.text ?? ''
        }

        await window.heraldOS.calc.deleteNote(id)
        blank.current.delete(id)
        const list = await refresh()

        if (noteRef.current?.id === id) {
          noteRef.current = null
          await select(neighbour(before, list, id))
        }

        return { title: noteTitle(text), text }
      } catch (error) {
        notify({ title: 'Could not delete the note', body: messageOf(error), level: 'error' })

        return null
      }
    },
    [saver, refresh, select]
  )

  // The first list, the Welcome note on the very first run, and the note open last time.
  useEffect(() => {
    let current = true

    const load = async () => {
      let list = newestFirst(await window.heraldOS.calc.listNotes())

      if (!list.length && !recall(WELCOMED_KEY)) {
        await welcome()
        list = newestFirst(await window.heraldOS.calc.listNotes())
      }

      if (!current) {
        return
      }

      listRef.current = list
      setNotes(list)
      setFailed(false)
      const remembered = recall(OPEN_KEY)
      const first = list.find(entry => entry.id === remembered)?.id ?? list[0]?.id ?? null

      if (first && !(await select(first)) && list[0] && list[0].id !== first) {
        await select(list[0].id)
      }

      if (current) {
        readyRef.current = true
        setReady(true)
      }
    }

    load().catch(error => {
      if (current) {
        setFailed(true)
        logFailure('calc.listNotes')(error)
      }
    })

    return () => {
      current = false
    }
  }, [attempt, select])

  // Another window (or main) changed the notes.
  useEffect(
    () =>
      window.heraldOS.calc.onChanged(what => {
        if (what !== 'notes') {
          return
        }

        const before = listRef.current

        void refresh()
          .then(async list => {
            const current = noteRef.current

            // The first load picks the note to open itself.
            if (!readyRef.current) {
              return
            }

            if (!current) {
              if (list.length && !before.length) {
                await select(list[0].id)
              }

              return
            }

            const summary = list.find(entry => entry.id === current.id)

            if (!summary) {
              await select(neighbour(before, list, current.id))

              return
            }

            if (summary.updatedAt <= (saver.updatedAt(current.id) ?? 0) || saver.pending() || editingRef.current()) {
              return
            }

            const loaded = await window.heraldOS.calc.readNote(current.id)

            if (loaded && noteRef.current?.id === loaded.id && noteRef.current.text !== loaded.text && !saver.pending() && !editingRef.current()) {
              saver.known(loaded)
              show({ id: loaded.id, text: loaded.text })
            }
          })
          .catch(logFailure('calc.listNotes'))
      }),
    [refresh, select, saver, show]
  )

  // Typing is saved whenever the note could be left: hidden, closed, unmounted.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        void saver.flush()
      }
    }
    const onUnload = () => void saver.flush()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('beforeunload', onUnload)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('beforeunload', onUnload)
      void saver.flush()
    }
  }, [saver])

  const retry = useCallback(() => {
    setFailed(false)
    setAttempt(value => value + 1)
  }, [])

  return { notes, failed, ready, note, setText, select, create, remove, flush: saver.flush, retry }
}
