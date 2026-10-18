// @vitest-environment happy-dom
import type { ModelOptionsResult } from '@herald-os/client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Language, type MessageKey, translate, type ValuesFor } from '../../../../shared/i18n.ts'
import { en } from '../../../../shared/locales/en.ts'
import type { KeyCatalog } from '../../../lib/model-provider.ts'
import { $prefs } from '../../../store/backend.ts'
import { $connection, $connectionEpoch } from '../../../store/gateway.ts'
import { t } from '../../../store/i18n.ts'
import { loadModelOptions } from '../../../store/model-provider.ts'
import { ModelProviderRow } from './ProviderRow.tsx'

vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

// None is current: one is ready, one takes an API key, one signs in through its own tool.
const OPTIONS: ModelOptionsResult = {
  providers: [
    { slug: 'openrouter', name: 'OpenRouter', authenticated: true, models: ['openrouter/auto'] },
    { slug: 'anthropic', name: 'Anthropic', authenticated: false, auth_type: 'api_key', key_env: 'ANTHROPIC_API_KEY', models: [] },
    { slug: 'copilot', name: 'GitHub Copilot', authenticated: false, auth_type: 'oauth_external', models: [] }
  ]
} as ModelOptionsResult

const KEYS: KeyCatalog = { ANTHROPIC_API_KEY: { provider: 'anthropic', is_password: true, is_set: false, url: 'https://console.anthropic.com/settings/keys' } }

vi.mock('../../../store/model-provider.ts', async importActual => ({
  ...(await importActual<typeof import('../../../store/model-provider.ts')>()),
  loadModelOptions: vi.fn(),
  loadKeyCatalog: vi.fn(async () => KEYS),
  loadEndpointKeys: vi.fn(async () => ({}))
}))

let root: Root | null = null
let container: HTMLElement | null = null

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
  }
}

async function show(language: Language): Promise<HTMLElement> {
  $prefs.set({ ...$prefs.get(), language })
  const host = document.createElement('div')
  document.body.append(host)
  container = host
  root = createRoot(host)
  await act(async () => root?.render(<ModelProviderRow />))
  await settle()

  return host
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy()
  await act(async () => (element as HTMLElement).click())
  await settle()
}

const chooser = (host: HTMLElement) => [...host.querySelectorAll('button')].find(button => button.textContent === t('settings.agents.provider.choose'))
const option = (host: HTMLElement, name: string) => [...host.querySelectorAll('[role="option"]')].find(item => item.textContent?.startsWith(name))

/** The message in the language shown, checked to differ from English so the English text cannot pass for it. */
function translated<K extends MessageKey>(key: K, ...values: ValuesFor<K>): string {
  const text = t(key, ...values)

  expect(text, key).not.toBe(translate('en', key, ...values))
  expect(text, key).not.toMatch(/\{\w+\}/)

  return text
}

beforeEach(() => {
  vi.mocked(loadModelOptions).mockResolvedValue(OPTIONS)
  $connection.set('open')
  $connectionEpoch.set(1)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  $prefs.set({ ...$prefs.get(), language: undefined })
  $connection.set('idle')
  $connectionEpoch.set(0)
})

