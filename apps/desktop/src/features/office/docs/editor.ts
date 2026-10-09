import { Editor } from '@tiptap/core'
import { Placeholder } from '@tiptap/extensions'
import type { EditorView } from '@tiptap/pm/view'
import { dataUrl, type DocJSON, IMAGE_TYPES, imageSize } from '../../../../shared/office/document.ts'
import { openWebWindow } from '../../../store/web-windows.ts'
import { FindHighlight } from './find.ts'
import { WordKeys } from './keys.ts'
import { HermesMarked } from './marked.ts'
import { applyLive, insertImage, type Place } from './model.ts'
import { revealInDesk } from './overlay.ts'
import { docsExtensions } from './schema.ts'
import { SlashCommand } from './slash.ts'
import { DocsTableView, imageView } from './views.ts'

/*
 * One document's TipTap editor: the document schema with the editor's own views, the '/' menu,
 * find, Word's keys, spelling, and pictures pasted or dropped in. A link opens with ⌘-click, in a
 * Herald web window.
 */

export interface EditorEvents {
  onUpdate: () => void
  onSelection: () => void
}

/** The picture formats a page shows (Word's EMF and WMF are not among them). */
const SHOWN = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml'])

export interface Picture {
  src: string
  width: number
  height: number
}

/** A picture from a file's bytes, at its own size scaled down to `maxWidth`. */
export function pictureFrom(bytes: Uint8Array, mime: string, maxWidth = Number.POSITIVE_INFINITY): Picture | null {
  if (!SHOWN.has(mime)) {
    return null
  }

  const size = imageSize(bytes) ?? { width: 480, height: 320 }
  const scale = Math.min(1, maxWidth / (size.width || 1))

  return { src: dataUrl(bytes, mime), width: Math.round(size.width * scale), height: Math.round(size.height * scale) }
}

export const mimeOfName = (name: string): string => IMAGE_TYPES[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''] ?? ''

/** The width the page gives text, in CSS pixels. */
export const textWidth = (view: EditorView): number => view.dom.clientWidth || 640

/** Put pictures in, at a position or the selection, as one step each. */
export async function insertPictures(view: EditorView, files: readonly { bytes: Uint8Array; mime: string }[], place: Place = 'selection'): Promise<number> {
  let count = 0

  for (const file of files) {
    const picture = pictureFrom(file.bytes, file.mime, textWidth(view))

    if (picture && applyLive(view, insertImage(picture, count ? 'selection' : place))) {
      count++
    }
  }

  return count
}

const imageFiles = (files: FileList | null | undefined): File[] => [...(files ?? [])].filter((file) => SHOWN.has(file.type))

async function fromFiles(view: EditorView, files: File[], place: Place): Promise<void> {
  const read = await Promise.all(files.map(async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type })))
  await insertPictures(view, read, place)
}

export function createDocsEditor(element: HTMLElement, content: DocJSON, events: EditorEvents): Editor {
  return new Editor({
    element,
    content,
    extensions: [
      ...docsExtensions({ views: { image: imageView, table: DocsTableView } }),
      Placeholder.configure({
        showOnlyCurrent: true,
        placeholder: ({ editor, node }) => (node.type.name === 'heading' ? 'Heading' : node.type.name !== 'paragraph' ? '' : editor.isEmpty ? 'Start writing, or type / to add a heading, list, table or picture' : 'Type / to insert')
      }),
      WordKeys,
      SlashCommand,
      FindHighlight,
      HermesMarked
    ],
    editorProps: {
      attributes: { spellcheck: 'true', 'aria-label': 'Document', 'aria-multiline': 'true', role: 'textbox' },
      handleScrollToSelection: (view) => revealInDesk(view, view.state.selection.head),
      handlePaste: (view, event) => {
        const files = imageFiles(event.clipboardData?.files)

        if (!files.length) {
          return false
        }

        void fromFiles(view, files, 'selection')

        return true
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = imageFiles(event.dataTransfer?.files)

        if (moved || !files.length) {
          return false
        }

        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
        void fromFiles(view, files, at ? { pos: at.pos } : 'selection')

        return true
      },
      handleClick: (view, pos, event) => {
        if (!(event.metaKey || event.ctrlKey)) {
          return false
        }

        const link = view.state.schema.marks.link
        const mark = view.state.doc.nodeAt(pos)?.marks.find((entry) => entry.type === link) ?? view.state.doc.resolve(pos).marks().find((entry) => entry.type === link)
        const href = mark?.attrs.href

        if (typeof href === 'string' && /^https?:/i.test(href)) {
          void openWebWindow(href)

          return true
        }

        return false
      }
    },
    onUpdate: events.onUpdate,
    onSelectionUpdate: events.onSelection
  })
}
