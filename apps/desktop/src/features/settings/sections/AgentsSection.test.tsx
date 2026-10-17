// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Language } from '../../../../shared/i18n.ts'
import { en } from '../../../../shared/locales/en.ts'
import { $prefs } from '../../../store/backend.ts'
import { $connection, $connectionEpoch } from '../../../store/gateway.ts'
import { t } from '../../../store/i18n.ts'
import { AgentsSection } from './AgentsSection.tsx'

// The preload bridge the section reads from; Hermes answers nothing, which is enough to draw the Autonomy cards.
vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, {
    heraldOS: {
      backend: { rest: async () => null },
      bridge: { readPolicy: async () => '', readAudit: async () => [] }
    }
  })
})

let root: Root | null = null

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
  }
}
let container: HTMLElement | null = null

async function show(language: Language): Promise<HTMLElement> {
  $prefs.set({ ...$prefs.get(), language })
  const host = document.createElement('div')
  document.body.append(host)
  container = host
  root = createRoot(host)
  await act(async () => root?.render(<AgentsSection />))
  await settle()

  return host
}

const autonomyCards = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>(`[aria-label="${t('settings.agents.autonomy')}"] > button`)]

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  $prefs.set({ ...$prefs.get(), language: undefined })
  $connection.set('idle')
  $connectionEpoch.set(0)
})

describe('the Autonomy cards', () => {
  it('read as before in English', async () => {
    const host = await show('en')

    expect(autonomyCards(host).map(card => card.textContent)).toEqual(['Ask firstConfirm each action', 'BalancedWork freely. Ask before sharing.', 'IndependentFollow your saved rules'])
  })

  it('are in the language chosen', async () => {
    const host = await show('pt-BR')

    expect(host.textContent).toContain(t('settings.agents.autonomy'))
    expect(autonomyCards(host).map(card => card.textContent)).toEqual([
      t('settings.agents.askFirst') + t('settings.agents.askFirstHint'),
      t('settings.agents.balanced') + t('settings.agents.balancedHint'),
      t('settings.agents.independent') + t('settings.agents.independentHint')
    ])
    expect(host.innerHTML).not.toContain('Work freely. Ask before sharing.')
  })

  it('cut a long label off with an ellipsis and keep it whole in a tooltip', async () => {
    const host = await show('pt-BR')
    const balanced = autonomyCards(host)[1]
    const [label, description] = balanced.querySelectorAll('span.truncate')

    expect(label.getAttribute('title')).toBe(t('settings.agents.balanced'))
    expect(description.getAttribute('title')).toBe(t('settings.agents.balancedHint'))
  })
})

/** The words a person reads or hears in the section: its text, and the labels, tooltips and placeholders of its controls. */
function readable(host: HTMLElement): Set<string> {
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

  return texts
}

const statusLine = (host: HTMLElement) => host.querySelector('.rounded-full')?.closest('div')?.textContent

async function openHistory(host: HTMLElement) {
  const link = [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith(t('settings.agents.viewHistory')))

  await act(async () => link?.click())
  await settle()
}

