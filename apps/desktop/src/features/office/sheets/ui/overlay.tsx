import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import type { ReactNode } from 'react'

/*
 * Herald Sheets' own dialogs (Summarize, Validation, Names…) and its side panel (a chart's settings),
 * over and beside the sheet of the document they belong to. A feature opens one with the element to
 * show; one dialog and one panel at a time.
 */

const $dialog = atom<{ docKey: string; node: ReactNode } | null>(null)
const $panel = atom<{ docKey: string; id: string; node: ReactNode } | null>(null)

export function openDialog(docKey: string, node: ReactNode): void {
  $dialog.set({ docKey, node })
}

export function closeDialog(): void {
  $dialog.set(null)
}

/** Show a side panel; `id` names what it is for (a chart), so a second open for the same thing replaces it. */
export function openPanel(docKey: string, id: string, node: ReactNode): void {
  $panel.set({ docKey, id, node })
}

/** Close the side panel, or only the one for `id`. */
export function closePanel(id?: string): void {
  if (!id || $panel.get()?.id === id) {
    $panel.set(null)
  }
}

export const panelFor = (): string | null => $panel.get()?.id ?? null

/** The side panel of a document, beside its sheet. */
export function SheetsPanel({ docKey }: { docKey: string }) {
  const panel = useStore($panel)

  return panel?.docKey === docKey ? <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-line">{panel.node}</aside> : null
}

/** The dialog of a document, over its sheet. */
export function SheetsDialog({ docKey }: { docKey: string }) {
  const dialog = useStore($dialog)

  return dialog?.docKey === docKey ? <>{dialog.node}</> : null
}
