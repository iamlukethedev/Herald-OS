import type { OfficeDocSummary, OfficePresence } from '../../../shared/ipc.ts'
import { baseName, OFFICE_APP_NAMES, type OfficeApp } from '../../../shared/office/files.ts'

/*
 * What Hermes's Office commands share, without a window or I/O: the open documents as one list
 * (every window's report, with what this window knows better), the one a command names, a line
 * that tells Hermes what is in front, and names for new files. Tested directly.
 */

/** One open document, as Hermes reads it. */
export interface OfficeEntry {
  app: OfficeApp
  key: string
  name: string
  path: string | null
  format: string
  modified: boolean
  /** The document in front in its app's window. */
  active: boolean
  /** The document in front of all Office documents: the active one of the window used last. */
  front: boolean
  /** What its status says: words and heading, the sheet and selection, the slide. */
  detail?: string
  /** What is selected in it: text in a document, a range in a workbook, a slide. */
  selection?: string
}

type WindowView = Omit<OfficePresence, 'at'>

const overlaps = (a: WindowView, b: WindowView): boolean => a.app === b.app && a.documents.some((doc) => b.documents.some((other) => other.key === doc.key))

/**
 * Every Office window's documents, the window used last first. `local` is this window's own
 * sessions read live (the selection as it is now), and wins over what this window last reported.
 */
export function officeEntries(presence: readonly OfficePresence[], local: readonly WindowView[] = []): OfficeEntry[] {
  const newest = Math.max(0, ...presence.map((entry) => entry.at)) + 1
  const own = local.filter((view) => view.documents.length).map((view) => ({ ...view, at: presence.find((entry) => overlaps(entry, view))?.at ?? newest }))
  const windows = [...own, ...presence.filter((entry) => !own.some((view) => overlaps(entry, view)))].sort((a, b) => b.at - a.at)
  const out: OfficeEntry[] = []

  for (const window of windows) {
    for (const doc of window.documents) {
      out.push({ app: window.app, key: doc.key, name: doc.name, path: doc.path, format: doc.format, modified: doc.modified, active: doc.key === window.active, front: false, ...(doc.detail ? { detail: doc.detail } : {}), ...(doc.selection ? { selection: doc.selection } : {}) })
    }
  }

  const front = out.find((entry) => entry.active)

  if (front) {
    front.front = true
  }

  return out
}

const comparable = (text: string): string => text.trim().toLowerCase()
const withoutExtension = (name: string): string => name.replace(/\.[a-z0-9]{1,5}$/i, '')

/**
 * The open document `ref` names in `app`: its path (resolved), or its name as its tab shows it, with
 * or without the extension ("Untitled 2", "Report", "report.docx"). Null when none is open.
 */
export function findEntry(entries: readonly OfficeEntry[], app: OfficeApp, ref: string, resolved?: string | null): OfficeEntry | null {
  const mine = entries.filter((entry) => entry.app === app)
  const wanted = comparable(ref)

  return (
    (resolved ? mine.find((entry) => entry.path === resolved) : undefined) ??
    mine.find((entry) => comparable(entry.name) === wanted) ??
    mine.find((entry) => comparable(withoutExtension(entry.name)) === comparable(withoutExtension(ref))) ??
    null
  )
}

/** A reference that reads as a file path rather than an open document's name. */
export const isPathLike = (ref: string): boolean => /^(~|\/)/.test(ref.trim())

const shorten = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** `~/…` for paths in the home folder, as people say them. */
export function tildePath(file: string, home: string): string {
  return home && (file === home || file.startsWith(`${home}/`)) ? `~${file.slice(home.length)}` : file
}

/** A full path from what Hermes or the person typed (`~/…` works); trailing slashes go. */
export function resolvePath(input: string, home: string): string {
  let value = input.trim()

  if (value === '~' || value.startsWith('~/')) {
    if (!home) {
      throw new Error('The home folder is not known yet; give the full path')
    }

    value = `${home}${value.slice(1)}`
  }

  if (!value.startsWith('/')) {
    throw new Error(`Give the full path (starting with / or ~/): ${input}`)
  }

  return value.replace(/\/+/g, '/').replace(/\/\.(?=\/|$)/g, '').replace(/(.)\/$/, '$1')
}

function describeEntry(entry: OfficeEntry, home: string): string {
  const where = entry.path ? tildePath(entry.path, home) : 'not saved yet'
  const parts = [`${entry.name} in ${OFFICE_APP_NAMES[entry.app]} (${where}${entry.modified ? ', unsaved edits' : ''})`]

  if (entry.selection) {
    parts.push(entry.app === 'docs' ? `selected text “${shorten(entry.selection, 160)}”` : `selection ${entry.selection}`)
  } else if (entry.detail) {
    parts.push(shorten(entry.detail, 80))
  }

  return parts.join(', ')
}

/** One line for Hermes: the Office document in front, its selection, and what else is open; null when nothing is. */
export function describeOffice(entries: readonly OfficeEntry[], home = ''): string | null {
  if (!entries.length) {
    return null
  }

  const front = entries.find((entry) => entry.front) ?? entries[0]
  const others = entries.filter((entry) => entry !== front)
  const rest = others.length ? `; also open: ${others.slice(0, 6).map((entry) => `${entry.name} (${OFFICE_APP_NAMES[entry.app]})`).join(', ')}${others.length > 6 ? `, and ${others.length - 6} more` : ''}` : ''

  return `Office: in front is ${describeEntry(front, home)}${rest}.`
}

/** A file's name with its extension, for what Hermes says about files on disk. */
export const fileName = (file: string): string => file.split('/').pop() || file

/** A file name for a new document: a name without characters that cannot name a file, with the extension the format has. */
export function documentFileName(name: string, extension: string): string {
  const clean = name.replace(/[/\\:]/g, '-').trim() || 'Untitled'

  return clean.toLowerCase().endsWith(extension) ? clean : `${clean}${extension}`
}

/** The first of "Name.ext", "Name 2.ext", … in `folder` that `taken` says is free. */
export async function freePath(folder: string, fileName: string, taken: (path: string) => Promise<boolean>): Promise<string> {
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const extension = dot > 0 ? fileName.slice(dot) : ''

  for (let n = 1; n < 1000; n++) {
    const candidate = `${folder}/${n === 1 ? stem : `${stem} ${n}`}${extension}`

    if (!(await taken(candidate))) {
      return candidate
    }
  }

  throw new Error(`Too many files called ${baseName(fileName)} in ${folder}`)
}

/** A document's summary as a report gives it, from what a session holds. */
export function summaryOf(doc: { key: string; path: string | null; name: string; format: string; modified: boolean }, detail?: string, selection?: string): OfficeDocSummary {
  return { key: doc.key, path: doc.path, name: doc.name, format: doc.format, modified: doc.modified, ...(detail ? { detail } : {}), ...(selection ? { selection } : {}) }
}

/** A positive whole number of steps from what a caller gave (1 when left out). */
export function stepCount(value: unknown): number {
  const n = value === undefined || value === null || value === '' ? 1 : Math.round(Number(value))

  if (!Number.isFinite(n) || n < 1 || n > 100) {
    throw new Error('steps is a whole number from 1 to 100')
  }

  return n
}

/** JSON a caller sent as text (the bridge and the CLI pass objects and lists that way), or the value itself. */
export function parseJsonArg(value: unknown, name: string): unknown {
  if (typeof value !== 'string') {
    return value
  }

  const text = value.trim()

  if (!/^[[{]/.test(text)) {
    return value
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${name} is not valid JSON: ${shorten(text, 60)}`)
  }
}
