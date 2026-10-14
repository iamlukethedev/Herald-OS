import type { GatewayEvent, SubagentEventPayload, ToolCompletePayload, ToolStartPayload } from '@herald-os/client'
import { atom, computed, map } from 'nanostores'
import type { ChatState } from '../lib/chat-model.ts'
import { systemFilesOutputs } from '../lib/file-ops.ts'
import { $agents, type AgentActivity } from './agents.ts'
import { $chats, SESSION_SOURCE } from './chat.ts'
import { onAnyGatewayEvent } from './gateway.ts'
import { $pendingRequests } from './requests.ts'
import { $runtimeIds, $sessions } from './sessions.ts'

/*
 * Missions are derived, never stored: a mission is a Hermes session viewed through its goal, its
 * todo plan, the artifacts it produced, the agents working on it and the requests it is waiting on.
 */

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

export interface Artifact {
  path: string
  name: string
  sessionId: string
  tool: string
  ts: number
  kind: 'file' | 'folder' | 'url'
}

export interface ActivityEntry {
  id: string
  ts: number
  sessionId?: string
  kind: 'tool' | 'agent' | 'plan' | 'turn' | 'artifact'
  title: string
  detail?: string
  agent?: string
}

export type MissionStatus = 'active' | 'review' | 'queued' | 'completed'

export interface MissionStep {
  id: string
  label: string
  state: 'done' | 'active' | 'pending'
  detail?: string
}

export interface Mission {
  /** Stable id: the stored session id when known, else the runtime id. */
  id: string
  runtimeId?: string
  title: string
  goal: string
  status: MissionStatus
  progress: number
  steps: MissionStep[]
  currentStep?: string
  agents: AgentActivity[]
  artifacts: Artifact[]
  updatedAt: number
  startedAt: number
  messageCount: number
  source?: string
  live: boolean
}

/** A command (voice, agent) asked the Missions page to show a tab and/or select a mission. */
export interface MissionFocus {
  tab?: MissionStatus | 'active' | 'review' | 'completed'
  missionId?: string
  compose?: boolean
  ts: number
}

export const $missionFocus = atom<MissionFocus | null>(null)

export function focusMissions(focus: Omit<MissionFocus, 'ts'>): void {
  $missionFocus.set({ ...focus, ts: Date.now() })
}

export const $todos = map<Record<string, { todos: TodoItem[]; revision: number }>>({})
export const $artifacts = map<Record<string, Artifact[]>>({})
export const $activity = atom<ActivityEntry[]>([])
/** Sessions the user has looked at since they finished (clears "Needs review"). */
export const $reviewed = atom<Set<string>>(new Set())

const MAX_ACTIVITY = 200
let counter = 0
const nextId = () => `act${Date.now().toString(36)}${(counter++).toString(36)}`

const PATH_KEYS = ['path', 'file_path', 'filepath', 'target', 'to', 'output_path', 'destination']
const ARTIFACT_TOOLS = new Set(['write_file', 'patch', 'system_files', 'create_file', 'edit_file'])

function pushActivity(entry: Omit<ActivityEntry, 'id'>): void {
  $activity.set([{ id: nextId(), ...entry }, ...$activity.get()].slice(0, MAX_ACTIVITY))
}

function extractPaths(args: Record<string, unknown> | null | undefined): string[] {
  if (!args) {
    return []
  }

  const out: string[] = []

  for (const key of PATH_KEYS) {
    const value = args[key]

    if (typeof value === 'string' && value.startsWith('/') || (typeof value === 'string' && value.startsWith('~'))) {
      out.push(value as string)
    }
  }

  const ops = args.operations

  if (Array.isArray(ops)) {
    for (const op of ops) {
      if (op && typeof op === 'object') {
        out.push(...extractPaths(op as Record<string, unknown>))
      }
    }
  }

  return out
}

/** Paths a tool call leaves on disk. */
function outputPaths(tool: string, args: Record<string, unknown> | null | undefined): string[] {
  return tool === 'system_files' ? systemFilesOutputs(args) : extractPaths(args)
}

function recordArtifact(sessionId: string, tool: string, args: Record<string, unknown> | null | undefined): void {
  const paths = outputPaths(tool, args)

  if (paths.length === 0) {
    return
  }

  const current = $artifacts.get()[sessionId] ?? []
  const now = Date.now()
  const additions: Artifact[] = []

  for (const p of paths) {
    const name = p.split('/').filter(Boolean).pop() ?? p
    const existing = current.find(a => a.path === p)

    if (existing) {
      existing.ts = now
    } else {
      additions.push({ path: p, name, sessionId, tool, ts: now, kind: /\.[a-z0-9]{1,6}$/i.test(name) ? 'file' : 'folder' })
    }
  }

  const next = [...additions, ...current].sort((a, b) => b.ts - a.ts).slice(0, 40)
  $artifacts.setKey(sessionId, next)

  for (const artifact of additions) {
    pushActivity({ ts: now, sessionId, kind: 'artifact', title: `Hermes saved ${artifact.name}`, detail: artifact.path })
  }
}

