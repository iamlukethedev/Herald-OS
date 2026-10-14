import { useStore } from '@nanostores/react'
import { IconChevronRight } from '@tabler/icons-react'
import type { TextKey } from '../../../shared/i18n.ts'
import { GlassCard, Section } from '../../components/ui/glass.tsx'
import { $agents } from '../../store/agents.ts'
import { $activeChatId, $chats } from '../../store/chat.ts'
import { t, useT } from '../../store/i18n.ts'
import { showPage } from '../../store/windows.ts'
import { agentNameFor, Avatar, Quiet, titleCase } from './shared.tsx'

/*
 * Who is working right now: live subagents (running or queued) and any chat session that is
 * streaming a turn. Rows open the place where that work can be followed.
 */

interface Worker {
  id: string
  name: string
  state: string
  avatar: string
  open: () => void
}

const TOOL_VERB: Record<string, TextKey> = {
  terminal: 'overview.tool.terminal',
  read_file: 'overview.tool.readFile',
  write_file: 'overview.tool.writeFile',
  patch: 'overview.tool.patch',
  search_files: 'overview.tool.searchFiles',
  web_search: 'overview.tool.webSearch',
  web_extract: 'overview.tool.webExtract',
  browser_navigate: 'overview.tool.browserNavigate',
  delegate_task: 'overview.tool.delegateTask',
  todo_list: 'overview.tool.todoList',
  memory: 'overview.tool.memory',
  system_find_files: 'overview.tool.systemFindFiles',
  system_open: 'overview.tool.systemOpen',
  system_files: 'overview.tool.systemFiles',
  system_processes: 'overview.tool.systemProcesses'
}

const toolVerb = (name: string): string | undefined => (Object.hasOwn(TOOL_VERB, name) ? t(TOOL_VERB[name]) : undefined)

function oneLine(text: string | undefined, max = 60): string {
  const line = (text ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? ''

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function WorkingWithYou() {
  useT()
  const agents = useStore($agents)
  const chats = useStore($chats)
  const workers: Worker[] = []

  for (const agent of Object.values(agents)) {
    if (agent.status !== 'running' && agent.status !== 'queued') {
      continue
    }

    const state = agent.status === 'queued' ? t('overview.worker.queued') : oneLine(agent.lastText) || (agent.toolName ? toolVerb(agent.toolName) ?? t('overview.tool.using', { tool: agent.toolName.replace(/_/g, ' ') }) : t('overview.worker.working'))

    workers.push({ id: `agent-${agent.id}`, name: agentNameFor(agent.goal), state, avatar: agent.goal, open: () => showPage('missions') })
  }

  for (const chat of Object.values(chats)) {
    if (!chat.streaming) {
      continue
    }

    const runningTool = [...chat.messages].reverse().find(m => m.role === 'tool' && m.running)
    const state = chat.status?.text || (runningTool && runningTool.role === 'tool' ? toolVerb(runningTool.name) ?? titleCase(runningTool.name.replace(/_/g, ' ')) : t('overview.worker.thinking'))

    workers.push({
      id: `chat-${chat.sessionId}`,
      name: chat.title ? oneLine(chat.title, 32) : 'Hermes',
      state: oneLine(state),
      avatar: chat.title || 'Hermes',
      open: () => {
        $activeChatId.set(chat.sessionId)
        showPage('hermes')
      }
    })
  }

  workers.sort((a, b) => a.name.localeCompare(b.name))

  return (
    <Section title={t('overview.working')}>
      {workers.length === 0 ? (
        <Quiet>{t('overview.worker.idle')}</Quiet>
      ) : (
        <GlassCard className="stagger flex flex-col divide-y divide-line p-1">
          {workers.map(worker => (
            <button key={worker.id} type="button" onClick={worker.open} className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-120 hover:bg-white/6" aria-label={t('overview.openNamed', { name: worker.name })}>
              <Avatar label={worker.avatar} size={30} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium text-fg" title={worker.name}>
                  {worker.name}
                </div>
                <div className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
                  <span className="size-1.5 shrink-0 rounded-full bg-progress animate-pulse-soft" aria-hidden="true" />
                  <span className="truncate" title={worker.state}>
                    {worker.state}
                  </span>
                </div>
              </div>
              <IconChevronRight size={14} className="shrink-0 text-fg-4" aria-hidden="true" />
            </button>
          ))}
        </GlassCard>
      )}
    </Section>
  )
}
