// @vitest-environment happy-dom
import type { ModelOptionsResult } from '@herald-os/client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../../../shared/locales/en.ts'
import { $prefs } from '../../store/backend.ts'
import { $connection, $connectionEpoch } from '../../store/gateway.ts'
import { t } from '../../store/i18n.ts'
import { FirstRunSetup } from './FirstRunSetup.tsx'

// Setup is due for someone who signed in at the login screen, so the account step asks only a name.
vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, {
    heraldOS: {
      backend: { rest: async () => null },
      setup: { state: async () => ({ needed: true, signedIn: true }), name: async () => undefined, finish: async () => undefined }
    }
  })
})

vi.mock('../status/StatusPanel.tsx', () => ({ StatusPanel: () => null }))

vi.mock('../../store/model-provider.ts', async importActual => ({
  ...(await importActual<typeof import('../../store/model-provider.ts')>()),
  loadModelOptions: vi.fn(async () => ({ providers: [{ slug: 'openrouter', name: 'OpenRouter', authenticated: true, models: ['openrouter/auto'] }] }) as ModelOptionsResult),
  loadKeyCatalog: vi.fn(async () => ({})),
  loadEndpointKeys: vi.fn(async () => ({}))
}))

let root: Root | null = null
let container: HTMLElement | null = null

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
  }
}

const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.trim().startsWith(text))

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy()
  await act(async () => (element as HTMLElement).click())
  await settle()
}

async function type(input: HTMLInputElement | null, value: string) {
  expect(input).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  $prefs.set({ ...$prefs.get(), language: undefined })
  $connection.set('idle')
  $connectionEpoch.set(0)
})

describe("first-run setup's Hermes step", () => {
  it('offers the model provider row in the language chosen', async () => {
    $prefs.set({ ...$prefs.get(), language: 'pt-BR' })
    $connection.set('open')
    $connectionEpoch.set(1)
    const host = document.createElement('div')
    document.body.append(host)
    container = host
    root = createRoot(host)
    await act(async () => root?.render(<FirstRunSetup />))
    await settle()

    await click(button(host, 'It is for me'))
    await type(host.querySelector('input[autocomplete="name"]'), 'Ana')
    await click(button(host, 'Next'))
    await click(button(host, 'Next'))
    await click(button(host, 'Use another provider'))

    for (const key of ['settings.agents.provider.label', 'settings.agents.provider.none'] as const) {
      expect(t(key), key).not.toBe(en[key])
      expect(host.textContent, key).toContain(t(key))
      expect(host.textContent, key).not.toContain(en[key])
    }

    await click(button(host, t('settings.agents.provider.choose')))
    expect(host.querySelector(`[role="dialog"][aria-label="${t('settings.agents.provider.chooseLabel')}"]`)).not.toBeNull()
    expect(host.querySelector(`[role="listbox"][aria-label="${t('settings.agents.provider.readyToUse')}"]`)?.textContent).toBe('OpenRouter')
    expect(host.querySelector('[role="option"] > span.truncate')?.getAttribute('title')).toBe('OpenRouter')
    expect(host.textContent).not.toContain(en['settings.agents.provider.readyToUse'])
  })
})
