// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Language } from '../../../../shared/i18n.ts'
import { $prefs } from '../../../store/backend.ts'
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
let container: HTMLElement | null = null

async function show(language: Language): Promise<HTMLElement> {
  $prefs.set({ ...$prefs.get(), language })
  const host = document.createElement('div')
  document.body.append(host)
  container = host
  root = createRoot(host)
  await act(async () => root?.render(<AgentsSection />))

  return host
}

const autonomyCards = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>(`[aria-label="${t('settings.agents.autonomy')}"] > button`)]

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  $prefs.set({ ...$prefs.get(), language: undefined })
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
