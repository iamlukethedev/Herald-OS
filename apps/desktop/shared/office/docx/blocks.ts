import { type CalloutKind, type DocNode, textNode } from '../document.ts'
import type { ListType } from './numbering.ts'

/*
 * The blocks of a Word file's text, read paragraph by paragraph, put together the way Herald Docs
 * nests them: numbered paragraphs into lists by their numbering and level, the paragraphs that
 * continue a list item into it, code lines into code blocks, and quote and callout paragraphs
 * into quotes and callouts.
 */

export interface ListMark {
  kind: 'bullet' | 'ordered' | 'task'
  depth: number
  /** The numbering the item counts in: an item in another one starts another list. */
  key: string
  /** How an ordered item's level writes its number. */
  type?: ListType | null
  /** The item's number, which gives a list its start. */
  value?: number
  checked?: boolean
}

export interface Entry {
  kind: 'text' | 'code' | 'block'
  /** A paragraph, heading, table, page break or rule. */
  node?: DocNode
  /** A line of a code block. */
  line?: string
  container?: 'quote' | CalloutKind
  list?: ListMark
  /** The paragraph style and left indent (in twips), which tell the paragraphs that continue a list item. */
  style?: string
  indent?: number
  /** A List Paragraph without a number of its own. */
  listParagraph?: boolean
  /** Part of the paragraph before: the rest of it after a page break inside it, or a text box in it. */
  attached?: boolean
}

interface OpenList {
  node: DocNode
  mark: ListMark
  indent: number
  style?: string
}

/** A list item's paragraphs are indented by the list, not by their own indents. */
function withoutIndent(node: DocNode): DocNode {
  if (!node.attrs || (node.attrs.indent === undefined && node.attrs.firstLine === undefined)) {
    return node
  }

  const attrs = Object.fromEntries(Object.entries(node.attrs).filter(([key]) => key !== 'indent' && key !== 'firstLine'))

  return Object.keys(attrs).length ? { ...node, attrs } : { type: node.type, ...(node.content ? { content: node.content } : {}) }
}

function listNode(mark: ListMark): DocNode {
  if (mark.kind !== 'ordered') {
    return { type: mark.kind === 'task' ? 'taskList' : 'bulletList', content: [] }
  }

  const attrs: Record<string, unknown> = {}

  if (mark.value !== undefined && mark.value !== 1) {
    attrs.start = mark.value
  }

  // The editor numbers a list without a type 1, 2, 3 at any depth.
  if (mark.type && mark.type !== '1') {
    attrs.type = mark.type
  }

  return Object.keys(attrs).length ? { type: 'orderedList', attrs, content: [] } : { type: 'orderedList', content: [] }
}

function itemNode(mark: ListMark, paragraph: DocNode): DocNode {
  if (mark.kind === 'task') {
    return mark.checked ? { type: 'taskItem', attrs: { checked: true }, content: [paragraph] } : { type: 'taskItem', content: [paragraph] }
  }

  return { type: 'listItem', content: [paragraph] }
}

const lastItem = (open: OpenList): DocNode => {
  const items = open.node.content ?? []

  return items[items.length - 1]
}

const sameList = (a: ListMark, b: ListMark): boolean => a.kind === b.kind && a.key === b.key

/** Lists, list items' other paragraphs and code blocks, among blocks of one container. */
function flow(entries: readonly Entry[]): DocNode[] {
  const out: DocNode[] = []
  const stack: OpenList[] = []
  const codeLines = new Map<DocNode, string[]>()
  let openCode: { block: DocNode; into: DocNode[] } | null = null

  const add = (into: DocNode[], entry: Entry, inItem: boolean): void => {
    if (entry.kind === 'code') {
      const line = entry.line ?? ''

      if (openCode?.into === into) {
        codeLines.get(openCode.block)?.push(line)
      } else {
        const block: DocNode = { type: 'codeBlock' }
        codeLines.set(block, [line])
        into.push(block)
        openCode = { block, into }
      }

      return
    }

    openCode = null

    if (entry.node) {
      into.push(inItem ? withoutIndent(entry.node) : entry.node)
    }
  }

  const placeItem = (entry: Entry, mark: ListMark): void => {
    // A list can only go one level deeper than the one it is in.
    const depth = Math.min(mark.depth, stack.length)
    stack.length = Math.min(stack.length, depth + 1)

    if (stack[depth] && !sameList(stack[depth].mark, mark)) {
      stack.length = depth
    }

    if (!stack[depth]) {
      const node = listNode(mark)

      if (depth === 0) {
        out.push(node)
      } else {
        lastItem(stack[depth - 1]).content?.push(node)
      }

      stack.push({ node, mark, indent: entry.indent ?? 0, style: entry.style })
    }

    stack[depth].node.content?.push(itemNode(mark, entry.node ?? { type: 'paragraph' }))
  }

  const continuing = (entry: Entry): number => {
    if (entry.attached) {
      return stack.length - 1
    }

    for (let level = stack.length - 1; level >= 0; level--) {
      const open = stack[level]
      const fits = entry.kind === 'code' || (entry.node?.type === 'paragraph' && (entry.listParagraph || entry.style === open.style))

      if (fits && Math.abs((entry.indent ?? 0) - open.indent) <= 20) {
        return level
      }
    }

    return -1
  }

  for (const entry of entries) {
    if (entry.list) {
      openCode = null
      placeItem(entry, entry.list)
      continue
    }

    const level = stack.length ? continuing(entry) : -1

    if (level >= 0) {
      stack.length = level + 1
      add(lastItem(stack[level]).content ?? [], entry, true)
      continue
    }

    stack.length = 0
    add(out, entry, false)
  }

  for (const [block, lines] of codeLines) {
    const text = lines.join('\n')

    if (text) {
      block.content = [textNode(text)]
    }
  }

  return out
}

/** Herald Docs blocks from the entries of a part of the file, in order. */
export function assemble(entries: readonly Entry[]): DocNode[] {
  const out: DocNode[] = []
  let start = 0

  while (start < entries.length) {
    const container = entries[start].container
    let end = start + 1

    while (end < entries.length && entries[end].container === container) {
      end++
    }

    const blocks = flow(entries.slice(start, end))

    if (container === 'quote') {
      out.push({ type: 'blockquote', content: blocks })
    } else if (container) {
      out.push(container === 'info' ? { type: 'callout', content: blocks } : { type: 'callout', attrs: { kind: container }, content: blocks })
    } else {
      for (const block of blocks) {
        out.push(block)
      }
    }

    start = end
  }

  return out
}
