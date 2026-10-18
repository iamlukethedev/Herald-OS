import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'
import type { PetSnapshot } from '../../../shared/pet.ts'
import { reducedMotion } from '../../lib/motion.ts'
import { $prefs } from '../../store/backend.ts'
import { bubbleText } from './chat-model.ts'
import type { DropSuggestion } from './drops.ts'
import { type PetPose, poseFor } from './sprite.ts'

/** Reduced motion from the system or Herald's own switch, kept current. */
export function useReducedMotion(): boolean {
  const prefs = useStore($prefs)
  const [system, setSystem] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setSystem(query.matches)
    query.addEventListener('change', onChange)

    return () => query.removeEventListener('change', onChange)
  }, [])

  return system || prefs.reduceMotion || reducedMotion()
}

/** False while the window is hidden or minimized: nothing animates then. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')

  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onChange)

    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  return visible
}

/** When `value` last changed. */
export function useSince<T>(value: T): number {
  const ref = useRef<{ value: T; at: number }>({ value, at: Date.now() })

  if (ref.current.value !== value) {
    ref.current = { value, at: Date.now() }
  }

  return ref.current.at
}

/** Re-render once after `ms` (nothing when null). */
export function useWakeAfter(ms: number | null): void {
  const [, setTick] = useState(0)

  useEffect(() => {
    if (ms === null || ms < 0) {
      return
    }

    const timer = setTimeout(() => setTick(tick => tick + 1), ms + 16)

    return () => clearTimeout(timer)
  }, [ms])
}

export type PetExtras = 'card' | 'drop' | 'bubble' | 'say' | null

export interface PetDrop {
  paths: string[]
  suggestions: DropSuggestion[]
}

export interface PetUi {
  bubble: boolean
  setBubble: (open: boolean) => void
  drop: PetDrop | null
  setDrop: (drop: PetDrop | null) => void
  /** A short speech bubble: the reply that came while the chat was closed, a note or a mood. */
  say: string | null
  hush: () => void
}

const SAY_REPLY_MS = 9000
const SAY_NOTE_MS = 6000

/** The pet's own state of things on screen; what Hermes does comes in the snapshot. */
export function usePetUi(snapshot: PetSnapshot): PetUi {
  const [bubble, setBubble] = useState(false)
  const [drop, setDrop] = useState<PetDrop | null>(null)
  const [say, setSay] = useState<{ text: string; until: number } | null>(null)
  const seen = useRef<{ reply: string | null; note: string | null; mood: string | null } | null>(null)
  const lastReply = snapshot.chat.messages.findLast(message => message.role === 'hermes') ?? null
  const replyKey = lastReply && !snapshot.chat.working ? lastReply.id : null

  useEffect(() => {
    const keys = { reply: replyKey, note: snapshot.note?.id ?? null, mood: snapshot.mood?.kind ?? null }
    const before = seen.current
    seen.current = keys

    if (!before) {
      return
    }

    if (keys.reply && keys.reply !== before.reply && !bubble && lastReply) {
      setSay({ text: bubbleText(lastReply.text).text, until: Date.now() + SAY_REPLY_MS })
    } else if (keys.note && keys.note !== before.note && snapshot.note) {
      setSay({ text: snapshot.note.text, until: Date.now() + SAY_NOTE_MS })
    } else if (keys.mood && keys.mood !== before.mood && snapshot.mood) {
      setSay({ text: snapshot.mood.text, until: Date.now() + SAY_NOTE_MS })
    }
  }, [replyKey, snapshot.note, snapshot.mood, bubble, lastReply])

  useEffect(() => {
    if (!say) {
      return
    }

    const timer = setTimeout(() => setSay(null), Math.max(0, say.until - Date.now()))

    return () => clearTimeout(timer)
  }, [say])

  const openBubble = (open: boolean) => {
    setBubble(open)

    if (open) {
      setSay(null)
    }
  }

  return { bubble, setBubble: openBubble, drop, setDrop, say: say?.text ?? null, hush: () => setSay(null) }
}

export function extrasOf(snapshot: PetSnapshot, ui: PetUi, arrived: boolean): PetExtras {
  if (snapshot.approval && arrived) {
    return 'card'
  }

  return ui.drop ? 'drop' : ui.bubble ? 'bubble' : ui.say ? 'say' : null
}

/** The approval the pet holds up: only once its card is drawn, so the request host keeps it on screen while the pet walks over. */
export function heldApprovalOf(snapshot: PetSnapshot, extras: PetExtras): string | null {
  return extras === 'card' ? (snapshot.approval?.id ?? null) : null
}

/** The pose for what the pet does now; worried moods look up at the person at an idle pace. */
export function petPose(snapshot: PetSnapshot, walking: -1 | 0 | 1, activitySince: number, state: { dragging: boolean; dropping: boolean }): { pose: PetPose; rest: boolean } {
  if (state.dragging) {
    return { pose: 'jump', rest: false }
  }

  if (state.dropping) {
    return { pose: 'wave', rest: false }
  }

  if (walking === 0 && snapshot.activity === 'idle' && snapshot.mood) {
    return { pose: 'waiting', rest: true }
  }

  return { pose: poseFor(snapshot.activity, walking, Date.now() - activitySince), rest: false }
}
