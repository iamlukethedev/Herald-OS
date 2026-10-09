import { OFFICE_APP_NAMES, OFFICE_NOUNS, type OfficeApp } from '../../../shared/office/files.ts'
import { $env } from '../../store/backend.ts'
import { type CommandContext, type CommandResult, ok, runCommand } from '../../store/os-commands.ts'
import { isMainSurface, isPanels } from '../../store/shell.ts'
import { openApp } from '../../store/windows.ts'
import { resolvePath } from '../canvas/agent-model.ts'
import { messageOf } from '../canvas/errors.ts'
import { describeOffice, findEntry, isPathLike, type OfficeEntry, officeEntries } from './agent-model.ts'
import { loadedSessions, type OfficeSession } from './session.ts'
import type { OfficeDocument } from './types.ts'

/*
 * Where Hermes's Office commands find their document, for Herald Docs, Sheets and Slides alike:
 * open in this window (the change goes into it as one step to undo, and saves as the person's own
 * edits do), open in another Office window (panels mode, where each app is its own window: the
 * command runs there), or a file on disk that is not open.
 */

export interface Outcome {
  summary: string
  data?: Record<string, unknown>
}

/** A document in this window, or a file: where a command's change can land from here. */
export type Local<Model> = { kind: 'live'; doc: OfficeDocument<Model> } | { kind: 'file'; path: string }

export type Located<Model> = Local<Model> | { kind: 'remote'; entry: OfficeEntry }

export const homeDir = (): string => $env.get()?.homeDir ?? ''

/** A full path from what Hermes or the person typed (`~/…` works). */
export const resolve = (input: string): string => resolvePath(input, homeDir())

export async function exists(file: string): Promise<boolean> {
  return (await window.heraldOS.canvas.exists(file)) === 'file'
}

/** Every open Office document, the one in front first among its window's; this window's own are read live. */
export async function openEntries(): Promise<OfficeEntry[]> {
  const presence = await window.heraldOS.office.presence().catch(() => [])
  const local = [...loadedSessions].map(([app, view]) => ({ app, active: view.active(), documents: view.summaries() }))

  return officeEntries(presence, local)
}

/** One line for Hermes about what is open in Herald Office and what is in front, or null. */
export async function officeContextLine(): Promise<string | null> {
  return describeOffice(await openEntries(), homeDir())
}

const noDocument = (app: OfficeApp): Error => new Error(`No ${OFFICE_NOUNS[app]} is open in ${OFFICE_APP_NAMES[app]}: open one (${app}.open) or start one (${app}.new)`)

/**
 * The document a command names (`ref`: a path, or an open document's name as its tab shows it) or
 * the one in front in `app`. Open in this window it is live; open elsewhere, remote; else the file.
 */
export async function locate<Model>(app: OfficeApp, session: OfficeSession<Model>, ref: unknown): Promise<Located<Model>> {
  const text = typeof ref === 'string' ? ref.trim() : ''
  const resolved = text && isPathLike(text) ? resolve(text) : null
  const entries = await openEntries()
  const entry = text ? findEntry(entries, app, text, resolved) : (entries.find((candidate) => candidate.app === app && candidate.active) ?? entries.find((candidate) => candidate.app === app) ?? null)

  if (entry) {
    const doc = session.find(entry.key)

    return doc ? { kind: 'live', doc } : { kind: 'remote', entry }
  }

  if (!text) {
    throw noDocument(app)
  }

  if (!resolved) {
    const names = entries.filter((candidate) => candidate.app === app).map((candidate) => candidate.name)

    throw new Error(`No ${OFFICE_NOUNS[app]} called “${text}” is open${names.length ? ` (open: ${names.join(', ')})` : ''}; give a file's full path (~/…) to work on a file`)
  }

  if (!(await exists(resolved))) {
    throw new Error(`There is no file at ${resolved}`)
  }

  return { kind: 'file', path: resolved }
}

/** Wait until a document's editor has mounted (its window shows it), at most `ms`. */
export async function waitForEditor<Model>(doc: OfficeDocument<Model>, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms

  while (!doc.editor && Date.now() < until) {
    await new Promise((done) => setTimeout(done, 50))
  }

  return Boolean(doc.editor)
}

/** Bring the app's window up with the document in front, and wait for its editor. */
export async function showDocument<Model>(app: OfficeApp, session: OfficeSession<Model>, doc: OfficeDocument<Model>): Promise<boolean> {
  openApp(app)
  session.activate(doc.key)

  return waitForEditor(doc)
}

/** A document closed with its window (desktop mode keeps it until Herald quits) gets its editor back before a change, so the change is one step to undo there. */
export async function withEditor<Model>(app: OfficeApp, doc: OfficeDocument<Model>): Promise<boolean> {
  if (doc.editor) {
    return true
  }

  openApp(app)

  return waitForEditor(doc)
}

/** An outcome as a command result; errors from main lose Electron's prefix, which says nothing to Hermes. */
export async function done(work: Promise<Outcome>): Promise<CommandResult> {
  try {
    const outcome = await work

    return ok(outcome.summary, { data: outcome.data })
  } catch (error) {
    throw new Error(messageOf(error))
  }
}

/**
 * Run a command where its document lives. In panels mode the Office apps are windows of their own:
 * from the Hermes window, a command on a document open in one runs in that window, so the change
 * lands live there as one step to undo. Everywhere else it runs here.
 */
export async function inOwnWindow(app: OfficeApp, command: string, args: Record<string, unknown>, ref: string, context: CommandContext, here: () => Promise<Outcome>): Promise<CommandResult> {
  if (isPanels && isMainSurface && typeof window.heraldOS?.office?.run === 'function') {
    const text = typeof args[ref] === 'string' ? String(args[ref]).trim() : ''
    const entries = await openEntries()
    const entry = text ? findEntry(entries, app, text, isPathLike(text) ? resolve(text) : null) : (entries.find((candidate) => candidate.app === app && candidate.active) ?? null)

    if (entry && !loadedSessions.get(app)?.summaries().some((doc) => doc.key === entry.key)) {
      try {
        const result = (await window.heraldOS.office.run({ app, key: entry.key }, command, args, context.source)) as CommandResult

        return result && typeof result === 'object' && 'ok' in result ? result : ok(`Ran ${command} in ${OFFICE_APP_NAMES[app]}`)
      } catch (error) {
        throw new Error(messageOf(error))
      }
    }
  }

  return done(here())
}

let relayBound = false

/** An Office window of its own (panels mode) runs the commands main hands it for its documents. */
export function bindOfficeRelay(): void {
  const office = window.heraldOS?.office

  if (relayBound || isMainSurface || typeof office?.onRunRequest !== 'function') {
    return
  }

  relayBound = true
  office.onRunRequest((request) => {
    void runCommand(request.command, request.args, { source: request.source })
      .then((result) => office.runReply({ requestId: request.requestId, result }))
      .catch((error: unknown) => office.runReply({ requestId: request.requestId, error: messageOf(error) }))
  })
}
