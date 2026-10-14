import { useStore } from '@nanostores/react'
import { BotAvatar } from '../../components/bot-avatar.tsx'
import { HermesMark } from '../../components/hermes-mark.tsx'
import { Badge } from '../../components/ui/primitives.tsx'
import { botByProfile } from '../../lib/bots.ts'
import { $bots } from '../../store/bots.ts'
import { $activeChat, interruptChat, runSlash, sendPrompt } from '../../store/chat.ts'
import { $connection } from '../../store/gateway.ts'
import { Composer } from './Composer.tsx'
import { SessionList } from './SessionList.tsx'
import { Transcript } from './Transcript.tsx'

const SUGGESTIONS = [
  "What's using the most CPU right now?",
  'Find the screenshots I took yesterday',
  'Open Safari',
  'What is taking up my disk space?'
]

export function ChatSurface() {
  const chat = useStore($activeChat)
  const connection = useStore($connection)
  const online = connection === 'open'
  const bots = useStore($bots)
  const bot = chat?.profile ? botByProfile(bots, chat.profile) : undefined

  const submit = async (text: string): Promise<void> => {
    await (text.startsWith('/') ? runSlash(text) : sendPrompt(text))
  }

  return (
    <div className="flex h-full">
      <SessionList />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-3 px-6">
          {bot && (
            <span className="flex shrink-0 items-center gap-2 text-[13px] text-fg">
              <BotAvatar bot={bot} size={20} rounded={6} />
              {bot.name}
            </span>
          )}
          <div className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{chat?.title || (chat ? 'New session' : 'Hermes')}</div>
          {chat?.info.cwd && <span className="truncate font-mono text-[11px] text-fg-4">{chat.info.cwd}</span>}
          {chat?.usage?.context_percent != null && <Badge tone="muted">{Math.round(chat.usage.context_percent)}% context</Badge>}
        </div>

        {chat ? (
          <Transcript chat={chat} bot={bot} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6">
            <HermesMark size={36} />
            <div className="text-center">
              <div className="text-[18px] font-medium tracking-tight">Hermes</div>
              <div className="mt-1 text-[13px] text-fg-3">Your computer, in conversation.</div>
            </div>
            <div className="grid w-full max-w-xl grid-cols-2 gap-2">
              {SUGGESTIONS.map(text => (
                <button key={text} type="button" onClick={() => void sendPrompt(text)} disabled={!online} className="rounded-md bg-surface px-3 py-2.5 text-left text-[12.5px] text-fg-2 hairline hover:bg-surface-2 hover:text-fg disabled:opacity-40">
                  {text}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="shrink-0 px-6 pb-5">
          <div className="mx-auto max-w-3xl">
            <Composer
              autoFocus
              disabled={!online}
              streaming={chat?.streaming}
              placeholder={online ? 'Message Hermes' : 'Connecting to Hermes…'}
              onSubmit={submit}
              onInterrupt={() => void interruptChat()}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
