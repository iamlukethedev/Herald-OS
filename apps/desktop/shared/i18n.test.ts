import { describe, expect, it, vi } from 'vitest'
import { formatLocale, languageSetting, localeTag, resolveLanguage, tagLanguage, translate } from './i18n.ts'

// A catalog that has translated some messages and not others, as one does while it is being written.
vi.mock('./locales/zh-CN.ts', () => ({
  zhCN: {
    'menuBar.search': '搜索',
    'menuBar.battery': '电池 {percent}%',
    'overview.mission.files': { other: '{count} 个文件' },
    'commandBar.ask': '问 Hermes：“{text}”'
  }
}))

describe('translate', () => {
  it('fills the slots, and writes numbers the way the language does', () => {
    expect(translate('en', 'menuBar.search')).toBe('Search')
    expect(translate('en', 'menuBar.battery', { percent: 85 })).toBe('Battery 85%')
    expect(translate('zh-CN', 'commandBar.ask', { text: '今天有什么安排' })).toBe('问 Hermes：“今天有什么安排”')
    expect(translate('en', 'menuBar.updates', { count: 1200 })).toBe('1,200 updates')
  })

  it("picks plural forms by the language's rules", () => {
    expect(translate('en', 'overview.mission.files', { count: 1 })).toBe('1 file')
    expect(translate('en', 'overview.mission.files', { count: 0 })).toBe('0 files')
    expect(translate('zh-CN', 'overview.mission.files', { count: 1 })).toBe('1 个文件')
  })

  it('shows English for a message the language has not translated yet, never its key', () => {
    expect(translate('zh-CN', 'menuBar.sound')).toBe('Sound')
    expect(translate('zh-CN', 'overview.memory.remembered', { count: 1 })).toBe('1 entry remembered')
    expect(translate('zh-CN', 'overview.memory.remembered', { count: 3 })).toBe('3 entries remembered')
  })

  it('fills slots and picks plural forms in Brazilian Portuguese', () => {
    expect(translate('pt-BR', 'menuBar.battery', { percent: 85 })).toBe('Bateria 85%')
    expect(translate('pt-BR', 'commandBar.ask', { text: 'o que tenho hoje' })).toBe('Perguntar ao Hermes: “o que tenho hoje”')
    expect(translate('pt-BR', 'overview.mission.files', { count: 1 })).toBe('1 arquivo')
    expect(translate('pt-BR', 'overview.mission.files', { count: 3 })).toBe('3 arquivos')
    expect(translate('pt-BR', 'menuBar.updates', { count: 1200 })).toBe('1.200 atualizações')
  })

  it('takes exactly the values a message has slots for', () => {
    // @ts-expect-error A message with slots needs its values.
    translate('en', 'menuBar.battery')
    // @ts-expect-error A plural message needs a count, as a number.
    translate('en', 'overview.mission.files', { count: '2' })
    // @ts-expect-error A message without slots takes none.
    translate('en', 'menuBar.search', { percent: 1 })
    // @ts-expect-error Keys are English's.
    translate('en', 'menuBar.nothing')
  })
})

describe('the language for a tag', () => {
  it('knows English in any region, and Simplified Chinese by its script or where it is written', () => {
    expect(['en', 'en-US', 'en-AU', 'en_GB.UTF-8'].map(tagLanguage)).toEqual(['en', 'en', 'en', 'en'])
    expect(['zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN', 'zh-Hans-FI', 'zh_CN.UTF-8', 'zh'].map(tagLanguage)).toEqual(Array(7).fill('zh-CN'))
  })

  it('reads every Portuguese as Brazilian Portuguese, glibc tags included', () => {
    expect(['pt', 'pt-BR', 'pt-PT', 'pt-AO', 'pt_BR.UTF-8', 'pt_PT.UTF-8@euro'].map(tagLanguage)).toEqual(Array(6).fill('pt-BR'))
  })

  it('has none for Traditional Chinese, other languages, or no locale at all', () => {
    expect(['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-TW', 'zh-Hant-CN', 'zh_TW.UTF-8', 'ja-JP', 'fr', 'C', 'POSIX', ''].map(tagLanguage)).toEqual(Array(12).fill(null))
  })

  it('reads glibc tags as Intl takes them', () => {
    expect(localeTag('zh_CN.UTF-8')).toBe('zh-CN')
    expect(localeTag('en_US.UTF-8@euro')).toBe('en-US')
    expect(localeTag('C')).toBeNull()
  })
})

