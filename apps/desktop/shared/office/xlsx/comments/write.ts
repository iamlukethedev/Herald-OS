import { cellName, parseCell } from '../address.ts'
import { type FinishContext, withRelationshipNamespace } from '../finish.ts'
import { CONTENT_TYPE, hasElement, placeInWorksheet, REL } from '../opc.ts'
import { readResource } from '../rules.ts'
import { encodeXml } from '../xml.ts'
import { dateOfComment, isFormatted, nameOfPersonId, NOTE_RESOURCE, type NotesResource, plainTextOf, THREAD_RESOURCE, type ThreadsResource, type UComment, type UNote } from './model.ts'
import { type Person, readPersons } from './read.ts'
import { type NoteBox, vmlDrawing } from './vml.ts'

/*
 * Writing a workbook's notes and comment threads as Excel keeps them. Notes go into the sheet's
 * comments part with their authors, plain text, and a box each in its VML drawing. Each thread
 * goes into the sheet's threaded comments part (replies name their thread by parentId, done="1"
 * when resolved), its people into the workbook's persons part, and Excel's placeholder for older
 * versions into the comments part: a note whose author is "tc={thread id}" and whose text has the
 * thread, with its box.
 */

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const THREADED = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments'
const GUID = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/i
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/** A braced GUID made from `seed` (the same seed, the same GUID), as Excel ids its comments and people. */
export function guidOf(seed: string): string {
  const hex = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((start) => {
      let hash = start

      for (let i = 0; i < seed.length; i++) {
        hash = Math.imul(hash ^ seed.charCodeAt(i), 0x01000193)
      }

      hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b)
      hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35)

      return ((hash ^ (hash >>> 16)) >>> 0).toString(16).padStart(8, '0')
    })
    .join('')
    .toUpperCase()

  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`
}

/** Text for a part: characters XML cannot hold as Excel escapes them (`_x0001_`), and text that looks like such an escape escaped itself. */
export const fileText = (text: string): string =>
  encodeXml(text.replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, (char) => `_x${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`))

/** A comment's time as Excel writes it: UTC, to a hundredth of a second, without a zone. */
function excelTime(dT: string): string | null {
  const date = dateOfComment(dT)

  return date ? date.toISOString().slice(0, 22) : null
}

/** The text older versions of Excel show for a thread, as a note. */
function placeholderText(comments: { text: string }[]): string {
  const indented = (text: string) => text.split('\n').map((line) => `    ${line}`).join('\n')
  const lines = comments.map((comment, index) => `${index ? 'Reply' : 'Comment'}:\n${indented(comment.text)}`)

  return `[Threaded comment]\n\nThis comment thread shows as a note in versions of Excel without threaded comments; changes made to it there are not kept in newer versions.\n\n${lines.join('\n')}`
}

interface LegacyNote {
  row: number
  col: number
  author: string
  text: string
  box: NoteBox
  uid?: string
}

/** The people a workbook's threads name, each with a GUID: kept from the file it was opened from where it had them. */
class People {
  private readonly people = new Map<string, Person>()

  constructor(private readonly known: Map<string, Person>) {}

  of(comment: UComment): Person {
    const id = comment.personId ?? ''
    const own = GUID.test(id) ? this.known.get(id.toUpperCase()) : undefined
    const name = comment.authorName || own?.displayName || nameOfPersonId(id) || id || 'Unknown'
    const person: Person = own ?? { id: GUID.test(id) ? id.toUpperCase() : guidOf(`person:${id}`), displayName: name, userId: nameOfPersonId(id) ?? name, providerId: 'None' }

    if (!this.people.has(person.id)) {
      this.people.set(person.id, person)
    }

    return person
  }

  list(): Person[] {
    return [...this.people.values()]
  }
}

const notesOf = (resource: NotesResource, sheetId: string): UNote[] => Object.values(resource[sheetId] ?? {}).flatMap((row) => Object.values(row ?? {}))

/** Add the workbook's notes and comment threads to the package being finished. */
export async function writeComments(ctx: FinishContext): Promise<void> {
  const notes = readResource<NotesResource>(ctx.workbook.resources, NOTE_RESOURCE) ?? {}
  const threads = readResource<ThreadsResource>(ctx.workbook.resources, THREAD_RESOURCE) ?? {}
  const people = new People(ctx.source ? await readPersons(ctx.source.pkg) : new Map())
  const ids = new Set<string>()
  // A GUID used once already gets another, as two comments cannot share one.
  const idOf = (id: string): string => {
    let guid = GUID.test(id) ? id.toUpperCase() : guidOf(`comment:${id}`)

    for (let n = 1; ids.has(guid); n++) {
      guid = guidOf(`comment:${id}:${n}`)
    }

    ids.add(guid)

    return guid
  }
  let block = 1

  for (const sheet of ctx.sheets) {
    const sheetThreads = (threads[sheet.id] ?? []).filter((root) => {
      const onCell = Boolean(parseCell(root?.ref ?? ''))

      if (root && !onCell) {
        ctx.losses.add('Comments on charts and pictures are not saved: Excel has comments on cells only.')
      }

      return onCell
    })
    const sheetNotes = notesOf(notes, sheet.id).filter((note) => Number.isInteger(note?.row) && Number.isInteger(note?.col) && note.note)

    if (!sheetThreads.length && !sheetNotes.length) {
      continue
    }

    const sheetXml = await ctx.writer.text(sheet.path)

    if (!sheetXml || hasElement(sheetXml, 'legacyDrawing')) {
      ctx.losses.add(`The notes and comments of ${sheet.name} are not saved.`)
      continue
    }

    // Excel has one thread to a cell: a second one's comments join the first as replies.
    const byCell = new Map<string, UComment[]>()

    for (const root of sheetThreads) {
      const cell = parseCell(root.ref!)!
      const key = `${cell.row}:${cell.column}`
      const comments = [root, ...(root.children ?? [])]

      if (byCell.has(key)) {
        ctx.losses.add('A cell with more than one comment thread is saved with one, the later threads’ comments as its replies.')
      }

      byCell.set(key, [...(byCell.get(key) ?? []), ...comments])
    }

    if ([...byCell.values()].flat().some((comment) => isFormatted(comment.text))) {
      ctx.losses.add('Comments keep their text but not its formatting.')
    }

    const legacy: LegacyNote[] = []
    const threaded: string[] = []

    for (const [key, comments] of byCell) {
      const [row, col] = key.split(':').map(Number)
      const ref = cellName(row, col)
      const [root, ...replies] = comments
      const rootId = idOf(root.id)
      const entries = [root, ...replies.sort((a, b) => (dateOfComment(a.dT)?.getTime() ?? 0) - (dateOfComment(b.dT)?.getTime() ?? 0))].map((comment, index) => ({ comment, id: index ? idOf(comment.id) : rootId, text: plainTextOf(comment.text) }))

      for (const { comment, id, text } of entries) {
        const time = excelTime(comment.dT)
        const parent = id === rootId ? '' : ` parentId="${rootId}"`
        const done = id === rootId && root.resolved ? ' done="1"' : ''
        threaded.push(`<threadedComment ref="${ref}"${time ? ` dT="${time}"` : ''} personId="${people.of(comment).id}" id="${id}"${parent}${done}><text>${fileText(text)}</text></threadedComment>`)
      }

      legacy.push({ row, col, author: `tc=${rootId}`, text: placeholderText(entries), uid: rootId, box: { row, col, width: 144, height: 79, shown: false } })
    }

    for (const note of sheetNotes) {
      if (byCell.has(`${note.row}:${note.col}`)) {
        ctx.losses.add('A note on a cell that also has a comment thread is not saved: Excel keeps one or the other.')
        continue
      }

      legacy.push({ row: note.row, col: note.col, author: note.author ?? '', text: note.note, box: { row: note.row, col: note.col, width: note.width || 160, height: note.height || 72, shown: Boolean(note.show) } })
    }

    legacy.sort((a, b) => a.row - b.row || a.col - b.col)
    const authors = [...new Set(legacy.map((note) => note.author))]
    const list = legacy.map((note) => `<comment ref="${cellName(note.row, note.col)}" authorId="${authors.indexOf(note.author)}" shapeId="0"${note.uid ? ` xr:uid="${note.uid}"` : ''}><text><t xml:space="preserve">${fileText(note.text)}</t></text></comment>`)
    const commentsPath = ctx.writer.freshName((n) => `xl/comments${n}.xml`)
    await ctx.writer.put(
      commentsPath,
      `${DECLARATION}<comments xmlns="${MAIN}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="xr" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision"><authors>${authors.map((author) => `<author>${fileText(author)}</author>`).join('')}</authors><commentList>${list.join('')}</commentList></comments>`,
      CONTENT_TYPE.comments
    )
    const vmlPath = ctx.writer.freshName((n) => `xl/drawings/vmlDrawing${n}.vml`)
    const vml = vmlDrawing(ctx.workbook.sheets[sheet.id], legacy.map((note) => note.box), block)
    block += vml.blocks
    await ctx.writer.put(vmlPath, vml.xml)
    await ctx.writer.setDefault('vml', CONTENT_TYPE.vml)
    await ctx.writer.relate(sheet.path, REL.comments, commentsPath)
    const drawingId = await ctx.writer.relate(sheet.path, REL.vmlDrawing, vmlPath)

    if (threaded.length) {
      const threadedPath = ctx.writer.freshName((n) => `xl/threadedComments/threadedComment${n}.xml`)
      await ctx.writer.put(threadedPath, `${DECLARATION}<ThreadedComments xmlns="${THREADED}" xmlns:x="${MAIN}">${threaded.join('')}</ThreadedComments>`, CONTENT_TYPE.threadedComments)
      await ctx.writer.relate(sheet.path, REL.threadedComment, threadedPath)
    }

    await ctx.writer.put(sheet.path, placeInWorksheet(withRelationshipNamespace(sheetXml), 'legacyDrawing', `<legacyDrawing r:id="${drawingId}"/>`))
  }

  const persons = people.list()

  if (persons.length) {
    const path = ctx.writer.has('xl/persons/person.xml') ? ctx.writer.freshName((n) => `xl/persons/person${n}.xml`) : 'xl/persons/person.xml'
    const entries = persons.map((person) => `<person displayName="${encodeXml(person.displayName)}" id="${person.id}"${person.userId ? ` userId="${encodeXml(person.userId)}"` : ''}${person.providerId ? ` providerId="${encodeXml(person.providerId)}"` : ''}/>`)
    await ctx.writer.put(path, `${DECLARATION}<personList xmlns="${THREADED}" xmlns:x="${MAIN}">${entries.join('')}</personList>`, CONTENT_TYPE.persons)
    await ctx.writer.relate('xl/workbook.xml', REL.person, path)
  }
}
