// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PendingRequest } from '../store/requests.ts'

/** The command as a window of each kind loads it, with the Hermes window unfocused and one request waiting. */
async function loadIn({ panels, main }: { panels: boolean; main: boolean }) {
  vi.resetModules()
  const openSurface = vi.fn()
  vi.doMock('../store/shell.ts', async importOriginal => ({ ...(await importOriginal<typeof import('../store/shell.ts')>()), isPanels: panels, isMainSurface: main, openSurface }))
  const { $windowState } = await import('../store/backend.ts')
  const { $pendingRequests } = await import('../store/requests.ts')
  const { requestCommands } = await import('./requests.ts')
  $windowState.set({ fullscreen: false, focused: false })
  $pendingRequests.set([{ kind: 'approval', request: { id: 'r1', method: 'approval', params: {}, respond: vi.fn(), fail: vi.fn() }, receivedAt: 0 } as unknown as PendingRequest])
  const card = document.createElement('div')
  card.tabIndex = -1
  card.setAttribute('data-request-card', 'r1')
  document.body.append(card)
  const run = () => requestCommands.find(command => command.id === 'requests.focus')!.run({}, { source: 'shortcut' }) as { ok: boolean }

  return { openSurface, run, card }
}

afterEach(() => {
  vi.doUnmock('../store/shell.ts')
  document.body.replaceChildren()
})

describe('raising the Hermes window', () => {
  it('raises it in the panels session, from the Hermes window', async () => {
    const { openSurface, run } = await loadIn({ panels: true, main: true })

    expect(run().ok).toBe(true)
    expect(openSurface).toHaveBeenCalledWith('main')
  })

  it('never raises anything in desktop mode, where the shell is one window', async () => {
    const { openSurface, run, card } = await loadIn({ panels: false, main: true })

    expect(run().ok).toBe(true)
    expect(document.activeElement).toBe(card)
    expect(openSurface).not.toHaveBeenCalled()
  })

  it('never raises the Hermes window from another panels surface', async () => {
    const { openSurface, run } = await loadIn({ panels: true, main: false })

    run()

    expect(openSurface).not.toHaveBeenCalled()
  })
})
