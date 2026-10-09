import { type CommentReply, type CommentThread, type DocNode, walk } from '../document.ts'
import { type Relationship, relationshipKind, type WordPackage } from './package.ts'
import { isOn } from './styles.ts'
import { attr, children, findAll, textOf, type XmlElement } from './xml.ts'

/*
 * Review comments in Word files. comments.xml holds each comment: its author, initials, date and
 * text; commentsExtended.xml says which comments answer which (by the id of each comment's last
 * paragraph) and which threads are resolved. Herald keeps a thread for each comment that answers
 * none, with the comments that answer it, directly or not, as its replies in order.
 */

export interface CommentsRead {
  threads: CommentThread[]
  /** The thread each comment is in, by the comment's id: a thread's first comment is its own. */
  threadOf: Map<string, string>
}

/** A comment's text: its paragraphs' text on lines of their own, without deleted text or field codes. */
function plainText(element: XmlElement): string {
  let out = ''

  for (const node of children(element)) {
    if (node.name === 'w:t') {
      out += textOf(node)
    } else if (node.name === 'w:tab') {
      out += '\t'
    } else if (node.name === 'w:br' || node.name === 'w:cr') {
      out += '\n'
    } else if (!['w:del', 'w:moveFrom', 'w:instrText', 'w:delText', 'w:rPr', 'w:pPr'].includes(node.name)) {
      out += plainText(node)
    }
  }

  return out
}

/** A date as an ISO string; Word writes UTC dates, some without saying so. */
function isoDate(value: string | undefined): string | null {
  const time = value ? Date.parse(/([zZ]|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`) : Number.NaN

  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/** The comments of a Word file, as threads with their replies. */
export async function readComments(pkg: WordPackage, relationships: Map<string, Relationship>): Promise<CommentsRead> {
  const partOf = (kind: string): Promise<XmlElement | null> => {
    const target = [...relationships.values()].find((item) => !item.external && relationshipKind(item) === kind)?.target

    return target ? pkg.xml(target) : Promise.resolve(null)
  }
  const [comments, extended] = await Promise.all([partOf('comments'), partOf('commentsExtended')])
  const answers = new Map(children(extended ?? undefined, 'w15:commentEx').map((item) => [attr(item, 'w15:paraId'), { parent: attr(item, 'w15:paraIdParent'), done: isOn(attr(item, 'w15:done')) }]))
  const read = children(comments ?? undefined, 'w:comment').map((element) => {
    const paragraphs = findAll(element, 'w:p')
    const initials = attr(element, 'w:initials')
    const reply: CommentReply = { id: attr(element, 'w:id') ?? '', author: attr(element, 'w:author') ?? '', ...(initials ? { initials } : {}), date: isoDate(attr(element, 'w:date')), text: paragraphs.map(plainText).join('\n') }

    return { reply, paraId: attr(paragraphs[paragraphs.length - 1], 'w14:paraId') }
  })
  const byParagraph = new Map(read.filter((item) => item.paraId).map((item) => [item.paraId, item]))

  const rootOf = (item: (typeof read)[number]): (typeof read)[number] => {
    let current = item
    const seen = new Set([item])

    for (let parent = byParagraph.get(answers.get(current.paraId)?.parent); parent && !seen.has(parent); parent = byParagraph.get(answers.get(current.paraId)?.parent)) {
      seen.add(parent)
      current = parent
    }

    return current
  }

  const threads = new Map<string, CommentThread>()
  const threadOf = new Map<string, string>()

  for (const item of read) {
    const root = rootOf(item)
    threadOf.set(item.reply.id, root.reply.id)

    if (root === item) {
      threads.set(item.reply.id, { ...item.reply, ...(answers.get(item.paraId)?.done ? { resolved: true } : {}) })
    }
  }

  for (const item of read) {
    const thread = threads.get(threadOf.get(item.reply.id) ?? '')

    if (thread && thread.id !== item.reply.id) {
      thread.replies = [...(thread.replies ?? []), item.reply]
    }
  }

  return { threads: [...threads.values()], threadOf }
}

/** For each comment on the text of some blocks, the first and the last node it is on, in order; notes' text is their own. */
export function commentSpans(blocks: readonly DocNode[]): Map<string, { first: DocNode; last: DocNode }> {
  const spans = new Map<string, { first: DocNode; last: DocNode }>()

  for (const block of blocks) {
    walk(block, (node) => {
      for (const mark of node.marks ?? []) {
        const id = mark.type === 'comment' && typeof mark.attrs?.id === 'string' ? mark.attrs.id : null

        if (id) {
          const span = spans.get(id)
          spans.set(id, { first: span?.first ?? node, last: node })
        }
      }
    })
  }

  return spans
}