const FRIENDLY_TOOL: Record<string, string> = {
  terminal: 'ran a command',
  read_file: 'read a file',
  write_file: 'wrote a file',
  patch: 'edited a file',
  search_files: 'searched files',
  web_search: 'searched the web',
  web_extract: 'read a web page',
  browser_navigate: 'browsed the web',
  delegate_task: 'delegated work',
  todo_list: 'updated the plan',
  memory: 'updated memory',
  system_find_files: 'searched for files',
  system_open: 'opened something',
  system_files: 'organised files',
  system_processes: 'inspected processes'
}

export function bindMissionEvents(): () => void {
  const offChats = $chats.subscribe(chats => {
    for (const chat of Object.values(chats)) {
      seedArtifactsFromChat(chat)
    }
  })
  const offEvents = bindGatewayMissionEvents()

  return () => {
    offChats()
    offEvents()
  }
}

function bindGatewayMissionEvents(): () => void {
  return onAnyGatewayEvent((event: GatewayEvent) => {
    const sid = event.session_id

    switch (event.type) {
      case 'todo.updated': {
        const payload = event.payload as { todos?: unknown[]; revision?: number } | undefined

        if (sid && payload?.todos) {
          const todos = payload.todos
            .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object')
            .map(t => ({ id: String(t.id ?? ''), content: String(t.content ?? ''), status: (String(t.status ?? 'pending') as TodoItem['status']) }))
          $todos.setKey(sid, { todos, revision: payload.revision ?? 0 })
          pushActivity({ ts: Date.now(), sessionId: sid, kind: 'plan', title: 'Hermes updated the mission plan', detail: `${todos.filter(t => t.status === 'completed').length} of ${todos.length} steps done` })
        }

        break
      }
      case 'tool.start': {
        const payload = event.payload as ToolStartPayload | undefined

        if (sid && payload?.name === 'delegate_task') {
          pushActivity({ ts: Date.now(), sessionId: sid, kind: 'agent', title: 'Hermes delegated a task', detail: payload.context ?? undefined })
        }

        break
      }
      case 'tool.complete': {
        const payload = event.payload as ToolCompletePayload | undefined

        if (!sid || !payload) {
          break
        }

        if (ARTIFACT_TOOLS.has(payload.name)) {
          recordArtifact(sid, payload.name, payload.args)
        } else if (payload.name !== 'todo_list') {
          pushActivity({ ts: Date.now(), sessionId: sid, kind: 'tool', title: `Hermes ${FRIENDLY_TOOL[payload.name] ?? payload.name.replace(/_/g, ' ')}`, detail: payload.summary ?? undefined })
        }

        break
      }
      case 'subagent.start':
      case 'subagent.complete': {
        const payload = event.payload as SubagentEventPayload | undefined

        if (payload) {
          pushActivity({ ts: Date.now(), sessionId: sid, kind: 'agent', title: event.type === 'subagent.start' ? 'Agent started' : 'Agent finished', detail: payload.summary ?? payload.goal, agent: payload.goal })
        }

        break
      }
      case 'message.complete': {
        if (sid) {
          pushActivity({ ts: Date.now(), sessionId: sid, kind: 'turn', title: 'Hermes finished a turn' })
        }

        break
      }
      default:
        break
    }
  })
}

const seeded = new Set<string>()

/** Rebuild a hydrated session's artifacts from its transcript tool rows (resume / history). */
function seedArtifactsFromChat(chat: ChatState): void {
  const sessionId = chat.sessionId

  if (seeded.has(sessionId) || $artifacts.get()[sessionId]?.length) {
    return
  }

  seeded.add(sessionId)
  const found: Artifact[] = []

  for (const row of chat.messages) {
    if (row.role !== 'tool' || !ARTIFACT_TOOLS.has(row.name)) {
      continue
    }

    const ts = row.ts

    for (const p of outputPaths(row.name, row.args)) {
      const name = p.split('/').filter(Boolean).pop() ?? p
      const existing = found.find(a => a.path === p)

      if (existing) {
        existing.ts = Math.max(existing.ts, ts)
      } else {
        found.push({ path: p, name, sessionId, tool: row.name, ts, kind: /\.[a-z0-9]{1,6}$/i.test(name) ? 'file' : 'folder' })
      }
    }
  }

  if (found.length) {
    $artifacts.setKey(sessionId, found.sort((a, b) => b.ts - a.ts).slice(0, 40))
  }
}

