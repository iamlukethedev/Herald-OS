import { rest } from '../../lib/rest.ts'

/** One row of `providers` in Hermes's GET /api/memory. */
export interface MemoryProviderStatus {
  name: string
  description?: string
  status?: string
  [key: string]: unknown
}

/** Hermes's GET /api/memory. `active` is empty when only MEMORY.md and USER.md are used. */
export interface MemoryStatusPayload {
  active?: string | null
  providers?: MemoryProviderStatus[]
  [key: string]: unknown
}

/** Menu id for "no external provider"; Hermes treats it, like "", as the built-in store. */
export const BUILT_IN = 'builtin'

// Hermes's CORE_MEMORY_PROVIDER_SENTINELS: `memory.provider` values that mean "built-in only".
const BUILT_IN_NAMES = new Set(['', 'default', 'builtin', 'built-in', 'none'])

export interface MemoryProviderChoice {
  id: string
  label: string
  description: string
  /** Hermes's readiness ("ready", "needs_config", "unavailable", "missing"); null for built-in. */
  status: string | null
}

export interface MemoryProviderView {
  /** The active provider's menu id: BUILT_IN, or the provider's name. */
  active: string
  label: string
  description: string
  choices: MemoryProviderChoice[]
}

export function normalizeMemoryProvider(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim()

  return BUILT_IN_NAMES.has(trimmed.toLowerCase()) ? BUILT_IN : trimmed
}

/**
 * What the "Memory provider" row shows. Providers that aren't ready stay selectable, so picking
 * one shows Hermes's own reason for refusing it.
 */
export function memoryProviderView(payload: MemoryStatusPayload | null | undefined): MemoryProviderView {
  const active = normalizeMemoryProvider(payload?.active)
  const providers = (payload?.providers ?? []).filter(row => normalizeMemoryProvider(row.name) !== BUILT_IN)
  const activeRow = providers.find(row => row.name === active)
  const choices: MemoryProviderChoice[] = [
    { id: BUILT_IN, label: 'Built-in only', description: 'MEMORY.md and USER.md', status: null },
    ...providers.map(row => ({ id: row.name, label: row.name, description: row.description ?? '', status: row.status ?? null }))
  ]

  if (active !== BUILT_IN && !activeRow) {
    choices.push({ id: active, label: active, description: '', status: null })
  }

  if (active === BUILT_IN) {
    return { active, label: 'Built-in only', description: 'Hermes remembers only what the Memory page lists.', choices }
  }

  if (activeRow?.status === 'missing') {
    return { active, label: active, description: `${active} is set in Hermes's config but isn't installed.`, choices }
  }

  return { active, label: active, description: `${active} also saves and recalls memories outside the two files on the Memory page.`, choices }
}

/** Body for PUT /api/memory/provider; Hermes refuses a provider that isn't set up yet. */
export function memoryProviderBody(id: string): { provider: string } {
  return { provider: normalizeMemoryProvider(id) === BUILT_IN ? '' : id }
}

export const getMemoryStatus = () => rest.get<MemoryStatusPayload>('/api/memory')

export const setMemoryProvider = (id: string) => rest.put<{ ok?: boolean; active?: string }>('/api/memory/provider', memoryProviderBody(id))
