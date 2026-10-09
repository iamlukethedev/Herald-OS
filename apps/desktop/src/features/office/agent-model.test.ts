import { describe, expect, it } from 'vitest'
import type { OfficePresence } from '../../../shared/ipc.ts'
import { describeOffice, documentFileName, findEntry, freePath, isPathLike, officeEntries, parseJsonArg, stepCount, summaryOf, tildePath } from './agent-model.ts'

const doc = (key: string, name: string, path: string | null, extra: Partial<OfficePresence['documents'][number]> = {}) => ({ key, name, path, format: '.docx', modified: false, ...extra })

const presence: OfficePresence[] = [
  { app: 'sheets', at: 200, active: 'sheets-1', documents: [{ ...doc('sheets-1', 'Budget.xlsx', '/Users/sam/Budget.xlsx'), format: '.xlsx', detail: 'Sheet1!B2', selection: 'Sheet1!B2:D9' }] },
  { app: 'docs', at: 100, active: 'docs-2', documents: [doc('docs-1', 'Notes.md', '/Users/sam/Notes.md'), doc('docs-2', 'Report.docx', '/Users/sam/Documents/Report.docx', { modified: true })] }
]

describe('the open Office documents', () => {
  it('lists every window’s documents, the window used last first, and marks the one in front', () => {
    const entries = officeEntries(presence)

    expect(entries.map((entry) => entry.name)).toEqual(['Budget.xlsx', 'Notes.md', 'Report.docx'])
    expect(entries.filter((entry) => entry.front).map((entry) => entry.name)).toEqual(['Budget.xlsx'])
    expect(entries.find((entry) => entry.name === 'Report.docx')).toMatchObject({ app: 'docs', active: true, modified: true })
  })

  it('reads this window’s own documents live, in its window’s place', () => {
    const local = [{ app: 'docs' as const, active: 'docs-1', documents: [doc('docs-1', 'Notes.md', '/Users/sam/Notes.md', { selection: 'the quick brown fox' }), doc('docs-2', 'Report.docx', '/Users/sam/Documents/Report.docx')] }]
    const entries = officeEntries(presence, local)

    expect(entries.map((entry) => entry.name)).toEqual(['Budget.xlsx', 'Notes.md', 'Report.docx'])
    expect(entries.find((entry) => entry.name === 'Notes.md')).toMatchObject({ active: true, selection: 'the quick brown fox' })
  })

  it('puts a window that has not reported yet in front', () => {
    const local = [{ app: 'docs' as const, active: 'docs-9', documents: [doc('docs-9', 'Untitled', null)] }]

    expect(officeEntries(presence, local)[0]).toMatchObject({ name: 'Untitled', front: true })
  })

  it('finds a document by its path or its name, with or without the extension', () => {
    const entries = officeEntries(presence)

    expect(findEntry(entries, 'docs', '~/Documents/Report.docx', '/Users/sam/Documents/Report.docx')?.key).toBe('docs-2')
    expect(findEntry(entries, 'docs', 'report')?.key).toBe('docs-2')
    expect(findEntry(entries, 'docs', 'notes.md')?.key).toBe('docs-1')
    expect(findEntry(entries, 'sheets', 'report')).toBeNull()
    expect(isPathLike('~/a.docx') && isPathLike('/tmp/a.docx') && !isPathLike('Untitled 2')).toBe(true)
  })

  it('tells Hermes what is in front, what is selected, and what else is open', () => {
    expect(describeOffice(officeEntries(presence), '/Users/sam')).toBe('Office: in front is Budget.xlsx in Herald Sheets (~/Budget.xlsx), selection Sheet1!B2:D9; also open: Notes.md (Herald Docs), Report.docx (Herald Docs).')
    expect(describeOffice([])).toBeNull()

    const docsFirst = officeEntries([{ ...presence[1], at: 300, documents: [doc('docs-2', 'Report.docx', null, { selection: 'Q3 revenue grew' })] }])

    expect(describeOffice(docsFirst)).toBe('Office: in front is Report.docx in Herald Docs (not saved yet), selected text “Q3 revenue grew”.')
  })

  it('names new files without taking one that exists', async () => {
    expect(documentFileName('Trip: budget', '.xlsx')).toBe('Trip- budget.xlsx')
    expect(documentFileName('Letter.docx', '.docx')).toBe('Letter.docx')
    const taken = new Set(['/d/Report.pdf', '/d/Report 2.pdf'])

    expect(await freePath('/d', 'Report.pdf', async (file) => taken.has(file))).toBe('/d/Report 3.pdf')
    expect(tildePath('/Users/sam/Documents/a.pdf', '/Users/sam')).toBe('~/Documents/a.pdf')
  })

  it('reads steps and JSON arguments', () => {
    expect(stepCount(undefined)).toBe(1)
    expect(stepCount('3')).toBe(3)
    expect(() => stepCount(0)).toThrow(/steps/)
    expect(parseJsonArg('[["a", 1]]', 'values')).toEqual([['a', 1]])
    expect(parseJsonArg('plain', 'values')).toBe('plain')
    expect(() => parseJsonArg('{bad', 'format')).toThrow(/format is not valid JSON/)
    expect(summaryOf({ key: 'k', path: null, name: 'A', format: '.md', modified: false }, undefined, 'x')).toEqual({ key: 'k', path: null, name: 'A', format: '.md', modified: false, selection: 'x' })
  })
})
