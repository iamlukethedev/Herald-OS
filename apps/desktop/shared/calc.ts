/*
 * Herald Calc: the sentence notepad, the keypads and the exact math tool Hermes uses. Shared by
 * Electron main (the notes, the history and the currency rates, all in Herald's data folder) and
 * the renderer. The rates are the app's only network call: the European Central Bank's daily
 * reference rates through Frankfurter, at most once a day, with nothing personal in the request.
 */

/** The ECB's reference rates through Frankfurter (frankfurter.dev): free, keyless, and its operators log no personal data. */
export const CALC_RATES_URL = 'https://api.frankfurter.dev/v2/providers/ecb/rates'
/** Rates fetched within this long are not fetched again. */
export const CALC_RATES_MAX_AGE_MS = 24 * 60 * 60_000
/** A fetch that failed is not tried again sooner than this, unless asked to refresh. */
export const CALC_RATES_RETRY_MS = 60 * 60_000

/** How much of each currency one euro buys, on the day the ECB published it. */
export interface CalcRates {
  base: 'EUR'
  /** The ECB's own date for these rates, YYYY-MM-DD. */
  date: string
  /** When Herald fetched them, epoch ms. */
  fetchedAt: number
  /** ISO 4217 code -> units of that currency per euro; EUR itself is 1. */
  rates: Record<string, number>
}

/**
 * The first of these that holds. off: the setting is off; nothing is fetched and the last rates
 * answer, or none. none: no rates yet; `error` says why when the last fetch failed. offline: the
 * last fetch failed; the rates from before it answer. fresh: fetched within CALC_RATES_MAX_AGE_MS.
 * cached: older rates, read without fetching because the caller asked for the cache only.
 */
export type CalcRatesStatus = 'fresh' | 'cached' | 'offline' | 'off' | 'none'

export interface CalcRatesState {
  rates: CalcRates | null
  status: CalcRatesStatus
  /** Why the last fetch failed, in a few plain words. */
  error?: string
}

export interface CalcNote {
  /** CALC_NOTE_ID. */
  id: string
  text: string
  createdAt: number
  updatedAt: number
}

export interface CalcNoteSummary {
  id: string
  /** noteTitle of its text. */
  title: string
  /** The first lines after the title, flattened and short. */
  preview: string
  createdAt: number
  updatedAt: number
}

export const CALC_NOTE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
/** A note longer than this is refused rather than cut. */
export const CALC_NOTE_MAX_CHARS = 200_000
export const CALC_NOTES_MAX = 500

/** Where a calculation came from. */
export type CalcSource = 'notes' | 'keypad' | 'voice' | 'hermes' | 'command'
export const CALC_SOURCES: readonly CalcSource[] = ['notes', 'keypad', 'voice', 'hermes', 'command']

export interface CalcHistoryEntry {
  id: string
  at: number
  /** What was asked, as typed or said: "20% of 84.50". */
  input: string
  /** The answer as Herald showed it: "16.90". */
  result: string
  source: CalcSource
  /** Words that help find it again: the note's title and the line's label ("Mortgage · monthly"). */
  context?: string
}

export type CalcHistoryInput = Omit<CalcHistoryEntry, 'id' | 'at'> & { at?: number }

/** The history keeps this many entries; the oldest go first. */
export const CALC_HISTORY_MAX = 2000
export const CALC_HISTORY_TEXT_MAX = 2000

export type CalcChange = 'notes' | 'history' | 'rates'

export type CalcKeypad = 'classic' | 'scientific' | 'programmer'
export const CALC_KEYPADS: readonly CalcKeypad[] = ['classic', 'scientific', 'programmer']

/** Herald Calc's preferences in prefs.json. */
export interface CalcPrefs {
  /** Fetch the ECB rates at most once a day; off, the last rates keep answering and nothing is fetched. */
  fetchRates: boolean
  /** Soft key sounds, synthesized with Web Audio. */
  sounds: boolean
  /** How the scientific keypad reads angles. */
  angle: 'deg' | 'rad'
  /** The keypad shown last. */
  keypad: CalcKeypad
}

export const CALC_PREFS_DEFAULTS: CalcPrefs = { fetchRates: true, sounds: false, angle: 'deg', keypad: 'classic' }

type Unsubscribe = () => void

/** window.heraldOS.calc. */
export interface CalcBridge {
  /**
   * The rates: fetched first when a fetch is due and allowed, then the cached ones. `cached` never
   * fetches; `refresh` fetches now unless the setting is off. Never rejects: a failed fetch shows
   * in the status.
   */
  rates: (options?: { cached?: boolean; refresh?: boolean }) => Promise<CalcRatesState>
  listNotes: () => Promise<CalcNoteSummary[]>
  readNote: (id: string) => Promise<CalcNote | null>
  /** Create a note (no id) or replace one; the note as saved. */
  saveNote: (note: { id?: string; text: string }) => Promise<CalcNote>
  deleteNote: (id: string) => Promise<void>
  /** Newest first. */
  history: (limit?: number) => Promise<CalcHistoryEntry[]>
  addHistory: (entries: CalcHistoryInput[]) => Promise<void>
  clearHistory: () => Promise<void>
  /** Any window changed the notes, the history or the rates. */
  onChanged: (listener: (what: CalcChange) => void) => Unsubscribe
}

/** A note's name: its first line with text, without a heading's # or a comment's //, at most 60 characters. */
export function noteTitle(text: string): string {
  const line = text.split('\n').find(candidate => candidate.trim() !== '') ?? ''
  const title = line
    .trim()
    .replace(/^(#+|\/\/)\s*/, '')
    .trim()

  return title.length > 60 ? `${title.slice(0, 59)}…` : title || 'Untitled'
}

/** What a note's list row shows under its title. */
export function notePreview(text: string): string {
  const lines = text.split('\n').filter(line => line.trim() !== '')
  const preview = lines.slice(1, 4).join(' · ').replace(/\s+/g, ' ').trim()

  return preview.length > 120 ? `${preview.slice(0, 119)}…` : preview
}

export function normalizeCalcPrefs(raw: unknown): CalcPrefs {
  const source = record(raw)

  return {
    fetchRates: source.fetchRates !== false,
    sounds: source.sounds === true,
    angle: source.angle === 'rad' ? 'rad' : 'deg',
    keypad: CALC_KEYPADS.includes(source.keypad as CalcKeypad) ? (source.keypad as CalcKeypad) : CALC_PREFS_DEFAULTS.keypad
  }
}

/** `patch` over `current`, field by field; a field left undefined keeps its value. */
export function mergeCalcPrefs(current: unknown, patch: unknown): CalcPrefs {
  const change = Object.fromEntries(Object.entries(record(patch)).filter(([, value]) => value !== undefined))

  return normalizeCalcPrefs({ ...record(current), ...change })
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
