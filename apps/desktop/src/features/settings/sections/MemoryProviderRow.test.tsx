// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RestRequest } from '../../../../shared/ipc.ts'
import { Toasts } from '../../../shell/Toasts.tsx'
import { $connectionEpoch } from '../../../store/gateway.ts'
import { $notifications, $toasts } from '../../../store/notifications.ts'
import { MemoryProviderRow } from './MemoryProviderRow.tsx'

// The preload bridge the row talks to: every REST call is recorded and answered by `bridge.handler`.
const bridge = vi.hoisted(() => {
  const state = { calls: [] as RestRequest[], handler: (async () => null) as (request: RestRequest) => Promise<unknown> }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, {
    heraldOS: {
      backend: {
        rest: (request: RestRequest) => {
          state.calls.push(request)

          return state.handler(request)
        }
      }
    }
  })

  return state
})

// GET /api/memory as Hermes answers it: Honcho and Holographic set up, Mem0 not configured yet.
const PROVIDERS = [
  { name: 'honcho', description: 'Cross-session user modelling', available: true, configured: true, status: 'ready' },
  { name: 'mem0', description: 'Mem0 cloud memory', available: false, configured: false, status: 'needs_config' },
  { name: 'holographic', description: 'Local fact store', available: true, configured: true, status: 'ready' }
]

/** An error the way main's REST call reaches the renderer: Electron's IPC prefix, then main's own. */
const ipcError = (message: string) => new Error(`Error invoking remote method 'herald-os:backend:rest': Error: ${message}`)

let root: Root
let container: HTMLElement

async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

async function mount() {
  await act(async () =>
    root.render(
      <div>
        <MemoryProviderRow />
        <Toasts />
      </div>
    )
  )
  await settle()
}

const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!
const menu = () => container.querySelector('[role="listbox"]')
const options = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
const puts = () => bridge.calls.filter(call => call.method === 'PUT')

async function open() {
  await act(async () => trigger().click())
}

async function pick(label: string) {
  const option = options().find(candidate => candidate.textContent?.startsWith(label))

  if (!option) {
    throw new Error(`no "${label}" in ${options().map(o => o.textContent).join(', ')}`)
  }

  await act(async () => option.click())
}

