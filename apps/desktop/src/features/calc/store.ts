import { atom } from 'nanostores'
import type { CalcContext, DocumentResult } from './engine/types.ts'
import type { GraphEntry, GraphSeries } from './graph/types.ts'
import { type CalcRequest, type CalcView, createRequestGate } from './requests.ts'

/** A request for the Calc window in this renderer (desktop mode); panels mode sends it as the window's payload. */
export const $calcRequest = atom<CalcRequest | null>(null)

/** Passes each request once for this renderer, however many times and ways it arrives. */
export const takeCalcRequest = createRequestGate()

/** The view in front. */
export const $calcView = atom<CalcView>('notes')

export interface CalcGraph {
  /** The Graph view's own list: what a request drew, then the person's edits, kept for the session. */
  entries: GraphEntry[]
  series: GraphSeries[]
  xMin?: number
  xMax?: number
  /** Counts the requests drawn; a new one starts the view afresh. */
  version: number
}

export const $calcGraph = atom<CalcGraph>({ entries: [], series: [], version: 0 })

/** The History view's search. */
export const $historyQuery = atom('')

/** The notes list beside the editor; 'auto' shows it when the window is wide enough. */
export const $notesSidebar = atom<'auto' | 'open' | 'closed'>('auto')

export interface NotepadSignal {
  /** new: a note with `text` (blank for New note). insert: `text` as a line at the end of the open note. */
  kind: 'new' | 'insert'
  text: string
  /** The person asked, so the editor takes the keyboard; a request from elsewhere never does. */
  focus: boolean
  id: number
}

/** Something for the notepad to do; it clears the signal once done. */
export const $notepadSignal = atom<NotepadSignal | null>(null)

let signals = 0

export function signalNotepad(kind: NotepadSignal['kind'], text: string, focus: boolean): void {
  $notepadSignal.set({ kind, text, focus, id: ++signals })
}

export interface OpenNote {
  title: string
  text: string
  /** The last answer from the engine, and the text it answered. */
  document: DocumentResult | null
  documentText: string | null
  context: CalcContext | null
}

/** The note in the editor, for the header's Copy to Sheets and Copy to Docs. */
export const $openNote = atom<OpenNote>({ title: '', text: '', document: null, documentText: null, context: null })

/** The numbers the open note names ("budget = 1,200"), for functions in the Graph view that use them. */
export const $noteScope = atom<Record<string, number>>({})
