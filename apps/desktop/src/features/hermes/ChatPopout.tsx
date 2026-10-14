import { useEffect } from 'react'
import { openStoredSession } from '../../store/chat.ts'
import { ChatSurface } from '../chat/ChatSurface.tsx'

/** A conversation in its own floating window; `profile` is the bot it runs as, when it is not Hermes. */
export function ChatPopout({ sessionId, profile }: { sessionId?: string; profile?: string }) {
  useEffect(() => {
    if (sessionId) {
      void openStoredSession(sessionId, profile)
    }
  }, [sessionId, profile])

  return <ChatSurface />
}
