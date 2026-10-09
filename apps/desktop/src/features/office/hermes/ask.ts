import { atom, computed, listenKeys, map } from 'nanostores'
import { OFFICE_APP_NAMES, type OfficeApp } from '../../../../shared/office/files.ts'
import type { AssistantMessage, ChatMessage, ChatState, SystemMessage, ToolMessage } from '../../../lib/chat-model.ts'
import { $backend } from '../../../store/backend.ts'
import { $activeChatId, $chats, createChat, interruptChat, sendPrompt } from '../../../store/chat.ts'
import { $connection } from '../../../store/gateway.ts'
import { $pendingRequests, type PendingRequest } from '../../../store/requests.ts'
import { isMainSurface, openSurface, relayToMain } from '../../../store/shell.ts'
import { showPage } from '../../../store/windows.ts'
import { messageOf } from '../../canvas/errors.ts'
import { homeDir, openEntries } from '../agent.ts'
import { buildPrompt, editsOffice, type HermesAction, type OpenDocument, type PromptSelection, stepLabel } from './prompts.ts'

/*
 * A request to Hermes from an Office window: the prompt is built from the live document, sent in
 * the document's own Hermes session (follow-ups keep the conversation), and followed to its end in
 * that chat, with the step Hermes is on, an approval it waits for and its reply. Hermes's changes
 * land through the docs and sheets commands, one step to undo each; the bar offers to undo them
 * while the document has had no other edit, which the document's history depth tells.
 */

export type AskPhase = 'idle' | 'working' | 'done' | 'error'

export interface AskState {
  phase: AskPhase
  /** What was asked: the person's words, or the action's name. */
  words: string
  action?: HermesAction
  /** What Hermes is doing, while it works. */
  step: string
  /** Hermes's reply, once it has finished. */
  answer: string
  error: string
  sessionId: string | null
  /** What Hermes waits for from the person: an approval, an answer to its question, a password. */
  waiting: PendingRequest['kind'] | null
  startedAt: number
  /** Steps the bar can undo: Hermes's changes, while the document has had no edit of anyone else's. */
  undo: number
}

export interface AskRequest {
  app: OfficeApp
  docKey: string
  words: string
  action?: HermesAction
  /** Herald Docs: mark the selection (or the caret's place) for the request first. */
  mark?: boolean
}

/** What a request needs from a document open in this window. */
export interface LiveDoc {
  name: string
  path: string | null
  selection: PromptSelection | null
  /** What is on screen, when the app says so (Herald Slides' slide). */
  detail?: string
  /** How many steps its history holds; null when it cannot say. */
  depth: () => number | null
  /** Calls back on every change to the document or its history (and more: the depth tells). */
  watch: (listener: () => void) => () => void
  /** Undo this many steps (never past the document as the request found it). */
  undo: (steps: number) => void
  /** Clears the mark the request put on the text. */
  unmark: () => void
}

const IDLE: AskState = { phase: 'idle', words: '', step: '', answer: '', error: '', sessionId: null, waiting: null, startedAt: 0, undo: 0 }

/** Each document's request to Hermes, by the document's key. */
export const $asks = map<Record<string, AskState>>({})

export const askOf = (docKey: string): AskState => $asks.get()[docKey] ?? IDLE

const patch = (docKey: string, change: Partial<AskState>): void => $asks.setKey(docKey, { ...askOf(docKey), ...change })

/** A request for an app's Ask Hermes bar to take the focus, with text to start from. */
export const $askDraft = atom<{ app: OfficeApp; text: string; at: number } | null>(null)

export function draftAsk(app: OfficeApp, text = ''): void {
  $askDraft.set({ app, text, at: Date.now() })
}

/** Whether this window can reach Hermes now. */
export const $hermesState = computed([$backend, $connection], (backend, connection) => (backend.phase === 'ready' && connection === 'open' ? 'ready' : backend.phase === 'failed' ? 'offline' : 'starting'))

/** One Hermes session per document, by the document's key. */
const sessions = new Map<string, string>()

interface Track {
  docKey: string
  live: LiveDoc | null
  sessionId: string | null
  /** Where the request's turn starts in its chat. */
  from: number
  /** The document's history depth when the request started, and when last seen. */
  start: number | null
  seen: number | null
  /** The document changed outside Hermes's calls: its steps are no longer the last ones. */
  touched: boolean
  finished: boolean
  /** Listeners kept while Hermes works. */
  stops: (() => void)[]
  /** The watch on the document, kept until the request is dismissed. */
  unwatch: () => void
}

