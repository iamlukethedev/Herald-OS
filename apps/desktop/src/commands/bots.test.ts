import type { ProfileRow } from '@herald-os/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HERMES_BOT } from '../lib/bots.ts'
import { matchIntent } from '../lib/voice/intents.ts'
import { $prefs } from '../store/backend.ts'
import { $bots, $botsFocus, $botsLoaded, refreshBots } from '../store/bots.ts'
import { $activeChatId, $chats } from '../store/chat.ts'
import { type CommandContext, defineCommands, resetCommands } from '../store/os-commands.ts'
import { $page } from '../store/windows.ts'
import { botCommands } from './bots.ts'
import { hermesCommands } from './hermes.ts'
import { commandGroups } from './index.ts'

// The stores read the preload bridge and the viewport when they load, and opening a page asks
// whether motion is reduced; tests run without a DOM. Hermes's socket is the fake below.
const edges = vi.hoisted(() => {
  const edges = { prefs: {} as Record<string, unknown>, requests: [] as Array<{ method: string; params: Record<string, unknown> }>, profiles: [] as unknown[], created: 0 }

  Object.assign(globalThis, {
    window: { innerWidth: 1440, innerHeight: 900, heraldOS: { prefs: { set: async (patch: Record<string, unknown>) => (edges.prefs = { ...edges.prefs, ...patch }) } } },
    document: { documentElement: { dataset: { reduceMotion: 'true' }, style: { setProperty: () => undefined, removeProperty: () => undefined } } }
  })

  return edges
})

vi.mock('../store/gateway.ts', async () => {
  const { atom } = await import('nanostores')

  return {
    $connection: atom('open'),
    $gatewayReady: atom({ version: 'test' }),
    $connectionEpoch: atom(0),
    bindGatewayToBackend: () => () => undefined,
    isGatewayOpen: () => true,
    onServerRequest: () => () => undefined,
    onGatewayEvent: () => () => undefined,
    onAnyGatewayEvent: () => () => undefined,
    gatewayRequest: async (method: string, params: Record<string, unknown>) => {
      edges.requests.push({ method, params })

      if (method === 'profiles.list') {
        return { profiles: edges.profiles, bot_mode_protocol: true }
      }

      if (method === 'session.create') {
        edges.created += 1

        return { session_id: `runtime-${edges.created}`, stored_session_id: `stored-${edges.created}`, message_count: 0, messages: [], info: {} }
      }

      return method === 'session.list' ? { sessions: [] } : {}
    }
  }
})

const UI: CommandContext = { source: 'ui' }
const row = (name: string, extra: Partial<ProfileRow> = {}): ProfileRow => ({ name, path: `/home/me/.hermes/profiles/${name}`, ...extra })
const titled = (title: string) => ({ ui_meta: { 'hermes-bots': { title } } })
const ROSTER = [row('default', { path: '/home/me/.hermes', is_default: true }), row('sally', titled('Sally')), row('alfred', { description: 'Alfred — Runs the house', ...titled('Alfred') })]
const sent = (method: string) => edges.requests.filter(request => request.method === method).map(request => request.params)

function command(id: string) {
  const found = [...botCommands, ...hermesCommands].find(entry => entry.id === id)

  if (!found) {
    throw new Error(`no command ${id}`)
  }

  return found
}

