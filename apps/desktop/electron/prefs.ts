import fs from 'node:fs'
import path from 'node:path'
import { type EventAutomation, isEventName } from '../shared/events.ts'
import type { ContinuityPrefs, CrashHelpPrefs, HeraldOSPrefs } from '../shared/ipc.ts'
import { normalizeMenuBar } from '../shared/menu-bar.ts'
import { normalizeCommentName } from '../shared/office/comment-name.ts'
import { normalizeVoicePrefs, VOICE_DEFAULTS } from '../shared/voice-prefs.ts'
import { heraldOsDataDir } from './paths.ts'

const CONTINUITY_DEFAULTS: ContinuityPrefs = { enabled: null, exclude: [] }
const CRASH_HELP_DEFAULTS: CrashHelpPrefs = { enabled: true, muted: [] }

const DEFAULTS: HeraldOSPrefs = {
  voice: VOICE_DEFAULTS,
  continuity: CONTINUITY_DEFAULTS,
  crashHelp: CRASH_HELP_DEFAULTS,
  fullscreenOnLaunch: true,
  reduceMotion: false,
  accent: 'blue',
  theme: 'ocean',
  spaces: [
    { id: 'personal', name: 'Personal', color: '#4d92ff' },
    { id: 'work', name: 'Work', color: '#36e6a6' },
    { id: 'ideas', name: 'Ideas', color: '#b47cff' }
  ],
  activeSpace: 'personal',
  favorites: []
}

function prefsFile(): string {
  return path.join(heraldOsDataDir(), 'prefs.json')
}

export function readPrefs(): HeraldOSPrefs {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) as Omit<Partial<HeraldOSPrefs>, 'accent'> & { accent?: string }
    // Accent names from the first alpha.
    const legacy: Record<string, HeraldOSPrefs['accent']> = { gold: 'blue', jade: 'violet', blue: 'blue', ice: 'ice', violet: 'violet' }
    const accent = parsed.accent ? legacy[parsed.accent] : undefined

    return {
      ...DEFAULTS,
      ...parsed,
      accent: (accent as HeraldOSPrefs['accent']) ?? DEFAULTS.accent,
      spaces: parsed.spaces?.length ? parsed.spaces : DEFAULTS.spaces,
      voice: normalizeVoicePrefs(parsed.voice),
      continuity: normalizeContinuity(parsed.continuity),
      crashHelp: normalizeCrashHelp(parsed.crashHelp),
      eventAutomations: normalizeEventAutomations(parsed.eventAutomations),
      commentName: normalizeCommentName(parsed.commentName) || undefined,
      ...(parsed.menuBar ? { menuBar: normalizeMenuBar(parsed.menuBar) } : {})
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function normalizeEventAutomations(value: unknown): EventAutomation[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  return value
    .filter((rule): rule is EventAutomation => Boolean(rule) && typeof rule === 'object' && isEventName((rule as EventAutomation).event) && typeof (rule as EventAutomation).jobId === 'string')
    .map(rule => {
      const match = rule.match && typeof rule.match === 'object' ? Object.fromEntries(Object.entries(rule.match).filter(([, v]) => typeof v === 'string' && v.trim())) : undefined

      return { event: rule.event, jobId: rule.jobId, enabled: rule.enabled !== false, ...(match && Object.keys(match).length ? { match } : {}) }
    })
}

function normalizeCrashHelp(value: Partial<CrashHelpPrefs> | undefined): CrashHelpPrefs {
  const muted = Array.isArray(value?.muted) ? [...new Set(value.muted.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map(entry => entry.trim()))] : []

  return { enabled: typeof value?.enabled === 'boolean' ? value.enabled : CRASH_HELP_DEFAULTS.enabled, muted }
}

function normalizeContinuity(value: Partial<ContinuityPrefs> | undefined): ContinuityPrefs {
  const enabled = typeof value?.enabled === 'boolean' ? value.enabled : null
  const exclude = Array.isArray(value?.exclude) ? value.exclude.filter((entry): entry is string => typeof entry === 'string') : []

  return { ...CONTINUITY_DEFAULTS, ...value, enabled, exclude }
}

export function writePrefs(patch: Partial<HeraldOSPrefs>): HeraldOSPrefs {
  const current = readPrefs()
  // Nested objects are patched field by field by their callers; merge instead of replacing.
  const next = {
    ...current,
    ...patch,
    voice: normalizeVoicePrefs({ ...current.voice, ...(patch.voice ?? {}) }),
    continuity: normalizeContinuity({ ...current.continuity, ...(patch.continuity ?? {}) }),
    crashHelp: normalizeCrashHelp({ ...current.crashHelp, ...(patch.crashHelp ?? {}) }),
    ...('commentName' in patch ? { commentName: normalizeCommentName(patch.commentName) || undefined } : {}),
    ...(patch.menuBar ? { menuBar: normalizeMenuBar({ ...current.menuBar, ...patch.menuBar }) } : {})
  }
  fs.mkdirSync(heraldOsDataDir(), { recursive: true })
  fs.writeFileSync(prefsFile(), JSON.stringify(next, null, 2))

  return next
}