const tracks = new Map<string, Track>()

const isCurrent = (track: Track): boolean => tracks.get(track.docKey) === track

const runningOfficeCall = (track: Track): boolean =>
  Boolean(track.sessionId && $chats.get()[track.sessionId]?.messages.slice(track.from).some((message) => message.role === 'tool' && message.running && editsOffice(message.name, message.args)))

const stepsOf = (track: Track): number => {
  const depth = track.live?.depth() ?? null

  return !track.touched && depth !== null && track.start !== null ? Math.max(0, depth - track.start) : 0
}

function stopListening(track: Track): void {
  track.finished = true
  track.stops.splice(0).forEach((stop) => stop())
  track.live?.unmark()
}

function release(docKey: string): void {
  const track = tracks.get(docKey)

  if (!track) {
    return
  }

  tracks.delete(docKey)

  if (!track.finished) {
    stopListening(track)
  }

  track.unwatch()
}

function fail(track: Track, error: string): void {
  stopListening(track)
  patch(track.docKey, { phase: 'error', step: '', error, waiting: null, undo: stepsOf(track) })
}

function finish(track: Track, turn: ChatMessage[]): void {
  const replies = turn.filter((message): message is AssistantMessage => message.role === 'assistant')
  const last = replies.at(-1)
  const answer = replies.findLast((message) => message.text.trim())?.text.trim() ?? ''
  const problem = turn.find((message): message is SystemMessage => message.role === 'system' && message.level === 'error')

  if (last?.status === 'error' || (problem && !answer)) {
    fail(track, last?.error || problem?.text || 'Hermes could not finish this request')

    return
  }

  if (last?.status === 'interrupted') {
    fail(track, 'Hermes stopped before it finished')

    return
  }

  stopListening(track)
  patch(track.docKey, { phase: 'done', step: '', answer: answer || 'Done.', waiting: null, undo: stepsOf(track) })
}

function progress(track: Track, chat: ChatState | undefined): void {
  if (!isCurrent(track) || track.finished) {
    return
  }

  if (!chat) {
    fail(track, 'Hermes restarted before it finished: ask again')

    return
  }

  const turn = chat.messages.slice(track.from)

  if (!chat.streaming && turn.length) {
    finish(track, turn)

    return
  }

  const tool = turn.findLast((message): message is ToolMessage => message.role === 'tool')
  const step = tool ? stepLabel(tool.name, tool.args) : 'Thinking'

  if (askOf(track.docKey).step !== step) {
    patch(track.docKey, { step })
  }
}

const ownedBy = (entry: PendingRequest, ids: readonly string[]): boolean => {
  const params = entry.request.params as { session_id?: unknown; gateway_session_id?: unknown }

  return ids.some((id) => id === params.session_id || id === params.gateway_session_id)
}

/** Follow a request's turn in its session, the approvals it waits for and the document's history. */
function follow(track: Track, live: LiveDoc, sessionId: string): void {
  const { docKey } = track
  const chat = $chats.get()[sessionId]
  const ids = [sessionId, chat?.storedSessionId].filter((id): id is string => Boolean(id))
  track.sessionId = sessionId
  track.from = chat?.messages.length ?? 0
  track.start = track.seen = live.depth()
  patch(docKey, { sessionId })

  track.unwatch = live.watch(() => {
    const depth = live.depth()

    if (depth === track.seen) {
      return
    }

    track.seen = depth

    // Hermes's own steps land while one of its Office calls runs; any other is the person's.
    if (!track.finished && runningOfficeCall(track)) {
      return
    }

    track.touched = true

    if (isCurrent(track) && askOf(docKey).undo) {
      patch(docKey, { undo: 0 })
    }
  })

  track.stops.push(
    listenKeys($chats, [sessionId], (chats) => progress(track, chats[sessionId])),
    $pendingRequests.subscribe((pending) => {
      const waiting = pending.find((entry) => ownedBy(entry, ids))?.kind ?? null

      if (isCurrent(track) && askOf(docKey).waiting !== waiting) {
        patch(docKey, { waiting })
      }
    })
  )
}

async function liveDocOf(app: OfficeApp, docKey: string, mark: boolean): Promise<LiveDoc | null> {
  if (app === 'docs') {
    return (await import('./docs-live.ts')).docsLive(docKey, mark)
  }

  if (app === 'sheets') {
    return (await import('./sheets-live.ts')).sheetsLive(docKey)
  }

  return (await import('./slides-live.ts')).slidesLive(docKey)
}

