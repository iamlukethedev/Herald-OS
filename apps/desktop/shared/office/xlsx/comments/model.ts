/*
 * Comments and notes as Univer keeps them in a workbook's resources: notes by the notes plugin
 * (SHEET_NOTE_PLUGIN, sheet id → row → column → note), comment threads by the sheets thread
 * comment plugin (SHEET_UNIVER_THREAD_COMMENT_PLUGIN, sheet id → the threads' first comments, each
 * with its replies as children, tied to its cell by `ref`).
 */

export const NOTE_RESOURCE = 'SHEET_NOTE_PLUGIN'
export const THREAD_RESOURCE = 'SHEET_UNIVER_THREAD_COMMENT_PLUGIN'

/** A note as Univer keeps it; Herald adds who wrote it. */
export interface UNote {
  id: string
  row: number
  col: number
  /** The note's box, in pixels. */
  width: number
  height: number
  note: string
  /** Shown all the time rather than when the cell is pointed at. */
  show?: boolean
  author?: string
}

export interface UBody {
  dataStream: string
  paragraphs?: { startIndex: number }[]
  textRuns?: { st: number; ed: number; ts?: object }[]
  customRanges?: unknown[]
  [key: string]: unknown
}

/** A comment as Univer keeps it: a thread's first comment has its replies as `children`. */
export interface UComment {
  id: string
  threadId: string
  /** The cell ("B2"), or an anchor on a drawing. */
  ref?: string
  /** When it was written: "2026/10/09 14:30" in local time as Univer writes it, or an ISO time read from a file. */
  dT: string
  personId: string
  authorName?: string
  text: UBody
  parentId?: string
  resolved?: boolean
  unitId?: string
  subUnitId?: string
  children?: UComment[]
  [key: string]: unknown
}

export type NotesResource = Record<string, Record<string, Record<string, UNote>>>
export type ThreadsResource = Record<string, UComment[]>

const NAMED = 'Owner_'

/**
 * The Univer user id of a person known by their name: Herald's own user, and the people of Excel
 * files who have no account behind their name. Univer's local permissions take a user's role from
 * the start of the id, so the one using Herald stays the workbook's owner.
 */
export const personIdOf = (name: string): string => `${NAMED}${name}`

/** The name in a person id made by `personIdOf`; null for other ids. */
export const nameOfPersonId = (id: string): string | null => (id.startsWith(NAMED) ? id.slice(NAMED.length) : null)

/** Plain text as Univer's document body: each paragraph ends with "\r", the body with "\r\n". */
export function bodyOf(text: string): UBody {
  const paragraphs: { startIndex: number }[] = []
  let dataStream = ''

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    dataStream += line
    paragraphs.push({ startIndex: dataStream.length })
    dataStream += '\r'
  }

  return { dataStream: `${dataStream}\n`, paragraphs, textRuns: [], customRanges: [], customBlocks: [], customDecorations: [], tables: [], sectionBreaks: [] }
}

/** The text of a document body, a line for each paragraph; the marks Univer puts around links and mentions taken out. */
export const plainTextOf = (body: { dataStream?: string } | undefined): string =>
  String(body?.dataStream ?? '')
    .replace(/\r?\n$/, '')
    .replace(/\r$/, '')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, '')

/** Whether a body has formatting a file's plain comment text cannot keep. */
export const isFormatted = (body: { textRuns?: { ts?: object }[] } | undefined): boolean => (body?.textRuns ?? []).some((run) => run.ts && Object.keys(run.ts).length > 0)

const pad = (n: number, size = 2) => String(n).padStart(size, '0')

/** When a comment was written, as a date: Univer's "2026/10/09 14:30" is local time; an ISO time without a zone is UTC, as Excel writes them. */
export function dateOfComment(dT: string): Date | null {
  const local = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(dT.trim())

  if (local) {
    const [year, month, day, hours, minutes, seconds] = local.slice(1).map((part) => Number(part ?? 0))

    return new Date(year, month - 1, day, hours, minutes, seconds)
  }

  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(dT.trim()) ? `${dT.trim()}Z` : dT.trim()
  const time = Date.parse(iso)

  return Number.isNaN(time) ? null : new Date(time)
}

/** A comment's time in local time, "2026-10-09 14:30", for people and commands to read. */
export function timeOfComment(dT: string): string {
  const date = dateOfComment(dT)

  return date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}` : dT
}
