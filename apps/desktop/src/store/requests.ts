import type { ApprovalRequestParams, ClarifyRequestParams, SecretRequestParams, ServerRequest, SudoRequestParams } from '@herald-os/client'
import { atom } from 'nanostores'
import { LEGACY_EXPIRE_EVENTS, LEGACY_REQUEST_EVENTS, legacyRequestFromEvent } from '../lib/legacy-requests.ts'
import { gatewayRequest, onAnyGatewayEvent, onGatewayEvent, onServerRequest } from './gateway.ts'
import { notify } from './notifications.ts'

// The generated contract types are closed shapes; the channel's params type carries an index
// signature. Intersect so cards get the typed fields without losing assignability.
type Open<T> = T & Record<string, unknown>

export type PendingRequest =
  | { kind: 'approval'; request: ServerRequest<'approval', Open<ApprovalRequestParams>>; receivedAt: number }
  | { kind: 'clarify'; request: ServerRequest<'clarify', Open<ClarifyRequestParams>>; receivedAt: number }
  | { kind: 'sudo'; request: ServerRequest<'sudo', Open<SudoRequestParams>>; receivedAt: number }
  | { kind: 'secret'; request: ServerRequest<'secret', Open<SecretRequestParams>>; receivedAt: number }

const HANDLED = new Set(['approval', 'clarify', 'sudo', 'secret'])

/** Open server->client questions, oldest first. One host renders them; answering removes them. */
export const $pendingRequests = atom<PendingRequest[]>([])

function enqueue(request: ServerRequest): void {
  const kind = request.method as PendingRequest['kind']
  const pending = $pendingRequests.get()

  if (pending.some(entry => entry.request.id === request.id)) {
    return
  }

  $pendingRequests.set([...pending, { kind, request, receivedAt: Date.now() } as PendingRequest])

  if (kind === 'approval') {
    const params = request.params as ApprovalRequestParams
    notify({ title: 'Approval needed', body: params.description || params.command || params.tool_name || 'Hermes is asking for permission', level: 'warn', surface: 'chat', native: true, category: 'approval' })
  } else if (kind === 'clarify') {
    notify({ title: 'Hermes has a question', body: (request.params as ClarifyRequestParams).question ?? 'Hermes needs clarification', level: 'info', surface: 'chat', native: true, category: 'approval' })
  }
}

function dropByRequestId(requestId: string): void {
  $pendingRequests.set($pendingRequests.get().filter(entry => entry.request.id !== requestId && entry.request.id !== `legacy:${requestId}` && entry.request.params.request_id !== requestId))
}

export function bindServerRequests(): () => void {
  // Current wire: server->client JSON-RPC requests.
  const offRequests = onServerRequest(request => {
    if (!HANDLED.has(request.method)) {
      // Declining lets the channel answer -32601 so the backend treats it as unanswered.
      return false
    }

    enqueue(request)

    return true
  })

  // Older runtimes (<= 0.21.0): `<kind>.request` events answered through `<kind>.respond` RPCs.
  const offLegacy = onAnyGatewayEvent(event => {
    const kind = LEGACY_REQUEST_EVENTS[event.type]

    if (kind && event.session_id) {
      enqueue(legacyRequestFromEvent(kind, event.session_id, (event.payload ?? {}) as Record<string, unknown>, (method, params) => gatewayRequest(method as 'approval.respond', params as never)))

      return
    }

    if (LEGACY_EXPIRE_EVENTS.has(event.type)) {
      const id = (event.payload as { request_id?: string } | undefined)?.request_id

      if (id) {
        dropByRequestId(id)
      }
    }
  })

  const offCancel = onGatewayEvent('request.cancel', event => {
    const id = (event.payload as { request_id?: string; id?: string } | undefined)?.request_id ?? (event.payload as { id?: string } | undefined)?.id

    if (id) {
      dropByRequestId(id)
    }
  })

  return () => {
    offRequests()
    offLegacy()
    offCancel()
  }
}

export function resolveRequest(id: string, result: Record<string, unknown>): void {
  const entry = $pendingRequests.get().find(item => item.request.id === id)

  if (!entry) {
    return
  }

  entry.request.respond(result)
  $pendingRequests.set($pendingRequests.get().filter(item => item.request.id !== id))
}
