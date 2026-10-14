import { useStore } from '@nanostores/react'
import { computed } from 'nanostores'
import { formatLocale, type LanguageSetting, type MessageKey, resolveLanguage, translate, type ValuesFor } from '../../shared/i18n.ts'
import type { EnvInfo } from '../../shared/ipc.ts'
import { $env, $prefs, updatePrefs } from './backend.ts'

/*
 * The language every window shows (shared/i18n.ts resolves it from the setting and the system's
 * languages), `t` for its strings, and the locale Herald formats dates and numbers in. Each window
 * follows a change in Settings as soon as its prefs do; see docs/TRANSLATING.md.
 */

/** Chromium's languages, which follow the system's; there are none without a window (tests). */
function browserLanguages(): string[] {
  return typeof window === 'undefined' ? [] : [...(window.navigator?.languages ?? [])]
}

/** The system's preferred languages as main reports them, Chromium's until it has. */
function systemLanguages(env: EnvInfo | null): readonly string[] {
  return env?.languages?.length ? env.languages : browserLanguages()
}

export const $language = computed([$prefs, $env], (prefs, env) => resolveLanguage(prefs.language, systemLanguages(env)))
/** The language following the system means now, for the setting's own menu. */
export const $systemLanguage = computed($env, env => resolveLanguage('system', systemLanguages(env)))
/** For `toLocale*String`; undefined is Chromium's own locale, which follows the system. */
export const $locale = computed([$prefs, $language, $env], (prefs, language, env) => formatLocale(prefs.language, language, [...browserLanguages(), ...(env?.languages ?? [])]))

export function t<K extends MessageKey>(key: K, ...values: ValuesFor<K>): string {
  return translate($language.get(), key, ...values)
}

/** `t` for a component, which renders again when the language changes. */
export function useT(): typeof t {
  useStore($language)

  return t
}

export function setLanguage(setting: LanguageSetting): Promise<void> {
  return updatePrefs({ language: setting })
}

let bound = false

/** Keeps `<html lang>` on the language shown: Chromium's font fallback reads it, so Chinese gets Simplified glyphs on any system. */
export function bindLanguage(): void {
  if (bound) {
    return
  }

  bound = true
  $language.subscribe(language => {
    document.documentElement.lang = language
  })
}
