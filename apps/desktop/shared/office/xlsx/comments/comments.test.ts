import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { CELL_TYPE, newSheet, newWorkbook, type WorkbookSnapshot } from '../../workbook.ts'
import { workbookFromXlsx } from '../read.ts'
import { readResource } from '../rules.ts'
import { xlsxFromWorkbook } from '../write.ts'
import { hasOpenpyxl, hasXmllint, malformedParts, openpyxl } from './checks.ts'
import { excelNotes, excelThreads, RESOLVED, REPLY, ROBIN, THREAD } from './fixtures.ts'
import { bodyOf, NOTE_RESOURCE, type NotesResource, personIdOf, plainTextOf, THREAD_RESOURCE, type ThreadsResource, timeOfComment, type UComment } from './model.ts'

const PAT = personIdOf('Pat Example')
const SAMPLE = personIdOf('Sam Sample')

const comment = (id: string, text: string, dT: string, author: 'Pat Example' | 'Sam Sample', extra: Partial<UComment> = {}): UComment => ({ id, threadId: extra.threadId ?? id, ref: 'D2', dT, personId: author === 'Pat Example' ? PAT : SAMPLE, authorName: author, text: bodyOf(text), unitId: 'book', subUnitId: 's1', ...extra })

/** A workbook with notes and threads as Univer saves them. */
function annotated(): WorkbookSnapshot {
  const notes: NotesResource = {
    s1: {
      1: { 1: { id: 'n1', row: 1, col: 1, width: 200, height: 96, note: 'Two lines\nof note & “quotes”', author: 'Pat Example', show: true } },
      4: { 2: { id: 'n2', row: 4, col: 2, width: 160, height: 72, note: 'No author _x0041_ here' } }
    },
    s2: { 0: { 0: { id: 'n3', row: 0, col: 0, width: 160, height: 72, note: 'On the second sheet', author: 'Sam Sample' } } }
  }
  const threads: ThreadsResource = {
    s1: [
      { ...comment('t1', 'Is rent right?\nIt went up.', '2026/10/09 14:30', 'Pat Example'), children: [comment('r1', 'Yes, from March.', '2026/10/09 15:05', 'Sam Sample', { threadId: 't1', parentId: 't1' }), comment('r2', 'Thanks', '2026/10/10 09:00', 'Pat Example', { threadId: 't1', parentId: 't1' })] },
      { ...comment('t2', 'Done', '2026/10/08 08:00', 'Sam Sample', { ref: 'E3' }), resolved: true, children: [] }
    ]
  }
  const book = newWorkbook('book', 'Book', [newSheet('s1', 'Notes', { 0: { 0: { v: 'Item', t: CELL_TYPE.string } } }), newSheet('s2', 'Second sheet')])

  return { ...book, resources: [{ name: NOTE_RESOURCE, data: JSON.stringify(notes) }, { name: THREAD_RESOURCE, data: JSON.stringify(threads) }] }
}

const part = async (bytes: Uint8Array, path: string): Promise<string> => (await (await JSZip.loadAsync(bytes)).file(path)?.async('string')) ?? ''

