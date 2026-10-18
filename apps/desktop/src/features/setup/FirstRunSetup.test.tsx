// @vitest-environment happy-dom
import type { ModelOptionsResult } from '@herald-os/client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Language, TextKey } from '../../../shared/i18n.ts'
import type { SetupResult } from '../../../shared/ipc.ts'
import { en } from '../../../shared/locales/en.ts'
import { $prefs } from '../../store/backend.ts'
import { $connection, $connectionEpoch } from '../../store/gateway.ts'
import { $hermesAuth } from '../../store/hermes-auth.ts'
import { t } from '../../store/i18n.ts'
import { FirstRunSetup } from './FirstRunSetup.tsx'

// The preload bridge setup reads from. By default setup is due for someone who signed in at the
// login screen, so the account step asks only a name, and Hermes has no provider signed in.
const bridge = vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const setup = {
    state: vi.fn(async () => ({ needed: true, signedIn: true })),
    name: vi.fn(async () => undefined),
    password: vi.fn(async (): Promise<SetupResult> => ({ ok: true })),
    finish: vi.fn(async () => undefined)
  }
  const rest = vi.fn(async (_request: { path: string }): Promise<unknown> => null)
  Object.assign(window, { heraldOS: { backend: { rest }, setup } })

  return { setup, rest }
})

vi.mock('../status/StatusPanel.tsx', () => ({ StatusPanel: () => null }))

vi.mock('../../store/model-provider.ts', async importActual => ({
  ...(await importActual<typeof import('../../store/model-provider.ts')>()),
  providerName: vi.fn((slug: string | null | undefined) => (slug === 'openrouter' ? 'OpenRouter' : null)),
  loadModelOptions: vi.fn(async () => ({ providers: [{ slug: 'openrouter', name: 'OpenRouter', authenticated: true, models: ['openrouter/auto'] }] }) as ModelOptionsResult),
  loadKeyCatalog: vi.fn(async () => ({})),
  loadEndpointKeys: vi.fn(async () => ({}))
}))

const SIGNED_OUT_AUTH = $hermesAuth.get()

// What may read the same in every language: product names, and the keyboard shortcuts and
// command that stay as they are (en.ts says which).
const KEPT = ['Herald OS', 'Hermes', 'OpenRouter', 'Super+Space', 'Super+M', 'herald-os password', 'API']

// Portuguese words spelled as English ones are ("o menu", "for ligado").
const NATIVE: Record<Exclude<Language, 'en'>, string[]> = { 'pt-BR': ['for', 'menu'], 'zh-CN': [] }

let root: Root | null = null
let container: HTMLElement | null = null

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
  }
}

const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.trim().startsWith(text))
const heading = (host: HTMLElement) => host.querySelector('h2')?.textContent

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

/** The words a person reads or hears: the text, and the labels, tooltips and placeholders of the controls. */
function readable(host: HTMLElement): string[] {
  const texts = new Set<string>()
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim()

    if (text && /\p{L}/u.test(text)) {
      texts.add(text)
    }
  }

  for (const element of host.querySelectorAll('[aria-label], [title], [placeholder]')) {
    for (const name of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(name)?.trim()

      if (value && /\p{L}/u.test(value)) {
        texts.add(value)
      }
    }
  }

  return [...texts]
}

/** The Latin words of three letters or more in a text, once what may stay as it is has gone. */
function words(text: string): string[] {
  let rest = text

  for (const kept of KEPT) {
    rest = rest.split(kept).join(' ')
  }

  return rest.match(/[A-Za-z]{3,}/g) ?? []
}

async function mount(language: Language): Promise<HTMLElement> {
  $prefs.set({ ...$prefs.get(), language })
  const host = document.createElement('div')
  document.body.append(host)
  container = host
  root = createRoot(host)
  await act(async () => root?.render(<FirstRunSetup />))
  await settle()

  return host
}

type Path = 'mine' | 'signed in' | 'someone else'

