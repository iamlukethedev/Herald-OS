import { en } from './locales/en.ts'
import { zhCN } from './locales/zh-CN.ts'

/*
 * Herald OS's translations, for main and the renderer alike: one catalog per language, keyed by
 * message, with English the source of every message and the fallback for any a language lacks. A
 * message is text with `{name}` slots, or plural forms chosen by `{count}`. docs/TRANSLATING.md
 * says how to add strings and languages.
 */

export type Language = 'en' | 'zh-CN'
/** What the person chose in Settings; `system` (the default) follows the system's languages. */
export type LanguageSetting = 'system' | Language

/** Each language under its own name, so anyone can find theirs whatever Herald is showing. */
export const LANGUAGES: readonly { id: Language; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'zh-CN', name: '简体中文' }
]

export type MessageKey = keyof typeof en

/** A message that changes with `{count}`, by the language's plural categories; `other` is required. */
export interface PluralForms {
  zero?: string
  one?: string
  two?: string
  few?: string
  many?: string
  other: string
}

/** A language's catalog: any of the English messages, plural forms where English has them. */
export type Translation = { readonly [K in MessageKey]?: (typeof en)[K] extends string ? string : PluralForms }

type Slots<S> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Slots<Rest> : never
type Values<M> = M extends string ? { [P in Slots<M>]: string | number } : { count: number } & { [P in Exclude<Slots<M[keyof M]>, 'count'>]: string | number }
/** The values a message's slots take: none for plain text, a `count` for plural forms. */
export type ValuesFor<K extends MessageKey> = keyof Values<(typeof en)[K]> extends never ? [] : [values: Values<(typeof en)[K]>]
/** A key whose message takes no values, for tables of labels. */
export type TextKey = { [K in MessageKey]: ValuesFor<K> extends [] ? K : never }[MessageKey]

const CATALOGS: Record<Language, Translation> = { en, 'zh-CN': zhCN }
const pluralRules = new Map<Language, Intl.PluralRules>()

function pluralCategory(language: Language, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(language)

  if (!rules) {
    rules = new Intl.PluralRules(language)
    pluralRules.set(language, rules)
  }

  return rules.select(count)
}

export function translate<K extends MessageKey>(language: Language, key: K, ...args: ValuesFor<K>): string {
  const values = args[0] as Record<string, string | number> | undefined
  const own = CATALOGS[language][key]
  // A message the language has not translated yet is English's, with English's plural rules.
  const [message, rules]: [string | PluralForms | undefined, Language] = own === undefined ? [en[key], 'en'] : [own, language]

  if (message === undefined) {
    return key
  }

  const text = typeof message === 'string' ? message : (message[pluralCategory(rules, Number(values?.count))] ?? message.other)

  return text.replace(/\{(\w+)\}/g, (slot, name: string) => {
    const value = values?.[name]

    return value === undefined ? slot : typeof value === 'number' ? value.toLocaleString(language) : value
  })
}

/** A tag as Intl takes it: glibc's `zh_TW.UTF-8` is `zh-TW`; null when it is not a locale (`C`, `POSIX`). */
export function localeTag(tag: string): string | null {
  const plain = tag.split(/[.@]/)[0].replace(/_/g, '-')

  try {
    return Intl.getCanonicalLocales(plain)[0] ?? null
  } catch {
    return null
  }
}

const TRADITIONAL_REGIONS = new Set(['tw', 'hk', 'mo'])

function isChinese(tag: string): boolean {
  return localeTag(tag)?.toLowerCase().split('-')[0] === 'zh'
}

/** Herald's language for a language tag (`en-AU`, `zh-Hans-CN`, `zh_SG.UTF-8`), or null when Herald has none for it. */
export function tagLanguage(tag: string): Language | null {
  const parts = localeTag(tag)?.toLowerCase().split('-') ?? []

  if (parts[0] === 'en') {
    return 'en'
  }

  if (parts[0] !== 'zh') {
    return null
  }

  const script = parts.find(part => part === 'hans' || part === 'hant')

  if (script) {
    return script === 'hans' ? 'zh-CN' : null
  }

  return parts.slice(1).some(part => TRADITIONAL_REGIONS.has(part)) ? null : 'zh-CN'
}

/** A stored setting, or undefined (follow the system) for anything Herald does not know. */
export function languageSetting(value: unknown): LanguageSetting | undefined {
  return value === 'system' || LANGUAGES.some(language => language.id === value) ? (value as LanguageSetting) : undefined
}

/**
 * The language Herald shows. Following the system, it is the first of the system's preferred
 * languages Herald has; Traditional Chinese, which it has no translation for yet, means English
 * rather than a Simplified Chinese further down the list (glib lists `zh` right after `zh_TW`).
 */
export function resolveLanguage(setting: LanguageSetting | undefined, systemLanguages: readonly string[]): Language {
  if (setting && setting !== 'system') {
    return setting
  }

  for (const tag of systemLanguages) {
    const language = tagLanguage(tag)

    if (language) {
      return language
    }

    if (isChinese(tag)) {
      return 'en'
    }
  }

  return 'en'
}

/**
 * The locale dates and numbers are formatted in: the first of `tags` (Chromium's, then the
 * system's) in Herald's language, so a region's conventions stay (`en-AU`). Following the system
 * in a language Herald does not have, they keep the system's format (undefined), as before.
 */
export function formatLocale(setting: LanguageSetting | undefined, language: Language, tags: readonly string[]): string | undefined {
  for (const tag of tags) {
    const locale = localeTag(tag)

    if (locale && tagLanguage(locale) === language) {
      return locale
    }
  }

  return setting && setting !== 'system' ? language : undefined
}