beforeEach(() => {
  bridge.calls.length = 0
  $toasts.set([])
  $notifications.set([])
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  $connectionEpoch.set($connectionEpoch.get() + 1)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('MemoryProviderRow', () => {
  it('shows built-in only, the scope of the setting, and every provider with its readiness', async () => {
    bridge.handler = async () => ({ active: '', providers: PROVIDERS, builtin_files: { memory: 10, user: 2 } })
    await mount()

    expect(trigger().textContent).toBe('Built-in only')
    expect(container.textContent).toContain('Applies to all of Hermes, including CLI and messaging. New sessions only.')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')

    await open()

    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(options().map(option => option.textContent)).toEqual(['Built-in onlyMEMORY.md and USER.md', 'HonchoCross-session user modellingready', 'Mem0Mem0 cloud memoryneeds setup', 'holographicLocal fact storeready'])
  })

  it('leaves names Hermes treats as built-in out of the provider list', async () => {
    bridge.handler = async () => ({ active: 'none', providers: [...PROVIDERS, { name: 'none', status: 'ready' }, { name: ' Default ', status: 'ready' }] })
    await mount()
    await open()

    expect(trigger().textContent).toBe('Built-in only')
    expect(options()).toHaveLength(4)
    expect(options().filter(option => /^\s*(none|default)/i.test(option.textContent ?? ''))).toHaveLength(0)
  })

  it('says an active provider that is not ready needs setup', async () => {
    bridge.handler = async () => ({ active: 'mem0', providers: PROVIDERS })
    await mount()

    expect(trigger().textContent).toBe('Mem0')
    expect(container.textContent).toContain('Mem0 is the active provider but needs setup')
    expect(container.textContent).not.toContain('also saves')
  })

  it('says a configured provider is not installed, in the description and its pill', async () => {
    bridge.handler = async () => ({ active: 'supermemory', providers: [...PROVIDERS, { name: 'supermemory', description: 'Configured provider was not found.', status: 'missing' }] })
    await mount()

    expect(container.textContent).toContain("supermemory is set in Hermes's config but not installed.")

    await open()

    expect(options().at(-1)?.textContent).toBe('supermemoryConfigured provider was not found.not installed')
  })

  it('sends PUT /api/memory/provider with the provider, and keeps the menu shut while it is in flight', async () => {
    let gets = 0
    let finish: (value: unknown) => void = () => undefined
    bridge.handler = async request => (request.method === 'GET' ? { active: gets++ ? 'holographic' : '', providers: PROVIDERS } : new Promise(resolve => (finish = resolve)))
    await mount()
    await open()
    await pick('holographic')

    expect(trigger().textContent).toBe('holographic')
    expect(trigger().disabled).toBe(true)
    expect(trigger().getAttribute('aria-disabled')).toBe('true')

    await open()

    expect(menu()).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')

    await act(async () => finish({ ok: true, active: 'holographic' }))
    await settle()

    expect(puts()).toEqual([{ method: 'PUT', path: '/api/memory/provider', body: { provider: 'holographic' } }])
    expect(trigger().disabled).toBe(false)
    expect(trigger().textContent).toBe('holographic')
    expect($toasts.get().map(toast => [toast.title, toast.body, toast.level])).toEqual([['Memory provider changed', 'holographic. New sessions use it.', 'success']])
  })

  it('sends an empty provider to switch back to built-in', async () => {
    bridge.handler = async request => (request.method === 'GET' ? { active: 'honcho', providers: PROVIDERS } : { ok: true, active: '' })
    await mount()
    await open()
    await pick('Built-in')
    await settle()

    expect(puts()).toEqual([{ method: 'PUT', path: '/api/memory/provider', body: { provider: '' } }])
  })

  it('sends nothing when the current provider is picked again', async () => {
    bridge.handler = async () => ({ active: 'honcho', providers: PROVIDERS })
    await mount()
    await open()
    await pick('Honcho')
    await settle()

    expect(puts()).toHaveLength(0)
    expect($toasts.get()).toHaveLength(0)
  })

  it("reverts a refused change and shows only Hermes's reason, as text", async () => {
    const reason = "Memory provider 'mem0' is not ready (needs config). <img src=x onerror=alert(1)>"
    bridge.handler = async request => {
      if (request.method === 'GET') {
        return { active: '', providers: PROVIDERS }
      }

      throw ipcError(`PUT /api/memory/provider -> 400: ${reason}`)
    }
    await mount()
    await open()
    await pick('Mem0')
    await settle()

    expect(trigger().textContent).toBe('Built-in only')
    expect(trigger().disabled).toBe(false)
    expect($toasts.get().map(toast => [toast.title, toast.body, toast.level])).toEqual([['Could not change memory provider', reason, 'error']])
    expect(container.textContent).toContain(reason)
    expect(container.textContent).not.toContain('Error invoking remote method')
    expect(container.textContent).not.toContain('-> 400')
    expect(container.querySelector('img')).toBeNull()

    await open()

    expect(menu()).not.toBeNull()
  })

  it('shows a read error with only the reason, and stays disabled', async () => {
    bridge.handler = async () => {
      throw ipcError('GET /api/memory -> 500: Internal Server Error')
    }
    await mount()

    expect(container.textContent).toContain('Could not read the memory provider: Internal Server Error')
    expect(container.textContent).not.toContain('Error invoking remote method')
    expect(trigger().textContent).toBe('Unavailable')
    expect(trigger().disabled).toBe(true)
  })

  it('stays disabled and shut until the first answer arrives', async () => {
    let answer: (value: unknown) => void = () => undefined
    bridge.handler = () => new Promise(resolve => (answer = resolve))
    await mount()

    expect(trigger().textContent).toBe('…')
    expect(trigger().disabled).toBe(true)

    await open()

    expect(menu()).toBeNull()

    await act(async () => answer({ active: 'honcho', providers: PROVIDERS }))
    await settle()

    expect(trigger().textContent).toBe('Honcho')
    expect(trigger().disabled).toBe(false)
  })

  const MALFORMED: [string, unknown][] = [
    ['a null body', null],
    ['providers that are not a list', { active: '', providers: { honcho: 1 } }],
    ['a non-string active', { active: 5, providers: [] }],
    ['a non-string provider name', { active: '', providers: [{ name: 7 }] }],
    ['an HTML page', '<html>oops</html>']
  ]

  for (const [name, body] of MALFORMED) {
    it(`shows the read error for ${name}`, async () => {
      bridge.handler = async () => body
      await mount()

      expect(container.textContent).toContain('Could not read the memory provider: Hermes sent a memory status Herald does not understand.')
      expect(trigger().textContent).toBe('Unavailable')
      expect(trigger().disabled).toBe(true)
    })
  }
})
