import { rest } from '../../lib/rest.ts'
import { messageOf } from '../canvas/errors.ts'

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

const DISPLAY_NAMES: Record<string, string> = { honcho: 'Honcho', mem0: 'Mem0' }

/** Hermes's readiness values as the row shows them; "missing" means configured but not installed. */
const STATUS_LABELS: Record<string, string> = { ready: 'ready', needs_config: 'needs setup', unavailable: 'unavailable', missing: 'not installed' }

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

/** A provider's name as people write it ("Honcho"); unknown names stay as Hermes sends them. */
export function memoryProviderLabel(name: string): string {
  return DISPLAY_NAMES[name.toLowerCase()] ?? name
}

export function memoryStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, ' ')
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
    ...providers.map(row => ({ id: row.name, label: memoryProviderLabel(row.name), description: row.description ?? '', status: row.status ?? null }))
  ]

  if (active === BUILT_IN) {
    return { active, label: 'Built-in only', description: 'Hermes remembers only what the Memory page lists.', choices }
  }

  const label = memoryProviderLabel(active)

  if (!activeRow) {
    choices.push({ id: active, label, description: '', status: 'missing' })
  }

  if (!activeRow || activeRow.status === 'missing') {
    return { active, label, description: `${label} is set in Hermes's config but not installed.`, choices }
  }

  if (activeRow.status && activeRow.status !== 'ready') {
    return { active, label, description: `${label} is the active provider but needs setup before it saves or recalls anything.`, choices }
  }

  return { active, label, description: `${label} also saves and recalls memories outside the two files on the Memory page.`, choices }
}

/** Body for PUT /api/memory/provider; Hermes refuses a provider that isn't set up yet. */
export function memoryProviderBody(id: string): { provider: string } {
  return { provider: normalizeMemoryProvider(id) === BUILT_IN ? '' : id }
}

/** Hermes's reason alone: without Electron's IPC prefix or main's "PUT /api/memory/provider -> 400:". */
export function memoryErrorText(error: unknown): string {
  return messageOf(error).replace(/^[A-Z]+ \/\S* -> \d{3}: /, '')
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** GET /api/memory checked before the row trusts it; anything else is a read error, not a crash. */
export function parseMemoryStatus(raw: unknown): MemoryStatusPayload {
  const fail = (): never => {
    throw new Error('Hermes sent a memory status Herald does not understand.')
  }

  if (!isRecord(raw) || !Array.isArray(raw.providers) || (raw.active != null && typeof raw.active !== 'string')) {
    return fail()
  }

  const providers = raw.providers.map(row => {
    if (!isRecord(row) || typeof row.name !== 'string') {
      return fail()
    }

    return { ...row, name: row.name, description: typeof row.description === 'string' ? row.description : undefined, status: typeof row.status === 'string' ? row.status : undefined }
  })

  return { ...raw, active: raw.active as string | null | undefined, providers }
}

export const getMemoryStatus = async () => parseMemoryStatus(await rest.get<unknown>('/api/memory'))

export const setMemoryProvider = (id: string) => rest.put<{ ok?: boolean; active?: string }>('/api/memory/provider', memoryProviderBody(id))