describe('the model provider row', () => {
  it.each(['pt-BR', 'zh-CN'] as const)('says Hermes has no provider yet in %s', async language => {
    const host = await show(language)

    expect(host.textContent).toContain(translated('settings.agents.provider.none'))
    expect(host.textContent).not.toContain(en['settings.agents.provider.none'])
  })

  it.each(['pt-BR', 'zh-CN'] as const)('heads the providers ready to use in %s', async language => {
    const host = await show(language)
    await click(chooser(host))

    const heading = translated('settings.agents.provider.readyToUse')
    expect(host.querySelector(`[role="listbox"][aria-label="${heading}"]`)).not.toBeNull()
    expect([...host.querySelectorAll('section > div:first-child')].map(title => title.textContent)).toContain(heading)
    expect(host.textContent).not.toContain(en['settings.agents.provider.readyToUse'])
  })

  it('keeps every provider name whole in a tooltip', async () => {
    const host = await show('pt-BR')
    await click(chooser(host))

    const names = [...host.querySelectorAll('[role="option"] > span.truncate')]
    expect(names.map(name => [name.textContent, name.getAttribute('title')])).toEqual([
      ['OpenRouter', 'OpenRouter'],
      ['Anthropic', 'Anthropic'],
      ['GitHub Copilot', 'GitHub Copilot']
    ])
  })

  it.each(['pt-BR', 'zh-CN'] as const)('tooltips the closed dropdown with its prompt in %s', async language => {
    const host = await show(language)
    const label = chooser(host)?.querySelector('span.truncate')

    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(label?.getAttribute('title')).toBe(translated('settings.agents.provider.choose'))
    expect(label?.getAttribute('title')).toBe(label?.textContent)
  })

  it('tooltips the closed dropdown with the whole name of the provider chosen', async () => {
    const name = 'OpenRouter with a name too long to show whole'
    vi.mocked(loadModelOptions).mockResolvedValue({ providers: [{ ...OPTIONS.providers[0], name, is_current: true }, ...OPTIONS.providers.slice(1)] } as ModelOptionsResult)
    const host = await show('zh-CN')
    const dropdown = [...host.querySelectorAll('button')].find(button => button.textContent === name)

    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(dropdown?.querySelector('span.truncate')?.getAttribute('title')).toBe(name)
  })

  it.each(['pt-BR', 'zh-CN'] as const)('asks for an API key in %s', async language => {
    const host = await show(language)
    await click(chooser(host))
    await click(option(host, 'Anthropic'))

    const values = { name: 'Anthropic', variable: 'ANTHROPIC_API_KEY' }
    expect(host.textContent).toContain(translated('settings.agents.provider.pasteKey', values))
    expect(host.textContent).not.toContain(translate('en', 'settings.agents.provider.pasteKey', values))
    expect(host.querySelector('span.font-mono')?.textContent).toBe('ANTHROPIC_API_KEY')
    expect(host.querySelector('input[type="password"]')?.getAttribute('aria-label')).toBe(translated('settings.agents.provider.keyFor', { name: 'Anthropic' }))
  })

  it('names the provider in the link to get a key', async () => {
    const host = await show('pt-BR')
    await click(chooser(host))
    await click(option(host, 'Anthropic'))

    const link = [...host.querySelectorAll('button')].find(button => button.textContent?.endsWith('→'))
    expect(link?.textContent).toBe(`${translated('settings.agents.provider.getKey', { name: 'Anthropic' })}→`)
    expect(link?.textContent).toContain('Anthropic')
  })

  it.each(['pt-BR', 'zh-CN'] as const)('says to sign in from the Terminal in %s', async language => {
    const host = await show(language)
    await click(chooser(host))
    await click(option(host, 'GitHub Copilot'))

    expect(host.textContent).toContain(translated('settings.agents.provider.terminalSetup', { name: 'GitHub Copilot' }))
    expect(host.querySelector('code')?.textContent).toBe('hermes model')
    expect(host.textContent).not.toContain('signs in through its own tool')
  })
})

describe('the model provider row, when Hermes cannot be reached', () => {
  it.each(['pt-BR', 'zh-CN'] as const)("says the gateway is not connected in %s, not in the client's English", async language => {
    vi.mocked(loadModelOptions).mockRejectedValue(new Error('gateway not connected'))
    const host = await show(language)

    expect(host.textContent).toContain(t('settings.agents.provider.unreadable', { error: translated('settings.agents.gatewayNotConnected') }))
    await click(chooser(host))
    expect([...host.querySelectorAll('.text-danger')].map(error => error.textContent)).toEqual([t('settings.agents.gatewayNotConnected')])
    expect(host.innerHTML).not.toContain('gateway not connected')
  })

  it('shows an error it does not know as it came', async () => {
    vi.mocked(loadModelOptions).mockRejectedValue(new Error('model.options: inventory unavailable'))
    const host = await show('zh-CN')

    expect(host.textContent).toContain(t('settings.agents.provider.unreadable', { error: 'model.options: inventory unavailable' }))
    await click(chooser(host))
    expect([...host.querySelectorAll('.text-danger')].map(error => error.textContent)).toEqual(['model.options: inventory unavailable'])
  })

  it.each([
    ["new Error('')", new Error('')],
    ['whitespace', '  \n'],
    ['undefined', undefined],
    ['null', null],
    ['{}', {}]
  ])('says something went wrong for a rejection with no text (%s), never a blank line', async (_what, reason) => {
    vi.mocked(loadModelOptions).mockRejectedValue(reason)
    const host = await show('pt-BR')
    const generic = t('settings.somethingWentWrong')

    expect(host.textContent).toContain(t('settings.agents.provider.unreadable', { error: generic }))
    await click(chooser(host))
    expect([...host.querySelectorAll('.text-danger')].map(error => error.textContent)).toEqual([generic])
    expect(host.textContent).not.toContain(t('settings.agents.provider.noMatch'))
    expect(host.textContent).not.toMatch(/undefined|null|\[object Object\]/)
  })
})
