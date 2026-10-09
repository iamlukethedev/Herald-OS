import type { Editor } from '@tiptap/core'
import type { ReactNode } from 'react'

export interface PartEditorsProps {
  editor: Editor
  docKey: string
  frame: HTMLElement | null
  desk: HTMLElement | null
  active: boolean
}

/** Headers, footers and notes edited in place on the page. */
export function PartEditors(_props: PartEditorsProps): ReactNode {
  return null
}

/** Puts what is being typed in a header, footer or note into the document, before it is read. */
export function flushPartEdits(_docKey: string): void {}