async function otherDocuments(docKey: string): Promise<OpenDocument[]> {
  const entries = await openEntries().catch(() => [])

  return entries.filter((entry) => entry.key !== docKey).map((entry) => ({ app: entry.app, name: entry.name, path: entry.path, ...(entry.app === 'sheets' && entry.selection ? { selection: entry.selection } : {}) }))
}

/** The document's Hermes session, started on its first request; a turn still ending there (one just stopped) ends first. */
async function sessionFor(app: OfficeApp, docKey: string, name: string): Promise<string> {
  const known = sessions.get(docKey)

  if (known && $chats.get()[known]) {
    const until = Date.now() + 5000

    while ($chats.get()[known]?.streaming && Date.now() < until) {
      await new Promise((done) => setTimeout(done, 100))
    }

    return known
  }

  try {
    const chat = await createChat({ title: `${OFFICE_APP_NAMES[app]} · ${name}`, activate: false })
    sessions.set(docKey, chat.sessionId)

    return chat.sessionId
  } catch (error) {
    throw new Error(`Could not reach Hermes: ${messageOf(error)}`)
  }
}

const UNREACHABLE = { offline: 'Hermes is offline right now: ask again once it is back', starting: 'Hermes is still starting: ask again in a moment' }

/** Send a request about a document to Hermes and follow it; false when it did not start (one is already running). */
export async function askHermes(request: AskRequest): Promise<boolean> {
  const { app, docKey } = request
  const words = request.words.trim()

  if (!words || askOf(docKey).phase === 'working') {
    return false
  }

  release(docKey)
  const track: Track = { docKey, live: null, sessionId: null, from: 0, start: null, seen: null, touched: false, finished: false, stops: [], unwatch: () => {} }
  tracks.set(docKey, track)
  $asks.setKey(docKey, { ...IDLE, phase: 'working', words, action: request.action, step: 'Sending to Hermes', startedAt: Date.now() })

  try {
    const reach = $hermesState.get()

    if (reach !== 'ready') {
      throw new Error(UNREACHABLE[reach])
    }

    const live = await liveDocOf(app, docKey, Boolean(request.mark))

    if (!isCurrent(track)) {
      live?.unmark()

      return false
    }

    if (!live) {
      throw new Error('This document is no longer open')
    }

    track.live = live
    const others = request.action ? [] : await otherDocuments(docKey)
    const prompt = buildPrompt({ app, document: { name: live.name, path: live.path }, words, selection: live.selection, detail: live.detail, others, home: homeDir(), action: request.action })
    const sessionId = await sessionFor(app, docKey, live.name)

    if (!isCurrent(track)) {
      return false
    }

    follow(track, live, sessionId)
    await sendPrompt(prompt, { sessionId })

    return true
  } catch (error) {
    if (isCurrent(track)) {
      fail(track, messageOf(error))
    }

    return false
  }
}

/** Stop the request Hermes is working on; what it has changed already stays, one step to undo each. */
export function cancelAsk(docKey: string): void {
  const { phase, sessionId } = askOf(docKey)

  if (phase !== 'working') {
    return
  }

  release(docKey)
  $asks.setKey(docKey, IDLE)

  if (sessionId) {
    interruptChat(sessionId).catch(() => {})
  }
}

/** Put the bar back to its input, the reply read. */
export function dismissAsk(docKey: string): void {
  if (askOf(docKey).phase === 'working') {
    return
  }

  release(docKey)
  $asks.setKey(docKey, IDLE)
}

/** Undo the steps Hermes's last request added, while nothing else has changed the document since. */
export function undoAsk(docKey: string): void {
  const track = tracks.get(docKey)
  const { phase, undo } = askOf(docKey)

  if (!track?.live || !undo || phase === 'working' || track.live.depth() !== track.seen) {
    return
  }

  release(docKey)
  track.live.undo(undo)
  $asks.setKey(docKey, IDLE)
}

/** Show the document's Hermes session in the Hermes window. */
export function openInHermes(docKey: string): void {
  const sessionId = askOf(docKey).sessionId ?? sessions.get(docKey)
  const chat = sessionId ? $chats.get()[sessionId] : undefined

  if (!chat) {
    showPage('hermes')

    return
  }

  // Panels mode: the Hermes window is another renderer with a connection of its own, so it opens the session by its stored id.
  if (isMainSurface) {
    $activeChatId.set(chat.sessionId)
    showPage('hermes')
  } else {
    relayToMain({ type: 'open-session', args: [chat.storedSessionId] })
    openSurface('main')
  }
}
