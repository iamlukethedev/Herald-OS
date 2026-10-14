import { useStore } from '@nanostores/react'
import { IconChevronRight, IconUser } from '@tabler/icons-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { BotAvatar } from '../../components/bot-avatar.tsx'
import { type Bot, botByProfile, isDefaultProfile } from '../../lib/bots.ts'
import { cn } from '../../lib/cn.ts'
import type { AssistantMessage, ChatMessage, ChatState, SystemMessage, ToolMessage, UserMessage } from '../../lib/chat-model.ts'
import { $bots, $newChatBot, startConversation } from '../../store/bots.ts'
import { interruptChat, runSlash, sendPrompt } from '../../store/chat.ts'
import type { Artifact } from '../../store/missions.ts'
import { $activeSpace } from '../../store/spaces.ts'
import { Markdown } from '../chat/Markdown.tsx'
import { $chatArtifacts, $selectedArtifact, artifactsInWindow, dayLabel, formatTime, selectArtifact } from './artifact-store.ts'
import { ArtifactCard } from './ArtifactCard.tsx'
import { HermesComposer } from './HermesComposer.tsx'
import { SuggestionChips } from './SuggestionChips.tsx'
import { ToolSummaryRow } from './ToolSummaryRow.tsx'

const HERO_SUGGESTIONS = ["What's using the most CPU right now?", 'Find the screenshots I took yesterday', 'Draft a brief for my next product review', 'What is taking up my disk space?']

/** A user prompt and everything Hermes did in response, up to the next prompt. */
interface Turn {
  id: string
  user: UserMessage | null
  items: ChatMessage[]
  start: number
  end: number
}

function groupTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = []

  for (const message of messages) {
    const last = turns.at(-1)

    if (message.role === 'user' || !last) {
      turns.push({ id: message.id, user: message.role === 'user' ? message : null, items: message.role === 'user' ? [] : [message], start: message.ts, end: Number.POSITIVE_INFINITY })
    } else {
      last.items.push(message)
    }
  }

  for (let i = 0; i < turns.length - 1; i++) {
    turns[i].end = turns[i + 1].start
  }

  return turns
}

/** Consecutive tool messages collapse into one block; other messages stand alone. */
type Block = { kind: 'tools'; id: string; tools: ToolMessage[] } | { kind: 'message'; id: string; message: AssistantMessage | SystemMessage }

function blocksOf(items: ChatMessage[]): Block[] {
  const blocks: Block[] = []

  for (const item of items) {
    if (item.role === 'tool') {
      const last = blocks.at(-1)

      if (last?.kind === 'tools') {
        last.tools.push(item)
      } else {
        blocks.push({ kind: 'tools', id: item.id, tools: [item] })
      }
    } else if (item.role !== 'user') {
      blocks.push({ kind: 'message', id: item.id, message: item })
    }
  }

  return blocks
}

export function Conversation({ chat, online }: { chat: ChatState | null; online: boolean }) {
  const space = useStore($activeSpace)
  const submit = async (text: string, attachments: string[]): Promise<void> => {
    await (text.startsWith('/') && attachments.length === 0 ? runSlash(text) : sendPrompt(text, { attachments }))
  }
  const bots = useStore($bots)
  const next = useStore($newChatBot)
  const bot = chat ? botByProfile(bots, chat.profile) : next
  // With no conversation open, the first message starts one with the bot shown above it.
  const send: typeof submit = async (...args) => {
    if (!chat) {
      await startConversation()
    }

    await submit(...args)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <BotAvatar bot={bot} size={36} rounded={10} />
        <div className="min-w-0">
          <div className="truncate text-[15px] leading-tight font-semibold text-fg">{bot.name}</div>
          <div className="truncate text-[12px] text-fg-3">{chat?.title || `${space?.name ?? 'Personal'} workspace`}</div>
        </div>
      </div>

      {chat ? <Transcript chat={chat} bot={bot} online={online} /> : <Hero bot={bot} online={online} />}

      <div className="shrink-0 px-4 pb-4 pt-2">
        <HermesComposer autoFocus disabled={!online} streaming={chat?.streaming} placeholder={online ? `Ask ${bot.name} anything…` : 'Connecting to Hermes…'} onSubmit={send} onInterrupt={() => void interruptChat()} />
      </div>
    </div>
  )
}

