import type { ProfileRow, SessionListRow } from '@herald-os/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HERMES_BOT } from '../lib/bots.ts'
import { $prefs } from './backend.ts'
import { $botAvatars, $bots, $botsLoaded, $conversationBot, $newChatBot, loadAvatar, refreshBots, startConversation } from './bots.ts'
import { $activeChatId, $chats, openStoredSession } from './chat.ts'
import { $missions } from './missions.ts'
import { $botSessions, $runtimeIds, $sessions, deleteSession, refreshSessions } from './sessions.ts'

// The bots, chat, sessions and missions stores are real; Hermes's socket is the fake below, and
// the preferences live in this test instead of Electron main.
const edges = vi.hoisted(() => {
  const edges = {
    prefs: {} as Record<string, unknown>,
    requests: [] as Array<{ method: string; params: Record<string, unknown> }>,
    profiles: [] as unknown[],
    sessions: {} as Record<string, unknown[]>,
    created: 0
  }

  Object.assign(globalThis, {
    window: { innerWidth: 1440, innerHeight: 900, heraldOS: { prefs: { set: async (patch: Record<string, unknown>) => (edges.prefs = { ...edges.prefs, ...patch }) } } },
    document: { documentElement: { dataset: {}, style: { setProperty: () => undefined, removeProperty: () => undefined } } }
  })

  return edges
})

vi.mock('./gateway.ts', async () => {
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

      switch (method) {
        case 'profiles.list':
          return { profiles: edges.profiles, bot_mode_protocol: true }
        case 'profiles.get_asset':
          return params.name === 'alfred' ? { found: true, mime: 'image/png', data: 'data:image/png;base64,QUxGUkVE' } : { found: false }
        case 'session.create':
          if (params.profile === 'ghost') {
            throw new Error("Profile 'ghost' does not exist.")
          }

          edges.created += 1

          return { session_id: `runtime-${edges.created}`, stored_session_id: `stored-${edges.created}`, message_count: 0, messages: [], info: { profile_name: params.profile ?? 'default' } }
        case 'session.resume':
          edges.created += 1

          return { session_id: `runtime-${edges.created}`, stored_session_id: params.session_id, message_count: 0, messages: [], info: {} }
        case 'session.list':
          return { sessions: edges.sessions[String(params.profile ?? 'default')] ?? [] }
        case 'session.delete':
          return { deleted: params.session_id }
        default:
          return {}
      }
    }
  }
})

const row = (name: string, extra: Partial<ProfileRow> = {}): ProfileRow => ({ name, path: `/home/me/.hermes/profiles/${name}`, ...extra })
const listed = (id: string, title: string, extra: Partial<SessionListRow> = {}): SessionListRow => ({ id, title, preview: '', started_at: 1_760_000_000, message_count: 2, source: 'desktop', ...extra })
const sent = (method: string) => edges.requests.filter(request => request.method === method).map(request => request.params)

const ROSTER = [
  row('default', { path: '/home/me/.hermes', is_default: true, has_avatar: true }),
  row('sally', { has_avatar: true, ui_meta: { 'hermes-bots': { title: 'Sally' } } }),
  row('alfred', { has_avatar: true, description: 'Alfred — Runs the house', ui_meta: { 'hermes-bots': { title: 'Alfred' } } }),
  row('hermes-setup', { role: 'setup' })
]

