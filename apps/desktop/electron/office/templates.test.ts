import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OfficeTemplates, templateName } from './templates.ts'

const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Dear Ann Example,' }] }] }

describe('OfficeTemplates', () => {
  let root: string
  let templates: OfficeTemplates

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'herald-office-templates-'))
    templates = new OfficeTemplates(root, () => new Date('2026-10-09T08:00:00Z'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('keeps each template as a JSON file in its app’s folder, and lists them by name with their documents', async () => {
    const saved = await templates.save('docs', '  Weekly   report ', doc)
    await templates.save('docs', 'agenda', doc)

    expect(saved).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: 'Weekly report', savedAt: '2026-10-09T08:00:00.000Z' })
    expect(JSON.parse(await fs.readFile(path.join(root, 'docs', `${saved.id}.json`), 'utf8'))).toEqual({ name: 'Weekly report', savedAt: '2026-10-09T08:00:00.000Z', model: doc })

    const list = await templates.list('docs')

    expect(list.map((entry) => entry.name)).toEqual(['agenda', 'Weekly report'])
    expect(list[1]).toEqual({ ...saved, model: doc })
    expect(await templates.list('sheets')).toEqual([])
  })

  it('saves over a template by its id, renames it and removes it', async () => {
    const { id } = await templates.save('docs', 'Letter', doc)
    const changed = { ...doc, content: [] }

    await templates.save('docs', 'Letter', changed, id)
    expect(await templates.list('docs')).toEqual([{ id, name: 'Letter', savedAt: '2026-10-09T08:00:00.000Z', model: changed }])

    expect(await templates.rename('docs', id, 'Formal letter')).toMatchObject({ id, name: 'Formal letter' })
    expect((await templates.list('docs'))[0].name).toBe('Formal letter')

    await templates.remove('docs', id)
    expect(await templates.list('docs')).toEqual([])
    expect((await fs.readdir(path.join(root, 'docs'))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('reaches nothing outside its folder: ids are UUIDs and apps are Office apps', async () => {
    await expect(templates.remove('docs', '../../outside')).rejects.toThrow(/no such template/)
    await expect(templates.save('docs', 'Letter', doc, '../letter')).rejects.toThrow(/no such template/)
    await expect(templates.rename('docs', 'letter.json', 'x')).rejects.toThrow(/no such template/)
    await expect(templates.list('../docs' as never)).rejects.toThrow(/not a Herald Office app/)
    await expect(templates.rename('docs', crypto.randomUUID(), 'x')).rejects.toThrow(/no such template/)
  })

  it('refuses a template without a name or a document, and passes over files that are not templates', async () => {
    await expect(templates.save('docs', ' \n ', doc)).rejects.toThrow(/needs a name/)
    await expect(templates.save('docs', 'Letter', 'Dear Ann')).rejects.toThrow(/is a document/)

    await fs.mkdir(path.join(root, 'docs'), { recursive: true })
    await fs.writeFile(path.join(root, 'docs', `${crypto.randomUUID()}.json`), '{ "name": "Broken"')
    await fs.writeFile(path.join(root, 'docs', `${crypto.randomUUID()}.json`), JSON.stringify({ name: 'No document' }))
    await fs.writeFile(path.join(root, 'docs', 'notes.json'), JSON.stringify({ name: 'Not ours', model: doc }))

    expect(await templates.list('docs')).toEqual([])
  })

  it('tidies a name onto one line of at most 120 characters', () => {
    expect(templateName('Monthly\nreport\u200b\tdraft')).toBe('Monthly report draft')
    expect(templateName('x'.repeat(200))).toHaveLength(120)
  })
})
