import type { ModelOptionsResult } from '@herald-os/client'
import { atom } from 'nanostores'
import { type KeyCatalog, pickModel, type ProviderChoice, providerChoices } from '../lib/model-provider.ts'
import { rest } from '../lib/rest.ts'
import { $activeChat } from './chat.ts'
import { gatewayRequest } from './gateway.ts'
import { $hermesAuth, refreshHermesAuth } from './hermes-auth.ts'

/*
 * The model provider and model Hermes thinks with, changed from the OS. The choice is written where
 * `hermes model` writes it (`/api/model/set`, config.yaml), so new conversations and the Hermes CLI
 * use it too, and the open chat moves along through `config.set model`. API keys go where Hermes
 * keeps them (`/api/env`, its .env file); signing in to an account runs on the OS card (hermes-auth.ts).
 */

/** Bumped after every change, so whatever lists providers or models reads them again. */
export const $providerChanges = atom(0)

/** The provider and model lists read again, as after a sign-in that finished on the card. */
export function providersChanged(): void {
  $providerChanges.set($providerChanges.get() + 1)
}

/** A request to show the provider chooser (Settings, first-run setup), at one provider's setup when `slug` is set. */
export const $providerFocus = atom<{ slug?: string; ts: number } | null>(null)

export function focusProvider(slug?: string): void {
  $providerFocus.set({ slug, ts: Date.now() })
}

const names = new Map<string, string>()

/** A provider's display name, once a list of providers has been read. */
export function providerName(slug: string | null | undefined): string | null {
  return slug ? (names.get(slug) ?? null) : null
}

/** Every provider Hermes knows, set up or not: what `hermes model` offers. */
export async function loadModelOptions(): Promise<ModelOptionsResult> {
  const options = await gatewayRequest('model.options', { include_unconfigured: true })

  for (const row of options.providers ?? []) {
    names.set(row.slug, row.name)
  }

  return options
}

/**
 * Hermes's key catalog: which variable each provider's API key goes in, and where to get one.
 * Empty when the runtime has none. The route also previews the saved keys; those are dropped here.
 */
export function loadKeyCatalog(): Promise<KeyCatalog> {
  return rest
    .get<KeyCatalog | null>('/api/env')
    .then(keys => Object.fromEntries(Object.entries(keys ?? {}).map(([name, { provider, is_password, url }]) => [name, { provider, is_password, url }])))
    .catch(() => ({}))
}

/** The providers as Settings lists them, read now. */
export async function readProviderChoices(): Promise<ProviderChoice[]> {
  const [options, keys, auth] = await Promise.all([loadModelOptions(), loadKeyCatalog(), $hermesAuth.get().checked ? $hermesAuth.get() : refreshHermesAuth()])

  return providerChoices(options, auth.providers, keys)
}

interface ModelSetResponse {
  ok?: boolean
  provider?: string
  model?: string
  confirm_required?: boolean
  confirm_message?: string
}

/** A change Hermes made, or one it holds until the person confirms the warning (a model far pricier than most). */
export type ModelChange = { ok: true; provider: string; model: string } | { ok: false; provider: string; model: string; confirm: string }

/** Make `provider` and `model` Hermes's default and move the open chat to them; `confirmed` accepts a price warning. */
export async function setHermesModel(provider: string, model: string, confirmed = false): Promise<ModelChange> {
  const result = await rest.post<ModelSetResponse | null>('/api/model/set', { scope: 'main', provider, model, confirm_expensive_model: confirmed })

  if (result?.confirm_required) {
    return { ok: false, provider, model, confirm: result.confirm_message?.trim() || `${model} costs far more than most models.` }
  }

  const saved = { provider: result?.provider || provider, model: result?.model || model }
  const chat = $activeChat.get()

  if (chat) {
    // A conversation keeps the model it started with; this one follows the change. The default is
    // saved either way, so a chat that cannot switch now still leaves new ones on the new model.
    await gatewayRequest('config.set', { session_id: chat.sessionId, key: 'model', value: `${saved.model} --provider ${saved.provider}`, confirm_expensive_model: true }).catch(() => undefined)
  }

  providersChanged()
  await refreshHermesAuth()

  return { ok: true, ...saved }
}

/** Switch Hermes to a provider that is set up: on its saved model when it already is the provider, else on Hermes's recommendation for it. */
export async function switchToProvider(slug: string, confirmed = false): Promise<ModelChange> {
  const options = await loadModelOptions()
  const row = options.providers.find(provider => provider.slug === slug)
  const name = row?.name ?? slug

  if (!row || row.authenticated === false) {
    throw new Error(`${name} is not set up yet.`)
  }

  const recommended = row.is_current && options.model ? null : await rest.get<{ model?: string } | null>('/api/model/recommended-default', { provider: slug }).then(
    result => result?.model ?? null,
    () => null
  )
  const model = pickModel(row, options.model, recommended)

  if (!model) {
    throw new Error(`Hermes lists no models for ${name} yet. Try again in a moment.`)
  }

  return setHermesModel(row.slug, model, confirmed)
}

/** Save a provider's API key where Hermes keeps its keys, then switch Hermes to that provider. */
export async function saveProviderKey(choice: ProviderChoice, key: string): Promise<ModelChange> {
  const value = key.trim()

  if (!choice.keyEnv || !value) {
    throw new Error(`Paste the ${choice.name} API key first.`)
  }

  await rest.put('/api/env', { key: choice.keyEnv, value })
  // The runtime reads keys from its own environment as well as from the file.
  await gatewayRequest('reload.env', {}).catch(() => undefined)

  try {
    return await switchToProvider(choice.slug)
  } catch (error) {
    throw new Error(`The key is saved, but Hermes did not switch to ${choice.name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
