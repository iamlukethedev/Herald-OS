// Voice preference defaults, shared by Electron main (prefs.json) and the renderer ($prefs seed)
// so a partially written `voice` object always resolves to a complete one.
import type { AudioDevicePref, VoicePrefs } from './ipc.ts'

export const DEFAULT_VOICE_HOTKEY = 'Alt+Space'

export const VOICE_DEFAULTS: VoicePrefs = {
  enabled: false,
  engine: 'chained',
  wakeWord: false,
  hotkey: DEFAULT_VOICE_HOTKEY,
  followUpSeconds: 8,
  announceNotifications: false,
  followHermes: false,
  sttTuned: false,
  liveIdleSeconds: 45,
  liveDailyCapMinutes: 60,
  liveUsage: { day: '', seconds: 0 },
  inputDevice: null,
  outputDevice: null,
  outputVolume: 100
}

/** Longest device id and label kept from storage; longer values are malformed, not useful. */
const MAX_DEVICE_ID = 256
const MAX_DEVICE_LABEL = 200

/** Merge a possibly partial or malformed stored value onto the defaults. */
export function normalizeVoicePrefs(raw: unknown): VoicePrefs {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<VoicePrefs>
  const usage = source.liveUsage && typeof source.liveUsage === 'object' ? source.liveUsage : VOICE_DEFAULTS.liveUsage

  return {
    ...VOICE_DEFAULTS,
    ...source,
    engine: source.engine === 'live' ? 'live' : 'chained',
    hotkey: typeof source.hotkey === 'string' ? source.hotkey : VOICE_DEFAULTS.hotkey,
    followUpSeconds: clampNumber(source.followUpSeconds, 0, 120, VOICE_DEFAULTS.followUpSeconds),
    liveIdleSeconds: clampNumber(source.liveIdleSeconds, 10, 600, VOICE_DEFAULTS.liveIdleSeconds),
    liveDailyCapMinutes: clampNumber(source.liveDailyCapMinutes, 0, 24 * 60, VOICE_DEFAULTS.liveDailyCapMinutes),
    liveUsage: { day: typeof usage.day === 'string' ? usage.day : '', seconds: clampNumber(usage.seconds, 0, Number.MAX_SAFE_INTEGER, 0) },
    inputDevice: normalizeDevicePref(source.inputDevice),
    outputDevice: normalizeDevicePref(source.outputDevice),
    outputVolume: Math.round(clampNumber(source.outputVolume, 0, 100, VOICE_DEFAULTS.outputVolume))
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

/**
 * A stored device choice, or `null` for "follow the system". The spread above would keep any shape
 * a hand-edited prefs.json holds, so this is the only thing that decides what a choice looks like.
 */
function normalizeDevicePref(value: unknown): AudioDevicePref | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const { id, label } = value as Partial<AudioDevicePref>

  if (typeof id !== 'string' || id.trim().length === 0 || id.length > MAX_DEVICE_ID) {
    return null
  }

  if (typeof label !== 'string' || label.length > MAX_DEVICE_LABEL) {
    return null
  }

  return { id, label }
}
