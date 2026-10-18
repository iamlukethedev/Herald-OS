import { afterEach, describe, expect, it } from 'vitest'
import { translate } from '../../../../shared/i18n.ts'
import { en } from '../../../../shared/locales/en.ts'
import { $prefs } from '../../../store/backend.ts'
import { t } from '../../../store/i18n.ts'
import { errorText } from './shared.tsx'

afterEach(() => {
  $prefs.set({ ...$prefs.get(), language: undefined })
})

describe('errorText', () => {
  it.each(['en', 'pt-BR', 'zh-CN'] as const)('translates a known message whatever its case or surrounding spaces in %s', language => {
    $prefs.set({ ...$prefs.get(), language })
    const translated = t('settings.agents.gatewayNotConnected')

    if (language !== 'en') {
      expect(translated).not.toBe(translate('en', 'settings.agents.gatewayNotConnected'))
      expect(translated).not.toBe(en['settings.agents.gatewayNotConnected'])
    }
    expect(errorText(new Error('gateway not connected'))).toBe(translated)
    expect(errorText('  Gateway Not Connected \n')).toBe(translated)
  })

  it('shows inherited object keys as they came, never as a lookup hit', () => {
    for (const message of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf']) {
      expect(errorText(new Error(message))).toBe(message)
      expect(errorText(message)).toBe(message)
    }
  })

  it('shows any other message exactly as it came, surrounding spaces included', () => {
    expect(errorText(new Error('Disk is full'))).toBe('Disk is full')
    expect(errorText('  Disk is full \n')).toBe('  Disk is full \n')
  })

  it('says something went wrong for an Error whose message is undefined', () => {
    const error = new Error('x')
    Object.defineProperty(error, 'message', { value: undefined })

    expect(() => errorText(error)).not.toThrow()
    expect(errorText(error)).toBe(t('settings.somethingWentWrong'))
  })

  it.each(['en', 'pt-BR', 'zh-CN'] as const)('says something went wrong in %s for an error with no text', language => {
    $prefs.set({ ...$prefs.get(), language })
    const generic = t('settings.somethingWentWrong')
    const nothing: [string, unknown][] = [
      ["new Error('')", new Error('')],
      ["new Error('  ')", new Error(' \n\t ')],
      ["''", ''],
      ['whitespace', ' \n\t '],
      ['undefined', undefined],
      ['null', null],
      ['{}', {}],
      ["new Error('[object Object]')", new Error('[object Object]')],
      ['an Error whose message is null', Object.defineProperty(new Error('x'), 'message', { value: null })],
      ['an Error whose message is {}', Object.defineProperty(new Error('x'), 'message', { value: {} })]
    ]

    for (const [what, error] of nothing) {
      expect(errorText(error), what).toBe(generic)
    }
  })

  it('shows text that only looks empty, such as "0" or "false", as it came', () => {
    expect(errorText(0)).toBe('0')
    expect(errorText(false)).toBe('false')
  })

  it.each(['en', 'pt-BR', 'zh-CN'] as const)('says something went wrong in %s for an Error whose message has no prototype', language => {
    $prefs.set({ ...$prefs.get(), language })
    const error = new Error('x')
    Object.defineProperty(error, 'message', { value: Object.create(null) })

    expect(() => errorText(error)).not.toThrow()
    expect(errorText(error)).toBe(t('settings.somethingWentWrong'))
  })

  it.each(['en', 'pt-BR', 'zh-CN'] as const)('says something went wrong in %s for a thrown object that has no prototype', language => {
    $prefs.set({ ...$prefs.get(), language })
    const thrown: unknown = Object.create(null)

    expect(() => errorText(thrown)).not.toThrow()
    expect(errorText(thrown)).toBe(t('settings.somethingWentWrong'))
  })

  it('says something went wrong for a thrown object whose toString throws', () => {
    const thrown = {
      toString() {
        throw new TypeError('no text')
      }
    }

    expect(errorText(thrown)).toBe(t('settings.somethingWentWrong'))
  })

  it.each(['pt-BR', 'zh-CN'] as const)('says something went wrong in %s, not in English', language => {
    $prefs.set({ ...$prefs.get(), language })
    const translated = t('settings.somethingWentWrong')

    expect(translated).not.toBe(en['settings.somethingWentWrong'])
    expect(translated).not.toBe(translate('en', 'settings.somethingWentWrong'))
    expect(errorText(Object.create(null))).toBe(translated)
  })

  it('shows a thrown object with text of its own as that text, translating a known one', () => {
    $prefs.set({ ...$prefs.get(), language: 'pt-BR' })

    expect(errorText({ toString: () => 'Disk is full' })).toBe('Disk is full')
    expect(errorText({ toString: () => 'gateway not connected' })).toBe(t('settings.agents.gatewayNotConnected'))
    expect(errorText(404)).toBe('404')
  })
})
