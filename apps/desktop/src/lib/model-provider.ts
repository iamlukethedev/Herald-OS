import type { ModelOptionProvider, ModelOptionsResult } from '@herald-os/client'

/*
 * The model providers Hermes knows, as the OS offers them (pure; tested). `model.options` with the
 * unconfigured ones lists what `hermes model` lists, the sign-in list (`/api/providers/oauth`) says
 * which sign in on an account, and Hermes's key catalog (`/api/env`) names the variable an API key
 * goes in and where to get one. A custom endpoint's entry in config.yaml names its own variable.
 */

/** How a provider that is not ready yet gets ready; `endpoint` is one of the person's own whose entry names no key. */
export type ProviderSetup = 'key' | 'sign-in' | 'terminal' | 'local' | 'endpoint'

export interface ProviderChoice {
  slug: string
  name: string
  current: boolean
  /** Signed in, its API key saved, or otherwise set up: Hermes can use it now. */
  ready: boolean
  setup: ProviderSetup
  /** The variable its API key goes in (`key`). */
  keyEnv: string | null
  /** Where to get an API key, or how its sign-in works. */
  helpUrl: string | null
  /** What to run in a terminal, for a provider that signs in through its own tool (`terminal`). */
  command: string | null
  models: string[]
}

/** The parts of a sign-in provider that the choices read. */
export interface SignInProvider {
  id: string
  flow: 'device_code' | 'external'
  cliCommand: string | null
  docsUrl: string | null
  loggedIn: boolean
}

/** One variable of Hermes's key catalog (`GET /api/env`). */
export interface KeyCatalogEntry {
  provider?: string
  is_password?: boolean
  is_set?: boolean
  url?: string | null
}

export type KeyCatalog = Record<string, KeyCatalogEntry>

/** The variable each custom endpoint keeps its API key in, by endpoint id. */
export type EndpointKeys = Record<string, string>

/** Providers that run on this computer: Settings > Software installs them and picks their model. */
const LOCAL = new Set(['lmstudio'])

/** Every provider Hermes knows: the current one first, then those ready to use, then the rest, each in Hermes's own order. */
export function providerChoices(options: ModelOptionsResult | null | undefined, signIns: readonly SignInProvider[], keys: KeyCatalog, endpoints: EndpointKeys = {}): ProviderChoice[] {
  const bySlug = new Map(signIns.map(provider => [provider.id, provider]))
  const rank = (choice: ProviderChoice) => (choice.current ? 0 : choice.ready ? 1 : 2)

  return (
    (options?.providers ?? [])
      // Mixture of Agents routes through other providers rather than being one to set up.
      .filter(row => row.slug !== 'moa' || row.is_current)
      .map(row => choiceFor(row, bySlug.get(row.slug), keys, endpoints))
      .sort((a, b) => rank(a) - rank(b))
  )
}

function choiceFor(row: ModelOptionProvider, signIn: SignInProvider | undefined, keys: KeyCatalog, endpoints: EndpointKeys): ProviderChoice {
  const endpointKey = row.is_user_defined ? (endpoints[endpointId(row.slug)] ?? null) : null
  // `model.options` names the key only for providers in Hermes's registry, which OpenRouter is not.
  const keyEnv = endpointKey || row.key_env || (Object.entries(keys).find(([, entry]) => entry.provider === row.slug && entry.is_password)?.[0] ?? null)
  const setup = setupFor(row, signIn, keyEnv)
  // Hermes lists a custom endpoint whether or not the key it names is saved; the key catalog, once
  // read, lists every variable in Hermes's .env.
  const keyUnsaved = endpointKey !== null && Object.keys(keys).length > 0 && !keys[endpointKey]?.is_set

  return {
    slug: row.slug,
    name: row.name || row.slug,
    current: Boolean(row.is_current),
    // The inventory counts a stored login that has lapsed; the sign-in list knows it is signed out.
    ready: row.authenticated !== false && !(signIn?.flow === 'device_code' && !signIn.loggedIn) && !keyUnsaved,
    setup,
    keyEnv: setup === 'key' ? keyEnv : null,
    helpUrl: setup === 'key' ? (keyEnv ? (keys[keyEnv]?.url ?? null) : null) : (signIn?.docsUrl ?? null),
    command: setup === 'terminal' ? (signIn?.cliCommand ?? 'hermes model') : null,
    models: (row.models ?? []).filter(Boolean)
  }
}

