import { describe, expect, it } from 'vitest'
import { EDIT_OPS } from '../features/office/docs/agent-model.ts'
import { validateArgs } from '../store/os-commands.ts'
import { docsCommands } from './docs.ts'

const TIERS: Record<string, string> = {
  'docs.setHeader': 'act',
  'docs.setFooter': 'act',
  'docs.clearHeader': 'mutate',
  'docs.clearFooter': 'mutate',
  'docs.setHeaderOptions': 'act',
  'docs.insertField': 'act',
  'docs.insertNote': 'act',
  'docs.listNotes': 'read',
  'docs.setNote': 'act',
  'docs.removeNote': 'mutate',
  'docs.insertSectionBreak': 'act',
  'docs.listSections': 'read',
  'docs.removeSectionBreak': 'mutate',
  'docs.setPage': 'act',
  'docs.listComments': 'read',
  'docs.addComment': 'act',
  'docs.addComments': 'act',
  'docs.replyToComment': 'act',
  'docs.editComment': 'act',
  'docs.resolveComment': 'act',
  'docs.deleteComment': 'mutate',
  'docs.insertToc': 'act',
  'docs.updateTocs': 'act',
  'docs.setToc': 'act',
  'docs.removeToc': 'mutate',
  'docs.listTemplates': 'read',
  'docs.statistics': 'read',
  'docs.read': 'read',
  'docs.new': 'act',
  'docs.edit': 'act'
}

const command = (id: string) => docsCommands.find((entry) => entry.id === id)!

describe('Herald Docs’ page and review commands', () => {
  it('each read, change or take away at their tier, once each', () => {
    const ids = docsCommands.map((entry) => entry.id)

    expect(Object.fromEntries(Object.keys(TIERS).map((id) => [id, command(id)?.tier]))).toEqual(TIERS)
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
  })

  it('describe every argument, and give no optional one a fixed list of choices', () => {
    for (const entry of docsCommands) {
      expect(entry.description.length, entry.id).toBeGreaterThan(40)

      for (const arg of entry.args) {
        expect(arg.description, `${entry.id} ${arg.name}`).toBeTruthy()
        expect(arg.enum, `${entry.id} ${arg.name}`).toBeUndefined()
      }
    }
  })

  it('take a review as a JSON list of comments, each on a quote', () => {
    const list = [{ text: 'Source?', quote: 'grew by a third' }]

    expect(validateArgs(command('docs.addComments'), { document: '~/Report.docx', comments: list })).toEqual({ args: { document: '~/Report.docx', comments: JSON.stringify(list) } })
    expect(validateArgs(command('docs.addComments'), { document: '~/Report.docx' })).toEqual({ error: expect.stringMatching(/^docs\.addComments needs "comments"/) })
    expect(command('docs.addComment').args.map((arg) => [arg.name, arg.type, Boolean(arg.required)])).toEqual([
      ['document', 'string', false],
      ['text', 'string', true],
      ['quote', 'string', false],
      ['heading', 'string', false],
      ['at', 'string', false],
      ['all', 'boolean', false]
    ])
  })

  it('keep docs.setPage’s arguments and add each side, the distances and a section', () => {
    expect(command('docs.setPage').args.map((arg) => arg.name)).toEqual(['document', 'size', 'orientation', 'margins', 'top', 'right', 'bottom', 'left', 'headerDistance', 'footerDistance', 'section'])
  })

  it('have a command for each op of docs.edit named after one, so a batch asks as its ops do', () => {
    const own = ['write', 'replace', 'format', 'table', 'image', 'pageBreak', 'page']

    expect(EDIT_OPS.filter((op) => !own.includes(op) && !docsCommands.some((entry) => entry.id === `docs.${op}`))).toEqual([])
  })
})
