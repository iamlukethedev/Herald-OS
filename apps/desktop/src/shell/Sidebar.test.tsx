// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGUAGES, type Language, type Translation } from '../../shared/i18n.ts'
import { en } from '../../shared/locales/en.ts'
import { ptBR } from '../../shared/locales/pt-BR.ts'
import { zhCN } from '../../shared/locales/zh-CN.ts'
import { shortcutLabel } from '../lib/platform-labels.ts'
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
// Expanded, a Space's button is the only one outside the page list without an aria-label.
const spaceButtons = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('button:not([aria-label])')].filter(button => !button.closest('nav'))
const spanReading = (host: HTMLElement, text: string) => [...host.querySelectorAll<HTMLSpanElement>('span')].find(span => span.textContent === text)

/** Every English sidebar message (that the language translates differently) still in the markup. */
const englishLeft = (host: HTMLElement, language: Language) =>
  Object.entries(en)
    .filter(([key, english]) => key.startsWith('sidebar.') && typeof english === 'string' && !english.includes('{') && CATALOGS[language][key as keyof typeof en] !== english)
    .map(([, english]) => english as string)
    .filter(english => host.innerHTML.includes(english))

const SPACES = [
  { id: 'personal', name: 'Personal', color: '#4d92ff' },
  { id: 'work', name: 'Work', color: '#ff9f0a' },
  { id: 'trip', name: 'A trip to the mountains with far too long a name', color: '#30d158' }
]
const savedSpaces = $prefs.get().spaces

beforeEach(() => {
  $sidebar.set({ width: 200, collapsed: false })
  $prefs.set({ ...$prefs.get(), spaces: SPACES, activeSpace: 'personal' })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  $prefs.set({ ...$prefs.get(), language: undefined, spaces: savedSpaces })
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

  it.each(['pt-BR', 'zh-CN'] as const)('leaves no English label in %s, expanded or collapsed', async language => {
    setLanguage(language)
    const expanded = await show()

    expect(englishLeft(expanded, language)).toEqual([])
    act(() => root?.unmount())

    $sidebar.set({ width: 200, collapsed: true })
    const collapsed = await show()

    expect(englishLeft(collapsed, language)).toEqual([])
  })

  it('heads the Spaces with the translated word, cut off with an ellipsis and whole in a tooltip', async () => {
    setLanguage('pt-BR')
    const host = await show()
    const header = spanReading(host, t('sidebar.spaces'))

    expect(t('sidebar.spaces')).not.toBe(en['sidebar.spaces'])
    expect(header).toBeDefined()
    expect(header?.className).toContain('truncate')
    expect(header?.className).toContain('min-w-0')
    expect(header?.getAttribute('title')).toBe(t('sidebar.spaces'))
  })

  it('names each Space, cuts a long name off with an ellipsis and keeps it whole in a tooltip', async () => {
    setLanguage('zh-CN')
    const host = await show()
    const labels = spaceButtons(host).map(button => button.querySelectorAll('span')[1])

    expect(labels.map(label => label?.textContent)).toEqual([t('space.personal'), t('space.work'), SPACES[2].name])
    for (const label of labels) {
      expect(label?.className).toContain('truncate')
      expect(label?.className).toContain('min-w-0')
      expect(label?.getAttribute('title')).toBe(label?.textContent)
    }
  })

  it('offers to add a Space in the language chosen, as a button and its tooltip', async () => {
    setLanguage('zh-CN')
    const expanded = await show()
    const add = expanded.querySelector(`button[aria-label="${t('sidebar.addSpace')}"]`)

    expect(t('sidebar.addSpace')).not.toBe(en['sidebar.addSpace'])
    expect(add?.getAttribute('title')).toBe(t('sidebar.addSpace'))
    act(() => root?.unmount())

    $sidebar.set({ width: 200, collapsed: true })
    const collapsed = await show()
    const addCollapsed = collapsed.querySelector(`button[aria-label="${t('sidebar.addSpace')}"]`)

    expect(addCollapsed?.querySelector('.side-tip')?.textContent).toBe(t('sidebar.addSpace'))
  })

  it('labels the collapse button with the short translated word, cut off with an ellipsis', async () => {
    setLanguage('pt-BR')
    const host = await show()
    const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${t('sidebar.collapse')}"]`)
    const label = button?.querySelector('span')

    expect(t('sidebar.collapseShort')).not.toBe(en['sidebar.collapseShort'])
    expect(label?.textContent).toBe(t('sidebar.collapseShort'))
    expect(label?.className).toContain('truncate')
    expect(label?.className).toContain('min-w-0')
    expect(button?.getAttribute('title')).toBe(t('sidebar.collapseHint', { shortcut: shortcutLabel('\\') }))
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
