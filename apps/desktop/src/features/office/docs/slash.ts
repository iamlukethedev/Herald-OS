import { type Editor, Extension, type Range } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion'
import { atom } from 'nanostores'
import type { CalloutKind } from '../../../../shared/office/document.ts'
import { isMac } from '../../../lib/shortcuts.ts'
import { applyLive, insertPageBreak, insertTable, setStyle } from './model.ts'

/*
 * The '/' menu: type a slash at the start of a line or after a space, then a few letters of what
 * to insert ("h2", "todo", "warn"), as in Confluence. Each item answers to its name and to the
 * words people reach for.
 */

export interface SlashItem {
  id: string
  label: string
  hint: string
  /** Words it answers to besides its label. */
  aliases: string[]
  group: 'Text' | 'Lists' | 'Insert' | 'Panels'
  run: (editor: Editor) => void
}

const callout = (kind: CalloutKind) => (editor: Editor) => {
  editor
    .chain()
    .focus()
    .wrapIn('callout', { kind })
    .run()
}

/** Pictures come from a file picker the window owns. */
export const $pickImage = atom<number>(0)

export const SLASH_ITEMS: readonly SlashItem[] = [
  { id: 'text', label: 'Text', hint: 'Plain paragraph', aliases: ['normal', 'paragraph', 'p', 'body'], group: 'Text', run: (editor) => applyLive(editor.view, setStyle('normal')) },
  { id: 'heading1', label: 'Heading 1', hint: 'Big section heading', aliases: ['h1', '#', 'heading', 'title', 'section'], group: 'Text', run: (editor) => applyLive(editor.view, setStyle('heading1')) },
  { id: 'heading2', label: 'Heading 2', hint: 'Medium heading', aliases: ['h2', '##', 'subheading', 'heading'], group: 'Text', run: (editor) => applyLive(editor.view, setStyle('heading2')) },
  { id: 'heading3', label: 'Heading 3', hint: 'Small heading', aliases: ['h3', '###', 'heading'], group: 'Text', run: (editor) => applyLive(editor.view, setStyle('heading3')) },
  { id: 'title', label: 'Title', hint: 'Document title', aliases: ['doc title', 'name'], group: 'Text', run: (editor) => applyLive(editor.view, setStyle('title')) },
  { id: 'subtitle', label: 'Subtitle', hint: 'Under the title', aliases: ['tagline', 'strapline'], group: 'Text', run: (editor) => applyLive(editor.view, setStyle('subtitle')) },
  { id: 'quote', label: 'Quote', hint: 'Quoted text', aliases: ['blockquote', 'citation', 'cite', '>'], group: 'Text', run: (editor) => applyLive(editor.view, setStyle('quote')) },
  { id: 'code', label: 'Code block', hint: 'Code in a monospace box', aliases: ['code', 'pre', 'snippet', 'source', '```'], group: 'Text', run: (editor) => editor.chain().focus().setCodeBlock().run() },
  { id: 'bullets', label: 'Bulleted list', hint: 'A simple list', aliases: ['bullet', 'ul', 'unordered', 'list', '-', '*'], group: 'Lists', run: (editor) => editor.chain().focus().toggleBulletList().run() },
  { id: 'numbers', label: 'Numbered list', hint: 'A list with numbers', aliases: ['ordered', 'ol', 'number', 'numbers', '1.'], group: 'Lists', run: (editor) => editor.chain().focus().toggleOrderedList().run() },
  { id: 'tasks', label: 'Checklist', hint: 'Items to tick off', aliases: ['todo', 'to do', 'task', 'tasks', 'checkbox', 'check', '[]'], group: 'Lists', run: (editor) => editor.chain().focus().toggleTaskList().run() },
  { id: 'table', label: 'Table', hint: 'Three by three, with a header row', aliases: ['grid', 'tbl', 'columns', 'rows', 'spreadsheet'], group: 'Insert', run: (editor) => applyLive(editor.view, insertTable({ rows: 3, cols: 3 }, 'selection')) },
  { id: 'image', label: 'Picture', hint: `From a file on this ${isMac ? 'Mac' : 'computer'}`, aliases: ['image', 'img', 'photo', 'picture', 'screenshot'], group: 'Insert', run: () => $pickImage.set($pickImage.get() + 1) },
  { id: 'divider', label: 'Divider', hint: 'A line across the page', aliases: ['hr', 'rule', 'line', 'separator', '---'], group: 'Insert', run: (editor) => editor.chain().focus().setHorizontalRule().run() },
  { id: 'pagebreak', label: 'Page break', hint: 'Start a new page', aliases: ['break', 'new page', 'newpage', 'page'], group: 'Insert', run: (editor) => applyLive(editor.view, insertPageBreak()) },
  { id: 'info', label: 'Info panel', hint: 'Blue panel', aliases: ['callout', 'panel', 'info', 'information', 'note'], group: 'Panels', run: callout('info') },
  { id: 'note', label: 'Note panel', hint: 'Purple panel', aliases: ['callout', 'panel', 'note', 'important', 'remember'], group: 'Panels', run: callout('note') },
  { id: 'success', label: 'Success panel', hint: 'Green panel', aliases: ['callout', 'panel', 'success', 'tip', 'done', 'good'], group: 'Panels', run: callout('success') },
  { id: 'warning', label: 'Warning panel', hint: 'Yellow panel', aliases: ['callout', 'panel', 'warning', 'warn', 'caution', 'alert'], group: 'Panels', run: callout('warning') },
  { id: 'error', label: 'Error panel', hint: 'Red panel', aliases: ['callout', 'panel', 'error', 'danger', 'stop', 'problem'], group: 'Panels', run: callout('error') }
]

