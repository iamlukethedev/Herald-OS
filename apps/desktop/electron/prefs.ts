import fs from 'node:fs'
import path from 'node:path'
import { CALC_PREFS_DEFAULTS, mergeCalcPrefs, normalizeCalcPrefs } from '../shared/calc.ts'
import { type EventAutomation, isEventName } from '../shared/events.ts'
import { languageSetting } from '../shared/i18n.ts'
import type { ContinuityPrefs, CrashHelpPrefs, HeraldOSPrefs, NotifyPrefs, PrefsPatch } from '../shared/ipc.ts'
import { normalizeMenuBar } from '../shared/menu-bar.ts'
import { NOTIFY_DEFAULTS, normalizeNotifyPrefs } from '../shared/notify-prefs.ts'
import { normalizeCommentName } from '../shared/office/comment-name.ts'
import { normalizePetPrefs, PET_PREFS_DEFAULTS } from '../shared/pet.ts'
import { mergeRoomPrefs, normalizeRoomPrefs, ROOM_PREFS_DEFAULTS } from '../shared/room.ts'
import { normalizeVoicePrefs, VOICE_DEFAULTS } from '../shared/voice-prefs.ts'
import { heraldOsDataDir } from './paths.ts'

const CONTINUITY_DEFAULTS: ContinuityPrefs = { enabled: null, exclude: [] }
const CRASH_HELP_DEFAULTS: CrashHelpPrefs = { enabled: true, muted: [] }

const DEFAULTS: HeraldOSPrefs = {
  voice: VOICE_DEFAULTS,
  continuity: CONTINUITY_DEFAULTS,
  crashHelp: CRASH_HELP_DEFAULTS,
  notify: NOTIFY_DEFAULTS,
  pet: PET_PREFS_DEFAULTS,
  room: ROOM_PREFS_DEFAULTS,
  calc: CALC_PREFS_DEFAULTS,
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
      language: languageSetting(parsed.language),
      accent: (accent as HeraldOSPrefs['accent']) ?? DEFAULTS.accent,
      spaces: parsed.spaces?.length ? parsed.spaces : DEFAULTS.spaces,
      voice: normalizeVoicePrefs(parsed.voice),
      continuity: normalizeContinuity(parsed.continuity),
      crashHelp: normalizeCrashHelp(parsed.crashHelp),
      notify: normalizeNotifyPrefs(parsed.notify),
      pet: normalizePetPrefs(parsed.pet),
      room: normalizeRoomPrefs(parsed.room),
      calc: normalizeCalcPrefs(parsed.calc),
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

export function writePrefs(patch: PrefsPatch): HeraldOSPrefs {
  const current = readPrefs()
  const notify = { ...storedNotify(), ...explicitNotify(patch.notify) }
  // Nested objects are patched field by field by their callers; merge instead of replacing.
  const next = {
    ...current,
    ...patch,
    voice: normalizeVoicePrefs({ ...current.voice, ...(patch.voice ?? {}) }),
    continuity: normalizeContinuity({ ...current.continuity, ...(patch.continuity ?? {}) }),
    crashHelp: normalizeCrashHelp({ ...current.crashHelp, ...(patch.crashHelp ?? {}) }),
    notify: normalizeNotifyPrefs(notify),
    pet: normalizePetPrefs({ ...current.pet, ...(patch.pet ?? {}) }),
    room: mergeRoomPrefs(current.room, patch.room),
    calc: mergeCalcPrefs(current.calc, patch.calc),
    ...('commentName' in patch ? { commentName: normalizeCommentName(patch.commentName) || undefined } : {}),
    ...('language' in patch ? { language: languageSetting(patch.language) } : {}),
    ...(patch.menuBar ? { menuBar: normalizeMenuBar({ ...current.menuBar, ...patch.menuBar }) } : {})
  }
  fs.mkdirSync(heraldOsDataDir(), { recursive: true })
  // Only the switches someone set go to disk, so a later migration can tell them from the defaults.
  fs.writeFileSync(prefsFile(), JSON.stringify({ ...next, notify }, null, 2))

  return next
}

/** The known Alerts switches in `value` that hold a boolean; everything else is dropped. */
function explicitNotify(value: unknown): Partial<NotifyPrefs> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(Object.entries(value).filter(([key, flag]) => Object.hasOwn(NOTIFY_DEFAULTS, key) && typeof flag === 'boolean'))
}

/** The Alerts switches as saved on disk, before defaults fill the gaps; none when the file is missing or unreadable. */
function storedNotify(): Partial<NotifyPrefs> {
  try {
    return explicitNotify((JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) as { notify?: unknown } | null)?.notify)
  } catch {
    return {}
  }
}

/** Switches a window kept in localStorage: each one is saved only when prefs.json has no value for it yet. */
export function adoptLegacyNotify(flags: unknown): HeraldOSPrefs {
  // Comes over IPC: only known switches holding a boolean count.
  const saved = storedNotify()
  const missing = Object.fromEntries(Object.entries(explicitNotify(flags)).filter(([key]) => !Object.hasOwn(saved, key)))

  return Object.keys(missing).length ? writePrefs({ notify: missing }) : readPrefs()
}
