import { atom } from 'nanostores'
import { isAuthErrorText, parseActiveProvider, signInTarget } from '../lib/hermes-auth.ts'
import { rest } from '../lib/rest.ts'
import { $gatewayReady, onGatewayEvent } from './gateway.ts'
import { notify } from './notifications.ts'
import { isMainSurface } from './shell.ts'

/*
 * Hermes's model-provider sign-in, owned by the OS. The runtime exposes the same device-code flow
 * its CLI uses (`/api/providers/oauth/...`): start returns a short code and a portal URL, a poller
 * on the backend exchanges the code and persists credentials, and the shell polls the status. So a
 * signed-out Hermes becomes a card in the shell, never "go sign in from a terminal".
 */

export interface OAuthProvider {
  id: string
  name: string
  flow: 'device_code' | 'external'
  /** CLI command for providers whose login lives in another tool (shown as instructions). */
  cliCommand: string | null
  docsUrl: string | null
  loggedIn: boolean
  source: string | null
}

export interface HermesAuthSnapshot {
  /** The provider list has been read at least once this connection. */
  checked: boolean
  /** `model.provider` from the runtime config (e.g. `nous`, `openai-codex`). */
  activeProvider: string | null
  providers: OAuthProvider[]
  /** Show the sign-in card. */
  needsLogin: boolean
  /** Why the card is up: the failing turn's message, or the boot check. */
  reason: string | null
  /** The user chose "Not now"; the card stays hidden until the next failed turn. */
  snoozed: boolean
  /** A provider the person picked to sign in to (Settings, setup, a command): the card signs into it, and Hermes switches to it after. */
  chosen: string | null
}

export interface DeviceLoginStart {
  sessionId: string
  userCode: string
  verificationUrl: string
  expiresIn: number
  pollInterval: number
}

export type DeviceLoginStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'error'

export const $hermesAuth = atom<HermesAuthSnapshot>({ checked: false, activeProvider: null, providers: [], needsLogin: false, reason: null, snoozed: false, chosen: null })

export { isAuthErrorText, parseActiveProvider }

function patch(next: Partial<HermesAuthSnapshot>): void {
  $hermesAuth.set({ ...$hermesAuth.get(), ...next })
}

interface OAuthListResponse {
  providers?: Array<{ id: string; name: string; flow: string; cli_command?: string | null; docs_url?: string | null; status?: { logged_in?: boolean; source?: string | null } }>
}

/** Re-read provider status and the active provider; opens the card when the active one is signed out. */
export async function refreshHermesAuth(): Promise<HermesAuthSnapshot> {
  try {
    const [list, raw] = await Promise.all([rest.get<OAuthListResponse>('/api/providers/oauth'), rest.get<{ yaml?: string }>('/api/config/raw').catch(() => ({ yaml: '' }))])
    const providers: OAuthProvider[] = (list.providers ?? []).map(p => ({
      id: p.id,
      name: p.name,
      flow: p.flow === 'external' ? 'external' : 'device_code',
      cliCommand: p.cli_command ?? null,
      docsUrl: p.docs_url ?? null,
      loggedIn: Boolean(p.status?.logged_in),
      source: p.status?.source ?? null
    }))
    const activeProvider = parseActiveProvider(raw.yaml ?? '') ?? $hermesAuth.get().activeProvider
    const active = providers.find(p => p.id === activeProvider)
    const signedOut = Boolean(active && !active.loggedIn)
    const current = $hermesAuth.get()
    // A sign-in the person asked for stays up whatever state the active provider is in.
    const asked = Boolean(current.chosen && current.needsLogin)

    patch({
      checked: true,
      activeProvider,
      providers,
      // A signed-in provider closes the card; a signed-out one opens it unless the user snoozed it.
      needsLogin: asked || (signedOut ? current.needsLogin || !current.snoozed : false),
      reason: asked ? current.reason : signedOut ? (current.reason ?? `${active?.name ?? activeProvider} is signed out.`) : null
    })
  } catch {
    // Older runtimes without the OAuth routes: nothing to show; turn errors still open the card.
    patch({ checked: true })
  }

  return $hermesAuth.get()
}

/**
 * A turn failed for lack of credentials (text or voice), or the person picked `providerId` to sign
 * in to: show the card regardless of snooze.
 */
export function requestHermesLogin(reason?: string, providerId?: string): void {
  const current = $hermesAuth.get()
  patch({ needsLogin: true, snoozed: false, chosen: providerId ?? current.chosen, reason: reason ?? current.reason ?? 'Hermes needs you to sign in.' })
}

export function snoozeHermesLogin(): void {
  patch({ needsLogin: false, snoozed: true, chosen: null })
}

/** The provider the card signs into (see `signInTarget`); null when Hermes uses an API key. */
export function loginTarget(snapshot: HermesAuthSnapshot = $hermesAuth.get()): OAuthProvider | null {
  return signInTarget(snapshot.providers, snapshot.activeProvider, snapshot.chosen)
}

export async function startDeviceLogin(providerId: string): Promise<DeviceLoginStart> {
  const result = await rest.post<{ session_id: string; user_code: string; verification_url: string; expires_in?: number; poll_interval?: number }>(`/api/providers/oauth/${encodeURIComponent(providerId)}/start`, {})

  return { sessionId: result.session_id, userCode: result.user_code, verificationUrl: result.verification_url, expiresIn: result.expires_in ?? 900, pollInterval: Math.max(2, result.poll_interval ?? 5) }
}

export async function pollDeviceLogin(providerId: string, sessionId: string): Promise<{ status: DeviceLoginStatus; error: string | null }> {
  const result = await rest.get<{ status?: string; error_message?: string | null }>(`/api/providers/oauth/${encodeURIComponent(providerId)}/poll/${encodeURIComponent(sessionId)}`)
  const status = result.status as DeviceLoginStatus | undefined

  return { status: status && ['pending', 'approved', 'denied', 'expired', 'error'].includes(status) ? status : 'error', error: result.error_message ?? null }
}

export function cancelDeviceLogin(sessionId: string): Promise<unknown> {
  return rest.del(`/api/providers/oauth/sessions/${encodeURIComponent(sessionId)}`).catch(() => undefined)
}

/** Sign-in finished: refresh status, close the card, tell the user. */
export async function completeHermesLogin(providerName: string): Promise<void> {
  patch({ needsLogin: false, snoozed: false, reason: null, chosen: null })
  await refreshHermesAuth()
  notify({ title: 'Signed in', body: `Hermes is connected to ${providerName}. Ask it something.`, level: 'success' })
}

let bound = false

export function bindHermesAuth(): () => void {
  if (bound || !isMainSurface) {
    return () => undefined
  }

  bound = true
  const offReady = $gatewayReady.subscribe(ready => {
    if (ready) {
      void refreshHermesAuth()
    } else {
      patch({ checked: false })
    }
  })
  // Any turn (typed or spoken) that dies for lack of credentials brings the card up.
  const offError = onGatewayEvent('error', event => {
    const message = (event.payload as { message?: string } | undefined)?.message

    if (isAuthErrorText(message)) {
      requestHermesLogin(message)
    }
  })
  const offComplete = onGatewayEvent('message.complete', event => {
    const payload = event.payload

    if (payload?.status === 'error' && isAuthErrorText(payload.error ?? (typeof payload.text === 'string' ? payload.text : ''))) {
      requestHermesLogin(payload.error ?? undefined)
    }
  })

  return () => {
    offReady()
    offError()
    offComplete()
    bound = false
  }
}