describe('notes and comment threads in .xlsx files', () => {
  it('writes notes as Excel notes and threads as Excel’s threaded comments, with the parts that tie them in', async () => {
    const { bytes, losses } = await xlsxFromWorkbook(annotated())
    const files = Object.keys((await JSZip.loadAsync(bytes)).files)
    const types = await part(bytes, '[Content_Types].xml')
    const sheet = await part(bytes, 'xl/worksheets/sheet1.xml')
    const rels = await part(bytes, 'xl/worksheets/_rels/sheet1.xml.rels')
    const legacy = await part(bytes, 'xl/comments1.xml')
    const threaded = await part(bytes, 'xl/threadedComments/threadedComment1.xml')

    expect(losses).toEqual([])
    expect(files).toEqual(expect.arrayContaining(['xl/comments1.xml', 'xl/comments2.xml', 'xl/drawings/vmlDrawing1.vml', 'xl/drawings/vmlDrawing2.vml', 'xl/threadedComments/threadedComment1.xml', 'xl/persons/person.xml']))
    expect(files).not.toContain('xl/threadedComments/threadedComment2.xml')
    expect(types).toContain('<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>')
    expect(types).toContain('<Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>')
    expect(types).toContain('<Override PartName="/xl/threadedComments/threadedComment1.xml" ContentType="application/vnd.ms-excel.threadedcomments+xml"/>')
    expect(types).toContain('<Override PartName="/xl/persons/person.xml" ContentType="application/vnd.ms-excel.person+xml"/>')
    expect(await part(bytes, 'xl/_rels/workbook.xml.rels')).toContain('Type="http://schemas.microsoft.com/office/2017/10/relationships/person" Target="persons/person.xml"')
    expect(rels).toContain('Target="../comments1.xml"')
    expect(rels).toContain('Target="../threadedComments/threadedComment1.xml"')
    const drawingId = /Id="(rId\d+)" Type="[^"]+\/vmlDrawing" Target="..\/drawings\/vmlDrawing1.vml"/.exec(rels)?.[1]
    expect(sheet).toContain(`<legacyDrawing r:id="${drawingId}"/>`)
    expect(sheet.indexOf('<legacyDrawing')).toBeGreaterThan(sheet.indexOf('<pageMargins'))

    // Each thread's placeholder note names it as its author, with its whole text.
    const [rootId, resolvedId] = [...threaded.matchAll(/<threadedComment ref="(D2|E3)"[^>]* id="(\{[^}]+\})"(?! parentId)/g)].map((match) => match[2])
    expect(legacy).toContain(`<authors><author>Pat Example</author><author>tc=${rootId}</author><author>tc=${resolvedId}</author><author></author></authors>`)
    expect(legacy).toMatch(new RegExp(`<comment ref="D2" authorId="1" shapeId="0" xr:uid="\\${rootId.slice(0, -1)}\\}"><text><t xml:space="preserve">\\[Threaded comment\\][\\s\\S]*Comment:\\n    Is rent right\\?\\n    It went up\\.\\nReply:\\n    Yes, from March\\.\\nReply:\\n    Thanks</t>`))
    expect(legacy).toContain('<t xml:space="preserve">Two lines\nof note &amp; “quotes”</t>')
    expect(legacy).toContain('No author _x005F_x0041_ here')
    expect(threaded).toMatch(new RegExp(`<threadedComment ref="D2" dT="\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:00\\.00" personId="(\\{[0-9A-F-]+\\})" id="\\${rootId.slice(0, -1)}\\}"><text>Is rent right\\?\nIt went up\\.</text></threadedComment>`))
    expect(threaded).toContain(`parentId="${rootId}"><text>Yes, from March.</text>`)
    expect(threaded).toMatch(/<threadedComment ref="E3"[^>]* done="1"><text>Done<\/text>/)
    expect(await part(bytes, 'xl/persons/person.xml')).toMatch(/<person displayName="Pat Example" id="\{[0-9A-F-]+\}" userId="Pat Example" providerId="None"\/><person displayName="Sam Sample" id="\{[0-9A-F-]+\}" userId="Sam Sample" providerId="None"\/>/)
    const vml = await part(bytes, 'xl/drawings/vmlDrawing1.vml')
    expect(vml).toContain('<o:idmap v:ext="edit" data="1"/>')
    expect(vml).toMatch(/<v:shape id="_x0000_s1025"[^>]*width:150pt;height:72pt;z-index:1;visibility:visible"[\s\S]*?<x:Row>1<\/x:Row><x:Column>1<\/x:Column><x:Visible\/>/)
    expect(await part(bytes, 'xl/drawings/vmlDrawing2.vml')).toMatch(/<o:idmap v:ext="edit" data="2"\/>[\s\S]*<v:shape id="_x0000_s2049"[^>]*margin-left:59.25pt;margin-top:1.5pt;width:120pt;height:54pt[\s\S]*<x:Anchor>1, 15, 0, 2, 3, 47, 3, 14<\/x:Anchor>/)
  })

  it('reads back what it wrote: notes with their authors, boxes and text; threads with replies, people, times and whether resolved', async () => {
    const { bytes } = await xlsxFromWorkbook(annotated())
    const { workbook, notes: fidelity } = await workbookFromXlsx(bytes, { id: 'again', name: 'Again' })
    const notes = readResource<NotesResource>(workbook.resources, NOTE_RESOURCE)!
    const threads = readResource<ThreadsResource>(workbook.resources, THREAD_RESOURCE)!

    expect(fidelity.filter((note) => /^(Notes keep|Mentions)/.test(note))).toEqual([])
    expect(notes['sheet-1'][1][1]).toMatchObject({ row: 1, col: 1, width: 200, height: 96, note: 'Two lines\nof note & “quotes”', author: 'Pat Example', show: true })
    expect(notes['sheet-1'][4][2]).toMatchObject({ note: 'No author _x0041_ here', width: 160, height: 72 })
    expect(notes['sheet-1'][4][2].author).toBeUndefined()
    expect(notes['sheet-2'][0][0]).toMatchObject({ note: 'On the second sheet', author: 'Sam Sample' })
    const [root, resolved] = threads['sheet-1']

    expect(root).toMatchObject({ ref: 'D2', personId: PAT, authorName: 'Pat Example', unitId: 'again', subUnitId: 'sheet-1' })
    expect(root.id).toMatch(/^\{[0-9A-F-]{36}\}$/)
    expect(root.threadId).toBe(root.id)
    expect(plainTextOf(root.text)).toBe('Is rent right?\nIt went up.')
    expect(timeOfComment(root.dT)).toBe('2026-10-09 14:30')
    expect(root.children!.map((child) => [plainTextOf(child.text), child.authorName, child.personId, child.parentId === root.id, child.threadId === root.id, timeOfComment(child.dT)])).toEqual([
      ['Yes, from March.', 'Sam Sample', SAMPLE, true, true, '2026-10-09 15:05'],
      ['Thanks', 'Pat Example', PAT, true, true, '2026-10-10 09:00']
    ])
    expect(resolved).toMatchObject({ ref: 'E3', resolved: true, authorName: 'Sam Sample', children: [] })
    expect(threads['sheet-2']).toBeUndefined()

    // A file saved again keeps its comments' ids and people.
    const again = await xlsxFromWorkbook(workbook, { original: bytes })
    expect(await part(again.bytes, 'xl/threadedComments/threadedComment1.xml')).toBe(await part(bytes, 'xl/threadedComments/threadedComment1.xml'))
    expect(await part(again.bytes, 'xl/persons/person.xml')).toBe(await part(bytes, 'xl/persons/person.xml'))
  })

  it('writes files other readers open: openpyxl reads the notes and the threads’ placeholders, and every part is well formed', async () => {
    const { bytes } = await xlsxFromWorkbook(annotated())

    if (hasXmllint()) {
      expect(await malformedParts(bytes)).toEqual([])
    }

    if (hasOpenpyxl()) {
      const read = JSON.parse(openpyxl(bytes, "print(json.dumps({sheet.title: {cell.coordinate: [cell.comment.author, cell.comment.text[:40]] for row in sheet.iter_rows() for cell in row if cell.comment} for sheet in book.worksheets}))"))

      expect(read.Notes.B2).toEqual(['Pat Example', 'Two lines\nof note & “quotes”'])
      // openpyxl leaves Excel's escapes as they are in the file and gives no author as "None".
      expect(read.Notes.C5).toEqual(['None', 'No author _x005F_x0041_ here'])
      expect(read.Notes.D2[0]).toMatch(/^tc=\{[0-9A-F-]{36}\}$/)
      expect(read.Notes.D2[1]).toBe('[Threaded comment]\n\nThis comment thread ')
      expect(read.Notes.E3[0]).toMatch(/^tc=/)
      expect(read['Second sheet'].A1).toEqual(['Sam Sample', 'On the second sheet'])
    }
  })

  it('keeps a cell’s thread over its note, and one thread to a cell, saying so', async () => {
    const book = annotated()
    const threads = readResource<ThreadsResource>(book.resources, THREAD_RESOURCE)!
    const notes = readResource<NotesResource>(book.resources, NOTE_RESOURCE)!
    notes.s1[1][3] = { id: 'clash', row: 1, col: 3, width: 160, height: 72, note: 'Under the thread' }
    threads.s1.push({ ...comment('t3', 'A second thread on D2', '2026/10/11 10:00', 'Sam Sample'), children: [] })
    threads.s1.push({ ...comment('t4', 'On a chart', '2026/10/11 10:00', 'Sam Sample', { ref: 'univer-comment-anchor:{"v":1}' }), children: [] })
    const { bytes, losses } = await xlsxFromWorkbook({ ...book, resources: [{ name: NOTE_RESOURCE, data: JSON.stringify(notes) }, { name: THREAD_RESOURCE, data: JSON.stringify(threads) }] })
    const read = readResource<ThreadsResource>((await workbookFromXlsx(bytes, { id: 'b', name: 'B' })).workbook.resources, THREAD_RESOURCE)!

    expect(losses).toEqual([
      'Comments on charts and pictures are not saved: Excel has comments on cells only.',
      'A cell with more than one comment thread is saved with one, the later threads’ comments as its replies.',
      'A note on a cell that also has a comment thread is not saved: Excel keeps one or the other.'
    ])
    expect(read['sheet-1'].find((root) => root.ref === 'D2')!.children!.map((child) => plainTextOf(child.text))).toEqual(['Yes, from March.', 'Thanks', 'A second thread on D2'])
    expect(await part(bytes, 'xl/comments1.xml')).not.toContain('Under the thread')
  })

  it('reads notes Excel wrote: their runs’ text, authors, box sizes and whether they show, and says the formatting goes', async () => {
    const { workbook, notes: fidelity } = await workbookFromXlsx(await excelNotes(), { id: 'notes', name: 'Notes' })
    const notes = readResource<NotesResource>(workbook.resources, NOTE_RESOURCE)!['sheet-1']

    expect(notes[1][1]).toMatchObject({ row: 1, col: 1, note: 'Robin Example:\nCheck this total\nbefore sending', author: 'Robin Example', width: 192, height: 96 })
    expect(notes[1][1].show).toBeUndefined()
    expect(notes[3][2]).toMatchObject({ note: 'Plain note & more', author: 'Sam Sample', width: 128, height: 74, show: true })
    expect(fidelity).toContain('Notes keep their text but not its formatting (such as the bold author name Excel starts a note with).')
  })

  it('reads threads Excel wrote with their people, leaving out the placeholders it keeps for them, and keeps who they are when saved again', async () => {
    const original = await excelThreads()
    const { workbook, notes: fidelity } = await workbookFromXlsx(original, { id: 'threads', name: 'Threads' })
    const threads = readResource<ThreadsResource>(workbook.resources, THREAD_RESOURCE)!['sheet-1']
    const notes = readResource<NotesResource>(workbook.resources, NOTE_RESOURCE)!['sheet-1']

    expect(threads.map((root) => [root.id, root.ref, root.personId, root.authorName, plainTextOf(root.text), Boolean(root.resolved), root.children!.map((child) => [child.id, child.personId, child.authorName, plainTextOf(child.text)])])).toEqual([
      [THREAD, 'B3', ROBIN, 'Robin Example', 'Is this total right?\nIt looks high.', false, [[REPLY, SAMPLE, 'Sam Sample', '@Robin Example yes, checked.']]],
      [RESOLVED, 'C2', SAMPLE, 'Sam Sample', 'Fixed the rate', true, []]
    ])
    expect(threads[0].dT).toBe('2026-03-04T05:06:07.890Z')
    expect(Object.keys(notes)).toEqual(['5'])
    expect(notes[5][0]).toMatchObject({ note: 'An old-style note', author: 'Robin Example', width: 160, height: 53 })
    expect(fidelity).toContain('Mentions in comments are kept as plain text.')

    const { bytes } = await xlsxFromWorkbook(workbook, { original })
    const persons = await part(bytes, 'xl/persons/person.xml')
    const threaded = await part(bytes, 'xl/threadedComments/threadedComment1.xml')

    expect(persons).toContain(`<person displayName="Robin Example" id="${ROBIN}" userId="S::robin@example.com::5c1d2e3f-0000-4000-8000-000000000001" providerId="AD"/>`)
    expect(persons).toMatch(/<person displayName="Sam Sample" id="\{[0-9A-F-]+\}" userId="Sam Sample" providerId="None"\/>/)
    expect(threaded).toContain(`<threadedComment ref="B3" dT="2026-03-04T05:06:07.89" personId="${ROBIN}" id="${THREAD}"><text>Is this total right?\nIt looks high.</text></threadedComment>`)
    expect(threaded).toContain(`id="${RESOLVED}" done="1"><text>Fixed the rate</text>`)
  })
})
