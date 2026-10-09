import { parseCell } from '../address.ts'
import type { ReadContext } from '../extras.ts'
import { parseRelationships } from '../opc.ts'
import type { XlsxPackage } from '../package.ts'
import type { Resource } from '../rules.ts'
import { decodeXml, elementsOf, firstElement } from '../xml.ts'
import { bodyOf, NOTE_RESOURCE, type NotesResource, personIdOf, THREAD_RESOURCE, type ThreadsResource, type UComment, type UNote } from './model.ts'
import { noteBoxes } from './vml.ts'

/*
 * Reading a file's notes and comment threads into Univer's resources. A thread's first comment
 * and its replies come from the sheet's threaded comments part, their authors from the workbook's
 * persons part; the notes from the sheet's comments part, but for the placeholders Excel keeps
 * there for its threads (their author is "tc={thread id}"); the notes' boxes from the VML drawing.
 */

export interface Person {
  /** A braced GUID. */
  id: string
  displayName: string
  userId?: string
  providerId?: string
}

/** Text as a part keeps it: Excel's escapes (`_x000D_`) turned back into characters, and line ends into "\n". */
const textIn = (xml: string): string => decodeXml(xml).replace(/_x([0-9A-Fa-f]{4})_/g, (_whole, code: string) => String.fromCharCode(parseInt(code, 16))).replace(/\r\n?/g, '\n')

/** The text of a rich text element (a note's `<text>`): its runs' text, without phonetic guides. */
const richText = (xml: string): string =>
  elementsOf(xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, ''), 't')
    .map((element) => textIn(element.inner))
    .join('')

/** Whether a note's runs have formatting beyond Excel's usual note font. */
const formatted = (xml: string): boolean => elementsOf(xml, 'rPr').some(({ inner }) => /<(?:\w+:)?(b|i|u|strike)\b(?![^>]*val="(0|false)")/.test(inner) || /<(?:\w+:)?color\b(?![^>]*indexed="81")[^>]*\/?>/.test(inner))

/** The workbook's people, by GUID (upper case). */
export async function readPersons(pkg: XlsxPackage): Promise<Map<string, Person>> {
  const workbookPath = parseRelationships('', await pkg.read('_rels/.rels')).find((rel) => rel.type.endsWith('/officeDocument'))?.target ?? 'xl/workbook.xml'
  const relsPath = `${workbookPath.slice(0, workbookPath.lastIndexOf('/') + 1)}_rels/${workbookPath.slice(workbookPath.lastIndexOf('/') + 1)}.rels`
  const path = parseRelationships(workbookPath, await pkg.read(relsPath)).find((rel) => rel.type.endsWith('/person'))?.target
  const xml = path ? await pkg.read(path) : undefined
  const people = new Map<string, Person>()

  for (const { attributes } of elementsOf(xml ?? '', 'person')) {
    if (attributes.id) {
      people.set(attributes.id.toUpperCase(), { id: attributes.id.toUpperCase(), displayName: attributes.displayName ?? '', ...(attributes.userId ? { userId: attributes.userId } : {}), ...(attributes.providerId ? { providerId: attributes.providerId } : {}) })
    }
  }

  return people
}

/** A person's Univer user id: the name of someone the file knows only by name, as Herald's own user is; else their GUID. */
const personIdFor = (person: Person | undefined, id: string): string => (person && (!person.providerId || person.providerId === 'None') ? personIdOf(person.userId || person.displayName) : id)

