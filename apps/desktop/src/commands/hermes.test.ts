import { beforeEach, describe, expect, it, vi } from 'vitest'
import { $settingsFocus } from '../features/settings/sections/shared.tsx'
import type { ProviderChoice } from '../lib/model-provider.ts'
import { matchIntent } from '../lib/voice/intents.ts'
import { $hermesAuth } from '../store/hermes-auth.ts'
import { $providerFocus } from '../store/model-provider.ts'
import { type CommandContext, defineCommands, resetCommands } from '../store/os-commands.ts'
import { hermesCommands } from './hermes.ts'
import { commandGroups } from './index.ts'

// The stores read the preload bridge and the viewport when they load, and opening Settings asks
// whether motion is reduced; tests run without a DOM.
vi.hoisted(() => {
  Object.assign(globalThis, { window: { innerWidth: 1440, innerHeight: 900 }, document: { documentElement: { dataset: { reduceMotion: 'true' } } } })
})

const providers = vi.hoisted(() => ({ read: vi.fn(), switchTo: vi.fn() }))

vi.mock('../store/model-provider.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../store/model-provider.ts')>()

  return { ...original, readProviderChoices: providers.read, switchToProvider: providers.switchTo }
})

const UI: CommandContext = { source: 'ui' }
const BASE = { current: false, ready: false, keyEnv: null, helpUrl: null, command: null, models: [] }
const CHOICES: ProviderChoice[] = [
  { ...BASE, slug: 'nous', name: 'Nous Portal', current: true, ready: true, setup: 'sign-in', models: ['hermes-4-405b'] },
  { ...BASE, slug: 'deepseek', name: 'DeepSeek', ready: true, setup: 'key', keyEnv: 'DEEPSEEK_API_KEY', models: ['deepseek-chat'] },
  { ...BASE, slug: 'openrouter', name: 'OpenRouter', setup: 'key', keyEnv: 'OPENROUTER_API_KEY' },
  { ...BASE, slug: 'openai-codex', name: 'ChatGPT or Codex Subscription', setup: 'sign-in' },
  { ...BASE, slug: 'openai-api', name: 'OpenAI API', setup: 'key', keyEnv: 'OPENAI_API_KEY' },
  { ...BASE, slug: 'copilot-acp', name: 'GitHub Copilot ACP', setup: 'terminal', command: 'copilot login' }
]

function command(id: string) {
  const found = hermesCommands.find(entry => entry.id === id)

  if (!found) {
    throw new Error(`no command ${id}`)
  }

  return found
}

describe('the model provider commands', () => {
  beforeEach(() => {
    providers.read.mockReset().mockResolvedValue(CHOICES)
    providers.switchTo.mockReset().mockImplementation(async (slug: string) => ({ ok: true, provider: slug, model: 'deepseek-chat' }))
    $hermesAuth.set({ ...$hermesAuth.get(), needsLogin: false, snoozed: false, chosen: null })
    $providerFocus.set(null)
  })

  it('list the providers, the one Hermes uses and which are set up', async () => {
    const result = await command('agents.provider.list').run({}, UI)

    expect(result).toMatchObject({ ok: true, summary: 'Hermes thinks with Nous Portal. Also set up: DeepSeek.' })
    expect(result.items).toHaveLength(CHOICES.length)
  })

  it('switch at once to a provider that is set up', async () => {
    const result = await command('agents.provider.set').run({ provider: 'deepseek' }, UI)

    expect(providers.switchTo).toHaveBeenCalledWith('deepseek')
    expect(result).toMatchObject({ ok: true, summary: 'Hermes now thinks with DeepSeek (deepseek-chat)' })
  })

  it('leave the provider Hermes already uses as it is', async () => {
    expect(await command('agents.provider.set').run({ provider: 'Nous' }, UI)).toMatchObject({ ok: true, summary: 'Hermes already thinks with Nous Portal' })
    expect(providers.switchTo).not.toHaveBeenCalled()
  })

  it('open the sign-in card for a provider that signs in on an account', async () => {
    expect((await command('agents.provider.set').run({ provider: 'ChatGPT' }, UI)).ok).toBe(true)
    expect($hermesAuth.get()).toMatchObject({ needsLogin: true, chosen: 'openai-codex' })
    expect(providers.switchTo).not.toHaveBeenCalled()
  })

  it('send a provider that needs an API key to Settings, where the key is typed', async () => {
    const result = await command('agents.provider.set').run({ provider: 'Open Router' }, UI)

    expect(result).toMatchObject({ ok: true, summary: 'Paste the OpenRouter API key in Settings > Hermes & agents' })
    expect($providerFocus.get()).toMatchObject({ slug: 'openrouter' })
    expect($settingsFocus.get()).toMatchObject({ section: 'agents' })
    expect(providers.switchTo).not.toHaveBeenCalled()
  })

  it('ask which provider is meant, and say when Hermes knows none by that name', async () => {
    expect(await command('agents.provider.set').run({ provider: 'open' }, UI)).toMatchObject({ ok: false, summary: 'Which provider? OpenRouter, OpenAI API' })
    expect(await command('agents.provider.set').run({ provider: 'mistral' }, UI)).toMatchObject({ ok: false, summary: expect.stringContaining('no provider called "mistral"') })
  })

  it('hand a price warning back instead of switching', async () => {
    providers.switchTo.mockResolvedValue({ ok: false, provider: 'deepseek', model: 'deepseek-reasoner', confirm: 'deepseek-reasoner costs far more than most models.' })

    expect(await command('agents.provider.set').run({ provider: 'deepseek' }, UI)).toMatchObject({ ok: false, summary: expect.stringContaining('costs far more than most models') })
  })
})

describe('the model provider on the voice fast path', () => {
  beforeEach(() => {
    resetCommands()
    defineCommands(Object.values(commandGroups).flat())
  })

  it('matches the provider phrases against the whole catalogue', () => {
    expect(matchIntent('switch hermes to openrouter')).toMatchObject({ command: 'agents.provider.set', args: { provider: 'openrouter' } })
    expect(matchIntent('use anthropic as the model provider')).toMatchObject({ command: 'agents.provider.set', args: { provider: 'anthropic' } })
    expect(matchIntent('change the model provider to nous portal')).toMatchObject({ command: 'agents.provider.set', args: { provider: 'nous portal' } })
    expect(matchIntent('which model providers are set up')).toMatchObject({ command: 'agents.provider.list' })
  })
})
