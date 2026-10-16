import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { CALC_NOTE_ID, CALC_NOTE_MAX_CHARS, CALC_NOTES_MAX, type CalcNote, type CalcNoteSummary, notePreview, noteTitle } from '../../shared/calc.ts'
import { writeTextAtomic } from '../atomic-write.ts'

/*
 * Herald Calc's notes (shared/calc.ts): a JSON file a note, `calc/notes/<id>.json` in Herald's
 * data folder, each replaced atomically. An id from a window is used only when it is CALC_NOTE_ID,
 * so a file name never leaves the folder. Saves and deletes run one at a time.
 */

const EXTENSION = '.json'
/** How many note files list() reads at once. */
const READ_BATCH = 16
const ID_ATTEMPTS = 8

export interface NotesStoreOptions {
  /** `calc/notes` in Herald's data folder. */
  dir: string
  now?: () => number
  /** After a save or a delete changed the notes. */
  onChange?: () => void
}

const isNoteId = (value: unknown): value is string => typeof value === 'string' && CALC_NOTE_ID.test(value)
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** A note file's content; null when it is not a whole note named `id`. */
function noteOf(raw: unknown, id: string): CalcNote | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const { id: named, text, createdAt, updatedAt } = raw as Record<string, unknown>

  return named === id && typeof text === 'string' && text.length <= CALC_NOTE_MAX_CHARS && isTime(createdAt) && isTime(updatedAt) ? { id, text, createdAt, updatedAt } : null
}

/** The id a window names: none for a new note; throws when it is not CALC_NOTE_ID. */
function idOf(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null
  }

  if (!isNoteId(value)) {
    throw new Error('That is not a note id.')
  }

  return value
}

/** What a window asked to save; throws when it is not a note Herald keeps. */
function draftOf(raw: unknown): { id: string | null; text: string } {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}

  if (typeof source.text !== 'string') {
    throw new Error('A note needs its text.')
  }

  if (source.text.length > CALC_NOTE_MAX_CHARS) {
    throw new Error(`A note holds at most ${CALC_NOTE_MAX_CHARS.toLocaleString('en')} characters.`)
  }

  return { id: idOf(source.id), text: source.text }
}

const newestFirst = (a: CalcNote, b: CalcNote): number => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1)

export class NotesStore {
  private readonly dir: string
  private readonly now: () => number
  private readonly onChange?: () => void
  private queue: Promise<unknown> = Promise.resolve()

  constructor({ dir, now = Date.now, onChange }: NotesStoreOptions) {
    this.dir = dir
    this.now = now
    this.onChange = onChange
  }

  /** Every note's title and preview, the one changed last first. */
  async list(): Promise<CalcNoteSummary[]> {
    const ids = await this.ids()
    const notes: CalcNote[] = []

    for (let start = 0; start < ids.length; start += READ_BATCH) {
      for (const note of await Promise.all(ids.slice(start, start + READ_BATCH).map(id => this.read(id)))) {
        if (note) {
          notes.push(note)
        }
      }
    }

    return notes.sort(newestFirst).map(({ id, text, createdAt, updatedAt }) => ({ id, title: noteTitle(text), preview: notePreview(text), createdAt, updatedAt }))
  }

  /** One note; null when there is none by that id. */
  async read(id: unknown): Promise<CalcNote | null> {
    if (!isNoteId(id)) {
      return null
    }

    try {
      return noteOf(JSON.parse(await fs.readFile(this.fileOf(id), 'utf8')), id)
    } catch {
      return null
    }
  }

  /**
   * Create a note (no id) or replace one, and the note as saved. A note longer than
   * CALC_NOTE_MAX_CHARS is refused, and so is a new one past CALC_NOTES_MAX. An id with no note
   * (deleted in another window while this one edited it) makes that note again.
   */
  async save(note: unknown): Promise<CalcNote> {
    const { id, text } = draftOf(note)

    return this.enqueue(async () => {
      const current = id ? await this.read(id) : null

      if (current?.text === text) {
        return current
      }

      if (!current) {
        await this.checkRoom()
      }

      const now = this.now()
      let saved: CalcNote

      if (id) {
        saved = { id, text, createdAt: current?.createdAt ?? now, updatedAt: now }
        await this.write(saved)
      } else {
        saved = await this.create(text, now)
      }

      this.onChange?.()

      return saved
    })
  }

  /** Delete a note; one that is not there is nothing to delete. */
  async remove(id: unknown): Promise<void> {
    if (!isNoteId(id)) {
      return
    }

    await this.enqueue(async () => {
      try {
        await fs.unlink(this.fileOf(id))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return
        }

        throw error
      }

      this.onChange?.()
    })
  }

  private fileOf(id: string): string {
    return path.join(this.dir, `${id}${EXTENSION}`)
  }

  /** The ids of the note files in the folder. */
  private async ids(): Promise<string[]> {
    let names: string[]

    try {
      names = await fs.readdir(this.dir)
    } catch {
      return []
    }

    return names
      .filter(name => name.endsWith(EXTENSION))
      .map(name => name.slice(0, -EXTENSION.length))
      .filter(isNoteId)
  }

  private async checkRoom(): Promise<void> {
    if ((await this.ids()).length >= CALC_NOTES_MAX) {
      throw new Error(`Herald Calc keeps at most ${CALC_NOTES_MAX} notes; delete one to make room.`)
    }
  }

  /** A new note under a short random id no other note has. */
  private async create(text: string, now: number): Promise<CalcNote> {
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
      const note = { id: crypto.randomBytes(5).toString('hex'), text, createdAt: now, updatedAt: now }

      if (await this.write(note, true)) {
        return note
      }
    }

    throw new Error('No free name for a new note.')
  }

  /** Write a note's file; `fresh` writes only when there is none yet, and says whether it did. */
  private async write(note: CalcNote, fresh = false): Promise<boolean> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })

    return writeTextAtomic(this.fileOf(note.id), `${JSON.stringify(note, null, 2)}\n`, fresh ? { expect: null } : {})
  }

  /** Run `task` after the saves and deletes before it; the queue goes on when one fails. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => undefined)

    return run
  }
}
