import { Extension, InputRule, mergeAttributes } from '@tiptap/core'
import { Bold } from '@tiptap/extension-bold'
import { Document } from '@tiptap/extension-document'
import { HardBreak } from '@tiptap/extension-hard-break'
import { Italic } from '@tiptap/extension-italic'
import { Paragraph } from '@tiptap/extension-paragraph'
import { Strike } from '@tiptap/extension-strike'
import { Text } from '@tiptap/extension-text'
import { TextStyle } from '@tiptap/extension-text-style'
import { Underline } from '@tiptap/extension-underline'
import { UndoRedo } from '@tiptap/extensions'
import type { Node as ProseNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { ListKind, Paragraph as SlideParagraphModel, TextBody, Theme } from '../deck.ts'
import { colorOf, cssColor, fontStack, resolveFont } from '../themes.ts'
import { listMarkers, MAX_LEVEL } from '../text.ts'
import { paragraphCss, shrunk, styleText } from '../view/text-style.ts'
import { changeParagraphs, shiftLevel } from './paragraphs.ts'
import { PARAGRAPH_ATTRS, paragraphFromNode } from './rich-text.ts'

/*
 * The text editor's schema, as the slide draws text: flat paragraphs carrying their list and level
 * (as PowerPoint's do), marks for bold, italic, underline and strike, and one style mark for font,
 * size, colour and highlight that keeps theme slots and theme fonts by name. List markers come from
 * the same numbering as the slide's. Keyboard shortcuts for formatting belong to the window's
 * menus, which also format whole boxes, so the marks have none of their own.
 */

const kebab = (key: string): string => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

const NUMERIC = new Set<string>(['level', 'startAt', 'lineSpacing', 'spaceBefore', 'spaceAfter', 'margin', 'indent'])

function listFromItem(item: HTMLElement): { list: ListKind; level: number } {
  let level = -1

  for (let at: HTMLElement | null = item.parentElement; at; at = at.parentElement) {
    if (at.tagName === 'UL' || at.tagName === 'OL') {
      level++
    }
  }

  return { list: item.parentElement?.tagName === 'OL' ? 'number' : 'bullet', level: Math.max(0, Math.min(MAX_LEVEL, level)) }
}

const SlideParagraph = Paragraph.extend({
  addAttributes() {
    return Object.fromEntries(
      PARAGRAPH_ATTRS.map((key) => [
        key,
        {
          default: null,
          keepOnSplit: true,
          parseHTML: (element: HTMLElement) => {
            const value = element.getAttribute(`data-${kebab(key)}`)

            if (value === null) {
              return null
            }

            return NUMERIC.has(key) ? (Number.isFinite(Number(value)) ? Number(value) : null) : value
          },
          renderHTML: (attributes: Record<string, unknown>) => (attributes[key] === null || attributes[key] === undefined ? {} : { [`data-${kebab(key)}`]: String(attributes[key]) })
        }
      ])
    )
  },

  parseHTML() {
    return [
      { tag: 'p', getAttrs: (element: HTMLElement) => (element.parentElement?.tagName === 'LI' ? listFromItem(element.parentElement) : {}) },
      { tag: 'li', getAttrs: (element: HTMLElement) => (element.querySelector(':scope > p') ? false : listFromItem(element)) },
      ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'].map((tag) => ({ tag }))
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['p', mergeAttributes(HTMLAttributes, { class: 'hs-p' }), 0]
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => shiftLevel(this.editor, 1) || this.editor.commands.insertContent('\t'),
      'Shift-Tab': () => shiftLevel(this.editor, -1) || true,
      Enter: () => {
        const { selection } = this.editor.state
        const node = selection.$from.parent

        // Enter on an empty list item steps out of the list, a level at a time.
        if (!selection.empty || node.type.name !== 'paragraph' || node.content.size || !node.attrs.list) {
          return false
        }

        return Number(node.attrs.level ?? 0) > 0 ? shiftLevel(this.editor, -1) : changeParagraphs(this.editor, () => ({ list: null, level: null, bullet: null, numbering: null, startAt: null }))
      },
      Backspace: () => {
        const { selection } = this.editor.state
        const node = selection.$from.parent

        // Backspace at the start of a list item takes its marker away before joining lines.
        if (!selection.empty || selection.$from.parentOffset !== 0 || node.type.name !== 'paragraph' || !node.attrs.list) {
          return false
        }

        return changeParagraphs(this.editor, () => ({ list: null, level: null, bullet: null, numbering: null, startAt: null }))
      }
    }
  },

  addInputRules() {
    const listRule = (find: RegExp, kind: ListKind) =>
      new InputRule({
        find,
        handler: ({ state, range, chain }) => {
          const node = state.selection.$from.parent

          if (node.attrs.list) {
            return
          }

          chain()
            .deleteRange(range)
            .command(({ tr }) => {
              tr.setNodeMarkup(state.selection.$from.before(), undefined, { ...node.attrs, list: kind, level: node.attrs.level ?? 0 })

              return true
            })
            .run()
        }
      })

    return [listRule(/^\s*[-*•]\s$/, 'bullet'), listRule(/^\s*1[.)]\s$/, 'number')]
  }
})

