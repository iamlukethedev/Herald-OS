import { describe, expect, it } from 'vitest'
import type { Language, Translation } from '../i18n.ts'
import { en } from './en.ts'
import { ptBR } from './pt-BR.ts'
import { zhCN } from './zh-CN.ts'

const TRANSLATIONS: Record<Exclude<Language, 'en'>, Translation> = { 'pt-BR': ptBR, 'zh-CN': zhCN }

// Chinese says 本机 and Portuguese "este computador" ("this computer") rather than naming the Mac,
// so a translation may drop {device}.
const OPTIONAL_SLOTS = new Set(['device'])

// Names that read the same in every language (docs/TRANSLATING.md).
const PRODUCTS = ['Herald Canvas', 'Herald Office', 'Herald Sheets', 'Herald Slides', 'Herald Calc', 'Herald Docs', 'Herald OS', 'Hermes']

// Words a language writes as English does: loanwords, and Studio, the name of an app. Anything
// else left in a message equal to English means it was copied rather than translated.
const SAME_AS_ENGLISH: Record<Exclude<Language, 'en'>, string[]> = {
  'pt-BR': ['Bluetooth', 'Emoji', 'min', 'offline', 'OK', 'Plugins', 'Software', 'Studio', 'Terminal', 'Web', 'Widget', 'Wi-Fi'],
  'zh-CN': ['Studio', 'Wi-Fi']
}

/** What is left of a text once product names, `{slots}`, allowed words and anything but letters are gone. */
function wordsLeft(text: string, allowed: string[]): string {
  let rest = text.replace(/\{\w+\}/g, ' ')

  for (const word of [...PRODUCTS, ...allowed]) {
    rest = rest.replace(new RegExp(`(?<![\\p{L}-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}-])`, 'gu'), ' ')
  }

  return rest.replace(/[^\p{L}]+/gu, ' ').trim()
}

const forms = (message: string | object): string[] => (typeof message === 'string' ? [message] : Object.values(message))
const slotsIn = (texts: string[]) => new Set(texts.flatMap(text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1])))

describe('the English catalog', () => {
  it('has text in every message, and a one and an other form in every plural', () => {
    for (const [key, message] of Object.entries(en)) {
      expect(forms(message).filter(text => !text.trim()), key).toEqual([])

      if (typeof message !== 'string') {
        expect(Object.keys(message).sort(), key).toEqual(['one', 'other'])
      }
    }
  })
})

describe('the pt-BR catalog', () => {
  it('leaves the theme draft open for the person to finish', () => {
    expect(ptBR['overview.makeThemeDraft']).toMatch(/ $/)
  })

  it('keeps one and other, and every required slot in each plural form', () => {
    for (const [key, message] of Object.entries(ptBR)) {
      if (typeof message === 'string') continue

      expect(Object.keys(message).sort(), key).toEqual(['one', 'other'])
      const english = slotsIn(forms(en[key as keyof typeof en]))
      for (const text of forms(message)) {
        expect(slotsIn([text]), key).toEqual(english)
      }
    }
  })

  it('keeps product names and the English words voice and dictation listen for', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      for (const product of ['Herald OS', 'Hermes', 'Herald Canvas', 'Herald Docs', 'Herald Sheets', 'Herald Slides', 'Herald Office']) {
        if (typeof en[key] === 'string' && en[key].includes(product)) {
          expect(ptBR[key], key).toContain(product)
        }
      }
    }
    expect(ptBR['settings.commands.subtitle']).toContain('"hey hermes"')
    expect(ptBR['settings.commands.subtitleKey']).toContain('"hey hermes"')
    for (const phrase of ['"comma"', '"new line"', '"press enter"']) {
      expect(ptBR['settings.general.dictationHint']).toContain(phrase)
    }
  })
})

describe.each(Object.entries(TRANSLATIONS))('the %s catalog', (language, catalog) => {
  const entries = Object.entries(catalog) as [keyof typeof en, string | object][]

  it('translates every English message', () => {
    expect(Object.keys(en).filter(key => !(key in catalog))).toEqual([])
  })

  it('translates only messages English has', () => {
    expect(entries.map(([key]) => key).filter(key => !(key in en))).toEqual([])
  })

  it('keeps the slots English fills in, and adds none', () => {
    for (const [key, message] of entries) {
      const english = slotsIn(forms(en[key]))
      const translated = slotsIn(forms(message))

      expect([...translated].filter(slot => !english.has(slot)), `${key} adds`).toEqual([])
      expect([...english].filter(slot => !translated.has(slot) && !OPTIONAL_SLOTS.has(slot)), `${key} drops`).toEqual([])
    }
  })

  it("has plural forms where English does, in the language's own categories", () => {
    const categories: string[] = new Intl.PluralRules(language).resolvedOptions().pluralCategories

    for (const [key, message] of entries) {
      expect(typeof message, key).toBe(typeof en[key])

      if (typeof message !== 'string') {
        expect(Object.keys(message).filter(form => !categories.includes(form)), key).toEqual([])
        expect(Object.keys(message), key).toContain('other')
      }
    }
  })

  it('has text in every message', () => {
    for (const [key, message] of entries) {
      expect(forms(message).filter(text => !text.trim()), key).toEqual([])
    }
  })

  it('translates every message rather than copying the English', () => {
    const allowed = SAME_AS_ENGLISH[language as Exclude<Language, 'en'>]
    const copied = entries.filter(([key, message]) => {
      const english = en[key]
      const same = typeof message === 'string' ? message === english : Object.entries(message).some(([form, text]) => text === (english as Record<string, string>)[form])

      return same && forms(message).some(text => wordsLeft(text, allowed) !== '')
    })

    expect(copied.map(([key]) => key)).toEqual([])
  })

  it('allows only words some message in it really keeps', () => {
    for (const word of SAME_AS_ENGLISH[language as Exclude<Language, 'en'>]) {
      const kept = entries.some(([key, message]) => forms(message).some(text => text.includes(word) && forms(en[key]).some(english => english === text)))

      expect(kept, word).toBe(true)
    }
  })
})

describe('the copied-English check', () => {
  it('lets product names, slots and allowed words through, and nothing else', () => {
    expect(wordsLeft('Hermes', [])).toBe('')
    expect(wordsLeft('Herald Canvas', [])).toBe('')
    expect(wordsLeft('{action} ({shortcut})', [])).toBe('')
    expect(wordsLeft('Wi-Fi {network}', ['Wi-Fi'])).toBe('')
    expect(wordsLeft('Hermes offline', [])).toBe('offline')
    expect(wordsLeft('Add space', ['Studio'])).toBe('Add space')
    expect(wordsLeft('Open Terminal', ['Terminal'])).toBe('Open')
  })
})