describe('the bots a conversation runs as', () => {
  beforeEach(() => {
    edges.requests.length = 0
    edges.profiles = ROSTER
    edges.sessions = {}
    edges.prefs = { ...$prefs.get(), conversationBot: undefined }
    $prefs.set(edges.prefs as never)
    $bots.set([HERMES_BOT])
    $botsLoaded.set(false)
    $botAvatars.set({})
    $chats.set({})
    $activeChatId.set(null)
    $sessions.set([])
    $botSessions.set({})
    $runtimeIds.set({})
  })

  it('come from the gateway’s roster, Hermes first', async () => {
    await refreshBots()

    expect($bots.get().map(bot => [bot.profile, bot.name, bot.description])).toEqual([
      ['default', 'Hermes', ''],
      ['alfred', 'Alfred', 'Runs the house'],
      ['sally', 'Sally', '']
    ])
    expect(sent('profiles.list')).toEqual([{ include_sessions: false }])
    expect(sent('profiles.get_asset')).toEqual([])
  })

  it('fetch a bot’s picture once, when it is first shown, and never Hermes’s', async () => {
    const bots = await refreshBots()
    await Promise.all(bots.map(loadAvatar))
    await Promise.all(bots.map(loadAvatar))

    // Hermes keeps Herald's own mark; the gateway says it has a picture of Sally but finds none.
    expect(sent('profiles.get_asset')).toEqual([
      { name: 'alfred', asset: 'avatar' },
      { name: 'sally', asset: 'avatar' }
    ])
    expect($botAvatars.get()).toEqual({ alfred: 'data:image/png;base64,QUxGUkVE', sally: null })
  })

  it('start a new conversation as the chosen bot, and the next one too', async () => {
    await refreshBots()
    const chat = await startConversation('alfred')

    expect(sent('session.create')).toEqual([expect.objectContaining({ source: 'herald_os', profile: 'alfred' })])
    expect(chat.profile).toBe('alfred')
    expect($activeChatId.get()).toBe(chat.sessionId)
    expect($conversationBot.get().name).toBe('Alfred')
    expect(edges.prefs.conversationBot).toBe('alfred')
    expect($newChatBot.get().profile).toBe('alfred')

    const next = await startConversation()

    expect(sent('session.create')[1]).toMatchObject({ profile: 'alfred' })
    expect(next.profile).toBe('alfred')
  })

  it('keep Hermes’s conversations as they always were, with no profile on the wire', async () => {
    await refreshBots()
    const chat = await startConversation('default')

    expect(sent('session.create')[0]).not.toHaveProperty('profile')
    expect(chat.profile).toBeUndefined()
    expect(edges.prefs.conversationBot).toBeUndefined()
  })

  it('wait for the roster before starting a conversation with the remembered bot', async () => {
    $prefs.set({ ...$prefs.get(), conversationBot: 'sally' })

    const chat = await startConversation()

    expect(sent('profiles.list')).toHaveLength(1)
    expect(chat.profile).toBe('sally')
  })

  it('fall back to Hermes when the remembered bot is no longer a profile', async () => {
    $prefs.set({ ...$prefs.get(), conversationBot: 'ghost' })
    await refreshBots()

    expect($newChatBot.get().profile).toBe('default')
    expect((await startConversation()).profile).toBeUndefined()
  })

  it('reload the roster when a bot turned out to be gone', async () => {
    await expect(startConversation('ghost')).rejects.toThrow("Profile 'ghost' does not exist.")

    expect(sent('profiles.list')).toHaveLength(1)
    expect(edges.prefs.conversationBot).toBeUndefined()
  })
})

describe('each bot’s sessions', () => {
  beforeEach(() => {
    edges.requests.length = 0
    edges.profiles = ROSTER
    edges.sessions = {
      default: [listed('h1', 'Disk space')],
      alfred: [listed('a1', 'Bot Chat'), listed('a2', 'Group: Research'), listed('a3', 'Dinner plans', { started_at: 1_760_000_500 })]
    }
    $chats.set({})
    $activeChatId.set(null)
    $sessions.set([])
    $botSessions.set({})
    $runtimeIds.set({})
  })

  it('are listed apart from Hermes’s, hidden chats included and group rooms left out', async () => {
    await refreshSessions('alfred')
    await refreshSessions()

    expect(sent('session.list')).toEqual([{ profile: 'alfred', limit: 60, include_hidden: true }, { limit: 60 }])
    expect($botSessions.get().alfred.map(session => session.id)).toEqual(['a3', 'a1'])
    expect($sessions.get().map(session => session.id)).toEqual(['h1'])
  })

  it('reopen with the bot’s profile, and a second open finds the live chat', async () => {
    const chat = await openStoredSession('a1', 'alfred')

    expect(sent('session.resume')).toEqual([{ session_id: 'a1', source: 'herald_os', profile: 'alfred' }])
    expect(chat).toMatchObject({ storedSessionId: 'a1', profile: 'alfred' })
    expect($runtimeIds.get()['alfred:a1']).toBe(chat.sessionId)

    expect(await openStoredSession('a1', 'alfred')).toBe(chat)
    expect(sent('session.resume')).toHaveLength(1)
  })

  it('never stand in for Hermes’s session with the same stored id', async () => {
    const bots = await openStoredSession('same-id', 'alfred')
    const hermes = await openStoredSession('same-id')

    expect(hermes).not.toBe(bots)
    expect(sent('session.resume')[1]).toEqual({ session_id: 'same-id', source: 'herald_os' })
    expect($runtimeIds.get()).toMatchObject({ 'same-id': hermes.sessionId, 'alfred:same-id': bots.sessionId })
  })

  it('are deleted in the bot’s own profile', async () => {
    await refreshSessions('alfred')
    await deleteSession('a3', 'alfred')

    expect(sent('session.delete')).toEqual([{ session_id: 'a3', profile: 'alfred' }])
    expect($botSessions.get().alfred.map(session => session.id)).toEqual(['a1'])
  })

  it('stay out of Missions, which reopen Hermes’s sessions only', async () => {
    const withHermes = await startConversation('default')
    const withAlfred = await startConversation('alfred')
    const missions = $missions.get().map(mission => mission.id)

    expect(missions).toContain(withHermes.storedSessionId)
    expect(missions).not.toContain(withAlfred.storedSessionId)
  })
})
