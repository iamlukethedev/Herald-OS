// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Language, TextKey } from '../../../shared/i18n.ts'
import { en } from '../../../shared/locales/en.ts'
import { $prefs } from '../../store/backend.ts'
import { t } from '../../store/i18n.ts'
import { SettingsPage } from './SettingsPage.tsx'

// The preload bridge Hermes & agents, the section Settings opens on, reads from; Hermes answers nothing.
vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, {
    heraldOS: {
      backend: { rest: async () => null },
      bridge: { readPolicy: async () => '', readAudit: async () => [] }
    }
  })
})

const SECTIONS: TextKey[] = [
  'settings.section.general',
  'settings.section.appearance',
  'settings.section.pet',
  'settings.section.room',
  'settings.section.software',
  'settings.section.plugins',
  'settings.section.agents',
  'settings.section.usage',
  'settings.section.voice',
  'settings.section.commands',
  'settings.section.privacy',
  'settings.section.notifications',
  'settings.section.network',
  'settings.section.storage',
  'settings.section.accessibility',
  'settings.section.about'
]

let root: Root | null = null
let container: HTMLElement | null = null

async function show(language: Language): Promise<HTMLElement> {
  $prefs.set({ ...$prefs.get(), language })
  const host = document.createElement('div')
  document.body.append(host)
  container = host
  root = createRoot(host)
  await act(async () => root?.render(<SettingsPage />))

  return host
}

const sectionNav = (host: HTMLElement) => host.querySelector<HTMLElement>(`nav[aria-label="${t('settings.sections')}"]`)
const navLabels = (host: HTMLElement) => [...(sectionNav(host)?.querySelectorAll<HTMLSpanElement>('button > span') ?? [])]

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  $prefs.set({ ...$prefs.get(), language: undefined })
})

describe('the Settings sections', () => {
  it('are listed by their English names in English', async () => {
    const host = await show('en')

    expect(navLabels(host).map(label => label.textContent)).toEqual(SECTIONS.map(key => en[key]))
  })

  it.each(['pt-BR', 'zh-CN'] as const)('are listed in %s, under a translated name', async language => {
    const host = await show(language)

    expect(t('settings.sections')).not.toBe(en['settings.sections'])
    expect(sectionNav(host)).not.toBeNull()
    expect(navLabels(host).map(label => label.textContent)).toEqual(SECTIONS.map(key => t(key)))
  })

  it('names every section in Chinese, none in English', async () => {
    const host = await show('zh-CN')

    for (const label of navLabels(host)) {
      expect(Object.values(en), label.textContent ?? '').not.toContain(label.textContent)
    }
  })

  it('cut a long name off with an ellipsis and keep it whole in a tooltip', async () => {
    const host = await show('pt-BR')
    const labels = navLabels(host)

    expect(labels).toHaveLength(SECTIONS.length)
    for (const label of labels) {
      expect(label.className).toContain('truncate')
      expect(label.className).toContain('min-w-0')
      expect(label.getAttribute('title')).toBe(label.textContent)
    }
  })

  it('marks Hermes & agents as the section shown', async () => {
    const host = await show('zh-CN')
    const current = sectionNav(host)?.querySelector('[aria-current="page"]')

    expect(current?.textContent).toBe(t('settings.section.agents'))
  })
})