export function markReviewed(missionId: string): void {
  const next = new Set($reviewed.get())
  next.add(missionId)
  $reviewed.set(next)
}

function stepsFromTodos(todos: TodoItem[]): MissionStep[] {
  return todos
    .filter(t => t.status !== 'cancelled')
    .map(t => ({ id: t.id, label: t.content, state: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : 'pending' }))
}

function goalOf(chat: ChatState | undefined, preview?: string): string {
  const first = chat?.messages.find(m => m.role === 'user')

  return (first && 'text' in first ? first.text : preview) ?? ''
}

export const $missions = computed([$chats, $sessions, $runtimeIds, $todos, $artifacts, $agents, $pendingRequests, $reviewed], (chats, sessions, runtimeIds, todos, artifacts, agents, pending, reviewed) => {
  const missions: Mission[] = []
  const seenRuntime = new Set<string>()

  for (const row of sessions) {
    const runtimeId = runtimeIds[row.id]
    const chat = runtimeId ? chats[runtimeId] : undefined

    if (runtimeId) {
      seenRuntime.add(runtimeId)
    }

    missions.push(buildMission(row.id, runtimeId, chat, row.title, row.preview, row.started_at, row.message_count, row.source, todos, artifacts, agents, pending, reviewed))
  }

  // A mission reopens by stored id alone, so a bot's conversations stay in its own session list.
  for (const chat of Object.values(chats)) {
    if (!seenRuntime.has(chat.sessionId) && !chat.profile) {
      missions.push(buildMission(chat.storedSessionId, chat.sessionId, chat, chat.title, undefined, undefined, chat.messages.length, SESSION_SOURCE, todos, artifacts, agents, pending, reviewed))
    }
  }

  return missions.sort((a, b) => b.updatedAt - a.updatedAt)
})

function buildMission(
  id: string,
  runtimeId: string | undefined,
  chat: ChatState | undefined,
  title: string | undefined,
  preview: string | undefined,
  startedAt: number | undefined,
  messageCount: number | undefined,
  source: string | undefined,
  todos: Record<string, { todos: TodoItem[] }>,
  artifacts: Record<string, Artifact[]>,
  agents: Record<string, AgentActivity>,
  pending: { request: { params: { session_id?: string } } }[],
  reviewed: Set<string>
): Mission {
  const todoState = runtimeId ? todos[runtimeId] : undefined
  const steps = todoState ? stepsFromTodos(todoState.todos) : []
  const done = steps.filter(s => s.state === 'done').length
  const progress = steps.length ? Math.round((done / steps.length) * 100) : chat?.streaming ? 35 : chat ? 100 : 0
  const missionAgents = Object.values(agents).filter(a => a.parentSessionId === runtimeId)
  const waiting = Boolean(runtimeId) && pending.some(p => p.request.params.session_id === runtimeId)
  const missionArtifacts = runtimeId ? (artifacts[runtimeId] ?? []) : []
  const lastTs = chat?.messages.at(-1)?.ts ?? (startedAt ? (startedAt < 1e12 ? startedAt * 1000 : startedAt) : Date.now())
  let status: MissionStatus

  if (chat?.streaming || missionAgents.some(a => a.status === 'running')) {
    status = waiting ? 'review' : 'active'
  } else if (waiting) {
    status = 'review'
  } else if (chat && (missionArtifacts.length > 0 || steps.length > 0) && !reviewed.has(id) && progress >= 100) {
    status = 'review'
  } else if (chat && steps.length > 0 && progress < 100) {
    status = 'queued'
  } else {
    status = 'completed'
  }

  const current = steps.find(s => s.state === 'active') ?? steps.find(s => s.state === 'pending')

  return {
    id,
    runtimeId,
    title: (chat?.title || title || preview || 'Untitled mission').replace(/^\[[a-z0-9-]+\]\s*/, ''),
    goal: goalOf(chat, preview),
    status,
    progress,
    steps,
    currentStep: chat?.status?.text ?? current?.label,
    agents: missionAgents,
    artifacts: missionArtifacts,
    updatedAt: lastTs,
    startedAt: startedAt ? (startedAt < 1e12 ? startedAt * 1000 : startedAt) : lastTs,
    messageCount: messageCount ?? chat?.messages.length ?? 0,
    source,
    live: Boolean(chat)
  }
}

export const $activeMissions = computed($missions, missions => missions.filter(m => m.status === 'active' || m.status === 'queued'))
export const $reviewMissions = computed($missions, missions => missions.filter(m => m.status === 'review'))
export const $completedMissions = computed($missions, missions => missions.filter(m => m.status === 'completed'))

/** All artifacts across sessions, newest first; the Files page uses it for "Related mission". */
export const $allArtifacts = computed($artifacts, artifacts => Object.values(artifacts).flat().sort((a, b) => b.ts - a.ts))
