import { describe, expect, it } from 'vitest'
import { initialCaptureState, MAX_REOPENS, reduceCapture, REOPEN_WINDOW_MS, recentAttempts, type CaptureState, type CaptureTarget } from './capture-policy.ts'

const TONOR: CaptureTarget = { deviceId: 'i-tonor', groupId: 'g-tonor', reason: 'chosen' }
const SYSTEM: CaptureTarget = { deviceId: 'i-airpods', groupId: 'g-airpods', reason: 'automatic' }
const NOTHING: CaptureTarget = { deviceId: null, groupId: null, reason: 'unavailable' }

const open = (state: CaptureState, deviceId: string, groupId: string) => reduceCapture(state, { kind: 'opened', deviceId, groupId }, 0).state

describe('reduceCapture', () => {
  it('binds the stream on open, and unbinds it on close', () => {
    const bound = open(initialCaptureState(), 'default', 'g-tonor')
    expect(bound.binding).toEqual({ deviceId: 'default', groupId: 'g-tonor' })
    expect(reduceCapture(bound, { kind: 'closed' }, 1).state.binding).toBeNull()
  })

  it('leaves the binding empty when no device was opened', () => {
    expect(open(initialCaptureState(), 'default', 'g').binding).not.toBeNull()
    expect(reduceCapture(initialCaptureState(), { kind: 'opened', deviceId: null, groupId: null }, 0).state.binding).toBeNull()
  })

  it('does nothing when the system change resolves to the device already open', () => {
    const bound = open(initialCaptureState(), 'default', 'g-tonor')
    const conversing = { ...bound, conversing: true }
    const { action, state: next } = reduceCapture(conversing, { kind: 'devices', target: { ...TONOR, deviceId: 'i-tonor' } }, 5)
    expect(action).toEqual({ kind: 'none' })
    expect(next).toBe(conversing)
  })

  it('reopens on the system device when the chosen one is unplugged', () => {
    const state = open(initialCaptureState(), 'default', 'g-tonor')
    const { action } = reduceCapture(state, { kind: 'devices', target: SYSTEM }, 10)
    expect(action).toEqual({ kind: 'reopen', deviceId: 'i-airpods', because: 'devices' })
  })

  it('reopens on the chosen device when it comes back', () => {
    const state = open(initialCaptureState(), 'default', 'g-airpods')
    const { action } = reduceCapture(state, { kind: 'devices', target: TONOR }, 10)
    expect(action).toEqual({ kind: 'reopen', deviceId: 'i-tonor', because: 'devices' })
  })

  it('defers a system change while a conversation is listening', () => {
    const state = { ...open(initialCaptureState(), 'default', 'g-tonor'), conversing: true }
    expect(reduceCapture(state, { kind: 'devices', target: SYSTEM }, 10).action).toEqual({ kind: 'defer', deviceId: 'i-airpods' })
  })

  it('applies a person\'s choice immediately, even mid-conversation', () => {
    const state = { ...open(initialCaptureState(), 'default', 'g-tonor'), conversing: true }
    expect(reduceCapture(state, { kind: 'chosen', target: SYSTEM }, 10).action).toEqual({ kind: 'reopen', deviceId: 'i-airpods', because: 'chosen' })
  })

  it('reopens straight away when the device is lost, conversation or not', () => {
    const state = { ...open(initialCaptureState(), 'default', 'g-tonor'), conversing: true }
    expect(reduceCapture(state, { kind: 'lost', target: SYSTEM }, 10).action).toEqual({ kind: 'reopen', deviceId: 'i-airpods', because: 'lost' })
  })

  it('does nothing when a change resolves to no device at all', () => {
    const state = open(initialCaptureState(), 'default', 'g-tonor')
    expect(reduceCapture(state, { kind: 'devices', target: NOTHING }, 10).action).toEqual({ kind: 'none' })
  })

  it('gives up after three reopen attempts inside the window, and counts them in the state', () => {
    let state = open(initialCaptureState(), 'default', 'g-airpods')
    const actions = []

    for (let i = 0; i < MAX_REOPENS + 1; i++) {
      const result = reduceCapture(state, { kind: 'devices', target: TONOR }, 100 + i * 1000)
      actions.push(result.action.kind)
      state = result.state
    }

    expect(actions).toEqual(['reopen', 'reopen', 'reopen', 'giveUp'])
    expect(state.attempts).toHaveLength(MAX_REOPENS)
  })

  it('allows reopening again once the window has passed', () => {
    let state = open(initialCaptureState(), 'default', 'g-airpods')

    for (let i = 0; i < MAX_REOPENS; i++) {
      state = reduceCapture(state, { kind: 'devices', target: TONOR }, 1_000 + i * 1_000).state
    }

    expect(state.attempts).toHaveLength(MAX_REOPENS)

    const late = reduceCapture(state, { kind: 'devices', target: TONOR }, 1_000 + MAX_REOPENS * 1_000 + REOPEN_WINDOW_MS)
    expect(late.action.kind).toBe('reopen')
    expect(late.state.attempts).toHaveLength(1)
  })

  it('forgets an attempt made outside the window', () => {
    expect(recentAttempts([0, 9_000], 10_500)).toEqual([9_000])
  })
})
