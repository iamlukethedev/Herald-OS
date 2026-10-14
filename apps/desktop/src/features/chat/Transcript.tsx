import { IconChevronRight } from '@tabler/icons-react'
import { memo, useEffect, useRef, useState } from 'react'
import { BotAvatar } from '../../components/bot-avatar.tsx'
import { HermesMark } from '../../components/hermes-mark.tsx'
import type { Bot } from '../../lib/bots.ts'
import { cn } from '../../lib/cn.ts'
import type { AssistantMessage, ChatMessage, ChatState } from '../../lib/chat-model.ts'
import { Markdown } from './Markdown.tsx'
import { ToolRow } from './ToolRow.tsx'

/** `bot` is the bot the chat runs as, when it is not Hermes. */
export function Transcript({ chat, bot }: { chat: ChatState; bot?: Bot }) {
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

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
  }, [chat.messages, chat.status])

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        {chat.messages.map(message => (
          <Message key={message.id} message={message} bot={bot} />
        ))}
        {chat.streaming && chat.status && (
          <div className="flex items-center gap-2 px-1 text-[12px] text-fg-3 animate-fade-in">
            <span className="size-1.5 rounded-full bg-accent animate-pulse-soft" />
            {chat.status.text}
          </div>
        )}
        {chat.streaming && !chat.status && !chat.openAssistantId && (
          <div className="flex items-center gap-2 px-1 text-[12px] text-fg-3 animate-fade-in">
            <span className="size-1.5 rounded-full bg-accent animate-pulse-soft" />
            Thinking
          </div>
        )}
      </div>
    </div>
  )
}

const Message = memo(function Message({ message, bot }: { message: ChatMessage; bot?: Bot }) {
  switch (message.role) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="selectable max-w-[80%] rounded-lg rounded-tr-sm bg-surface-2 px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap">{message.text}</div>
        </div>
      )
    case 'assistant':
      return <Assistant message={message} bot={bot} />
    case 'tool':
      return <ToolRow tool={message} />
    case 'system':
      return (
        <div className={cn('selectable rounded-md px-3 py-2 text-[12.5px] whitespace-pre-wrap', message.level === 'error' ? 'bg-danger/10 text-danger' : message.level === 'warn' ? 'bg-warn/10 text-warn' : 'text-fg-3')}>
          {message.text}
        </div>
      )
  }
})

function Assistant({ message, bot }: { message: AssistantMessage; bot?: Bot }) {
  const [showReasoning, setShowReasoning] = useState(false)
  const hasReasoning = message.reasoning.trim().length > 0

  return (
    <div className="flex gap-3">
      <div className="mt-1.5 flex size-5 shrink-0 items-center justify-center">
        {bot ? <BotAvatar bot={bot} size={20} rounded={6} className={cn(message.streaming && 'animate-pulse-soft')} /> : <HermesMark size={14} className={cn(message.streaming && 'animate-pulse-soft')} />}
      </div>
      <div className="min-w-0 flex-1">
        {hasReasoning && (
          <button type="button" onClick={() => setShowReasoning(v => !v)} className="mb-1 flex items-center gap-1 text-[11.5px] text-fg-3 hover:text-fg-2">
            <IconChevronRight size={12} className={cn('transition-transform duration-100', showReasoning && 'rotate-90')} />
            {message.streaming && !message.text ? 'Thinking' : 'Reasoning'}
          </button>
        )}
        {hasReasoning && showReasoning && (
          <div className="selectable mb-2 border-l border-hairline-strong pl-3 text-[12px] leading-relaxed whitespace-pre-wrap text-fg-3">{message.reasoning}</div>
        )}
        {message.text.trim() ? (
          <div className={cn('text-[13.5px] leading-relaxed', message.streaming && 'caret')}>
            <Markdown text={message.text.replace(/^\s+/, '')} />
          </div>
        ) : message.streaming && !hasReasoning ? (
          <div className="h-5 w-16 animate-pulse-soft rounded bg-surface-2" />
        ) : null}
        {message.error && <div className="mt-2 rounded-md bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{message.error}</div>}
        {message.status === 'interrupted' && <div className="mt-1 text-[11.5px] text-fg-4">Interrupted</div>}
      </div>
    </div>
  )
}
