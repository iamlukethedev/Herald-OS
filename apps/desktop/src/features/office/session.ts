/*
 * One Office app's open documents in this window: opening, saving, watching and closing them. An
 * Office file is never replaced silently with less than it had. Before the first save over a file,
 * the person sees what Herald could not keep of it (and main backs the original up); Herald saves a
 * document by itself only after the person has saved it once, and stops when a save would lose
 * something new. A file changed on disk comes in when there are no unsaved edits here, and is a
 * question when there are.
 */

import { atom } from 'nanostores'
import { baseName, extensionOf, OFFICE_APP_NAMES, OFFICE_NOUNS, type OfficeApp, saveFormats } from '../../../shared/office/files.ts'
import type { OfficeChangedEvent, OfficeDocSummary } from '../../../shared/ipc.ts'
import { messageOf } from '../canvas/errors.ts'
import { summaryOf } from './agent-model.ts'
import { officeAbilities } from './open.ts'
import type { Conflict, EditorHandle, Notice, OfficeAdapter, OfficeDialog, OfficeDocument } from './types.ts'

const AUTOSAVE_DELAY = 1500

export { officeAbilities }

export type OfficeSession<Model> = ReturnType<typeof createSession<Model>>

/** The Office sessions loaded in this window, as Hermes's commands read them: what is open, and what is in front. */
export const loadedSessions = new Map<OfficeApp, { active: () => string | null; summaries: () => OfficeDocSummary[] }>()