describe('the bot commands', () => {
  beforeEach(() => {
    edges.requests.length = 0
    edges.profiles = ROSTER
    edges.prefs = { ...$prefs.get(), conversationBot: undefined }
    $prefs.set(edges.prefs as never)
    $bots.set([HERMES_BOT])
    $botsLoaded.set(false)
    $botsFocus.set(null)
    $chats.set({})
    $activeChatId.set(null)
  })

  it('list the bots, Hermes first, and open the New conversation menu on them', async () => {
    const result = await command('bots.list').run({}, UI)

    expect(result).toMatchObject({ ok: true, page: 'hermes', summary: '3 bots: Hermes, Alfred and Sally. New conversations run as Hermes.' })
    expect(result.items).toEqual([
      { profile: 'default', name: 'Hermes', description: '', current: true },
      { profile: 'alfred', name: 'Alfred', description: 'Runs the house', current: false },
      { profile: 'sally', name: 'Sally', description: '', current: false }
    ])
    expect($botsFocus.get()).not.toBeNull()
    expect($page.get()).toBe('hermes')
  })

  it('say so when Hermes is the only bot', async () => {
    edges.profiles = [ROSTER[0]]

    expect(await command('bots.list').run({}, UI)).toMatchObject({ ok: true, summary: expect.stringContaining('Hermes is the only bot so far.') })
    expect($botsFocus.get()).toBeNull()
  })

  it('start a conversation with a bot by its name, and remember it for the next ones', async () => {
    const result = await command('bots.chat').run({ bot: 'alfred' }, UI)

    expect(result).toMatchObject({ ok: true, summary: 'Started a conversation with Alfred', page: 'hermes', data: { bot: 'alfred' } })
    expect(sent('session.create')).toEqual([expect.objectContaining({ profile: 'alfred' })])
    expect($chats.get()[String(result.data?.sessionId)]?.profile).toBe('alfred')
    expect(edges.prefs.conversationBot).toBe('alfred')
  })

  it('find a bot made after the roster was read', async () => {
    await refreshBots()
    edges.profiles = [...ROSTER, row('mark', titled('Mark'))]

    expect(await command('bots.chat').run({ bot: 'Mark' }, UI)).toMatchObject({ ok: true, summary: 'Started a conversation with Mark' })
  })

  it('ask which bot is meant, and say when none goes by that name', async () => {
    edges.profiles = [...ROSTER, row('sam', titled('Sam'))]

    expect(await command('bots.chat').run({ bot: 'sa' }, UI)).toMatchObject({ ok: false, summary: 'Which bot? Sally, Sam' })
    expect(await command('bots.chat').run({ bot: 'nobody' }, UI)).toMatchObject({ ok: false, summary: 'No bot is called "nobody". bots.list names them.' })
    expect(sent('session.create')).toEqual([])
  })

  it('start new chats with the bot chosen last', async () => {
    $prefs.set({ ...$prefs.get(), conversationBot: 'sally' })
    expect(await command('chat.new').run({}, UI)).toMatchObject({ ok: true, summary: 'Started a new chat with Sally' })

    $prefs.set({ ...$prefs.get(), conversationBot: 'default' })
    expect(await command('chat.new').run({}, UI)).toMatchObject({ ok: true, summary: 'Started a new chat' })

    expect(sent('session.create').map(params => params.profile)).toEqual(['sally', undefined])
  })
})

describe('the bots on the voice fast path', () => {
  beforeEach(() => {
    resetCommands()
    defineCommands(Object.values(commandGroups).flat())
  })

  it('match a bot by name against the whole catalogue', () => {
    expect(matchIntent('talk to alfred')).toMatchObject({ command: 'bots.chat', args: { bot: 'alfred' } })
    expect(matchIntent('Hey Hermes, chat with Sally')).toMatchObject({ command: 'bots.chat', args: { bot: 'Sally' } })
    expect(matchIntent('start a conversation with mark')).toMatchObject({ command: 'bots.chat', args: { bot: 'mark' } })
    expect(matchIntent('which bots do i have')).toMatchObject({ command: 'bots.list' })
  })

  it('leave the phrases other commands had alone', () => {
    expect(matchIntent('talk to hermes')?.command).not.toBe('bots.chat')
    expect(matchIntent('talk to me')?.command).not.toBe('bots.chat')
    expect(matchIntent('talk to the pet')?.command).not.toBe('bots.chat')
    expect(matchIntent('new chat')?.command).toBe('chat.new')
    expect(matchIntent('new conversation')?.command).toBe('chat.new')
  })
})
