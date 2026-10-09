import { describe, expect, it } from 'vitest'
import { normalizeVoicePrefs, VOICE_DEFAULTS } from './voice-prefs.ts'

describe('normalizeVoicePrefs', () => {
  it('fills defaults for missing or malformed values', () => {
    expect(normalizeVoicePrefs(undefined)).toEqual(VOICE_DEFAULTS)
    expect(normalizeVoicePrefs('junk')).toEqual(VOICE_DEFAULTS)
  })

  it('keeps valid values and clamps numbers', () => {
    const prefs = normalizeVoicePrefs({ enabled: true, engine: 'live', liveIdleSeconds: 5, liveDailyCapMinutes: 99_999, followUpSeconds: 12, liveUsage: { day: '2026-09-22', seconds: 120 } })
    expect(prefs.enabled).toBe(true)
    expect(prefs.engine).toBe('live')
    expect(prefs.liveIdleSeconds).toBe(10)
    expect(prefs.liveDailyCapMinutes).toBe(24 * 60)
    expect(prefs.followUpSeconds).toBe(12)
    expect(prefs.liveUsage).toEqual({ day: '2026-09-22', seconds: 120 })
  })

  it('rejects unknown engines', () => {
    expect(normalizeVoicePrefs({ engine: 'realtime' }).engine).toBe('chained')
  })

  it('starts with no device chosen and the full volume', () => {
    expect(VOICE_DEFAULTS.inputDevice).toBeNull()
    expect(VOICE_DEFAULTS.outputDevice).toBeNull()
    expect(VOICE_DEFAULTS.outputVolume).toBe(100)
  })

  it('keeps a well-formed device choice', () => {
    const prefs = normalizeVoicePrefs({ inputDevice: { id: 'i-tonor', label: 'Tonor (USB)' }, outputDevice: { id: 'o-airpods', label: 'AirPods (Bluetooth)' } })
    expect(prefs.inputDevice).toEqual({ id: 'i-tonor', label: 'Tonor (USB)' })
    expect(prefs.outputDevice).toEqual({ id: 'o-airpods', label: 'AirPods (Bluetooth)' })
  })

  it('drops a device choice that is not a pair of strings', () => {
    expect(normalizeVoicePrefs({ inputDevice: 'Tonor' }).inputDevice).toBeNull()
    expect(normalizeVoicePrefs({ inputDevice: { id: '', label: 'Tonor' } }).inputDevice).toBeNull()
    expect(normalizeVoicePrefs({ inputDevice: { id: 42, label: 'Tonor' } }).inputDevice).toBeNull()
    expect(normalizeVoicePrefs({ inputDevice: { id: 'i1' } }).inputDevice).toBeNull()
    expect(normalizeVoicePrefs({ outputDevice: { id: 'o1', label: 'x'.repeat(201) } }).outputDevice).toBeNull()
    expect(normalizeVoicePrefs({ outputDevice: { id: 'o'.repeat(257), label: 'x' } }).outputDevice).toBeNull()
    expect(normalizeVoicePrefs(null).outputDevice).toBeNull()
  })

  it('clamps the Herald volume to whole percent', () => {
    expect(normalizeVoicePrefs({ outputVolume: 45.6 }).outputVolume).toBe(46)
    expect(normalizeVoicePrefs({ outputVolume: 250 }).outputVolume).toBe(100)
    expect(normalizeVoicePrefs({ outputVolume: -10 }).outputVolume).toBe(0)
    expect(normalizeVoicePrefs({ outputVolume: 'loud' }).outputVolume).toBe(100)
  })
})
