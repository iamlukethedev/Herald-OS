import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LanguageSetting } from '../../shared/i18n.ts'
import { $prefs } from '../store/backend.ts'
import { formatRelative, formatSpan, greetingFor } from './format.ts'

const choose = (language: LanguageSetting | undefined) => $prefs.set({ ...$prefs.get(), language })

describe('the formats that follow the language', () => {
  afterEach(() => {
    choose(undefined)
    vi.useRealTimers()
  })

  it('says how long ago, and gives an older date in the language', () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 14, 13, 0) })
    const now = Date.now()

    expect([formatRelative(now - 10_000), formatRelative(now - 5 * 60_000), formatRelative(now - 3 * 3_600_000), formatRelative(now - 2 * 86_400_000)]).toEqual(['just now', '5m ago', '3h ago', '2d ago'])

    choose('en')
    expect(formatRelative(new Date(2026, 8, 1).getTime())).toBe('Sep 1')
  })

  it('says how long an event lasts', () => {
    expect([formatSpan(45), formatSpan(60), formatSpan(90), formatSpan(0)]).toEqual(['45 min', '1 hr', '1 hr 30 min', ''])
  })

  it('greets by the hour', () => {
    const at = (hour: number) => greetingFor(new Date(2026, 9, 14, hour))

    expect([at(2), at(9), at(15), at(21)]).toEqual(['Good night', 'Good morning', 'Good afternoon', 'Good evening'])
  })
})