function Hero({ bot, online }: { bot: Bot; online: boolean }) {
  // The suggestions need Herald's system tools, and Herald's setup gives those to Hermes alone.
  const hermes = isDefaultProfile(bot.profile)

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6 page-enter">
      <BotAvatar bot={bot} size={48} rounded={14} />
      <div className="text-center">
        <div className="text-[20px] font-semibold tracking-tight text-fg">{bot.name}</div>
        <div className="mt-1 max-w-sm text-[13px] text-fg-3">{hermes ? 'Your computer, in conversation.' : bot.description || `${bot.name} answers here, with its own memory, skills and model.`}</div>
      </div>
      {hermes && (
        <div className="stagger grid w-full max-w-md grid-cols-2 gap-2">
          {HERO_SUGGESTIONS.map(text => (
            <button key={text} type="button" onClick={() => void sendPrompt(text)} disabled={!online} className="glass-card glass-card-hover rounded-xl px-3.5 py-3 text-left text-[12.5px] text-fg-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40">
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Transcript({ chat, bot, online }: { chat: ChatState; bot: Bot; online: boolean }) {
  const artifacts = useStore($chatArtifacts)
  const selected = useStore($selectedArtifact)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const turns = useMemo(() => groupTurns(chat.messages), [chat.messages])

  useEffect(() => {
    const el = scroller.current

    if (!el) {
      return
    }

    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    }
    el.addEventListener('scroll', onScroll, { passive: true })

    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Follow new content only while the reader is at the bottom.
  useEffect(() => {
    const el = scroller.current

    if (el && pinned.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [chat.messages, chat.status, artifacts])

  const lastTurn = turns.at(-1)
  const lastComplete = Boolean(lastTurn && !chat.streaming && lastTurn.items.some(m => m.role === 'assistant' && !m.streaming))
  let previousDay = ''

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="flex flex-col gap-3">
        {chat.hydrating && chat.messages.length === 0 && (
          <div className="flex flex-col gap-3" aria-label="Loading conversation">
            <div className="shimmer ml-auto h-12 w-3/5 rounded-xl" />
            <div className="shimmer h-16 w-4/5 rounded-xl" />
          </div>
        )}
        {turns.map((turn, index) => {
          const day = dayLabel(turn.start)
          const divider = day !== previousDay
          previousDay = day
          const produced = artifactsInWindow(artifacts, turn.start, turn.end)
          const isLast = index === turns.length - 1
          const finished = !isLast || !chat.streaming

          return (
            <div key={turn.id} className="flex flex-col gap-3">
              {divider && <DayDivider label={day} />}
              {turn.user && <UserBubble message={turn.user} />}
              {blocksOf(turn.items).map(block =>
                block.kind === 'tools' ? <ToolSummaryRow key={block.id} tools={block.tools} /> : block.message.role === 'assistant' ? <AssistantBubble key={block.id} message={block.message} bot={bot} /> : <SystemRow key={block.id} message={block.message} />
              )}
              {finished && produced.map(artifact => <ArtifactCard key={artifact.path} artifact={artifact} selected={selected?.path === artifact.path} onSelect={() => selectArtifact(artifact.path)} />)}
              {isLast && lastComplete && <SuggestionChips hasArtifact={artifacts.some((a: Artifact) => a.kind === 'file')} disabled={!online} onPick={text => void sendPrompt(text)} />}
            </div>
          )
        })}
        {chat.streaming && (chat.status || !chat.openAssistantId) && (
          <div className="flex items-center gap-2 px-1 text-[12px] text-fg-3 animate-fade-in">
            <span className="size-1.5 rounded-full bg-accent animate-pulse-soft" />
            {chat.status?.text ?? 'Thinking'}
          </div>
        )}
      </div>
    </div>
  )
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <span className="text-[11.5px] text-fg-3">{label}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  )
}

const UserBubble = memo(function UserBubble({ message }: { message: UserMessage }) {
  return (
    <div className="flex items-start justify-end gap-3">
      <span className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-white/8 text-fg-2" aria-hidden="true">
        <IconUser size={16} stroke={1.7} />
      </span>
      <div className="selectable min-w-0 max-w-[85%] rounded-xl border border-line-strong/50 bg-accent/35 px-4 py-2.5 shadow-card backdrop-blur-md">
        <div className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-fg">{message.text}</div>
        <div className="mt-1 text-right text-[10.5px] tabular-nums text-fg-3">{formatTime(message.ts)}</div>
      </div>
    </div>
  )
})

const AssistantBubble = memo(function AssistantBubble({ message, bot }: { message: AssistantMessage; bot: Bot }) {
  const [showReasoning, setShowReasoning] = useState(false)
  const hasReasoning = message.reasoning.trim().length > 0
  const text = message.text.replace(/^\s+/, '')

  return (
    <div className="flex items-start gap-3">
      <BotAvatar bot={bot} size={28} rounded={8} className={cn('mt-1', message.streaming && 'animate-pulse-soft')} />
      <div className="glass-card min-w-0 max-w-[85%] rounded-xl px-4 py-2.5">
        {hasReasoning && (
          <button type="button" onClick={() => setShowReasoning(v => !v)} className="mb-1 flex items-center gap-1 text-[11.5px] text-fg-3 hover:text-fg-2">
            <IconChevronRight size={12} className={cn('transition-transform duration-100', showReasoning && 'rotate-90')} />
            {message.streaming && !text ? 'Thinking' : 'Reasoning'}
          </button>
        )}
        {hasReasoning && showReasoning && <div className="selectable mb-2 border-l border-line-strong pl-3 text-[12px] leading-relaxed whitespace-pre-wrap text-fg-3">{message.reasoning}</div>}
        {text ? (
          <div className={cn('text-[13.5px] leading-relaxed', message.streaming && 'caret')}>
            <Markdown text={text} />
          </div>
        ) : message.streaming ? (
          <div className="shimmer h-4 w-24 rounded-sm" />
        ) : null}
        {message.error && <div className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{message.error}</div>}
        <div className="mt-1 flex items-center justify-end gap-2 text-[10.5px] tabular-nums text-fg-3">
          {message.status === 'interrupted' && <span className="text-fg-4">Interrupted</span>}
          {!message.streaming && <span>{formatTime(message.ts)}</span>}
        </div>
      </div>
    </div>
  )
})

function SystemRow({ message }: { message: SystemMessage }) {
  return <div className={cn('selectable rounded-lg px-3 py-2 text-[12.5px] whitespace-pre-wrap', message.level === 'error' ? 'bg-danger/10 text-danger' : message.level === 'warn' ? 'bg-warn/10 text-warn' : 'text-fg-3')}>{message.text}</div>
}
