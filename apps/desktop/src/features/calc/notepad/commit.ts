import type { CalcHistoryInput } from '../../../../shared/calc.ts'
import type { LineResult } from '../engine/types.ts'

/*
 * When a line of a note goes into the history: once the person is done with it (the caret leaves
 * it, or it sits still a moment after typing), and only when it worked something out.
 */

/** How long a line typed on sits still before it counts as done. */
export const COMMIT_IDLE_MS = 2500

/** The line the caret is on: its text after the last keystroke there, and whether it was typed on since the caret came. */
export interface CaretLine {
  index: number
  text: string
  dirty: boolean
}

/** A line the person is done with, recorded once its result is in. */
export interface Commit {
  index: number
  source: string
}

export interface CaretStep {
  state: CaretLine | null
  commit: Commit | null
}

/** The caret is on `index`, after typing (`typed`) or a move; the line it left is done if it was typed on. */
export function moveCaret(state: CaretLine | null, index: number, text: string, typed: boolean): CaretStep {
  if (state && state.index === index) {
    return { state: { index, text: typed ? text : state.text, dirty: state.dirty || typed }, commit: null }
  }

  return { state: { index, text, dirty: typed }, commit: state?.dirty ? { index: state.index, source: state.text } : null }
}

/** The line sat still after typing: it is done, and stays so until typed on again. */
export function idleCaret(state: CaretLine | null): CaretStep {
  if (!state?.dirty) {
    return { state, commit: null }
  }

  return { state: { ...state, dirty: false }, commit: { index: state.index, source: state.text } }
}

/** The caret left the note (blur, another note): the line it was on is done if typed on. */
export function leaveCaret(state: CaretLine | null): CaretStep {
  return { state: null, commit: state?.dirty ? { index: state.index, source: state.text } : null }
}

/** The answer for a finished line: at its place, or where lines added or removed above moved it. */
export function committedLine(commit: Commit, lines: readonly LineResult[]): LineResult | null {
  if (lines[commit.index]?.source === commit.source) {
    return lines[commit.index]
  }

  let best: LineResult | null = null

  for (const line of lines) {
    if (line.source === commit.source && (!best || Math.abs(line.index - commit.index) < Math.abs(best.index - commit.index))) {
      best = line
    }
  }

  return best
}

/** "budget = 1,200" shows 1,200: the line names a number and works nothing out. */
export function isEcho(line: LineResult): boolean {
  if (!line.display) {
    return false
  }

  const marker = line.name ? line.source.indexOf('=') : line.label ? line.source.indexOf(':') : -1
  const expression = marker >= 0 ? line.source.slice(marker + 1) : line.source
  const plain = (text: string) => text.toLowerCase().replace(/[\s,._'’]/g, '')

  return plain(expression) === plain(line.display)
}

/**
 * The history entry for a finished line: only a value worked out for exactly that text, never the
 * number as typed, never the entry recorded just before. `key` is what to compare the next one to.
 */
export function historyEntry(commit: Commit, lines: readonly LineResult[], title: string, last: string | null): { entry: CalcHistoryInput; key: string } | null {
  const line = committedLine(commit, lines)

  if (!line || line.kind !== 'value' || !line.display || isEcho(line)) {
    return null
  }

  const input = line.source.trim()
  const key = `${input}\n${line.display}`

  if (key === last) {
    return null
  }

  return { entry: { input, result: line.display, source: 'notes', context: line.label ? `${title} · ${line.label}` : title }, key }
}
