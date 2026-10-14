import { useStore } from '@nanostores/react'
import { IconChevronDown, IconPlus, IconTrash } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { BotAvatar } from '../../components/bot-avatar.tsx'
import { Button } from '../../components/ui/button.tsx'
import { botByProfile, isDefaultProfile, sessionKey } from '../../lib/bots.ts'
import { cn } from '../../lib/cn.ts'
import { formatRelative } from '../../lib/format.ts'
import { $bots, $conversationBot, startConversation } from '../../store/bots.ts'
import { $activeChatId, $chats, forgetChat, LISTED_SESSION_SOURCES, openStoredSession } from '../../store/chat.ts'
import { notify } from '../../store/notifications.ts'
import { $botSessions, $runtimeIds, $sessions, deleteSession, refreshSessions } from '../../store/sessions.ts'
import { BotMenu } from '../hermes/BotPicker.tsx'
import { PopMenu } from '../hermes/Menu.tsx'

export function SessionList() {
  const bots = useStore($bots)
  const current = useStore($conversationBot)
  const [shown, setShown] = useState(current.profile)
  const [choosing, setChoosing] = useState(false)
  const hermesSessions = useStore($sessions)
  const botSessions = useStore($botSessions)
  const runtimeIds = useStore($runtimeIds)
  const activeId = useStore($activeChatId)
  const chats = useStore($chats)
  const bot = botByProfile(bots, shown)
  const profile = isDefaultProfile(shown) ? undefined : shown
  const sessions = profile ? (botSessions[profile] ?? []) : hermesSessions
  const visible = sessions.filter(row => !row.source || LISTED_SESSION_SOURCES.has(row.source))

  // Each bot keeps its own sessions: the list shows those of the conversation on screen until another bot is picked above it.
  useEffect(() => {
    setShown(current.profile)
  }, [current.profile])

  useEffect(() => {
    if (profile) {
      void refreshSessions(profile)
    }
  }, [profile])

  const startNew = () => {
    void startConversation(shown).catch((error: unknown) => {
      notify({ title: 'Could not start the conversation', body: error instanceof Error ? error.message : String(error), level: 'error', surface: 'hermes' })
    })
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-hairline">
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <span className="text-[11px] font-medium tracking-[0.08em] text-fg-3 uppercase">Sessions</span>
        <div className="flex min-w-0 items-center gap-1">
          {bots.length > 1 && (
            <PopMenu
              open={choosing}
              onClose={() => setChoosing(false)}
              width="w-64"
              className="min-w-0"
              trigger={
                <button type="button" onClick={() => setChoosing(v => !v)} aria-haspopup="menu" aria-expanded={choosing} aria-label={`Sessions with ${bot.name}; choose another bot`} className="flex h-7 max-w-full items-center gap-1.5 rounded-lg pr-1.5 pl-1 text-[12px] text-fg-2 hover:bg-white/8 hover:text-fg">
                  <BotAvatar bot={bot} size={18} rounded={5} />
                  <span className="truncate">{bot.name}</span>
                  <IconChevronDown size={13} className="shrink-0 text-fg-3" />
                </button>
              }
            >
              <BotMenu
                heading="Sessions with"
                current={shown}
                onChoose={chosen => {
                  setChoosing(false)
                  setShown(chosen.profile)
                }}
              />
            </PopMenu>
          )}
          <Button variant="ghost" size="icon-sm" aria-label={bots.length > 1 ? `New session with ${bot.name}` : 'New session'} onClick={startNew}>
            <IconPlus size={15} />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {visible.length === 0 && <div className="px-2 py-4 text-[12px] text-fg-4">No sessions yet. Say something to {bot.name}.</div>}
        {visible.map(row => {
          const runtimeId = runtimeIds[sessionKey(row.id, profile)]
          const live = runtimeId ? chats[runtimeId] : undefined
          const active = runtimeId === activeId && Boolean(activeId)
          const title = live?.title || row.title || row.preview || 'Untitled'

          return (
            <div key={row.id} className={cn('group/reveal-row relative flex items-center rounded-md', active ? 'bg-white/6' : 'hover:bg-white/4')}>
              <button type="button" onClick={() => void openStoredSession(row.id, profile)} className="min-w-0 flex-1 px-2.5 py-2 text-left">
                <div className="flex items-center gap-2">
                  {live?.streaming && <span className="size-1.5 shrink-0 rounded-full bg-accent animate-pulse-soft" />}
                  <span className={cn('truncate text-[12.5px]', active ? 'text-fg' : 'text-fg-2')}>{title}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-fg-4">
                  <span>{formatRelative(row.started_at)}</span>
                  {row.message_count ? <span>· {row.message_count} msgs</span> : null}
                </div>
              </button>
              <button
                type="button"
                aria-label="Delete session"
                onClick={() => {
                  void deleteSession(row.id, profile)

                  if (runtimeId) {
                    forgetChat(runtimeId)
                  }
                }}
                className="reveal mr-1 flex size-6 shrink-0 items-center justify-center rounded-xs text-fg-4 hover:text-danger"
              >
                <IconTrash size={13} />
              </button>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