/** A time Excel wrote (UTC, often without a zone) as one the comment shows in local time. */
function univerTime(dT: string | undefined): string {
  const text = dT?.trim() ?? ''
  const time = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`)

  return Number.isNaN(time) ? text : new Date(time).toISOString()
}

/** A sheet's threads from its threaded comments part, first comments with their replies, by their cells. */
function threadsOf(xml: string, people: Map<string, Person>, unitId: string, sheetId: string, notes: Set<string>): Map<string, UComment> {
  const comments = elementsOf(xml, 'threadedComment').map(({ attributes, inner }) => ({ attributes, text: textIn(firstElement(inner, 'text')?.inner ?? ''), mentions: /<(?:\w+:)?mention\b/.test(inner) }))
  const byId = new Map(comments.map((comment) => [comment.attributes.id, comment]))
  const roots = new Map<string, UComment>()
  const rootOf = (id: string | undefined, seen = new Set<string>()): string | undefined => {
    const parent = id ? byId.get(id)?.attributes.parentId : undefined

    return parent && byId.has(parent) && !seen.has(parent) ? rootOf(parent, seen.add(parent)) : id
  }

  if (comments.some((comment) => comment.mentions)) {
    notes.add('Mentions in comments are kept as plain text.')
  }

  const read = comments
    .filter(({ attributes }) => attributes.id && parseCell(attributes.ref ?? ''))
    .map(({ attributes, text }): UComment => {
      const person = people.get(String(attributes.personId ?? '').toUpperCase())

      return {
        id: attributes.id,
        threadId: rootOf(attributes.id) ?? attributes.id,
        ref: attributes.ref,
        dT: univerTime(attributes.dT),
        personId: personIdFor(person, String(attributes.personId ?? '')),
        ...(person?.displayName ? { authorName: person.displayName } : {}),
        text: bodyOf(text),
        attachments: [],
        unitId,
        subUnitId: sheetId,
        ...(attributes.done === '1' || attributes.done === 'true' ? { resolved: true } : {})
      }
    })

  for (const comment of read.filter((entry) => entry.threadId === entry.id)) {
    roots.set(comment.id, { ...comment, children: [] })
  }

  for (const comment of read.filter((entry) => entry.threadId !== entry.id)) {
    const { resolved: _resolved, ...reply } = comment
    roots.get(comment.threadId)?.children?.push({ ...reply, ref: roots.get(comment.threadId)?.ref, parentId: comment.threadId })
  }

  return roots
}

/** The comment and note resources of a file. */
export async function readCommentResources(ctx: ReadContext): Promise<Resource[]> {
  const people = await readPersons(ctx.pkg)
  const notes: NotesResource = {}
  const threads: ThreadsResource = {}
  let formattedNotes = false

  for (const [index, sheet] of ctx.pkg.sheets.entries()) {
    const sheetId = ctx.ids[index]
    const related = (type: string) => sheet.related.find((rel) => rel.type === type)?.target

    if (!sheetId || sheet.kind !== 'worksheet') {
      continue
    }

    const threadedXml = related('threadedComment') ? await ctx.pkg.read(related('threadedComment')!) : undefined
    const roots = threadsOf(threadedXml ?? '', people, ctx.unitId, sheetId, ctx.notes)
    const legacyId = /<(?:\w+:)?legacyDrawing\b[^>]*\br:id="([^"]+)"/.exec(sheet.tail)?.[1]
    const vmlPath = sheet.related.find((rel) => rel.id === legacyId)?.target ?? related('vmlDrawing')
    const boxes = noteBoxes((vmlPath ? await ctx.pkg.read(vmlPath) : undefined) ?? '')
    const commentsXml = related('comments') ? await ctx.pkg.read(related('comments')!) : undefined
    const authors = elementsOf(firstElement(commentsXml ?? '', 'authors')?.inner ?? '', 'author').map((author) => textIn(author.inner))
    const sheetNotes: Record<string, Record<string, UNote>> = {}

    for (const { attributes, inner } of elementsOf(firstElement(commentsXml ?? '', 'commentList')?.inner ?? '', 'comment')) {
      const cell = parseCell(attributes.ref ?? '')
      const author = authors[Number(attributes.authorId)] ?? ''
      const thread = /^tc=/.test(author) ? author.slice(3) : (Object.entries(attributes).find(([key]) => /(^|:)uid$/.test(key))?.[1] ?? '')

      // A thread's placeholder: the thread itself is read from its own part.
      if (!cell || roots.has(thread)) {
        continue
      }

      const text = firstElement(inner, 'text')?.inner ?? ''
      const box = boxes.get(`${cell.row}:${cell.column}`)
      formattedNotes ||= formatted(text)
      sheetNotes[cell.row] ??= {}
      sheetNotes[cell.row][cell.column] = {
        id: `note-${index + 1}-${cell.row}-${cell.column}`,
        row: cell.row,
        col: cell.column,
        width: box?.width || 160,
        height: box?.height || 72,
        note: richText(text),
        ...(box?.shown ? { show: true } : {}),
        ...(author && !/^tc=/.test(author) ? { author } : {})
      }
    }

    if (Object.keys(sheetNotes).length) {
      notes[sheetId] = sheetNotes
    }

    if (roots.size) {
      threads[sheetId] = [...roots.values()]
    }
  }

  if (formattedNotes) {
    ctx.notes.add('Notes keep their text but not its formatting (such as the bold author name Excel starts a note with).')
  }

  return [
    ...(Object.keys(notes).length ? [{ name: NOTE_RESOURCE, data: JSON.stringify(notes) }] : []),
    ...(Object.keys(threads).length ? [{ name: THREAD_RESOURCE, data: JSON.stringify(threads) }] : [])
  ]
}
