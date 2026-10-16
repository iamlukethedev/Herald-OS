import { atom } from 'nanostores'
import { CALC_HISTORY_MAX, type CalcHistoryEntry, type CalcHistoryInput } from '../../../../shared/calc.ts'
import { logFailure } from '../../../lib/report.ts'

/*
 * Herald Calc's history in this window. Main keeps it in Herald's data folder for every window,
 * cuts long text and tells each window when it changes. A calculation goes over in one batch with
 * the others made in the same moment; whoever keeps one does not wait for it, and a failure goes to
 * the log.
 */

/** The history, newest first, as main last sent it. */
export const $calcHistory = atom<CalcHistoryEntry[]>([])
/** The history has been read once, so an empty one means there is none. */
export const $calcHistoryLoaded = atom(false)

let following = false
let reading: Promise<void> | null = null
let readAgain = false
/** Bumped by a clear, so a read that started before it cannot bring the old entries back. */
let generation = 0
let queue: CalcHistoryInput[] = []
/** The newest calculation known here, kept or read, so that the same one again is kept once. */
let last: { key: string; at: number } | null = null

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()
const keyOf = (input: string, result: string): string => `${squash(input)}\n${squash(result)}`

async function read(): Promise<void> {
  const started = generation

  try {
    const entries = await window.heraldOS.calc.history(CALC_HISTORY_MAX)

    if (started !== generation || !Array.isArray(entries)) {
      return
    }

    $calcHistory.set(entries)
    const newest = entries[0]

    // Main keeps a repeat once too, so forgetting the last one when another window cleared is safe.
    if (!newest) {
      last = null
    } else if (!last || newest.at > last.at) {
      last = { key: keyOf(newest.input, newest.result), at: newest.at }
    }
  } catch (error) {
    logFailure('calc.history')(error)
  } finally {
    $calcHistoryLoaded.set(true)
  }
}

/** Read the history; a change that comes during a read reads it once more after. */
function refresh(join = false): Promise<void> {
  if (reading) {
    readAgain ||= !join

    return reading
  }

  reading = read().finally(() => {
    reading = null

    if (readAgain) {
      readAgain = false
      void refresh()
    }
  })

  return reading
}

/** Read the history and follow changes from every window. */
export async function loadHistory(): Promise<void> {
  const calc = window.heraldOS?.calc

  if (!following && typeof calc?.onChanged === 'function') {
    following = true
    calc.onChanged(what => {
      if (what === 'history') {
        void refresh()
      }
    })
  }

  await refresh(true)
}

function flush(): void {
  const batch = queue
  queue = []

  if (batch.length) {
    Promise.resolve()
      .then(() => window.heraldOS.calc.addHistory(batch))
      .catch(logFailure('calc.addHistory'))
  }
}

/** Keep a calculation; fire and forget, never throws, and the same input and result twice in a row is kept once. */
export function recordCalc(entry: CalcHistoryInput): void {
  try {
    const input = typeof entry.input === 'string' ? entry.input.trim() : ''
    const result = typeof entry.result === 'string' ? entry.result.trim() : ''

    if (!input || !result) {
      return
    }

    const key = keyOf(input, result)

    if (last?.key === key) {
      return
    }

    const at = typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : Date.now()
    const context = typeof entry.context === 'string' ? entry.context.trim() : ''
    last = { key, at }
    queue.push({ input, result, source: entry.source, at, ...(context ? { context } : {}) })

    if (queue.length === 1) {
      queueMicrotask(flush)
    }
  } catch (error) {
    logFailure('calc.recordCalc')(error)
  }
}

/** Forget every calculation, in every window; rejects with what went wrong. */
export async function clearHistory(): Promise<void> {
  generation++
  queue = []
  last = null
  await window.heraldOS.calc.clearHistory()
  $calcHistory.set([])
}
