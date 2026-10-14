import { useStore } from '@nanostores/react'
import { IconArrowUpRight, IconHistory, IconPencil, IconTrash, IconX } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { GlassCard, MoreButton } from '../../components/ui/glass.tsx'
import { botByProfile } from '../../lib/bots.ts'
import { $bots } from '../../store/bots.ts'
import { $activeChat, $activeChatId, $chats, forgetChat } from '../../store/chat.ts'
import { $connection } from '../../store/gateway.ts'
import { notify } from '../../store/notifications.ts'
import { deleteSession } from '../../store/sessions.ts'
import { openApp } from '../../store/windows.ts'
import { SessionList } from '../chat/SessionList.tsx'
import { ArtifactPane } from './ArtifactPane.tsx'
import { NewConversationButton } from './BotPicker.tsx'
import { Conversation } from './Conversation.tsx'
import { MenuDivider, MenuItem, PopMenu } from './Menu.tsx'

/*
 * The Hermes page: a conversation on the left, what Hermes produced on the right. Chat state is
 * the shared store/chat.ts pipeline; this page only lays it out and adds the artifact pane.
 */
export function HermesPage() {
  const chat = useStore($activeChat)
  const activeId = useStore($activeChatId)
  const connection = useStore($connection)
  const online = connection === 'open'
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const renameInput = useRef<HTMLInputElement>(null)

  // Picking a session from the drawer closes it.
  useEffect(() => {
    setSessionsOpen(false)
  }, [activeId])

  useEffect(() => {
    if (!menuOpen) {
      setConfirmDelete(false)
    }
  }, [menuOpen])

  const startRename = () => {
    if (!chat) {
      return
    }

    setTitle(chat.title || '')
    setMenuOpen(false)
    setRenaming(true)
    requestAnimationFrame(() => renameInput.current?.select())
  }

  const commitRename = () => {
    setRenaming(false)

    if (!chat) {
      return
    }

    const next = title.trim()
    const current = $chats.get()[chat.sessionId]

    if (current && next !== current.title) {
      // Local only: the runtime keeps its own title until it renames the session itself.
      $chats.setKey(chat.sessionId, { ...current, title: next, info: { ...current.info, title: next || undefined } })
    }
  }

  const remove = async () => {
    if (!chat) {
      return
    }

    setBusy(true)

    try {
      await deleteSession(chat.storedSessionId, chat.profile)
      forgetChat(chat.sessionId)
      notify({ title: 'Conversation deleted', body: chat.title || undefined, level: 'info', surface: 'hermes' })
    } catch (error) {
      notify({ title: 'Could not delete', body: error instanceof Error ? error.message : String(error), level: 'error', surface: 'hermes' })
    } finally {
      setBusy(false)
      setMenuOpen(false)
    }
  }

  return (
    <div className="page-enter relative flex h-full flex-col">
      <div className="flex items-center justify-end gap-2 px-6 pt-5 pb-4">
        {renaming && (
          <input
            ref={renameInput}
            value={title}
            autoFocus
            aria-label="Conversation title"
            placeholder="Conversation title"
            onChange={event => setTitle(event.target.value)}
            onBlur={commitRename}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                commitRename()
              } else if (event.key === 'Escape') {
                setRenaming(false)
              }
            }}
            className="glass-input h-9 w-72 rounded-lg px-3 text-[13px] outline-none placeholder:text-fg-4 animate-pop"
          />
        )}
        <NewConversationButton disabled={!online} />
        <PopMenu open={menuOpen} onClose={() => setMenuOpen(false)} trigger={<MoreButton aria-label="Conversation actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(v => !v)} />}>
          <MenuItem icon={<IconPencil />} disabled={!chat} onClick={startRename}>
            Rename
          </MenuItem>
          <MenuItem
            icon={<IconArrowUpRight />}
            disabled={!chat}
            onClick={() => {
              setMenuOpen(false)

              if (chat) {
                openApp('chat-popout', { payload: { sessionId: chat.storedSessionId, profile: chat.profile }, title: chat.title || botByProfile($bots.get(), chat.profile).name })
              }
            }}
          >
            Pop out
          </MenuItem>
          <MenuItem
            icon={<IconHistory />}
            onClick={() => {
              setMenuOpen(false)
              setSessionsOpen(v => !v)
            }}
          >
            Sessions…
          </MenuItem>
          <MenuDivider />
          {confirmDelete ? (
            <MenuItem icon={<IconTrash />} danger disabled={busy} onClick={() => void remove()}>
              {busy ? 'Deleting…' : 'Delete for good?'}
            </MenuItem>
          ) : (
            <MenuItem icon={<IconTrash />} danger disabled={!chat} onClick={() => setConfirmDelete(true)}>
              Delete
            </MenuItem>
          )}
        </PopMenu>
      </div>

      <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6">
        <GlassCard className="flex min-w-[380px] basis-[45%] flex-col overflow-hidden">
          <Conversation chat={chat} online={online} />
        </GlassCard>
        <GlassCard className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <ArtifactPane chat={chat} />
        </GlassCard>
      </div>

      {sessionsOpen && (
        <div className="absolute inset-0 z-10 flex" role="dialog" aria-label="Sessions">
          <button type="button" aria-label="Close sessions" onClick={() => setSessionsOpen(false)} className="absolute inset-0 cursor-default bg-black/20" />
          <div className="glass relative m-6 mr-0 flex w-[280px] flex-col overflow-hidden rounded-2xl animate-rise">
            <div className="flex items-center justify-end px-2 pt-2">
              <button type="button" aria-label="Close" onClick={() => setSessionsOpen(false)} className="flex size-7 items-center justify-center rounded-lg text-fg-3 hover:bg-white/8 hover:text-fg">
                <IconX size={15} />
              </button>
            </div>
            <div className="min-h-0 flex-1 [&>aside]:h-full [&>aside]:w-full [&>aside]:border-r-0">
              <SessionList />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
