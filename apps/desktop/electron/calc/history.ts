import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { CALC_HISTORY_MAX, CALC_HISTORY_TEXT_MAX, CALC_SOURCES, type CalcHistoryEntry, type CalcSource } from '../../shared/calc.ts'
import { writeTextAtomic } from '../atomic-write.ts'

/*
 * Herald Calc's history (shared/calc.ts): `calc/history.json` in Herald's data folder, newest first
 * and at most CALC_HISTORY_MAX entries, replaced atomically. Reads and writes run one at a time,
 * so adds from several windows at once all land.
 */

const ID = /^[a-z0-9-]{1,64}$/

export interface HistoryStoreOptions {
  /** `calc/history.json` in Herald's data folder. */
  file: string
  now?: () => number
  /** After an add or a clear changed the history. */
  onChange?: () => void
}

type Fields = Omit<CalcHistoryEntry, 'id' | 'at'>

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isSource = (value: unknown): value is CalcSource => CALC_SOURCES.includes(value as CalcSource)
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/** `text` trimmed and cut to CALC_HISTORY_TEXT_MAX, never between the halves of a surrogate pair; empty when it is not text. */
function textOf(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''

  if (text.length <= CALC_HISTORY_TEXT_MAX) {
    return text
  }

  const last = text.charCodeAt(CALC_HISTORY_TEXT_MAX - 1)

  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? CALC_HISTORY_TEXT_MAX - 1 : CALC_HISTORY_TEXT_MAX).trimEnd()
}

/** What every entry holds, checked and cut to size; null without an input, a result or a known source. */
function fieldsOf(raw: Record<string, unknown>): Fields | null {
  const input = textOf(raw.input)
  const result = textOf(raw.result)
  const context = textOf(raw.context)

  if (!input || !result || !isSource(raw.source)) {
    return null
  }

  return { input, result, source: raw.source, ...(context ? { context } : {}) }
}

/** An entry as history.json holds it; null when it is not whole. */
function storedEntry(raw: unknown): CalcHistoryEntry | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !ID.test(raw.id) || !isTime(raw.at)) {
    return null
  }

  const fields = fieldsOf(raw)

  return fields ? { id: raw.id, at: raw.at, ...fields } : null
}

const newestFirst = (a: CalcHistoryEntry, b: CalcHistoryEntry): number => b.at - a.at

export class HistoryStore {
  private readonly file: string
  private readonly now: () => number
  private readonly onChange?: () => void
  private entries: CalcHistoryEntry[] | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor({ file, now = Date.now, onChange }: HistoryStoreOptions) {
    this.file = file
    this.now = now
    this.onChange = onChange
  }

  /** The newest `limit` entries; all of them when it is not a number. */
  list(limit?: unknown): Promise<CalcHistoryEntry[]> {
    const count = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : CALC_HISTORY_MAX

    return this.enqueue(async () => (await this.load()).slice(0, count))
  }

  /**
   * Keep calculations, given in the order they were made. Entries without an input, a result or a
   * known source are dropped, and so is one with the same input and result as the newest before
   * it. `at` defaults to now and is never later than now.
   */
  add(entries: unknown): Promise<void> {
    const given: unknown[] = Array.isArray(entries) ? entries.slice(-CALC_HISTORY_MAX) : []

    if (given.length === 0) {
      return Promise.resolve()
    }

    return this.enqueue(async () => {
      const current = await this.load()
      const now = this.now()
      const added: CalcHistoryEntry[] = []
      let newest: CalcHistoryEntry | undefined = current[0]

      for (const raw of given) {
        if (!isRecord(raw)) {
          continue
        }

        const fields = fieldsOf(raw)

        if (!fields || (newest?.input === fields.input && newest.result === fields.result)) {
          continue
        }

        newest = { id: crypto.randomBytes(6).toString('hex'), at: isTime(raw.at) ? Math.min(raw.at, now) : now, ...fields }
        added.push(newest)
      }

      if (added.length === 0) {
        return
      }

      // Newest first; the sort keeps the order of entries made at the same time.
      const next = [...added.reverse(), ...current].sort(newestFirst).slice(0, CALC_HISTORY_MAX)
      await this.write(next)
      this.entries = next
      this.onChange?.()
    })
  }

  /** Forget every calculation: the file goes. */
  clear(): Promise<void> {
    return this.enqueue(async () => {
      const had = (await this.load()).length > 0
      await fs.rm(this.file, { force: true })
      this.entries = []

      if (had) {
        this.onChange?.()
      }
    })
  }

  private async load(): Promise<CalcHistoryEntry[]> {
    if (this.entries) {
      return this.entries
    }

    let stored: unknown[] = []

    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'))
      stored = isRecord(parsed) && Array.isArray(parsed.entries) ? parsed.entries : []
    } catch {
      stored = []
    }

    this.entries = stored
      .map(storedEntry)
      .filter((entry): entry is CalcHistoryEntry => entry !== null)
      .sort(newestFirst)
      .slice(0, CALC_HISTORY_MAX)

    return this.entries
  }

  private async write(entries: CalcHistoryEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    await writeTextAtomic(this.file, `${JSON.stringify({ v: 1, entries })}\n`)
  }

  /** Run `task` after the reads and writes before it; the queue goes on when one fails. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => undefined)

    return run
  }
}
