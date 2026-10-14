import type {
  GatewayEvent,
  MessageCompletePayload,
  SessionLiveInfo,
  StreamDeltaPayload,
  ToolCompletePayload,
  ToolStartPayload,
  TranscriptMessage,
  TurnStatus,
  Usage
} from '@herald-os/client'

export interface UserMessage {
  id: string
  role: 'user'
  text: string
  ts: number
}

export interface AssistantMessage {
  id: string
  role: 'assistant'
  text: string
  reasoning: string
  streaming: boolean
  status?: TurnStatus
  error?: string
  ts: number
}

export interface ToolMessage {
  id: string
  role: 'tool'
  toolId: string
  name: string
  args?: Record<string, unknown> | null
  context?: string | null
  result?: unknown
  resultText?: string | null
  summary?: string | null
  durationS?: number | null
  running: boolean
  ts: number
}

export interface SystemMessage {
  id: string
  role: 'system'
  text: string
  level: 'info' | 'warn' | 'error'
  ts: number
}

export type ChatMessage = UserMessage | AssistantMessage | ToolMessage | SystemMessage

export interface ChatState {
  sessionId: string
  storedSessionId: string
  /** The bot the session runs as (a Hermes profile); unset for Hermes itself. */
  profile?: string
  title: string
  messages: ChatMessage[]
  streaming: boolean
  status?: { kind: string; text: string }
  info: SessionLiveInfo
  usage?: Usage | null
  /** Id of the assistant bubble currently receiving deltas, if any. */
  openAssistantId: string | null
  hydrating: boolean
}

