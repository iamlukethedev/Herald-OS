import { atom, computed } from 'nanostores'
import { type Bot, botByProfile, DEFAULT_PROFILE, HERMES_BOT, isDefaultProfile, rosterFrom } from '../lib/bots.ts'
import type { ChatState } from '../lib/chat-model.ts'
import { $prefs, updatePrefs } from './backend.ts'
import { $activeChat, createChat } from './chat.ts'
import { gatewayRequest, isGatewayOpen } from './gateway.ts'

/*
 * The bots a conversation can run as (lib/bots.ts). Choosing one starts a new conversation with it
 * and is remembered for the next ones; chats that features start for their own use stay with Hermes.
 */

/** Hermes first, then the bots; only Hermes until the roster arrives, or on a gateway that serves none. */
export const $bots = atom<Bot[]>([HERMES_BOT])
export const $botsLoaded = atom(false)
/** Pictures by profile, as data URLs; null where the gateway has none. */
export const $botAvatars = atom<Record<string, string | null>>({})

/** The bot new conversations run as: the last one chosen while the roster still has it, else Hermes. */
export const $newChatBot = computed([$bots, $prefs], (bots, prefs) => bots.find(bot => bot.profile === prefs.conversationBot) ?? bots[0] ?? HERMES_BOT)

/** Who the Hermes window's conversation is with, or the next one it starts. */
export const $conversationBot = computed([$activeChat, $bots, $newChatBot], (chat, bots, next) => (chat ? botByProfile(bots, chat.profile) : next))

/** A command asked to see the bots: the Hermes page opens its New conversation menu. */
export const $botsFocus = atom<{ ts: number } | null>(null)

export function focusBots(): void {
  $botsFocus.set({ ts: Date.now() })
}

const unchanged = (a: Bot, b: Bot): boolean => a.profile === b.profile && a.name === b.name && a.description === b.description && a.hasAvatar === b.hasAvatar

let inflight: Promise<Bot[]> | null = null

/** Reload the roster. A gateway without `profiles.list` leaves it at Hermes alone. */
export function refreshBots(): Promise<Bot[]> {
  if (!isGatewayOpen()) {
    return Promise.resolve($bots.get())
  }

  if (inflight) {
    return inflight
  }

  inflight = gatewayRequest('profiles.list', { include_sessions: false })
    .then(result => {
      // Keep the objects of bots that did not change, so the chats showing them do not redraw.
      const known = new Map($bots.get().map(bot => [bot.profile, bot]))
      const bots = rosterFrom(result.profiles ?? []).map(bot => {
        const before = known.get(bot.profile)

        return before && unchanged(before, bot) ? before : bot
      })
      $bots.set(bots)
      $botsLoaded.set(true)

      return bots
    })
    .catch(() => $bots.get())
    .finally(() => {
      inflight = null
    })

  return inflight
}

const loadingAvatars = new Set<string>()

/**
 * Fetch a bot's picture the first time it is shown: a picture can be megabytes, and in panels mode
 * every surface window keeps its own roster. Hermes keeps Herald's own mark, so its picture is never asked for.
 */
export async function loadAvatar(bot: Bot): Promise<void> {
  if (!bot.hasAvatar || isDefaultProfile(bot.profile) || bot.profile in $botAvatars.get() || loadingAvatars.has(bot.profile) || !isGatewayOpen()) {
    return
  }

  loadingAvatars.add(bot.profile)

  try {
    const asset = await gatewayRequest('profiles.get_asset', { name: bot.profile, asset: 'avatar' })
    $botAvatars.set({ ...$botAvatars.get(), [bot.profile]: asset.found && asset.data ? asset.data : null })
  } catch {
    // Its initial stands in; showing it again asks again.
  } finally {
    loadingAvatars.delete(bot.profile)
  }
}

/**
 * Start a new conversation with a bot and show it in the Hermes window. A bot named here is
 * remembered for the next new conversations; without one, it is the bot they run as.
 */
export async function startConversation(profile?: string, options: { title?: string } = {}): Promise<ChatState> {
  if (profile === undefined && !isDefaultProfile($prefs.get().conversationBot) && !$botsLoaded.get()) {
    await refreshBots()
  }

  let chat: ChatState

  try {
    chat = await createChat({ title: options.title, profile: profile ?? $newChatBot.get().profile })
  } catch (error) {
    // Most likely a bot removed since the roster was read; the pickers should stop offering it.
    void refreshBots()

    throw error
  }

  if (profile !== undefined && ($prefs.get().conversationBot ?? DEFAULT_PROFILE) !== profile) {
    await updatePrefs({ conversationBot: profile }).catch(() => undefined)
  }

  return chat
}