const quiet = { addKeyboardShortcuts: () => ({}), addInputRules: () => [], addPasteRules: () => [] }

function cssColorToHex(value: string): string | null {
  const hex = colorOf(value)

  if (hex) {
    return hex
  }

  const rgb = /^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+%?))?\)$/.exec(value.trim())

  if (!rgb || (rgb[4] !== undefined && Number.parseFloat(rgb[4]) === 0)) {
    return null
  }

  return `#${[rgb[1], rgb[2], rgb[3]].map((part) => Math.min(255, Number(part)).toString(16).padStart(2, '0')).join('')}`
}

function cssSizeToPoints(value: string): number | null {
  const match = /^([\d.]+)(px|pt)$/.exec(value.trim())

  return match ? Math.round(Number(match[1]) * (match[2] === 'px' ? 0.75 : 1) * 10) / 10 : null
}

const firstFamily = (value: string): string | null =>
  value
    .split(',')[0]
    ?.replace(/["']/g, '')
    .trim() || null

/** The style mark's attributes: theme slots and theme fonts by name, drawn in the deck's theme. */
const RunStyle = Extension.create<{ theme: Theme | null }>({
  name: 'heraldRunStyle',

  addOptions() {
    return { theme: null }
  },

  addGlobalAttributes() {
    const theme = this.options.theme

    if (!theme) {
      return []
    }

    return [
      {
        types: ['textStyle'],
        attributes: {
          font: {
            default: null,
            parseHTML: (element: HTMLElement) => element.dataset.font || firstFamily(element.style.fontFamily),
            renderHTML: (attributes: Record<string, unknown>) => (attributes.font ? { 'data-font': String(attributes.font), style: `font-family: ${fontStack(resolveFont(String(attributes.font), theme))}` } : {})
          },
          size: {
            default: null,
            parseHTML: (element: HTMLElement) => (element.dataset.size ? Number(element.dataset.size) || null : cssSizeToPoints(element.style.fontSize)),
            renderHTML: (attributes: Record<string, unknown>) => (attributes.size ? { 'data-size': String(attributes.size), style: `font-size: ${shrunk(Number(attributes.size))}` } : {})
          },
          color: {
            default: null,
            parseHTML: (element: HTMLElement) => colorOf(element.dataset.color) ?? cssColorToHex(element.style.color),
            renderHTML: (attributes: Record<string, unknown>) => {
              const color = colorOf(attributes.color)

              return color ? { 'data-color': color, style: `color: ${cssColor(color, theme)}` } : {}
            }
          },
          highlight: {
            default: null,
            parseHTML: (element: HTMLElement) => colorOf(element.dataset.highlight) ?? cssColorToHex(element.style.backgroundColor),
            renderHTML: (attributes: Record<string, unknown>) => {
              const color = colorOf(attributes.highlight)

              return color ? { 'data-highlight': color, style: `background-color: ${cssColor(color, theme)}` } : {}
            }
          }
        }
      }
    ]
  }
})

/** Each paragraph drawn as the slide draws it: its marker, indents, spacing and the font of its first run. */
function paragraphLook(theme: Theme, body: TextBody): Plugin {
  const cache = new WeakMap<ProseNode, DecorationSet>()

  return new Plugin({
    key: new PluginKey('heraldSlideParagraphs'),
    props: {
      decorations(state) {
        const known = cache.get(state.doc)

        if (known) {
          return known
        }

        const found: { from: number; to: number; paragraph: SlideParagraphModel }[] = []
        state.doc.forEach((node, offset) => {
          if (node.type.name === 'paragraph') {
            found.push({ from: offset, to: offset + node.nodeSize, paragraph: paragraphFromNode(node.toJSON(), body) })
          }
        })
        const markers = listMarkers(found.map((entry) => entry.paragraph))
        const set = DecorationSet.create(
          state.doc,
          found.map((entry, index) => Decoration.node(entry.from, entry.to, { style: styleText(paragraphCss(entry.paragraph, body, theme, markers[index])), ...(markers[index] ? { 'data-marker': markers[index] } : {}) }))
        )
        cache.set(state.doc, set)

        return set
      }
    }
  })
}

/** Everything a slide's text editor is made of, for one text body in one theme. */
export function slideTextExtensions(theme: Theme, body: TextBody) {
  return [
    Document,
    Text,
    SlideParagraph,
    HardBreak.configure({ keepMarks: true }),
    Bold.extend(quiet),
    Italic.extend(quiet),
    Underline.extend(quiet),
    Strike.extend(quiet),
    TextStyle,
    RunStyle.configure({ theme }),
    UndoRedo.configure({ depth: 200 }),
    Extension.create({ name: 'heraldSlideParagraphs', addProseMirrorPlugins: () => [paragraphLook(theme, body)] })
  ]
}