describe('Hermes & agents', () => {
  it('reads as before in English', async () => {
    const host = await show('en')

    for (const english of [
      'Personal agent',
      'Waiting for Hermes',
      'Account',
      'Model provider',
      'Model & performance',
      'Preferred model',
      'Choose the model Hermes uses for most tasks.',
      'Hermes · Automatic',
      'Run on',
      'This device',
      'Background agents',
      'Tool search',
      'Privacy & control',
      'Remember preferences',
      'Memory provider',
      'Ask before sending messages',
      'Activity history',
      'View history'
    ]) {
      expect(host.textContent, english).toContain(english)
    }
  })

  it.each(['pt-BR', 'zh-CN'] as const)('shows its status, groups and rows in %s', async language => {
    const host = await show(language)
    const keys = [
      'settings.agents.personalAgent',
      'menuBar.waitingForHermes',
      'settings.agents.account',
      'settings.agents.modelPerformance',
      'settings.agents.privacyControl',
      'settings.agents.preferredModel',
      'settings.agents.preferredModelHint',
      'settings.agents.automatic',
      'settings.agents.runOn',
      'settings.agents.runOnHint',
      'settings.agents.thisDevice',
      'settings.agents.backgroundAgents',
      'settings.agents.backgroundAgentsHint',
      'settings.agents.rememberPreferences',
      'settings.agents.rememberPreferencesHint',
      'settings.agents.askBeforeSending',
      'settings.agents.askBeforeSendingHint',
      'settings.agents.activityHistory',
      'settings.agents.activityHistoryHint',
      'settings.agents.viewHistory',
      'settings.agents.provider.label',
      'settings.agents.memoryProvider.label',
      'settings.agents.memoryProvider.scope',
      'settings.agents.toolSearch.label',
      'settings.agents.toolSearch.hint'
    ] as const

    for (const key of keys) {
      expect(t(key), key).not.toBe(en[key])
      expect(host.textContent, key).toContain(t(key))
      expect(host.textContent, key).not.toContain(en[key])
    }
    expect(statusLine(host)).toBe(t('menuBar.waitingForHermes'))
    expect(host.querySelector(`[aria-label="${t('settings.decrease', { name: t('settings.agents.backgroundAgentsCount') })}"]`)).not.toBeNull()
    expect(host.querySelector(`[aria-label="${t('settings.increase', { name: t('settings.agents.backgroundAgentsCount') })}"]`)).not.toBeNull()
    for (const toggle of ['settings.agents.rememberPreferences', 'settings.agents.askBeforeSending', 'settings.agents.toolSearch.label'] as const) {
      expect(host.querySelector(`[role="switch"][aria-label="${t(toggle)}"], button[aria-label="${t(toggle)}"]`), toggle).not.toBeNull()
    }
    expect(host.querySelector(`button[aria-label="${t('settings.agents.provider.refresh')}"]`)).not.toBeNull()
  })

  it('says why it cannot show the memory provider, in the language chosen', async () => {
    $connectionEpoch.set(1)
    const host = await show('zh-CN')

    expect(host.textContent).toContain(t('settings.agents.memoryProvider.unreadable', { error: t('settings.agents.memoryProvider.badStatus') }))
    expect(host.textContent).toContain(t('settings.agents.memoryProvider.unavailable'))
  })

  it.each([
    ['connecting', 'settings.agents.connecting'],
    ['error', 'settings.agents.connectionError'],
    ['closed', 'settings.agents.disconnected']
  ] as const)('says the connection is %s in the language chosen', async (state, key) => {
    $connection.set(state)
    const host = await show('pt-BR')

    expect(t(key)).not.toBe(en[key])
    expect(statusLine(host)).toBe(t(key))
  })

  // The gateway client here has no socket, so every request it is asked for rejects with its own English.
  it.each(['pt-BR', 'zh-CN'] as const)("says the gateway is not connected in %s, not in the client's English", async language => {
    $connection.set('open')
    $connectionEpoch.set(1)
    const host = await show(language)
    const notConnected = t('settings.agents.gatewayNotConnected')

    expect(notConnected).not.toBe(en['settings.agents.gatewayNotConnected'])
    expect(host.textContent).toContain(t('settings.agents.autonomyUnreadable', { error: notConnected }))
    expect(host.textContent).toContain(t('settings.agents.provider.unreadable', { error: notConnected }))
    expect(host.innerHTML).not.toContain('gateway not connected')
  })

  it.each(['pt-BR', 'zh-CN'] as const)("says the model list cannot load because the gateway is not connected in %s, not in the client's English", async language => {
    $connection.set('open')
    $connectionEpoch.set(1)
    const host = await show(language)
    const dropdown = [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith(`${t('app.hermes')} · `))

    await act(async () => dropdown?.click())
    await settle()

    const models = host.querySelector(`[role="dialog"][aria-label="${t('settings.agents.chooseModel')}"]`)
    expect(models).not.toBeNull()
    expect([...(models?.querySelectorAll('.text-danger') ?? [])].map(error => error.textContent)).toEqual([t('settings.agents.gatewayNotConnected')])
    expect(models?.innerHTML).not.toContain('gateway not connected')
  })

  it('opens the activity history in the language chosen', async () => {
    const host = await show('zh-CN')
    await openHistory(host)

    expect(host.textContent).toContain(t('settings.agents.activityHistoryIntro'))
    expect(host.textContent).toContain(t('settings.agents.noActivity'))
    expect(host.textContent).toContain(t('settings.agents.hideHistory'))
    expect([...host.querySelectorAll('button')].some(button => button.textContent === t('overview.refresh'))).toBe(true)
    for (const english of ['Every action the system bridge took or refused, newest first.', 'No bridge activity yet.', 'Hide history', 'Refresh']) {
      expect(host.textContent, english).not.toContain(english)
    }
  })

  it.each(['pt-BR', 'zh-CN'] as const)('keeps nothing English in %s but the name Hermes', async language => {
    $connectionEpoch.set(1)
    const english = await show('en')
    await openHistory(english)
    const shownInEnglish = readable(english)
    act(() => root?.unmount())
    container?.remove()

    const translated = await show(language)
    await openHistory(translated)

    expect([...readable(translated)].filter(text => shownInEnglish.has(text))).toEqual(['Hermes'])
  })
})
