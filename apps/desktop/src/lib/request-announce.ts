import type { PendingRequest } from '../store/requests.ts'
import { $language, t } from '../store/i18n.ts'
import { requestShortcut } from './request-keys.ts'

/** The longest detail read out: the start of a long description or command says enough. */
const DETAIL_MAX = 160

function clip(text: unknown): string {
  const flat = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''

  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1).trimEnd()}…` : flat
}

/** What a request asks, in a few words: the approval's description, the question, the secret's name. */
function detailOf(entry: PendingRequest): string {
  switch (entry.kind) {
    case 'approval':
      return clip(entry.request.params.description) || clip(entry.request.params.tool_name) || clip(entry.request.params.command)
    case 'clarify':
      return clip(entry.request.params.question) || clip(entry.request.params.questions?.[0]?.question)
    case 'sudo':
      return ''
    case 'secret':
      return clip(entry.request.params.prompt) || clip(entry.request.params.env_var)
  }
}

const CARD_LABEL = { approval: 'requests.card.approval', clarify: 'requests.card.clarify', sudo: 'requests.card.sudo', secret: 'requests.card.secret' } as const

function sentenceOf(entry: PendingRequest): string {
  const detail = detailOf(entry)

  switch (entry.kind) {
    case 'approval':
      return detail ? t('requests.announce.approval', { detail }) : t('requests.announce.approvalPlain')
    case 'clarify':
      return detail ? t('requests.announce.clarify', { detail }) : t('requests.announce.clarifyPlain')
    case 'sudo':
      return t('requests.announce.sudo')
    case 'secret':
      return detail ? t('requests.announce.secret', { detail }) : t('requests.announce.secretPlain')
  }
}

/**
 * What a screen reader says when `entry` arrives among `pending` (every request waiting, oldest
 * first): what it asks, then where the request shortcut goes. The shortcut reaches the oldest
 * request's card, as the cards show the oldest first: when that is `entry`, the others waiting are
 * counted; when it is not, everything waiting is counted and the card the keys reach is named.
 */
export function announcementOf(entry: PendingRequest, pending: readonly PendingRequest[], keys: string = requestShortcut().label): string {
  const first = pending[0] ?? entry
  const parts = [sentenceOf(entry)]

  if (first.request.id === entry.request.id) {
    if (pending.length > 1) {
      parts.push(t('requests.announce.more', { count: pending.length - 1 }))
    }

    parts.push(t('requests.announce.jump', { keys }))
  } else {
    const named = (detailOf(first) || t(CARD_LABEL[first.kind])).replace(/[.?!。？！…]+$/u, '')
    parts.push(t('requests.announce.waiting', { count: pending.length }), t('requests.announce.jumpFirst', { keys, first: named }))
  }

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
