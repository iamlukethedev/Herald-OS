import { app } from 'electron'
import { type Language, resolveLanguage } from '../shared/i18n.ts'
import { readPrefs } from './prefs.ts'

/** The system's preferred languages, most preferred first; Chromium's locale where the system lists none. */
export function systemLanguages(): string[] {
  const languages = app.getPreferredSystemLanguages()

  return languages.length > 0 ? languages : [app.getLocale()]
}

/** The language of the menus main builds, read as each one opens so a change in Settings applies to the next. */
export function menuLanguage(): Language {
  return resolveLanguage(readPrefs().language, systemLanguages())
}
