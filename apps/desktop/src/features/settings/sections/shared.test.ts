import { describe, expect, it } from 'vitest'
import { t } from '../../../store/i18n.ts'
import { errorText } from './shared.tsx'

describe('errorText', () => {
  it('translates a known message whatever its case or surrounding spaces', () => {
    const translated = t('settings.agents.gatewayNotConnected')

    expect(errorText(new Error('gateway not connected'))).toBe(translated)
    expect(errorText('  Gateway Not Connected \n')).toBe(translated)
  })

  it('shows inherited object keys as they came, never as a lookup hit', () => {
    for (const message of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf']) {
      expect(errorText(new Error(message))).toBe(message)
      expect(errorText(message)).toBe(message)
    }
  })

  it('shows any other message as it came', () => {
    expect(errorText(new Error('Disk is full'))).toBe('Disk is full')
  })
})