function setupFor(row: ModelOptionProvider, signIn: SignInProvider | undefined, keyEnv: string | null): ProviderSetup {
  if (LOCAL.has(row.slug) || row.auth_type === 'local') {
    return 'local'
  }

  if (signIn?.flow === 'device_code') {
    return 'sign-in'
  }

  // Rows that are set up carry no auth type; a key the catalog knows for them means an API key.
  if (keyEnv && (!row.auth_type || row.auth_type === 'api_key')) {
    return 'key'
  }

  return row.is_user_defined ? 'endpoint' : 'terminal'
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** An endpoint's id as Hermes matches it: `custom:Lab GPU` and `lab-gpu` are the same endpoint. */
const endpointId = (value: string) => value.trim().toLowerCase().replace(/ /g, '-').replace(/^custom:/, '')

/** A `custom_providers` name up to the separator Hermes puts before a model ("Lab GPU — llama3"). */
const namePrefix = (name: string) => ['—', ' - '].map(separator => name.split(separator)).find(parts => parts.length > 1)?.[0].trim() ?? name

/** The variable a config entry keeps its key in, read as Hermes reads it; never the key itself. */
function keyVariable(entry: Record<string, unknown>): string | null {
  const named = [entry.key_env, entry.api_key_env].find((value): value is string => typeof value === 'string' && value.trim() !== '')
  const reference = typeof entry.api_key === 'string' ? /^\$\{(\w+)\}$/.exec(entry.api_key.trim())?.[1] : undefined

  return named?.trim() ?? reference ?? null
}

/**
 * The variables the custom endpoints in Hermes's raw config (`GET /api/config?include_defaults=false`)
 * keep their API keys in: `key_env`, else `api_key_env`, else an `api_key` of just `${VAR}`. A key
 * written into config.yaml itself is never kept.
 */
export function endpointKeys(config: { providers?: unknown; custom_providers?: unknown } | null | undefined): EndpointKeys {
  const found: EndpointKeys = {}
  const add = (id: string, entry: unknown) => {
    const variable = isRecord(entry) ? keyVariable(entry) : null

    if (id && variable && !(id in found)) {
      found[id] = variable
    }
  }
  const providers = config?.providers
  const legacy = config?.custom_providers

  // Hermes finds an endpoint under `providers:` before the older list.
  for (const [id, entry] of Object.entries(isRecord(providers) ? providers : {})) {
    add(endpointId(id), entry)
  }

  for (const entry of Array.isArray(legacy) ? legacy : []) {
    if (isRecord(entry)) {
      add(endpointId(String(entry.provider_key || namePrefix(String(entry.name ?? '')))), entry)
    }
  }

  return found
}

/** The model a switch to `row` lands on: the saved one when the provider stays, else Hermes's recommendation, else its first. */
export function pickModel(row: Pick<ModelOptionProvider, 'is_current' | 'models'> | undefined, savedModel: string | null | undefined, recommended: string | null | undefined): string | null {
  if (row?.is_current && savedModel) {
    return savedModel
  }

  return recommended?.trim() || row?.models?.find(Boolean) || null
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * The provider a typed or spoken name means: an exact id or name, else the one name that starts
 * with it, the one id that does, or the one name containing it. More than one is ambiguous.
 */
export function matchProvider(choices: readonly ProviderChoice[], query: string): { choice: ProviderChoice | null; candidates: ProviderChoice[] } {
  const needle = squash(query)

  if (!needle) {
    return { choice: null, candidates: [] }
  }

  const tests: ((choice: ProviderChoice) => boolean)[] = [
    choice => squash(choice.slug) === needle || squash(choice.name) === needle,
    choice => squash(choice.name).startsWith(needle),
    choice => squash(choice.slug).startsWith(needle),
    choice => squash(choice.name).includes(needle)
  ]

  for (const test of tests) {
    const found = choices.filter(test)

    if (found.length > 0) {
      return { choice: found.length === 1 ? found[0] : null, candidates: found }
    }
  }

  return { choice: null, candidates: [] }
}
