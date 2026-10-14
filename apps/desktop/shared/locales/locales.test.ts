import { describe, expect, it } from 'vitest'
import type { Language, Translation } from '../i18n.ts'
import { en } from './en.ts'
import { zhCN } from './zh-CN.ts'

const TRANSLATIONS: Record<Exclude<Language, 'en'>, Translation> = { 'zh-CN': zhCN }

// Chinese says 本机 ("this computer") rather than naming the Mac, so a translation may drop {device}.
const OPTIONAL_SLOTS = new Set(['device'])

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

describe.each(Object.entries(TRANSLATIONS))('the %s catalog', (language, catalog) => {
  const entries = Object.entries(catalog) as [keyof typeof en, string | object][]

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
})
