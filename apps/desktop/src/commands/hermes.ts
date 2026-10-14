import { focusSettings } from '../features/settings/sections/shared.tsx'
import { botByProfile } from '../lib/bots.ts'
import { matchProvider } from '../lib/model-provider.ts'
import { pauseAllAgents } from '../store/agents-control.ts'
import { $bots, startConversation } from '../store/bots.ts'
import { $activeChat, interruptChat, openStoredSession, sendPrompt } from '../store/chat.ts'
import { requestHermesLogin } from '../store/hermes-auth.ts'
import { $activeMissions, $completedMissions, $missions, $reviewMissions, focusMissions, markReviewed, type Mission } from '../store/missions.ts'
import { startMission } from '../store/missions-actions.ts'
import { focusProvider, readProviderChoices, switchToProvider } from '../store/model-provider.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { $sessions, refreshSessions } from '../store/sessions.ts'
import { readToolSearch, setToolSearch } from '../store/tool-search.ts'
import { openApp, showPage } from '../store/windows.ts'

/* Chat sessions and missions, how Hermes reaches its tools, and the model provider it thinks with. */

function findMission(query: string): { mission: Mission | null; candidates: Mission[] } {
  const needle = query.trim().toLowerCase()
  const missions = $missions.get()

  if (!needle) {
    return { mission: null, candidates: missions }
  }

  const exact = missions.filter(m => m.title.toLowerCase() === needle)

  if (exact.length === 1) {
    return { mission: exact[0], candidates: exact }
  }

  const partial = missions.filter(m => m.title.toLowerCase().includes(needle) || m.goal.toLowerCase().includes(needle))

  return { mission: partial.length === 1 ? partial[0] : null, candidates: partial }
}

const ambiguous = (what: string, names: string[]) => fail(`Which ${what}? ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}`, { items: names })

