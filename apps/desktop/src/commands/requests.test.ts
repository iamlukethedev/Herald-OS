// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandSource } from '../store/os-commands.ts'
import type { PendingRequest } from '../store/requests.ts'

const shell = vi.hoisted(() => ({ openSurface: vi.fn() }))

vi.mock('../store/shell.ts', async importOriginal => ({ ...(await importOriginal<typeof import('../store/shell.ts')>()), isPanels: true, isMainSurface: true, openSurface: shell.openSurface }))

const { $windowState } = await import('../store/backend.ts')
const { $pendingRequests } = await import('../store/requests.ts')
const { mayFocusRequest, REQUEST_FOCUS_EVERY_MS, REQUEST_RAISE_EVERY_MS, requestCommands, resetRequestFocus } = await import('./requests.ts')

const focusRequest = requestCommands.find(command => command.id === 'requests.focus')!
const run = (source: CommandSource = 'cli') => focusRequest.run({}, { source }) as { ok: boolean; summary: string }

function pending(...ids: string[]): void {
  $pendingRequests.set(ids.map(id => ({ kind: 'approval', request: { id, method: 'approval', params: {}, respond: vi.fn(), fail: vi.fn() }, receivedAt: 0 }) as unknown as PendingRequest))
}

function card(id: string): HTMLElement {
  const element = document.createElement('div')
  element.tabIndex = -1
  element.setAttribute('data-request-card', id)
  document.body.append(element)

  return element
}

let now = 1_000_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  resetRequestFocus()
  shell.openSurface.mockClear()
  $windowState.set({ fullscreen: false, focused: false })
  pending('r1')
  card('r1')
})

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
  $pendingRequests.set([])
  now += 10 * REQUEST_RAISE_EVERY_MS
})

const later = (ms: number) => vi.setSystemTime(Date.now() + ms)

describe('who may go to a waiting request', () => {
  it('lets keys, the command bar, voice and Herald itself, and the CLI only in the Herald OS Linux session', () => {
    for (const source of ['shortcut', 'palette', 'voice', 'ui'] as const) {
      expect(mayFocusRequest(source, false), source).toBe(true)
      expect(mayFocusRequest(source, true), source).toBe(true)
    }

    expect(mayFocusRequest('cli', true)).toBe(true)
    expect(mayFocusRequest('cli', false)).toBe(false)
  })

  it("never lets Hermes's tool, plugins or the follow view", () => {
    for (const source of ['agent', 'plugin', 'follow'] as const) {
      expect(mayFocusRequest(source, true), source).toBe(false)
      expect(run(source).ok, source).toBe(false)
    }

    expect(shell.openSurface).not.toHaveBeenCalled()
  })
})

describe('the rate limit', () => {
  it('goes once a second at most, from any source', () => {
    expect(run('cli').ok).toBe(true)
    expect(run('cli').ok).toBe(false)
    expect(run('shortcut').ok).toBe(false)

    later(REQUEST_FOCUS_EVERY_MS - 1)
    expect(run('shortcut').ok).toBe(false)

    later(1)
    expect(run('shortcut').ok).toBe(true)
  })

  it('does not count a refused source against the person', () => {
    expect(run('agent').ok).toBe(false)
    expect(run('shortcut').ok).toBe(true)
  })
})

describe('raising the Hermes window', () => {
  it('raises it when it does not have the focus', () => {
    run()

    expect(shell.openSurface).toHaveBeenCalledTimes(1)
    expect(shell.openSurface).toHaveBeenCalledWith('main')
  })

  it('leaves it alone when it already has the focus', () => {
    $windowState.set({ fullscreen: false, focused: true })

    expect(run().ok).toBe(true)
    expect(shell.openSurface).not.toHaveBeenCalled()
  })

  it('raises it once per request, not on every call, and again only after a while', () => {
    run()
    for (let call = 0; call < 5; call++) {
      later(REQUEST_FOCUS_EVERY_MS)
      expect(run().ok).toBe(true)
    }

    expect(shell.openSurface).toHaveBeenCalledTimes(1)

    later(REQUEST_RAISE_EVERY_MS)
    run()
    expect(shell.openSurface).toHaveBeenCalledTimes(2)
  })

  it('raises it again for a new request', () => {
    run()
    pending('r2')
    card('r2')
    later(REQUEST_FOCUS_EVERY_MS)

    run()

    expect(shell.openSurface).toHaveBeenCalledTimes(2)
  })
})

describe('where it goes', () => {
  it("goes to the oldest request's card, wherever it is on the page", () => {
    document.body.replaceChildren()
    const second = card('r2')
    const first = card('r1')
    pending('r1', 'r2')

    expect(run('shortcut').ok).toBe(true)

    expect(document.activeElement).toBe(first)
    expect(document.activeElement).not.toBe(second)
  })
})
