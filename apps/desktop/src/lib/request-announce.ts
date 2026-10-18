import type { PendingRequest } from '../store/requests.ts'
import { $language, t } from '../store/i18n.ts'
import { requestShortcut } from './request-keys.ts'

/** The longest detail read out: the start of a long description or command says enough. */
const DETAIL_MAX = 160

function clip(text: unknown): string {
  const flat = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''

  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1).trimEnd()}…` : flat
}

/** What a screen reader says when a request arrives: what it asks, how many more wait, and the keys that go to it. */
export function announcementOf(entry: PendingRequest, more: number, keys: string = requestShortcut().label): string {
  const parts: string[] = []

  switch (entry.kind) {
    case 'approval': {
      const params = entry.request.params
      const detail = clip(params.description) || clip(params.tool_name) || clip(params.command)
      parts.push(detail ? t('requests.announce.approval', { detail }) : t('requests.announce.approvalPlain'))
      break
    }
    case 'clarify': {
      const params = entry.request.params
      const detail = clip(params.question) || clip(params.questions?.[0]?.question)
      parts.push(detail ? t('requests.announce.clarify', { detail }) : t('requests.announce.clarifyPlain'))
      break
    }
    case 'sudo':
      parts.push(t('requests.announce.sudo'))
      break
    case 'secret': {
      const detail = clip(entry.request.params.prompt) || clip(entry.request.params.env_var)
      parts.push(detail ? t('requests.announce.secret', { detail }) : t('requests.announce.secretPlain'))
      break
    }
  }

  if (more > 0) {
    parts.push(t('requests.announce.more', { count: more }))
  }

  parts.push(t('requests.announce.jump', { keys }))

  // Chinese runs its sentences together; the others leave a space.
  return parts.join($language.get() === 'zh-CN' ? '' : ' ')
}

/**
 * Which of `pending` have not been announced yet, oldest first; marks them in `announced` and forgets
 * requests that are no longer pending, so each request is announced once however often its host renders.
 */
export function freshArrivals(pending: readonly PendingRequest[], announced: Set<string>): PendingRequest[] {
  const ids = new Set(pending.map(entry => entry.request.id))

  for (const id of [...announced]) {
    if (!ids.has(id)) {
      announced.delete(id)
    }
  }

  const fresh = pending.filter(entry => !announced.has(entry.request.id))

  for (const entry of fresh) {
    announced.add(entry.request.id)
  }

  return fresh
}
