import { app, BrowserWindow, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { type Language, translate } from '../../shared/i18n.ts'
import { menuLanguage } from '../i18n.ts'

/*
 * Spelling where a page asks for it (Herald Docs' pages; the shell keeps it off everywhere else):
 * a right-click on a word Chromium marked offers its suggestions and Add to Dictionary, with Cut,
 * Copy and Paste. On the Mac the words come from the system's own spelling dictionary.
 */

const SUGGESTIONS = 6

export function spellingMenu(contents: WebContents, params: Electron.ContextMenuParams, language: Language = 'en'): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []

  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, SUGGESTIONS)) {
      items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) })
    }

    if (!params.dictionarySuggestions.length) {
      items.push({ label: translate(language, 'menu.noGuesses'), enabled: false })
    }

    items.push({ label: translate(language, 'menu.addToDictionary'), click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: 'separator' })
  }

  // Electron names role items in English whatever the system's language, so they carry their own labels.
  items.push(
    { role: 'cut', label: translate(language, 'menu.cut'), enabled: params.editFlags.canCut },
    { role: 'copy', label: translate(language, 'menu.copy'), enabled: params.editFlags.canCopy },
    { role: 'paste', label: translate(language, 'menu.paste'), enabled: params.editFlags.canPaste },
    { type: 'separator' },
    { role: 'selectAll', label: translate(language, 'menu.selectAll') }
  )

  return items
}

/** The menu for every page Herald opens from now on. */
export function registerSpellingMenus(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('context-menu', (_menuEvent, params) => {
      if (params.isEditable && params.spellcheckEnabled) {
        Menu.buildFromTemplate(spellingMenu(contents, params, menuLanguage())).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined })
      }
    })
  })
}