export const hermesCommands: readonly OsCommand[] = [
  {
    id: 'chat.new',
    title: 'New chat',
    description: 'Start a new conversation and show it. It runs as the bot last chosen for new conversations: Hermes, unless bots.chat picked another.',
    tier: 'act',
    args: [{ name: 'title', type: 'string', description: 'Optional title' }],
    phrases: ['new chat', 'start a new chat', 'new conversation', 'new session'],
    run: async ({ title }) => {
      const chat = await startConversation(undefined, { title: title ? String(title) : undefined })
      showPage('hermes')

      return ok(chat.profile ? `Started a new chat with ${botByProfile($bots.get(), chat.profile).name}` : 'Started a new chat', { page: 'hermes', data: { sessionId: chat.sessionId } })
    }
  },
  {
    id: 'chat.open',
    title: 'Open a session',
    description: 'Open a past Hermes session by title.',
    tier: 'read',
    args: [{ name: 'title', type: 'string', description: 'Part of the session title', required: true }],
    phrases: ['open the chat about {title}', 'open my {title} session', 'open the conversation about {title}'],
    run: async ({ title }) => {
      const needle = String(title).toLowerCase()
      let rows = $sessions.get()

      if (rows.length === 0) {
        await refreshSessions()
        rows = $sessions.get()
      }

      const matches = rows.filter(row => `${row.title ?? ''} ${row.preview ?? ''}`.toLowerCase().includes(needle))

      if (matches.length === 0) {
        return fail(`No session mentions "${String(title)}".`)
      }

      if (matches.length > 1 && !matches.some(row => (row.title ?? '').toLowerCase() === needle)) {
        return ambiguous(
          'session',
          matches.map(row => row.title || row.preview || row.id)
        )
      }

      const row = matches.find(r => (r.title ?? '').toLowerCase() === needle) ?? matches[0]
      showPage('hermes')
      await openStoredSession(row.id)

      return ok(`Opened "${row.title || row.preview || 'session'}"`, { page: 'hermes' })
    }
  },
  {
    id: 'chat.stop',
    title: 'Stop Hermes',
    description: 'Interrupt the running turn in the active session.',
    tier: 'act',
    args: [],
    phrases: ['stop hermes', 'stop the current task', 'interrupt', 'cancel that'],
    run: async () => {
      const chat = $activeChat.get()

      if (!chat?.streaming) {
        return ok('Nothing is running', { spoken: 'Nothing is running right now.' })
      }

      await interruptChat(chat.sessionId)

      return ok('Stopped the current turn')
    }
  },
  {
    id: 'chat.popout',
    title: 'Pop out the chat',
    description: 'Open the active session in its own window.',
    tier: 'read',
    args: [],
    phrases: ['pop out the chat', 'open the chat in a window', 'chat popout'],
    run: () => {
      const chat = $activeChat.get()

      if (!chat) {
        return fail('No active session to pop out.')
      }

      openApp('chat-popout', { payload: { sessionId: chat.storedSessionId, profile: chat.profile }, title: chat.title || botByProfile($bots.get(), chat.profile).name })

      return ok('Popped out the chat')
    }
  },
  {
    id: 'chat.send',
    title: 'Ask Hermes',
    description: 'Send a message to Hermes in the active session.',
    tier: 'act',
    args: [{ name: 'text', type: 'string', description: 'The message', required: true }],
    hidden: true,
    run: async ({ text }) => {
      showPage('hermes')
      const sid = await sendPrompt(String(text))

      return ok('Sent to Hermes', { page: 'hermes', data: { sessionId: sid } })
    }
  },
  {
    id: 'mission.start',
    title: 'Start a mission',
    description: 'Start a mission: Hermes plans the steps and works through them.',
    tier: 'mutate',
    args: [{ name: 'goal', type: 'string', description: 'What the mission should achieve', required: true }],
    phrases: ['start a mission to {goal}', 'new mission {goal}', 'create a mission to {goal}', 'start a mission: {goal}'],
    run: async ({ goal }) => {
      const { sessionId, title } = await startMission(String(goal))

      return ok(`Started mission "${title}"`, { spoken: 'Mission started.', page: 'hermes', data: { sessionId } })
    }
  },
  {
    id: 'mission.compose',
    title: 'New mission form',
    description: 'Open the Missions page with the new-mission form.',
    tier: 'read',
    args: [],
    phrases: ['new mission', 'start a mission', 'create a mission'],
    hidden: true,
    run: () => {
      showPage('missions')
      focusMissions({ compose: true })

      return ok('Opened the new-mission form', { page: 'missions' })
    }
  },
  {
    id: 'mission.open',
    title: 'Open a mission',
    description: 'Show a mission by name on the Missions page.',
    tier: 'read',
    args: [{ name: 'name', type: 'string', description: 'Part of the mission title', required: true }],
    phrases: ['open the {name} mission', 'show the mission {name}', 'open mission {name}'],
    run: ({ name }) => {
      const { mission, candidates } = findMission(String(name))

      if (!mission) {
        return candidates.length ? ambiguous('mission', candidates.map(m => m.title)) : fail(`No mission matches "${String(name)}".`)
      }

      showPage('missions')
      focusMissions({ tab: mission.status, missionId: mission.id })

      return ok(`Showing mission "${mission.title}"`, { page: 'missions', highlight: { kind: 'mission', id: mission.id }, data: { status: mission.status, progress: mission.progress } })
    }
  },
  {
    id: 'mission.list',
    title: 'List missions',
    description: 'Summarise active missions and those waiting for review.',
    tier: 'read',
    args: [],
    phrases: ['what missions are running', 'list my missions', 'show my missions', 'how are my missions going'],
    run: () => {
      const active = $activeMissions.get()
      const review = $reviewMissions.get()
      const completed = $completedMissions.get()
      showPage('missions')
      const summary = `${active.length} active, ${review.length} to review, ${completed.length} completed`

      return ok(summary, {
        page: 'missions',
        spoken: active.length ? `${summary}. Active: ${active.map(m => m.title).slice(0, 3).join(', ')}.` : `${summary}.`,
        items: [...active, ...review].map(m => ({ id: m.id, title: m.title, status: m.status, progress: m.progress, currentStep: m.currentStep }))
      })
    }
  },
  {
    id: 'mission.pause',
    title: 'Pause a mission',
    description: 'Interrupt a running mission.',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Part of the mission title', required: true }],
    phrases: ['pause the {name} mission', 'stop the {name} mission'],
    run: async ({ name }) => {
      const { mission, candidates } = findMission(String(name))

      if (!mission) {
        return candidates.length ? ambiguous('mission', candidates.map(m => m.title)) : fail(`No mission matches "${String(name)}".`)
      }

      if (!mission.runtimeId) {
        return fail(`"${mission.title}" is not running.`)
      }

      await interruptChat(mission.runtimeId)
      showPage('missions')
      focusMissions({ missionId: mission.id })

      return ok(`Paused "${mission.title}"`, { page: 'missions', highlight: { kind: 'mission', id: mission.id } })
    }
  },
  {
    id: 'mission.markReviewed',
    title: 'Mark a mission reviewed',
    description: 'Move a mission from Needs review to Completed.',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Part of the mission title', required: true }],
    phrases: ['mark the {name} mission as reviewed', 'mark {name} reviewed', 'i reviewed the {name} mission'],
    run: ({ name }) => {
      const { mission, candidates } = findMission(String(name))

      if (!mission) {
        return candidates.length ? ambiguous('mission', candidates.map(m => m.title)) : fail(`No mission matches "${String(name)}".`)
      }

      markReviewed(mission.id)
      showPage('missions')
      focusMissions({ tab: 'completed', missionId: mission.id })

      return ok(`Marked "${mission.title}" as reviewed`, { page: 'missions', highlight: { kind: 'mission', id: mission.id } })
    }
  },
  {
    id: 'agents.pauseAll',
    title: 'Pause all agents',
    description: 'Interrupt every running session and pause every automation.',
    tier: 'destructive',
    args: [],
    phrases: ['pause all agents', 'pause everything', 'stop everything'],
    run: async () => {
      const result = await pauseAllAgents()

      return ok(`Paused all agents: ${result.interrupted} sessions, ${result.paused} automations`, { data: { ...result } })
    }
  },
  {
    id: 'agents.toolSearch.set',
    title: 'Tool search',
    description: "Hermes's Tool Search for every session: on looks plugin and MCP tools up when needed (fewer prompt tokens), off keeps Herald OS's system tools directly callable. New conversations use it.",
    tier: 'mutate',
    args: [{ name: 'enabled', type: 'boolean', description: 'true to turn Tool Search on, false to turn it off; leave it out to flip it' }],
    phrases: [
      { phrase: 'turn on tool search', args: { enabled: true } },
      { phrase: 'turn off tool search', args: { enabled: false } }
    ],
    run: async ({ enabled }) => {
      const on = enabled === undefined ? !(await readToolSearch()) : Boolean(enabled)
      await setToolSearch(on)

      return ok(`Tool search ${on ? 'on' : 'off'} for new conversations`, { highlight: { kind: 'setting', id: 'agents' }, data: { enabled: on } })
    }
  },
  {
    id: 'agents.provider.list',
    title: 'Model providers',
    description: 'The model providers Hermes knows (Nous Portal, OpenRouter, OpenAI, Anthropic, a ChatGPT account, …), the one it thinks with, and which are set up.',
    tier: 'read',
    args: [],
    phrases: ['which model providers are set up', 'list the model providers', 'which model provider does hermes use'],
    run: async () => {
      const choices = await readProviderChoices()
      const current = choices.find(choice => choice.current)
      const ready = choices.filter(choice => choice.ready && !choice.current)

      return ok(`${current ? `Hermes thinks with ${current.name}${current.ready ? '' : ', which is not set up'}` : 'Hermes has no model provider yet'}. ${ready.length ? `Also set up: ${ready.map(choice => choice.name).join(', ')}.` : 'No other provider is set up.'}`, {
        highlight: { kind: 'setting', id: 'agents' },
        items: choices.map(choice => ({ id: choice.slug, name: choice.name, current: choice.current, ready: choice.ready, setup: choice.ready ? null : choice.setup }))
      })
    }
  },
  {
    id: 'agents.provider.set',
    title: 'Use a model provider',
    description:
      "Switch the provider Hermes thinks with. One that is set up (signed in, or its API key saved) is used at once, on Hermes's recommended model for it; one that signs in on an account opens the sign-in card; any other opens Settings > Hermes & agents at its setup. An API key is only ever typed into Settings, never passed to a command.",
    tier: 'mutate',
    args: [{ name: 'provider', type: 'string', description: 'Provider name or id: OpenRouter, Anthropic, Nous Portal, openai-codex, …', required: true }],
    phrases: ['switch hermes to {provider}', 'use {provider} as the model provider', 'change the model provider to {provider}', 'set the model provider to {provider}'],
    run: async ({ provider }) => {
      const choices = await readProviderChoices()
      const { choice, candidates } = matchProvider(choices, String(provider))
      const highlight = { kind: 'setting', id: 'agents' } as const

      if (!choice) {
        return candidates.length > 1 ? ambiguous('provider', candidates.map(item => item.name)) : fail(`Hermes knows no provider called "${String(provider)}". agents.provider.list names them.`)
      }

      if (choice.ready && choice.current) {
        return ok(`Hermes already thinks with ${choice.name}`, { highlight })
      }

      if (choice.ready) {
        const change = await switchToProvider(choice.slug)

        if (!change.ok) {
          return fail(`${change.confirm} Choose ${choice.name}'s model in Settings > Hermes & agents.`, { highlight })
        }

        return ok(`Hermes now thinks with ${choice.name} (${change.model})`, { spoken: `Hermes now uses ${choice.name}.`, highlight, data: { provider: change.provider, model: change.model } })
      }

      if (choice.setup === 'sign-in') {
        requestHermesLogin(`Sign in to ${choice.name} to use it with Hermes.`, choice.slug)

        return ok(`Sign in to ${choice.name} on the card`, { data: { provider: choice.slug } })
      }

      showPage('settings')
      focusSettings({ section: 'agents' })
      focusProvider(choice.slug)

      return ok(choice.setup === 'key' ? `Paste the ${choice.name} API key in Settings > Hermes & agents` : `Settings > Hermes & agents shows how to set ${choice.name} up`, { page: 'settings', highlight, data: { provider: choice.slug, setup: choice.setup } })
    }
  }
]
