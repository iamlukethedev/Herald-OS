import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { spellingMenu } from './spelling.ts'

const editFlags = { canCut: true, canCopy: true, canPaste: true, canUndo: true, canRedo: true, canDelete: true, canSelectAll: true, canEditRichly: true }

function params(misspelledWord: string, dictionarySuggestions: string[]): Electron.ContextMenuParams {
  return { misspelledWord, dictionarySuggestions, isEditable: true, spellcheckEnabled: true, editFlags } as unknown as Electron.ContextMenuParams
}

describe('spellingMenu', () => {
  it('offers the suggestions for a misspelled word, then Add to Dictionary and editing', () => {
    const contents = { replaceMisspelling: vi.fn(), session: { addWordToSpellCheckerDictionary: vi.fn() } }
    const items = spellingMenu(contents as unknown as WebContents, params('recieve', ['receive', 'relieve']))

    expect(items.map((item) => item.role ?? item.label ?? item.type)).toEqual(['receive', 'relieve', 'Add to Dictionary', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll'])
    items[0].click?.({} as never, undefined, {} as never)
    items[2].click?.({} as never, undefined, {} as never)
    expect(contents.replaceMisspelling).toHaveBeenCalledWith('receive')
    expect(contents.session.addWordToSpellCheckerDictionary).toHaveBeenCalledWith('recieve')
  })

  it('says when there are no guesses, and is only editing for a word spelled right', () => {
    const contents = {} as WebContents

    expect(spellingMenu(contents, params('qwzx', []))[0]).toEqual({ label: 'No Guesses Found', enabled: false })
    expect(spellingMenu(contents, params('', [])).map((item) => item.role ?? item.type)).toEqual(['cut', 'copy', 'paste', 'separator', 'selectAll'])
  })

  it("names every item in Herald's language, the editing ones too", () => {
    const contents = {} as WebContents

    expect(spellingMenu(contents, params('', [])).map((item) => item.label ?? item.type)).toEqual(['Cut', 'Copy', 'Paste', 'separator', 'Select All'])
    expect(spellingMenu(contents, params('qwzx', []), 'zh-CN').map((item) => item.label ?? item.type)).toEqual(['没有拼写建议', '添加到词典', 'separator', '剪切', '复制', '粘贴', 'separator', '全选'])
  })
})