let counter = 0
export const nextId = (prefix = 'm'): string => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`

export function emptyChat(sessionId: string, storedSessionId: string, info: SessionLiveInfo = {}): ChatState {
  return {
    sessionId,
    storedSessionId,
    title: info.title ?? '',
    messages: [],
    streaming: Boolean(info.running),
    info,
    usage: info.usage ?? null,
    openAssistantId: null,
    hydrating: false
  }
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value))

/** Project the gateway's transcript rows into renderer messages. */
export function fromTranscript(rows: TranscriptMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []

  for (const row of rows) {
    if (row.display_kind === 'hidden') {
      continue
    }

    const ts = row.timestamp ? (row.timestamp < 1e12 ? row.timestamp * 1000 : row.timestamp) : Date.now()

    if (row.role === 'user') {
      out.push({ id: nextId('u'), role: 'user', text: textOf(row.text), ts })
    } else if (row.role === 'assistant') {
      const text = textOf(row.text)

      if (text || row.reasoning) {
        out.push({ id: nextId('a'), role: 'assistant', text, reasoning: row.reasoning ?? '', streaming: false, status: 'complete', ts })
      }
    } else if (row.role === 'tool') {
      out.push({
        id: nextId('t'),
        role: 'tool',
        toolId: String(row.tool_call_id ?? row.row_id ?? nextId('tc')),
        name: row.name ?? 'tool',
        args: row.args ?? null,
        context: row.context ?? null,
        resultText: textOf(row.text) || null,
        running: false,
        ts
      })
    } else if (row.role === 'system' && row.text) {
      out.push({ id: nextId('s'), role: 'system', text: textOf(row.text), level: 'info', ts })
    }
  }

  return out
}

function openAssistant(state: ChatState): { state: ChatState; message: AssistantMessage } {
  if (state.openAssistantId) {
    const existing = state.messages.find((m): m is AssistantMessage => m.id === state.openAssistantId && m.role === 'assistant')

    if (existing) {
      return { state, message: existing }
    }
  }

  const message: AssistantMessage = { id: nextId('a'), role: 'assistant', text: '', reasoning: '', streaming: true, ts: Date.now() }

  return { state: { ...state, openAssistantId: message.id, streaming: true, messages: [...state.messages, message] }, message }
}

function replaceMessage(state: ChatState, next: ChatMessage): ChatState {
  return { ...state, messages: state.messages.map(m => (m.id === next.id ? next : m)) }
}

export function appendUser(state: ChatState, text: string): ChatState {
  return {
    ...state,
    streaming: true,
    status: undefined,
    // A new turn always starts a new assistant bubble.
    openAssistantId: null,
    messages: [...state.messages, { id: nextId('u'), role: 'user', text, ts: Date.now() }]
  }
}

export function appendSystem(state: ChatState, text: string, level: SystemMessage['level'] = 'info'): ChatState {
  return { ...state, messages: [...state.messages, { id: nextId('s'), role: 'system', text, level, ts: Date.now() }] }
}

function onDelta(state: ChatState, payload: StreamDeltaPayload | undefined, field: 'text' | 'reasoning'): ChatState {
  if (!payload?.text) {
    return state
  }

  const opened = openAssistant(state)
  const message = { ...opened.message, [field]: opened.message[field] + payload.text, streaming: true }

  return replaceMessage({ ...opened.state, streaming: true }, message)
}

function onToolStart(state: ChatState, payload: ToolStartPayload | undefined): ChatState {
  if (!payload) {
    return state
  }

  const existing = state.messages.find((m): m is ToolMessage => m.role === 'tool' && m.toolId === payload.tool_id)

  if (existing) {
    return replaceMessage(state, { ...existing, args: payload.args ?? existing.args, context: payload.context ?? existing.context, running: true })
  }

  // Text produced before a tool call belongs to the bubble above the tool row; later text opens a new bubble.
  const sealed = state.openAssistantId
    ? replaceMessage(state, { ...(state.messages.find(m => m.id === state.openAssistantId) as AssistantMessage), streaming: false })
    : state

  return {
    ...sealed,
    streaming: true,
    openAssistantId: null,
    messages: [
      ...sealed.messages,
      {
        id: nextId('t'),
        role: 'tool',
        toolId: payload.tool_id,
        name: payload.name,
        args: payload.args ?? null,
        context: payload.context ?? payload.preview ?? null,
        running: true,
        ts: Date.now()
      }
    ]
  }
}

function onToolComplete(state: ChatState, payload: ToolCompletePayload | undefined): ChatState {
  if (!payload) {
    return state
  }

  const existing = state.messages.find((m): m is ToolMessage => m.role === 'tool' && m.toolId === payload.tool_id)
  const patch = {
    result: payload.result,
    resultText: payload.result_text ?? (typeof payload.result === 'string' ? payload.result : null),
    summary: payload.summary ?? null,
    durationS: payload.duration_s ?? null,
    running: false
  }

  if (existing) {
    return replaceMessage(state, { ...existing, ...patch, args: payload.args ?? existing.args })
  }

  return {
    ...state,
    messages: [...state.messages, { id: nextId('t'), role: 'tool', toolId: payload.tool_id, name: payload.name, args: payload.args ?? null, ts: Date.now(), ...patch }]
  }
}

function onComplete(state: ChatState, payload: MessageCompletePayload | undefined): ChatState {
  const finalText = typeof payload?.text === 'string' ? payload.text : ''
  const status = payload?.status ?? 'complete'
  let next = state

  if (state.openAssistantId) {
    const open = state.messages.find((m): m is AssistantMessage => m.id === state.openAssistantId)

    if (open) {
      next = replaceMessage(state, {
        ...open,
        // The final payload is authoritative when the stream was partial or empty.
        text: finalText && (payload?.partial || !open.text) ? finalText : open.text || finalText,
        reasoning: open.reasoning || payload?.reasoning || '',
        streaming: false,
        status,
        error: payload?.error ?? undefined
      })
    }
  } else if (finalText) {
    next = { ...state, messages: [...state.messages, { id: nextId('a'), role: 'assistant', text: finalText, reasoning: payload?.reasoning ?? '', streaming: false, status, ts: Date.now() }] }
  }

  if (status === 'error' && payload?.error && !finalText) {
    next = appendSystem(next, payload.error, 'error')
  }

  return {
    ...next,
    streaming: false,
    openAssistantId: null,
    status: undefined,
    usage: payload?.usage ?? next.usage,
    messages: next.messages.map(m => (m.role === 'tool' && m.running ? { ...m, running: false } : m))
  }
}

/** Pure reducer: one gateway event in, the next chat state out. Unknown events are no-ops. */
export function reduceChatEvent(state: ChatState, event: GatewayEvent): ChatState {
  switch (event.type) {
    case 'message.start':
      return { ...state, streaming: true }
    case 'message.delta':
      return onDelta(state, event.payload as StreamDeltaPayload, 'text')
    case 'reasoning.delta':
      return onDelta(state, event.payload as StreamDeltaPayload, 'reasoning')
    case 'thinking.delta': {
      // Not reasoning content: the agent's live activity line (spinner faces, "waiting on the
      // provider" notices). An empty text clears it.
      const text = (event.payload as StreamDeltaPayload | undefined)?.text ?? ''

      return text.trim() ? { ...state, status: { kind: 'thinking', text: text.replace(/^[^\p{L}\p{N}]+/u, '').trim() || text } } : { ...state, status: undefined }
    }
    case 'message.interim': {
      const payload = event.payload as { text: string; already_streamed: boolean } | undefined

      if (!payload || payload.already_streamed || !payload.text) {
        return { ...state, openAssistantId: null }
      }

      const sealed = { ...state, openAssistantId: null }

      return { ...sealed, messages: [...sealed.messages, { id: nextId('a'), role: 'assistant', text: payload.text, reasoning: '', streaming: false, status: 'complete', ts: Date.now() }] }
    }
    case 'tool.start':
      return onToolStart(state, event.payload as ToolStartPayload)
    case 'tool.complete':
      return onToolComplete(state, event.payload as ToolCompletePayload)
    case 'message.complete':
      return onComplete(state, event.payload as MessageCompletePayload)
    case 'status.update': {
      const payload = event.payload as { kind: string; text: string } | undefined

      return payload ? { ...state, status: payload } : state
    }
    case 'session.title': {
      const payload = event.payload as { title: string } | undefined

      return payload ? { ...state, title: payload.title, info: { ...state.info, title: payload.title } } : state
    }
    case 'session.info': {
      const info = (event.payload ?? {}) as SessionLiveInfo

      return { ...state, info: { ...state.info, ...info }, title: info.title ?? state.title, usage: info.usage ?? state.usage }
    }
    case 'session.usage': {
      const payload = event.payload as { usage: Usage } | undefined

      return payload ? { ...state, usage: payload.usage } : state
    }
    case 'error': {
      const payload = event.payload as { message: string } | undefined

      return payload ? { ...appendSystem(state, payload.message, 'error'), streaming: false, openAssistantId: null } : state
    }
    default:
      return state
  }
}
