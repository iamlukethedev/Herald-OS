import { CALC_KEYPADS, CALC_NOTE_MAX_CHARS, type CalcKeypad } from '../../../shared/calc.ts'
import type { GraphRequest, GraphSeries } from './graph/types.ts'

/* What opens Herald Calc on something: a command, voice, Hermes, another app. */

export type CalcView = 'notes' | 'keypad' | 'graph' | 'history'
export const CALC_VIEWS: readonly CalcView[] = ['notes', 'keypad', 'graph', 'history']

export interface CalcRequest {
  view?: CalcView
  keypad?: CalcKeypad
  /** Start a new note with this text. */
  text?: string
  /** Draw these in the Graph view. */
  plot?: GraphRequest
  /** Show the history searched for this. */
  search?: string
  /** When it was asked; a window acts on each request once. */
  at: number
}

const MAX_POINTS = 20_000
const MAX_ENTRIES = 24
const MAX_SERIES = 12
const MAX_ENTRY_CHARS = 500
const MAX_SEARCH_CHARS = 500

/** A request from a window payload, checked field by field; null when it holds none. */
export function readCalcRequest(payload: unknown): CalcRequest | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }

  const source = payload as Record<string, unknown>

  if (typeof source.at !== 'number' || !Number.isFinite(source.at)) {
    return null
  }

  const request: CalcRequest = { at: source.at }

  if (CALC_VIEWS.includes(source.view as CalcView)) {
    request.view = source.view as CalcView
  }

  if (CALC_KEYPADS.includes(source.keypad as CalcKeypad)) {
    request.keypad = source.keypad as CalcKeypad
  }

  // Main refuses a note this long rather than cutting it, so the request does too.
  if (typeof source.text === 'string' && source.text.trim() && source.text.length <= CALC_NOTE_MAX_CHARS) {
    request.text = source.text
  }

  if (typeof source.search === 'string') {
    request.search = source.search.trim().slice(0, MAX_SEARCH_CHARS)
  }

  const plot = readPlot(source.plot)

  if (plot) {
    request.plot = plot
  }

  return request
}

function readPlot(raw: unknown): GraphRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const source = raw as Record<string, unknown>
  const entries = Array.isArray(source.entries)
    ? source.entries
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '' && entry.length <= MAX_ENTRY_CHARS)
        .map(entry => entry.trim())
        .slice(0, MAX_ENTRIES)
    : []
  const series = Array.isArray(source.series)
    ? source.series
        .map(readSeries)
        .filter((entry): entry is GraphSeries => entry !== null)
        .slice(0, MAX_SERIES)
    : []
  const plot: GraphRequest = {}

  if (entries.length) {
    plot.entries = entries
  }

  if (series.length) {
    plot.series = series
  }

  if (typeof source.xMin === 'number' && typeof source.xMax === 'number' && Number.isFinite(source.xMin) && Number.isFinite(source.xMax) && source.xMin < source.xMax) {
    plot.xMin = source.xMin
    plot.xMax = source.xMax
  }

  return plot.entries || plot.series ? plot : null
}

function readSeries(raw: unknown): GraphSeries | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const source = raw as Record<string, unknown>
  const points = Array.isArray(source.points)
    ? source.points
        .slice(0, MAX_POINTS)
        .filter((point): point is [number, number] => Array.isArray(point) && point.length === 2 && point.every(value => typeof value === 'number' && Number.isFinite(value)))
    : []
  const label = typeof source.label === 'string' && source.label.trim() ? source.label.trim() : 'Data'

  return points.length ? { label, points } : null
}

/** What a request asks of the window, the view first: the one it names, or else the one its contents imply. */
export interface CalcRequestPlan {
  view: CalcView | null
  keypad?: CalcKeypad
  text?: string
  plot?: GraphRequest
  search?: string
}

export function planRequest(request: CalcRequest): CalcRequestPlan {
  const implied: CalcView | null = request.plot ? 'graph' : request.search !== undefined ? 'history' : request.keypad ? 'keypad' : request.text ? 'notes' : null

  return { view: request.view ?? implied, keypad: request.keypad, text: request.text, plot: request.plot, search: request.search }
}

/**
 * A check that passes once for each request's `at`. The same request can come twice (as the
 * window's payload and through the store) and again when the window mounts anew.
 */
export function createRequestGate(remember = 64): (request: CalcRequest) => boolean {
  const seen: number[] = []

  return request => {
    if (seen.includes(request.at)) {
      return false
    }

    seen.push(request.at)

    if (seen.length > remember) {
      seen.shift()
    }

    return true
  }
}
