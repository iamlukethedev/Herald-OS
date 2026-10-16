import type { CalcKind, LineResult, TokenSpan, TokenType } from '../engine/types.ts'

/* How the notepad lays a note out: its lines, their colours, and where each result sits. */

/** The lines as the textarea shows them; a trailing newline makes an empty last line. */
export function splitLines(text: string): string[] {
  return text.split('\n')
}

/** The line an offset in the text falls on. */
export function lineAt(text: string, offset: number): number {
  const end = Math.min(Math.max(offset, 0), text.length)
  let line = 0

  for (let index = 0; index < end; index++) {
    if (text.charCodeAt(index) === 10) {
      line++
    }
  }

  return line
}

/** Where a line starts in the text; past the last line, the end of the text. */
export function lineStart(text: string, line: number): number {
  let offset = 0

  for (let index = 0; index < line; index++) {
    const next = text.indexOf('\n', offset)

    if (next === -1) {
      return text.length
    }

    offset = next + 1
  }

  return offset
}

/** Where a line ends, before its newline. */
export function lineEnd(text: string, line: number): number {
  const start = lineStart(text, line)
  const next = text.indexOf('\n', start)

  return next === -1 ? text.length : next
}

export interface LineView {
  /** The line's result: for exactly this text when `fresh`, else from just before the last edit. */
  result: LineResult | null
  /** Highlighting that still fits the line. */
  tokens: readonly TokenSpan[]
  fresh: boolean
}

const EMPTY: LineView = { result: null, tokens: [], fresh: false }

/**
 * The last results laid over the lines as they are now, while the engine works out the new ones.
 * Lines unchanged at the top and the bottom keep theirs (the bottom ones moved by the lines added or
 * removed). When no line was added or removed, an edited line keeps its old result, and its colours
 * too while it was only typed or erased at its end. Everything else waits for the engine.
 */
export function alignResults(lines: readonly string[], previous: readonly LineResult[] | null): LineView[] {
  const views: LineView[] = lines.map(() => EMPTY)

  if (!previous?.length) {
    return views
  }

  const shared = Math.min(lines.length, previous.length)
  let top = 0

  while (top < shared && previous[top].source === lines[top]) {
    views[top] = { result: previous[top], tokens: previous[top].tokens ?? [], fresh: true }
    top++
  }

  let bottom = 0

  while (bottom < shared - top && previous[previous.length - 1 - bottom].source === lines[lines.length - 1 - bottom]) {
    const result = previous[previous.length - 1 - bottom]
    views[lines.length - 1 - bottom] = { result, tokens: result.tokens ?? [], fresh: true }
    bottom++
  }

  if (lines.length === previous.length) {
    for (let index = top; index < lines.length - bottom; index++) {
      const result = previous[index]
      const line = lines[index]
      const atEnd = line.startsWith(result.source) || result.source.startsWith(line)
      views[index] = { result, tokens: atEnd ? (result.tokens ?? []) : [], fresh: false }
    }
  }

  return views
}

export interface Segment {
  text: string
  type: TokenType | null
}

/** A line cut into runs to colour: the tokens that fit it, in order (one starting inside another is left out), and plain text between them. */
export function segments(line: string, tokens: readonly TokenSpan[]): Segment[] {
  const runs: Segment[] = []
  const sorted = [...tokens].sort((a, b) => a.from - b.from)
  let at = 0

  for (const token of sorted) {
    const from = Math.max(token.from, 0)
    const to = Math.min(token.to, line.length)

    if (from < at || to <= from) {
      continue
    }

    if (from > at) {
      runs.push({ text: line.slice(at, from), type: null })
    }

    runs.push({ text: line.slice(from, to), type: token.type })
    at = to
  }

  if (at < line.length) {
    runs.push({ text: line.slice(at), type: null })
  }

  return runs
}

/** A heading or a comment by its first characters, for colouring a line the engine has not answered yet. */
export function plainKind(line: string): 'heading' | 'comment' | null {
  const start = line.trimStart()

  if (start.startsWith('#')) {
    return 'heading'
  }

  return start.startsWith('//') ? 'comment' : null
}

/** From this wide the notes list sits beside the note; narrower, it opens over it. */
export const SIDEBAR_INLINE_PX = 620

/** Whether the notes list shows: as the person set it, or on 'auto' when the window is wide enough (or not measured yet). */
export function sidebarShown(setting: 'auto' | 'open' | 'closed', width: number): boolean {
  return setting === 'auto' ? width === 0 || width >= SIDEBAR_INLINE_PX : setting === 'open'
}

export interface RowBox {
  top: number
  height: number
}

/**
 * Where each line's result goes. `tops` are the measured tops of the lines in the mirror (the
 * first row of a wrapped line) and `end` the bottom of the last; each box spans its line's rows.
 * Until a measure fits these lines, every line takes one row under the padding.
 */
export function rowBoxes(count: number, measure: { tops: readonly number[]; end: number } | null, row: number, padding: number): RowBox[] {
  if (!measure || measure.end <= 0 || measure.tops.length !== count || !measure.tops.every((top, index, tops) => Number.isFinite(top) && (index === 0 || top >= tops[index - 1]))) {
    return Array.from({ length: count }, (_, index) => ({ top: padding + index * row, height: row }))
  }

  const { tops, end } = measure

  return tops.map((top, index) => ({ top, height: Math.max((index + 1 < count ? tops[index + 1] : end) - top, row) }))
}

export type ResultCell =
  | { kind: 'value'; value: string; unit: string; display: string }
  | { kind: 'error'; message: string }
  | { kind: 'graph' }

/**
 * What the results column shows for a line. An error waits until the answer is for the line as it
 * is, and while the person is still typing on it.
 */
export function resultCell(view: LineView, typing: boolean): ResultCell | null {
  const result = view.result

  if (!result) {
    return null
  }

  if (result.kind === 'value' && result.display) {
    return { kind: 'value', display: result.display, ...displayParts(result.display, result.value?.kind) }
  }

  if (result.kind === 'function' || (result.kind === 'plot' && (result.plot || result.plotSource))) {
    return { kind: 'graph' }
  }

  if (result.kind === 'error' && view.fresh && !typing && result.source.trim()) {
    return { kind: 'error', message: result.error?.trim() || "This line doesn't work out yet" }
  }

  return null
}

const UNIT_KINDS: ReadonlySet<CalcKind> = new Set(['unit', 'currency', 'duration'])

/** A result cut into its number and its unit, which shows quieter: "3.11 mi" is "3.11" and " mi". */
export function displayParts(display: string, kind?: CalcKind): { value: string; unit: string } {
  if (kind && UNIT_KINDS.has(kind)) {
    const match = /^([^\p{L}]*\d)(\s*\D+)$/u.exec(display)

    if (match) {
      return { value: match[1], unit: match[2] }
    }
  }

  return { value: display, unit: '' }
}
