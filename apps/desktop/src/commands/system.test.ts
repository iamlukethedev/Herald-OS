import { beforeEach, describe, expect, it, vi } from 'vitest'
import { $settingsFocus } from '../features/settings/sections/shared.tsx'
import { matchIntent } from '../lib/voice/intents.ts'
import { $env, $prefs } from '../store/backend.ts'
import { $language } from '../store/i18n.ts'
import { type CommandContext, defineCommands, resetCommands, runCommand } from '../store/os-commands.ts'
import { commandGroups } from './index.ts'
import { systemCommands } from './system.ts'

// The stores read the preload bridge and the viewport when they load, and opening Settings asks
// whether motion is reduced; tests run without a DOM.
const opened = vi.hoisted(() => [] as string[])

vi.hoisted(() => {
  const prefs = { current: {} as Record<string, unknown> }
  Object.assign(globalThis, {
    window: {
      innerWidth: 1440,
      innerHeight: 900,
      matchMedia: () => ({ matches: true }),
      heraldOS: {
        prefs: { set: async (patch: Record<string, unknown>) => (prefs.current = { ...prefs.current, ...patch }) },
        shell: { openExternal: async (url: string) => void opened.push(url) }
      }
    },
    document: { documentElement: { dataset: {}, style: { setProperty: () => undefined, removeProperty: () => undefined } } }
  })
})

const UI: CommandContext = { source: 'ui' }
const ENV = { platform: 'darwin' as const, hermesHome: '/h/.hermes', homeDir: '/h', version: '0.0.0', isDev: false, shellMode: 'desktop' as const }

function command(id: string) {
  const found = systemCommands.find(entry => entry.id === id)

  if (!found) {
    throw new Error(`no command ${id}`)
  }

  return found
}

describe('the language command', () => {
  beforeEach(() => {
    $env.set({ ...ENV, languages: ['zh-Hans-CN', 'en-US'] })
    $prefs.set({ ...$prefs.get(), language: undefined })
  })

  it('switches every string Herald translates, and goes back to following the system', async () => {
    expect($language.get()).toBe('zh-CN')

    expect(await command('language.set').run({ language: 'en' }, UI)).toMatchObject({ ok: true, summary: 'Herald OS is in English' })
    expect($prefs.get().language).toBe('en')
    expect($language.get()).toBe('en')

    expect(await command('language.set').run({ language: 'system' }, UI)).toMatchObject({ ok: true, summary: 'Herald OS follows the system language: 简体中文' })
    expect($language.get()).toBe('zh-CN')
  })

  it('opens the language setting under General', () => {
    command('settings.open').run({ section: 'language' }, UI)

    expect($settingsFocus.get()).toMatchObject({ section: 'general' })
  })
})

describe('the language on the voice fast path', () => {
  beforeEach(() => {
    resetCommands()
    defineCommands(Object.values(commandGroups).flat())
  })

  it('matches the language phrases against the whole catalogue', () => {
    expect(matchIntent('switch to chinese')).toMatchObject({ command: 'language.set', args: { language: 'zh-CN' } })
    expect(matchIntent('Hey Hermes, set the language to english')).toMatchObject({ command: 'language.set', args: { language: 'en' } })
    expect(matchIntent('use the system language')).toMatchObject({ command: 'language.set', args: { language: 'system' } })
    expect(matchIntent('switch to missions')).toMatchObject({ command: 'page.open' })
  })
})

describe('the Privacy & Security pane command', () => {
  beforeEach(() => {
    opened.length = 0
    resetCommands()
    defineCommands(systemCommands)
  })

  it('opens the pane a permission message names, on macOS', async () => {
    $env.set(ENV)

    expect(await runCommand('privacy.openPane', { pane: 'Camera' }, UI)).toMatchObject({ ok: true })
    expect(await runCommand('privacy.openPane', { pane: 'microphone' }, UI)).toMatchObject({ ok: true })
    expect(opened).toEqual(['x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Camera', 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone'])
  })

  it('refuses a pane it does not know, and opens nothing', async () => {
    $env.set(ENV)

    expect(await runCommand('privacy.openPane', { pane: 'users' }, UI)).toMatchObject({ ok: false })
    expect(await command('privacy.openPane').run({ pane: 'toString' }, UI)).toMatchObject({ ok: false })
    expect(opened).toEqual([])
  })

  it('opens nothing off macOS', async () => {
    $env.set({ ...ENV, platform: 'linux' })

    expect(await runCommand('privacy.openPane', { pane: 'camera' }, UI)).toMatchObject({ ok: false, error: 'System Settings panes exist only on macOS.' })
    expect(opened).toEqual([])
  })

  it('stays out of the command bar', () => {
    expect(command('privacy.openPane').hidden).toBe(true)
  })
})