export function createSession<Model>(adapter: OfficeAdapter<Model>) {
  const appName = OFFICE_APP_NAMES[adapter.app]
  const noun = OFFICE_NOUNS[adapter.app]
  const $documents = atom<OfficeDocument<Model>[]>([])
  const $activeKey = atom<string | null>(null)
  const $notice = atom<Notice | null>(null)
  const $conflict = atom<Conflict | null>(null)
  const $dialog = atom<OfficeDialog | null>(null)
  /** Per document: its watch on disk, its autosave timer, the save in flight, and how many edits it has had. */
  const tracked = new Map<string, { watchId: string | null; timer: ReturnType<typeof setTimeout> | null; saving: Promise<boolean> | null; edits: number }>()
  let untitled = 0
  let nextKey = 0

  const notify = (message: string, tone: Notice['tone'] = 'info'): void => $notice.set({ message, tone, at: Date.now() })
  const find = (key: string | null | undefined) => $documents.get().find((doc) => doc.key === key) ?? null
  const active = () => find($activeKey.get())

  /** Redraw the shell for a change to a document. */
  function touch(doc: OfficeDocument<Model>): void {
    doc.revision++
    $documents.set([...$documents.get()])
  }

  /** Each document as Hermes reads it, its detail and selection read from its editor now. */
  function summaries() {
    return $documents.get().map((doc) => summaryOf(doc, doc.editor?.detail?.(), doc.editor?.selection?.()))
  }

  function report(focused = false): void {
    window.heraldOS.office.report({ app: adapter.app, focused, active: $activeKey.get(), documents: summaries() })
  }

  async function watch(doc: OfficeDocument<Model>): Promise<void> {
    const entry = tracked.get(doc.key)

    if (!entry || !doc.path) {
      return
    }

    if (entry.watchId) {
      void window.heraldOS.office.unwatch(entry.watchId)
      entry.watchId = null
    }

    try {
      entry.watchId = await window.heraldOS.office.watch(doc.path, doc.digest)
    } catch (error) {
      notify(`Herald will not see outside changes to ${doc.name}: ${messageOf(error)}`, 'error')
    }
  }

  function add(doc: OfficeDocument<Model>): OfficeDocument<Model> {
    tracked.set(doc.key, { watchId: null, timer: null, saving: null, edits: 0 })
    $documents.set([...$documents.get(), doc])
    $activeKey.set(doc.key)
    void watch(doc)
    report(true)

    return doc
  }

  function blankDocument(name: string, model: Model, path: string | null, format: string): OfficeDocument<Model> {
    return { key: `${adapter.app}-${++nextKey}`, name, path, format, digest: null, modified: false, notes: [], layout: undefined, accepted: null, autosave: false, initial: model, editor: null, revision: 0 }
  }

  /** A new document: blank and untitled, or named and holding what Hermes started it with. */
  function create(options: { name?: string; model?: Model } = {}): OfficeDocument<Model> {
    const name = options.name?.trim() || `Untitled${++untitled > 1 ? ` ${untitled}` : ''}`

    return add(blankDocument(name, options.model ?? adapter.blank(name), null, adapter.defaultFormat))
  }

  /** Files being read, so a second request for one (a double click, Files and Hermes at once) gets the same tab. */
  const opening = new Map<string, Promise<OfficeDocument<Model>>>()

  function open(file: string): Promise<OfficeDocument<Model>> {
    const existing = $documents.get().find((doc) => doc.path === file)

    if (existing) {
      activate(existing.key)

      return Promise.resolve(existing)
    }

    const pending = opening.get(file) ?? readInto(file).finally(() => opening.delete(file))
    opening.set(file, pending)

    return pending
  }

  async function readInto(file: string): Promise<OfficeDocument<Model>> {
    const data = await window.heraldOS.office.read(file)
    const name = baseName(file)
    const result = await adapter.read(data.bytes, extensionOf(file), name)
    const doc = blankDocument(name, result.model, data.path, extensionOf(file))
    doc.digest = data.digest
    doc.notes = result.notes
    doc.layout = result.layout

    if (result.notes.length) {
      notify(`Opened ${name}: ${result.notes.length === 1 ? 'one thing is' : `${result.notes.length} things are`} shown differently. See File > What Herald changed.`)
    }

    return add(doc)
  }

  async function openPicked(): Promise<void> {
    for (const file of await window.heraldOS.office.pickOpen(adapter.app)) {
      await open(file).catch((error: unknown) => notify(`Could not open ${baseName(file)}: ${messageOf(error)}`, 'error'))
    }
  }

  function activate(key: string): void {
    if (find(key)) {
      $activeKey.set(key)
      report(true)
    }
  }

  /** A document's view has its editor: the session reads from it from now on. */
  function attach(doc: OfficeDocument<Model>, editor: EditorHandle<Model> | null): void {
    doc.editor = editor
    touch(doc)
  }

  function scheduleAutosave(doc: OfficeDocument<Model>): void {
    const entry = tracked.get(doc.key)

    if (!entry || !doc.autosave || !doc.path || !doc.modified) {
      return
    }

    if (entry.timer) {
      clearTimeout(entry.timer)
    }

    entry.timer = setTimeout(() => {
      entry.timer = null

      if (entry.saving) {
        void entry.saving.finally(() => scheduleAutosave(doc))

        return
      }

      if (doc.modified && $conflict.get()?.key !== doc.key) {
        void save(doc, { auto: true }).catch(() => {})
      }
    }, AUTOSAVE_DELAY)
  }

  /** The document's content changed (an edit here, or Hermes's). */
  function changed(doc: OfficeDocument<Model>): void {
    const entry = tracked.get(doc.key)

    if (entry) {
      entry.edits++
    }

    if (!doc.modified) {
      doc.modified = true
    }

    touch(doc)
    scheduleAutosave(doc)
  }

  function askFidelity(doc: OfficeDocument<Model>, notes: string[], losses: string[]): Promise<'replace' | 'copy' | 'cancel'> {
    return new Promise((resolve) => $dialog.set({ kind: 'fidelity', key: doc.key, notes, losses, resolve }))
  }

  /** Save a document: over its file, where the person picks (`as`), or to `to` (a path in one of the app's formats). */
  async function save(doc: OfficeDocument<Model> | null = active(), options: { as?: boolean; auto?: boolean; to?: string } = {}): Promise<boolean> {
    if (!doc) {
      return false
    }

    const entry = tracked.get(doc.key)

    if (entry?.saving) {
      await entry.saving.catch(() => false)
    }

    const saving = saveNow(doc, options)

    if (entry) {
      entry.saving = saving
    }

    try {
      return await saving
    } finally {
      if (entry) {
        entry.saving = null
      }
    }
  }

  async function saveNow(doc: OfficeDocument<Model>, options: { as?: boolean; auto?: boolean; to?: string }): Promise<boolean> {
    const savable = saveFormats(adapter.app, await officeAbilities()).map((format) => format.extension)

    if (options.to && !savable.includes(extensionOf(options.to))) {
      throw new Error(`${appName} saves ${noun}s as ${savable.join(', ')}, not ${extensionOf(options.to) || 'a file without an extension'}`)
    }

    let target = options.to ? { path: options.to, extension: extensionOf(options.to) } : doc.path && !options.as && savable.includes(doc.format) ? { path: doc.path, extension: doc.format } : null

    if (!target) {
      if (options.auto) {
        return false
      }

      if (!savable.length) {
        notify(`${appName} cannot save ${noun}s yet. Export as PDF keeps a copy.`, 'error')

        return false
      }

      target = await window.heraldOS.office.pickSave(adapter.app, doc.name, savable.includes(doc.format) ? doc.format : adapter.defaultFormat)

      if (!target) {
        return false
      }
    }

    const entry = tracked.get(doc.key)
    const edits = entry?.edits ?? 0
    await doc.editor?.settle?.()
    const model = doc.editor?.snapshot() ?? doc.initial
    const sameFile = target.path === doc.path
    const { bytes, losses } = await adapter.write(model, target.extension, target.extension === doc.format ? doc.layout : undefined)

    if (sameFile) {
      // The first save over a file shows what Herald could not keep of it; later ones only what is new.
      const first = doc.accepted === null
      const fresh = losses.filter((loss) => !doc.accepted?.has(loss))
      const notes = first ? doc.notes : []

      if (notes.length || fresh.length) {
        if (options.auto) {
          doc.autosave = false
          touch(doc)
          notify(`Herald stopped saving ${doc.name} by itself: ${fresh[0] ?? notes[0]} Save it to go on.`, 'error')

          return false
        }

        const choice = await askFidelity(doc, notes, first ? losses : fresh)

        if (choice === 'cancel') {
          return false
        }

        if (choice === 'copy') {
          return saveNow(doc, { as: true })
        }
      }
    }

    let result

    try {
      result = await window.heraldOS.office.write(target.path, bytes)
    } catch (error) {
      notify(`Could not save ${doc.name}: ${messageOf(error)}`, 'error')
      throw error
    }

    const moved = target.path !== doc.path
    doc.path = target.path
    doc.format = target.extension
    doc.name = baseName(target.path)
    doc.digest = result.digest
    doc.notes = []
    doc.accepted = new Set([...(sameFile ? (doc.accepted ?? []) : []), ...losses])
    doc.modified = (tracked.get(doc.key)?.edits ?? 0) !== edits
    doc.autosave = true
    touch(doc)

    if (moved) {
      void watch(doc)
    }

    if (!sameFile && losses.length && !options.auto) {
      $dialog.set({ kind: 'notes', title: `Saved ${doc.name}`, notes: losses })
    } else if (result.backup) {
      notify(`Saved ${doc.name}. The file as it was is in Herald's Office backups.`)
    } else if (!options.auto) {
      notify(`Saved ${doc.name}`)
    }

    report()

    return true
  }

  async function reload(doc: OfficeDocument<Model>): Promise<void> {
    if (!doc.path) {
      return
    }

    const data = await window.heraldOS.office.read(doc.path)
    const result = await adapter.read(data.bytes, extensionOf(doc.path), doc.name)
    doc.digest = data.digest
    doc.layout = result.layout
    doc.initial = result.model
    doc.modified = false

    // A version with things Herald shows differently is agreed to again before it is saved over.
    if (result.notes.length) {
      doc.notes = result.notes
      doc.accepted = null
    }

    doc.editor?.load(result.model)
    touch(doc)
    notify(`${doc.name} changed on disk: this is the new version`)
  }

  async function onChanged(event: OfficeChangedEvent): Promise<void> {
    const doc = $documents.get().find((entry) => tracked.get(entry.key)?.watchId === event.watchId)

    if (!doc || event.digest === doc.digest) {
      return
    }

    if (event.digest === null) {
      notify(`${doc.name} was moved or deleted. Save it to put it back.`, 'error')

      return
    }

    if (!doc.modified) {
      await reload(doc).catch((error: unknown) => notify(`Could not take in the change to ${doc.name}: ${messageOf(error)}`, 'error'))
    } else {
      $conflict.set({ key: doc.key, digest: event.digest })
    }
  }

  /** Settle a conflict: take the version on disk, or keep the edits here (saved over it). */
  async function resolveConflict(choice: 'theirs' | 'mine'): Promise<void> {
    const conflict = $conflict.get()
    const doc = find(conflict?.key)
    $conflict.set(null)

    if (!conflict || !doc) {
      return
    }

    if (choice === 'theirs') {
      await reload(doc)
    } else {
      doc.digest = conflict.digest
      await save(doc)
    }
  }

  function close(key: string): void {
    const entry = tracked.get(key)
    const doc = find(key)

    if (entry) {
      if (entry.watchId) {
        void window.heraldOS.office.unwatch(entry.watchId)
      }

      if (entry.timer) {
        clearTimeout(entry.timer)
      }

      tracked.delete(key)
    }

    const docs = $documents.get()
    const index = docs.findIndex((item) => item.key === key)
    const rest = docs.filter((item) => item.key !== key)
    $documents.set(rest)

    if ($activeKey.get() === key) {
      $activeKey.set(rest[Math.min(index, rest.length - 1)]?.key ?? null)
    }

    if ($conflict.get()?.key === key) {
      $conflict.set(null)
    }

    // The view unmounts with the tab; its editor goes after this frame, outside React's commit.
    if (doc?.editor) {
      const editor = doc.editor
      doc.editor = null
      setTimeout(() => editor.dispose(), 0)
    }

    report()
  }

  /** Print the document to a PDF, at `path` or where the person picks. */
  async function exportPdf(doc: OfficeDocument<Model> | null = active(), path?: string): Promise<string | null> {
    if (!doc) {
      return null
    }

    try {
      await doc.editor?.settle?.()
      const view = await adapter.print(doc.editor?.snapshot() ?? doc.initial, doc.name)
      const file = await window.heraldOS.office.exportPdf({ html: view.html, suggestedName: doc.name, landscape: view.landscape, path })

      if (file) {
        notify(`Exported ${baseName(file)}.pdf`)
      }

      return file
    } catch (error) {
      notify(`Could not export ${doc.name}: ${messageOf(error)}`, 'error')

      return null
    }
  }

  window.heraldOS.office.onChanged((event) => void onChanged(event))
  loadedSessions.set(adapter.app, { active: () => $activeKey.get(), summaries })

  return { adapter, $documents, $activeKey, $notice, $conflict, $dialog, active, find, notify, report, summaries, create, open, openPicked, activate, attach, changed, refresh: touch, save, close, resolveConflict, exportPdf }
}