describe('resolveLanguage', () => {
  it('uses the language the person chose, whatever the system speaks', () => {
    expect(resolveLanguage('en', ['zh-Hans-CN'])).toBe('en')
    expect(resolveLanguage('zh-CN', ['en-US'])).toBe('zh-CN')
    expect(resolveLanguage('pt-BR', ['en-US'])).toBe('pt-BR')
    expect(resolveLanguage('en', ['pt-BR'])).toBe('en')
  })

  it('follows a Portuguese system', () => {
    expect(resolveLanguage('system', ['pt-BR', 'en-US'])).toBe('pt-BR')
    expect(resolveLanguage(undefined, ['pt_PT.UTF-8'])).toBe('pt-BR')
    expect(resolveLanguage('system', ['de-DE', 'pt-AO'])).toBe('pt-BR')
    expect(resolveLanguage('system', ['en-US', 'pt-BR'])).toBe('en')
  })

  it('follows the first of the system languages Herald has', () => {
    expect(resolveLanguage('system', ['zh-Hans-CN', 'en-US'])).toBe('zh-CN')
    expect(resolveLanguage(undefined, ['en-AU', 'zh-Hans-CN'])).toBe('en')
    expect(resolveLanguage('system', ['ja-JP', 'zh-Hans-CN'])).toBe('zh-CN')
    expect(resolveLanguage('system', ['de-DE', 'fr-FR'])).toBe('en')
    expect(resolveLanguage('system', [])).toBe('en')
  })

  it('shows English for Traditional Chinese, even with Simplified further down the list', () => {
    expect(resolveLanguage('system', ['zh-Hant-TW', 'zh-Hans-CN'])).toBe('en')
    expect(resolveLanguage('system', ['zh_TW.UTF-8', 'zh_TW', 'zh.UTF-8', 'zh'])).toBe('en')
    expect(resolveLanguage('system', ['zh-HK'])).toBe('en')
  })
})

describe('formatLocale', () => {
  it("keeps the region of a tag in Herald's language, Chromium's first", () => {
    expect(formatLocale(undefined, 'en', ['en-GB', 'en-AU'])).toBe('en-GB')
    expect(formatLocale('system', 'zh-CN', ['zh-CN', 'zh-Hans-CN'])).toBe('zh-CN')
    expect(formatLocale('en', 'en', ['zh-CN', 'zh-Hans-CN', 'en-AU'])).toBe('en-AU')
    expect(formatLocale('zh-CN', 'zh-CN', ['en_AU.UTF-8', 'zh_SG.UTF-8'])).toBe('zh-SG')
    expect(formatLocale('system', 'pt-BR', ['pt_PT.UTF-8'])).toBe('pt-PT')
    expect(formatLocale('pt-BR', 'pt-BR', ['en-GB'])).toBe('pt-BR')
  })

  it("formats in the chosen language when nothing the system lists is in it, and keeps the system's format otherwise", () => {
    expect(formatLocale('zh-CN', 'zh-CN', ['en-GB'])).toBe('zh-CN')
    expect(formatLocale('en', 'en', ['de-DE'])).toBe('en')
    expect(formatLocale('system', 'en', ['de-DE', 'de'])).toBeUndefined()
    expect(formatLocale(undefined, 'en', ['zh-TW', 'zh-Hant-TW'])).toBeUndefined()
  })
})

describe('languageSetting', () => {
  it('keeps a setting Herald knows and drops anything else, which then follows the system', () => {
    expect(['system', 'en', 'pt-BR', 'zh-CN'].map(languageSetting)).toEqual(['system', 'en', 'pt-BR', 'zh-CN'])
    expect(['fr', 'zh', 'ZH-CN', 'pt', 'pt-PT', 42, null, undefined].map(languageSetting)).toEqual(Array(8).fill(undefined))
  })
})
