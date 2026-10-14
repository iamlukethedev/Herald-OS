import { useStore } from '@nanostores/react'
import { IconCheck, IconChevronDown, IconPlus } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { BotAvatar } from '../../components/bot-avatar.tsx'
import { GlassButton } from '../../components/ui/glass.tsx'
import type { Bot } from '../../lib/bots.ts'
import { cn } from '../../lib/cn.ts'
import { $bots, $botsFocus, $conversationBot, $newChatBot, refreshBots, startConversation } from '../../store/bots.ts'
import { notify } from '../../store/notifications.ts'
import { PopMenu } from './Menu.tsx'

/*
 * Choosing the bot a conversation runs as. Choosing starts a new conversation with that bot and is
 * remembered for the next ones; with Hermes the only bot, none of this shows.
 */

function startWith(profile?: string): void {
  void startConversation(profile).catch((error: unknown) => {
    notify({ title: 'Could not start the conversation', body: error instanceof Error ? error.message : String(error), level: 'error', surface: 'hermes' })
  })
}

/** The bots as rows to choose from, Hermes first: picture, name and what each is for. */
export function BotMenu({ heading, current, onChoose }: { heading: string; current: string; onChoose: (bot: Bot) => void }) {
  const bots = useStore($bots)

  // A bot made since the roster was read shows up the next time the menu opens.
  useEffect(() => {
    void refreshBots()
  }, [])

  return (
    <div role="group" aria-label={heading}>
      <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-[0.08em] text-fg-3 uppercase">{heading}</div>
      <div className="max-h-80 overflow-y-auto">
        {bots.map(bot => {
          const chosen = bot.profile === current

          return (
            <button key={bot.profile} type="button" role="menuitemradio" aria-checked={chosen} onClick={() => onChoose(bot)} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-white/8">
              <BotAvatar bot={bot} size={28} rounded={8} />
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-[12.5px]', chosen ? 'text-fg' : 'text-fg-2')}>{bot.name}</span>
                {bot.description && <span className="block truncate text-[11.5px] text-fg-3">{bot.description}</span>}
              </span>
              {chosen && <IconCheck size={15} className="shrink-0 text-accent-strong" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** New conversation, and beside it the bot it runs as, which opens the menu of bots to start one with instead. */
export function NewConversationButton({ disabled }: { disabled?: boolean }) {
  const bots = useStore($bots)
  const next = useStore($newChatBot)
  const focus = useStore($botsFocus)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (focus) {
      setOpen(true)
    }
  }, [focus])

  if (bots.length < 2) {
    return (
      <GlassButton onClick={() => startWith()} disabled={disabled} aria-label="New conversation">
        <IconPlus />
        New conversation
      </GlassButton>
    )
  }

  const choose = (bot: Bot) => {
    setOpen(false)
    startWith(bot.profile)
  }

  return (
    <PopMenu
      open={open}
      onClose={() => setOpen(false)}
      width="w-72"
      trigger={
        <div className="flex">
          <GlassButton onClick={() => startWith()} disabled={disabled} aria-label={`New conversation with ${next.name}`} className="rounded-r-none">
            <IconPlus />
            New conversation
          </GlassButton>
          <GlassButton onClick={() => setOpen(v => !v)} disabled={disabled} aria-label={`Choose the bot, now ${next.name}`} aria-haspopup="menu" aria-expanded={open} className="-ml-px gap-1 rounded-l-none px-2">
            <BotAvatar bot={next} size={20} rounded={6} />
            <IconChevronDown className="text-fg-3" />
          </GlassButton>
        </div>
      }
    >
      <BotMenu heading="New conversation with" current={next.profile} onChoose={choose} />
    </PopMenu>
  )
}

/** Who a message from here goes to; its menu starts a new conversation with another bot. */
export function BotChip({ disabled }: { disabled?: boolean }) {
  const bots = useStore($bots)
  const bot = useStore($conversationBot)
  const [open, setOpen] = useState(false)

  if (bots.length < 2) {
    return null
  }

  const choose = (chosen: Bot) => {
    setOpen(false)
    startWith(chosen.profile)
  }

  return (
    <PopMenu
      open={open}
      onClose={() => setOpen(false)}
      align="left"
      width="w-72"
      trigger={
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(v => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Talking to ${bot.name}; choose a bot to start a new conversation with`}
          className="inline-flex h-8 items-center gap-2 rounded-full border border-line bg-white/6 pr-2.5 pl-1 text-[12.5px] text-fg transition-colors duration-120 hover:border-line-strong hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <BotAvatar bot={bot} size={24} rounded={12} />
          {bot.name}
          <IconChevronDown size={14} className="text-fg-3" />
        </button>
      }
    >
      <BotMenu heading="New conversation with" current={bot.profile} onChoose={choose} />
    </PopMenu>
  )
}
