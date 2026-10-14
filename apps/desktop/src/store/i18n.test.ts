import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvInfo } from '../../shared/ipc.ts'
import { $env, $prefs } from './backend.ts'
import { $language, $locale, $systemLanguage, bindLanguage, t } from './i18n.ts'

// Chromium in a Chinese system, before main has said what the system's languages are.
vi.hoisted(() => {
  Object.assign(globalThis, { window: { navigator: { languages: ['zh-CN', 'zh'] } }, document: { documentElement: { lang: 'en' } } })
})

const ENV: EnvInfo = { platform: 'darwin', hermesHome: '/h/.hermes', homeDir: '/h', version: '0.0.0', isDev: false, shellMode: 'desktop' }

describe('the language Herald shows', () => {
  beforeEach(() => {
    $env.set(null)
    $prefs.set({ ...$prefs.get(), language: undefined })
  })

  it("follows Chromium's languages until main reports the system's, then the system's", () => {
    expect($language.get()).toBe('zh-CN')

    $env.set({ ...ENV, languages: ['en-AU', 'zh-Hans-CN'] })
    expect($language.get()).toBe('en')
    expect($systemLanguage.get()).toBe('en')

    $env.set({ ...ENV, languages: [] })
    expect($language.get()).toBe('zh-CN')
  })

  it('is the one chosen in Settings, whatever the system speaks', () => {
    $env.set({ ...ENV, languages: ['zh-Hans-CN'] })
    $prefs.set({ ...$prefs.get(), language: 'en' })

    expect($language.get()).toBe('en')
    expect($systemLanguage.get()).toBe('zh-CN')
    expect(t('app.settings')).toBe('Settings')

    $prefs.set({ ...$prefs.get(), language: 'zh-CN' })
    expect($language.get()).toBe('zh-CN')
  })

  it('keeps <html lang> on it', () => {
    bindLanguage()
    expect(document.documentElement.lang).toBe('zh-CN')

    $prefs.set({ ...$prefs.get(), language: 'en' })
    expect(document.documentElement.lang).toBe('en')
  })
})

describe('the locale Herald formats in', () => {
  beforeEach(() => {
    $prefs.set({ ...$prefs.get(), language: undefined })
  })

  it("is Chromium's, region and all, when it speaks Herald's language", () => {
    $env.set({ ...ENV, languages: ['zh-Hans-CN', 'en-US'] })
    expect($locale.get()).toBe('zh-CN')

    $prefs.set({ ...$prefs.get(), language: 'en' })
    expect($locale.get()).toBe('en-US')
  })

  it("is the chosen language's own when nothing the system lists is in it", () => {
    $env.set({ ...ENV, languages: ['zh-Hans-CN'] })
    $prefs.set({ ...$prefs.get(), language: 'en' })

    expect($locale.get()).toBe('en')
    expect(new Date(2026, 9, 14).toLocaleDateString($locale.get(), { weekday: 'long', month: 'long', day: 'numeric' })).toBe('Wednesday, October 14')
  })
})