/** The items for what was typed after the slash: names first, then words that start, then words that hold it. */
export function slashItems(query: string): SlashItem[] {
  const wanted = query.trim().toLowerCase()

  if (!wanted) {
    return [...SLASH_ITEMS]
  }

  const score = (item: SlashItem): number => {
    const label = item.label.toLowerCase()
    const words = [label, ...item.aliases]

    if (label.startsWith(wanted)) {
      return 3
    }

    if (words.some((word) => word.startsWith(wanted))) {
      return 2
    }

    return words.some((word) => word.includes(wanted)) ? 1 : 0
  }

  return SLASH_ITEMS.map((item) => ({ item, score: score(item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item)
}

export interface SlashState {
  items: SlashItem[]
  index: number
  rect: DOMRect | null
  choose: (item: SlashItem) => void
}

/** The open '/' menu, if any (one editor types at a time). */
export const $slash = atom<SlashState | null>(null)

function bridge() {
  const show = (props: SuggestionProps<SlashItem, SlashItem>, index = 0) =>
    $slash.set({ items: props.items, index: Math.min(index, Math.max(0, props.items.length - 1)), rect: props.clientRect?.() ?? null, choose: (item) => props.command(item) })

  return {
    onStart: (props: SuggestionProps<SlashItem, SlashItem>) => show(props),
    onUpdate: (props: SuggestionProps<SlashItem, SlashItem>) => show(props, $slash.get()?.index ?? 0),
    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
      const state = $slash.get()

      if (!state) {
        return false
      }

      if (event.key === 'Escape') {
        $slash.set(null)

        return true
      }

      if (!state.items.length) {
        return false
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const step = event.key === 'ArrowDown' ? 1 : -1
        $slash.set({ ...state, index: (state.index + step + state.items.length) % state.items.length })

        return true
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        state.choose(state.items[state.index])

        return true
      }

      return false
    },
    onExit: () => $slash.set(null)
  }
}

export const slashKey = new PluginKey('docsSlash')

export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: slashKey,
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        allowedPrefixes: [' ', '\t', '\u00a0'],
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)

          return $from.parent.type.name !== 'codeBlock' && !$from.marks().some((mark) => mark.type.name === 'code')
        },
        items: ({ query }) => slashItems(query),
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: SlashItem }) => {
          editor.chain().focus().deleteRange(range).run()
          props.run(editor)
        },
        render: bridge
      })
    ]
  }
})
