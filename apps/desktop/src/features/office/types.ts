import type { OfficeApp } from '../../../shared/office/files.ts'

/** A document's live editor (Univer, or Herald Slides' own), from the moment its view mounts. */
export interface EditorHandle<Model> {
  /** The document as it is now. */
  snapshot: () => Model
  /** Wait for what a change is still working out (a sheet's formula results), before a save or print takes the snapshot. */
  settle?: () => Promise<void>
  /** Show another version (one that changed on disk); history starts again from it. */
  load: (model: Model) => void
  undo: () => void
  redo: () => void
  /** What the status bar says about the document: words, cells, slides. */
  status: () => string
  /** What is in front inside it, for Hermes: the sheet and selection, the slide. */
  detail?: () => string | undefined
  /** What is selected, for Hermes: the text in a document, a range in a workbook ("Sheet1!B2:D9"), a slide. */
  selection?: () => string | undefined
  focus?: () => void
  zoom?: (step: 'in' | 'out' | 'reset') => void
  dispose: () => void
}

/** What a file read gives: the model, what reading approximated, and how to write it back the same. */
export interface ReadResult<Model> {
  model: Model
  notes: string[]
  layout?: unknown
}

export interface WriteResult {
  bytes: Uint8Array
  /** What the format cannot keep of this document. */
  losses: string[]
}

export interface PrintView {
  html: string
  landscape?: boolean
}

/** How one app reads, writes and prints its documents; the shell does the rest. */
export interface OfficeAdapter<Model> {
  app: OfficeApp
  /** The format a new document is saved in, and offered first. */
  defaultFormat: string
  blank: (name: string) => Model
  read: (bytes: Uint8Array, extension: string, name: string) => Promise<ReadResult<Model>>
  write: (model: Model, extension: string, layout: unknown) => Promise<WriteResult>
  print: (model: Model, name: string) => Promise<PrintView>
}

export interface OfficeDocument<Model> {
  readonly key: string
  name: string
  path: string | null
  /** The extension it is saved in. */
  format: string
  /** The digest of the file version this document matches: the one it loaded or last saved. */
  digest: string | null
  modified: boolean
  /** What reading the file approximated, for the fidelity report. */
  notes: string[]
  /** How the file was laid out (CSV delimiter, line endings), to write it back the same. */
  layout: unknown
  /** The person agreed that saving over the file keeps only what Herald keeps; losses they agreed to. */
  accepted: Set<string> | null
  /** Herald saves it by itself once the person has saved it in this session. */
  autosave: boolean
  /** The model it opened with, until its editor mounts. */
  initial: Model
  editor: EditorHandle<Model> | null
  /** Bumped on every change worth redrawing the shell for. */
  revision: number
}

export interface Notice {
  message: string
  tone: 'info' | 'error'
  at: number
}

/** A file changed on disk while it had unsaved edits here. */
export interface Conflict {
  key: string
  digest: string | null
}

/** Dialogs the shell shows on request. */
export type OfficeDialog =
  | { kind: 'close'; key: string }
  | { kind: 'fidelity'; key: string; notes: string[]; losses: string[]; resolve: (choice: 'replace' | 'copy' | 'cancel') => void }
  | { kind: 'notes'; title: string; notes: string[] }
