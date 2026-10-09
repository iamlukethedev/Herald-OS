import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocJSON } from '../../../../../shared/office/document.ts'
import { documentFromTemplate } from './index.ts'
import { savedDocument, savedTemplates, saveTemplate, templateModel } from './saved.ts'

const letter = (): DocJSON => documentFromTemplate('letter', { locale: 'en-GB' })

describe('saved templates', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keep a document whole, but not what Herald holds of the Word file it came from', () => {
    const doc = { ...letter(), attrs: { ...letter().attrs, kept: { parts: ['word/theme/theme1.xml'] } } }

    expect(templateModel(doc).attrs?.kept).toBeNull()
    expect(templateModel(doc).content).toEqual(doc.content)
    expect(templateModel(doc).attrs?.headers).toEqual(doc.attrs.headers)
  })

  it('read back only documents the schema takes', () => {
    expect(savedDocument(letter())?.content).toHaveLength(letter().content.length)
    expect(savedDocument(null)).toBeNull()
    expect(savedDocument({ type: 'paragraph' })).toBeNull()
    expect(savedDocument({ type: 'doc', content: [{ type: 'spreadsheet' }] })).toBeNull()
    expect(savedDocument({ type: 'doc', content: [] })).toBeNull()
  })

  it('make styles safe to become CSS', () => {
    const doc = savedDocument({ type: 'doc', attrs: { styles: { normal: { font: 'Georgia; } body { display: none', color: 'red; }', size: '11pt; x', bold: 'yes' }, heading1: { color: '#123456', size: 18 }, sneaky: { font: 'Arial' } } }, content: [{ type: 'paragraph' }] })

    expect(doc?.attrs?.styles).toEqual({ normal: { font: 'Georgia  body  display none' }, heading1: { color: '#123456', size: 18 } })
  })

  it('come from main for Herald Docs, those that are not documents left out, and none from a window without the call', async () => {
    const templates = vi.fn(async () => [
      { id: 'a', name: 'Letter', savedAt: '2026-10-09T08:00:00.000Z', model: letter() },
      { id: 'b', name: 'Broken', savedAt: '', model: { type: 'doc', content: [{ type: 'nothing' }] } }
    ])
    const save = vi.fn(async () => ({ id: 'c', name: 'Mine', savedAt: '' }))
    vi.stubGlobal('window', { heraldOS: { office: { templates, saveTemplate: save } } })

    expect((await savedTemplates()).map((entry) => entry.name)).toEqual(['Letter'])
    expect(templates).toHaveBeenCalledWith('docs')

    await saveTemplate('Mine', { ...letter(), attrs: { ...letter().attrs, kept: { parts: [] } } })
    expect(save).toHaveBeenCalledWith('docs', 'Mine', expect.objectContaining({ attrs: expect.objectContaining({ kept: null }) }), undefined)

    vi.stubGlobal('window', { heraldOS: { office: {} } })
    expect(await savedTemplates()).toEqual([])
  })
})