/** Every step on one way through setup, each with what it shows, checked to have its own heading. */
async function walk(language: Language, path: Path): Promise<{ step: string; texts: string[] }[]> {
  const shown: { step: string; texts: string[] }[] = []
  const host = await mount(language)
  const at = (step: string, title: TextKey) => {
    expect(heading(host), `${language} ${path}: ${step}`).toBe(t(title))
    shown.push({ step, texts: readable(host) })
  }

  at('welcome', 'firstRun.welcome.title')

  if (path === 'someone else') {
    await click(button(host, t('firstRun.welcome.forSomeoneElse')))
    at('wifi', 'firstRun.wifi.title')
    await click(button(host, t('firstRun.next')))
    at('hand over', 'firstRun.handOver.title')
    await click(button(host, t('firstRun.handOver.done')))
    expect(bridge.setup.finish).toHaveBeenLastCalledWith({ later: true })

    return shown
  }

  await click(button(host, t('firstRun.welcome.forMe')))

  if (path === 'mine') {
    at('account', 'firstRun.account.title')
    await type(host.querySelector('input[autocomplete="name"]'), 'Ana')
    const [password, again] = host.querySelectorAll<HTMLInputElement>('input[type="password"]')
    await type(password, 'correct horse')
    await type(again, 'correct hors')
    at('passwords differ', 'firstRun.account.title')
    expect(host.querySelector('.text-danger')?.textContent).toBe(t('firstRun.account.mismatch'))
    await type(again, 'correct horse')
    const says = (expected: string) => expect(host.querySelector('.text-danger')?.textContent).toBe(expected)
    bridge.setup.password.mockResolvedValueOnce({ ok: false, reason: 'refused' })
    await click(button(host, t('firstRun.next')))
    at('password refused', 'firstRun.account.title')
    says(t('firstRun.account.refusedNoReason'))
    // pwquality's reason is English whatever the language, so this step is not compared with English.
    bridge.setup.password.mockResolvedValueOnce({ ok: false, reason: 'refused', detail: 'The password fails the dictionary check - it is based on a dictionary word' })
    await click(button(host, t('firstRun.next')))
    says(t('firstRun.account.refused', { reason: 'The password fails the dictionary check - it is based on a dictionary word' }))
    bridge.setup.password.mockResolvedValueOnce({ ok: false, reason: 'timeout' })
    await click(button(host, t('firstRun.next')))
    at('password timed out', 'firstRun.account.title')
    says(t('firstRun.account.timeout'))
    bridge.setup.password.mockResolvedValueOnce({ ok: false, reason: 'failed' })
    await click(button(host, t('firstRun.next')))
    at('password not set', 'firstRun.account.title')
    says(t('firstRun.account.passwordNotSet'))
    bridge.setup.password.mockResolvedValueOnce({ ok: false })
    await click(button(host, t('firstRun.next')))
    says(t('firstRun.account.passwordNotSet'))
  } else {
    at('account', 'firstRun.account.titleSignedIn')
    await type(host.querySelector('input[autocomplete="name"]'), 'Ana')
  }

  await click(button(host, t('firstRun.next')))
  at('wifi', 'firstRun.wifi.title')
  await click(button(host, t('firstRun.next')))
  at('hermes', 'firstRun.hermes.title')

  if (path === 'mine') {
    expect(button(host, t('settings.agents.provider.signIn'))).toBeTruthy()
    await click(button(host, t('firstRun.hermes.otherProvider')))
    at('another provider', 'firstRun.hermes.title')
    await click(button(host, t('firstRun.later')))
  } else {
    expect(host.textContent).toContain(t('firstRun.hermes.thinksWith', { provider: 'OpenRouter' }))
    await click(button(host, t('firstRun.next')))
  }

  at('done', 'firstRun.done.title')
  await click(button(host, t('firstRun.done.start')))
  expect(bridge.setup.finish).toHaveBeenLastCalledWith({ later: false })

  return shown
}

function unmount() {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
}

function given(path: Path) {
  bridge.setup.state.mockResolvedValue({ needed: true, signedIn: path !== 'mine' })
  bridge.rest.mockImplementation(async ({ path: url }) => {
    if (path !== 'signed in') {
      return null
    }

    return url === '/api/providers/oauth' ? { providers: [{ id: 'openrouter', name: 'OpenRouter', flow: 'external', status: { logged_in: true } }] } : url === '/api/config/raw' ? { yaml: 'model:\n  provider: openrouter\n' } : null
  })
}

beforeEach(() => {
  $connection.set('open')
  $connectionEpoch.set(1)
})

afterEach(() => {
  unmount()
  $prefs.set({ ...$prefs.get(), language: undefined })
  $connection.set('idle')
  $connectionEpoch.set(0)
  $hermesAuth.set(SIGNED_OUT_AUTH)
  bridge.setup.state.mockResolvedValue({ needed: true, signedIn: true })
  bridge.rest.mockImplementation(async () => null)
})

describe("first-run setup's Hermes step", () => {
  it('offers the model provider row in the language chosen', async () => {
    const host = await mount('pt-BR')

    await click(button(host, t('firstRun.welcome.forMe')))
    await type(host.querySelector('input[autocomplete="name"]'), 'Ana')
    await click(button(host, t('firstRun.next')))
    await click(button(host, t('firstRun.next')))
    await click(button(host, t('firstRun.hermes.otherProvider')))

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

describe('first-run setup', () => {
  it.each(['mine', 'signed in', 'someone else'] as const)('reads as before in English, the %s way through', async path => {
    given(path)
    const steps = await walk('en', path)
    const all = steps.flatMap(step => step.texts)

    expect(all).toContain('Welcome to Herald OS')
    expect(all).toContain('Set up Herald OS')
    expect(all).toContain(path === 'someone else' ? 'Ready to hand over' : 'You are all set')
    if (path !== 'someone else') {
      expect(all).toContain('It is for me')
    }
  })

  describe.each(['pt-BR', 'zh-CN'] as const)('in %s', language => {
    it.each(['mine', 'signed in', 'someone else'] as const)('keeps nothing English but product names, the %s way through', async path => {
      given(path)
      const english = await walk('en', path)
      unmount()
      const translated = await walk(language, path)

      expect(translated.map(step => step.step)).toEqual(english.map(step => step.step))
      translated.forEach(({ step, texts }, index) => {
        const englishTexts = new Set(english[index].texts)
        const englishWords = new Set(english[index].texts.flatMap(words).map(word => word.toLowerCase()))
        const same = texts.filter(text => englishTexts.has(text))

        expect(same.filter(text => words(text).length > 0), `${step}: shown as in English`).toEqual([])
        expect(
          texts.flatMap(words).filter(word => englishWords.has(word.toLowerCase()) && !NATIVE[language].includes(word)),
          `${step}: English words`
        ).toEqual([])
      })
    })

    it('labels the dialog in the language chosen', async () => {
      const host = await mount(language)

      expect(t('firstRun.label')).not.toBe(en['firstRun.label'])
      expect(host.querySelector(`[role="dialog"][aria-label="${t('firstRun.label')}"]`)).not.toBeNull()
      expect(host.querySelector(`[aria-label="${en['firstRun.label']}"]`)).toBeNull()
    })
  })
})
