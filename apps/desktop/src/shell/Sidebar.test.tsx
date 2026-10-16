// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGUAGES, type Language, type Translation } from '../../shared/i18n.ts'
import { en } from '../../shared/locales/en.ts'
import { ptBR } from '../../shared/locales/pt-BR.ts'
import { zhCN } from '../../shared/locales/zh-CN.ts'
import { $prefs } from '../store/backend.ts'
import { t } from '../store/i18n.ts'
import { $sidebar } from '../store/sidebar.ts'
import { appName, PAGES } from './apps.ts'
import { Sidebar } from './Sidebar.tsx'

vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

const CATALOGS: Record<Language, Translation> = { en, 'pt-BR': ptBR, 'zh-CN': zhCN }

let root: Root | null = null
let container: HTMLElement | null = null

async function show(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  container = host
  root = createRoot(host)
  await act(async () => root?.render(<Sidebar />))

  return host
}

const setLanguage = (language: Language) => $prefs.set({ ...$prefs.get(), language })
const pageButtons = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('nav button')]

beforeEach(() => {
  $sidebar.set({ width: 200, collapsed: false })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  $prefs.set({ ...$prefs.get(), language: undefined })
})

describe.each(LANGUAGES.map(language => language.id))('the page names in %s', language => {
  it("come from the language's own catalog, never a missing key", () => {
    setLanguage(language)
    const messages = Object.values(CATALOGS[language])

    for (const page of PAGES) {
      const name = appName(page)

      expect(name, page.id).not.toMatch(/^app\./)
      expect(name.trim(), page.id).not.toBe('')
      expect(messages, page.id).toContain(name)
    }
  })
})

describe('the sidebar', () => {
  it("shows the pages' English names in English, the same ones commands match on", async () => {
    setLanguage('en')
    const host = await show()

    expect(pageButtons(host).map(button => button.textContent)).toEqual(PAGES.map(page => page.name))
  })

  it('shows its labels in the language chosen', async () => {
    setLanguage('zh-CN')
    const host = await show()

    expect(host.querySelector('nav')?.getAttribute('aria-label')).toBe(t('sidebar.pages'))
    expect(pageButtons(host).map(button => button.textContent)).toEqual(PAGES.map(page => appName(page)))
    expect(host.textContent).toContain(t('sidebar.tagline'))
    expect(host.textContent).toContain(t('sidebar.spaces'))
    expect(host.textContent).toContain(t('space.personal'))
    expect(host.textContent).toContain(t('sidebar.collapseShort'))
    expect(host.querySelector(`[aria-label="${t('sidebar.collapse')}"]`)).not.toBeNull()
    expect(host.querySelector(`[aria-label="${t('sidebar.addSpace')}"]`)).not.toBeNull()
    expect(host.querySelector('[role="separator"]')?.getAttribute('aria-label')).toBe(t('sidebar.resize'))

    for (const english of ['A more capable you. Always.', 'Add space', 'Collapse', 'Personal']) {
      expect(host.innerHTML, english).not.toContain(english)
    }
  })

  it('cuts a long label off with an ellipsis and keeps it whole in a tooltip', async () => {
    setLanguage('pt-BR')
    const host = await show()

    for (const button of pageButtons(host)) {
      const label = button.querySelector('span')

      expect(label?.className).toContain('truncate')
      expect(label?.className).toContain('min-w-0')
      expect(label?.getAttribute('title')).toBe(button.textContent)
    }
  })

  it('names the pages and Spaces in the language chosen when collapsed to icons', async () => {
    setLanguage('pt-BR')
    $sidebar.set({ width: 200, collapsed: true })
    const host = await show()

    expect(pageButtons(host).map(button => button.getAttribute('aria-label'))).toEqual(PAGES.map(page => appName(page)))
    expect(host.querySelector(`[aria-label="${t('sidebar.spaceNamed', { name: t('space.personal') })}"]`)).not.toBeNull()
    expect(host.querySelector(`[aria-label="${t('sidebar.expand')}"]`)).not.toBeNull()
  })
})
