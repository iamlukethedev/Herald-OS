import { findBot } from '../lib/bots.ts'
import { $bots, $newChatBot, focusBots, refreshBots, startConversation } from '../store/bots.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { showPage } from '../store/windows.ts'

/* The bots a conversation can run as: Hermes itself and the other Hermes profiles (lib/bots.ts). */

/** "Hermes, Alfred and Sally". */
const listed = (names: readonly string[]): string => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ''))

/** The bot a name means, asking the gateway again when the roster has no such bot yet (one made since it was read). */
async function lookUp(name: string): Promise<ReturnType<typeof findBot>> {
  const cached = findBot($bots.get(), name)

  return cached.bot || cached.candidates.length > 1 ? cached : findBot(await refreshBots(), name)
}

export const botCommands: readonly OsCommand[] = [
  {
    id: 'bots.list',
    title: 'List bots',
    description: "The bots a conversation can run as (every Hermes profile, Hermes itself first) and the one new conversations run as, shown in the Hermes page's New conversation menu.",
    tier: 'read',
    args: [],
    phrases: ['which bots do i have', 'list my bots', 'show my bots', 'what bots do i have'],
    run: async () => {
      const bots = await refreshBots()
      const next = $newChatBot.get()
      const items = bots.map(bot => ({ profile: bot.profile, name: bot.name, description: bot.description, current: bot.profile === next.profile }))

      if (bots.length < 2) {
        return ok('Hermes is the only bot so far. Each Hermes profile is a bot; make one with Bot Mode in Hermes Desktop or with hermes profile create.', { spoken: 'Hermes is the only bot so far.', items })
      }

      showPage('hermes')
      focusBots()

      return ok(`${bots.length} bots: ${listed(bots.map(bot => bot.name))}. New conversations run as ${next.name}.`, { page: 'hermes', items })
    }
  },
  {
    id: 'bots.chat',
    title: 'Talk to a bot',
    description: 'Start a new conversation with one of your bots (a Hermes profile) and show it. New conversations run as that bot from then on, until another is chosen.',
    tier: 'act',
    args: [{ name: 'bot', type: 'string', description: 'The bot by its name or profile: Alfred, mark, Hermes', required: true }],
    phrases: ['talk to {bot}', 'chat with {bot}', 'start a conversation with {bot}', 'new conversation with {bot}', 'new chat with {bot}'],
    run: async ({ bot: name }) => {
      const { bot, candidates } = await lookUp(String(name))

      if (!bot) {
        const names = candidates.map(candidate => candidate.name)

        return names.length > 1 ? fail(`Which bot? ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}`, { items: names }) : fail(`No bot is called "${String(name)}". bots.list names them.`)
      }

      const chat = await startConversation(bot.profile)
      showPage('hermes')

      return ok(`Started a conversation with ${bot.name}`, { page: 'hermes', data: { sessionId: chat.sessionId, bot: bot.profile } })
    }
  }
]
