// When the microphone has to be reopened, and when it must not be. Pure on purpose: the reasons are
// a table of cases, and audio-capture.ts stays thin enough to be read at a glance. See docs/VOICE.md.
import type { DeviceChoiceReason } from '../audio-devices.ts'

/**
 * The device the open stream is on. `groupId` is `''` when the platform reports none (some virtual
 * and Linux devices), and the device id is then what identifies it.
 */
export interface CaptureBinding {
  deviceId: string
  groupId: string
}

/** What the device list resolves to right now, in the shape the policy compares. */
export interface CaptureTarget {
  deviceId: string | null
  groupId: string | null
  reason: DeviceChoiceReason
}

export interface CaptureState {
  /** The device the open stream is on, or null while the microphone is closed. */
  binding: CaptureBinding | null
  /** True while a conversation is listening: a system change waits, a person's choice does not. */
  conversing: boolean
  /**
   * When the recent reopens the system caused happened, for the guard against a reopen loop. A
   * person's pick is never counted: picking four microphones in a row is not a device flapping.
   */
  attempts: number[]
}

export type CaptureEvent =
  | { kind: 'opened'; deviceId: string | null; groupId: string }
  | { kind: 'closed' }
  | { kind: 'conversation'; conversing: boolean }
  | { kind: 'lost'; target: CaptureTarget }
  | { kind: 'chosen'; target: CaptureTarget }
  | { kind: 'devices'; target: CaptureTarget }

export type CaptureAction =
  | { kind: 'none' }
  | { kind: 'reopen'; deviceId: string | null; because: 'lost' | 'chosen' | 'devices' }
  | { kind: 'defer'; deviceId: string | null }
  | { kind: 'giveUp' }

/** Reopen attempts allowed inside the window before the shell stops and tells the person. */
export const MAX_REOPENS = 3
export const REOPEN_WINDOW_MS = 10_000

export function initialCaptureState(): CaptureState {
  return { binding: null, conversing: false, attempts: [] }
}

/**
 * The next action and state for one event. The shell applies the action and, after a reopen, feeds
 * the result back with `opened`.
 */
export function reduceCapture(state: CaptureState, event: CaptureEvent, now: number): { action: CaptureAction; state: CaptureState } {
  switch (event.kind) {
    case 'opened':
      return { action: { kind: 'none' }, state: { ...state, binding: deviceIdIn(event) } }

    case 'closed':
      return { action: { kind: 'none' }, state: { ...state, binding: null } }

    case 'conversation':
      return { action: { kind: 'none' }, state: { ...state, conversing: event.conversing } }

    case 'chosen':
      // A person asked for this device, so it applies even in the middle of a conversation, and
      // outside the guard.
      return sameDevice(state.binding, event.target) ? { action: { kind: 'none' }, state } : { action: { kind: 'reopen', deviceId: event.target.deviceId, because: 'chosen' }, state: { ...state, binding: null } }

    case 'devices':
      if (sameDevice(state.binding, event.target) || event.target.reason === 'unavailable') {
        return { action: { kind: 'none' }, state }
      }

      // The system changed under us: never cut into a sentence that is already being listened to.
      return state.conversing ? { action: { kind: 'defer', deviceId: event.target.deviceId }, state } : attemptReopen(state, event.target.deviceId, 'devices', now)

    case 'lost':
      return attemptReopen(state, event.target.deviceId, 'lost', now)
  }
}

/** Drop attempts older than the window, so the guard covers a burst and not the whole session. */
export function recentAttempts(attempts: readonly number[], now: number): number[] {
  return attempts.filter(at => now - at < REOPEN_WINDOW_MS)
}

function attemptReopen(state: CaptureState, deviceId: string | null, because: 'lost' | 'devices', now: number): { action: CaptureAction; state: CaptureState } {
  const attempts = recentAttempts(state.attempts, now)

  if (attempts.length >= MAX_REOPENS) {
    return { action: { kind: 'giveUp' }, state: { ...state, attempts } }
  }

  return { action: { kind: 'reopen', deviceId, because }, state: { ...state, attempts: [...attempts, now], binding: null } }
}

/**
 * Same device, judged by the group when both sides report one, and by the id otherwise. The shell
 * binds a stream opened without a device constraint (whose track reports `default`) to the id of
 * the device it resolved to, so the ids compare like with like.
 */
function sameDevice(binding: CaptureBinding | null, target: CaptureTarget): boolean {
  if (!binding) {
    return false
  }

  if (binding.groupId && target.groupId) {
    return binding.groupId === target.groupId
  }

  return target.deviceId !== null && binding.deviceId === target.deviceId
}

function deviceIdIn(event: { deviceId: string | null; groupId: string }): CaptureBinding | null {
  return event.deviceId ? { deviceId: event.deviceId, groupId: event.groupId } : null
}
