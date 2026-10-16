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

  it('does not throw for an Error whose message is not a string', () => {
    const error = new Error('x')
    Object.defineProperty(error, 'message', { value: undefined })

    expect(() => errorText(error)).not.toThrow()
    expect(errorText(error)).toBe(String(undefined))
  })
})
