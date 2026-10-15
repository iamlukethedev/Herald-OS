import { describe, expect, it } from 'vitest'
import { BUILT_IN, memoryErrorText, memoryProviderBody, memoryProviderView, memoryStatusLabel, type MemoryStatusPayload, parseMemoryStatus } from './memory-provider.ts'

// GET /api/memory as Hermes answers it, with Honcho set up and Mem0 not configured yet.
const PROVIDERS: MemoryStatusPayload['providers'] = [
  { name: 'honcho', description: 'Cross-session user modelling', available: true, configured: true, status: 'ready' },
  { name: 'mem0', description: 'Mem0 cloud memory', available: false, configured: false, status: 'needs_config' }
]

describe('memoryProviderView', () => {
  it('says "Built-in only" when Hermes reports no external provider', () => {
    const view = memoryProviderView({ active: '', providers: PROVIDERS, builtin_files: { memory: 1119, user: 40 } })

    expect(view.active).toBe(BUILT_IN)
    expect(view.label).toBe('Built-in only')
    expect(view.description).toBe('Hermes remembers only what the Memory page lists.')
  })

  it('treats the names Hermes reads as built-in the same way', () => {
    for (const active of ['default', 'builtin', 'Built-in', 'none', '  ', null, undefined]) {
      expect(memoryProviderView({ active, providers: PROVIDERS }).label).toBe('Built-in only')
    }

    expect(memoryProviderView(null).label).toBe('Built-in only')
  })

  it('names a ready external provider with its display casing and says it remembers outside the two files', () => {
    const view = memoryProviderView({ active: 'honcho', providers: PROVIDERS })

    expect(view.active).toBe('honcho')
    expect(view.label).toBe('Honcho')
    expect(view.description).toBe('Honcho also saves and recalls memories outside the two files on the Memory page.')
  })

  it('says the active provider needs setup when it is not ready', () => {
    const view = memoryProviderView({ active: 'mem0', providers: PROVIDERS })

    expect(view.label).toBe('Mem0')
    expect(view.description).toBe('Mem0 is the active provider but needs setup before it saves or recalls anything.')
    expect(view.description).not.toContain('also saves')
  })

  it('says an unavailable active provider needs setup too', () => {
    const view = memoryProviderView({ active: 'openviking', providers: [...PROVIDERS!, { name: 'openviking', description: 'OpenViking context store', available: false, configured: true, status: 'unavailable' }] })

    expect(view.description).toBe('openviking is the active provider but needs setup before it saves or recalls anything.')
    expect(view.choices.at(-1)?.status).toBe('unavailable')
    expect(memoryStatusLabel('unavailable')).toBe('unavailable')
  })

  it('says when the configured provider is not installed', () => {
    const view = memoryProviderView({ active: 'supermemory', providers: [...PROVIDERS!, { name: 'supermemory', description: 'Configured provider was not found.', available: false, configured: false, status: 'missing' }] })

    expect(view.label).toBe('supermemory')
    expect(view.description).toBe("supermemory is set in Hermes's config but not installed.")
  })

  it('offers built-in first, then every provider with its readiness, including ones not set up', () => {
    expect(memoryProviderView({ active: 'honcho', providers: PROVIDERS }).choices).toEqual([
      { id: BUILT_IN, label: 'Built-in only', description: 'MEMORY.md and USER.md', status: null },
      { id: 'honcho', label: 'Honcho', description: 'Cross-session user modelling', status: 'ready' },
      { id: 'mem0', label: 'Mem0', description: 'Mem0 cloud memory', status: 'needs_config' }
    ])
  })

  it('keeps the active provider selectable, as not installed, when discovery did not list it', () => {
    const view = memoryProviderView({ active: 'honcho', providers: [] })

    expect(view.choices.map(choice => [choice.id, choice.status])).toEqual([
      [BUILT_IN, null],
      ['honcho', 'missing']
    ])
    expect(view.description).toBe("Honcho is set in Hermes's config but not installed.")
  })
})

describe('memoryStatusLabel', () => {
  it('uses one term for a configured provider that is not installed', () => {
    expect(memoryStatusLabel('missing')).toBe('not installed')
    expect(memoryStatusLabel('needs_config')).toBe('needs setup')
    expect(memoryStatusLabel('some_new_state')).toBe('some new state')
  })
})

describe('memoryProviderBody', () => {
  it('sends an empty provider for built-in, and the name otherwise', () => {
    expect(memoryProviderBody(BUILT_IN)).toEqual({ provider: '' })
    expect(memoryProviderBody('honcho')).toEqual({ provider: 'honcho' })
  })
})

describe('memoryErrorText', () => {
  it("keeps only Hermes's reason", () => {
    const raw = "Error invoking remote method 'herald-os:backend:rest': Error: PUT /api/memory/provider -> 400: Memory provider 'mem0' is not ready (needs config)."

    expect(memoryErrorText(new Error(raw))).toBe("Memory provider 'mem0' is not ready (needs config).")
    expect(memoryErrorText(raw)).toBe("Memory provider 'mem0' is not ready (needs config).")
    expect(memoryErrorText(new Error('GET /api/memory -> 500: Internal Server Error'))).toBe('Internal Server Error')
    expect(memoryErrorText(new Error('connect ECONNREFUSED'))).toBe('connect ECONNREFUSED')
  })

  it('words the failure from the status code when there is no reason, or an HTML page in its place', () => {
    const ipc = (message: string) => new Error(`Error invoking remote method 'herald-os:backend:rest': Error: ${message}`)

    expect(memoryErrorText(ipc('PUT /api/memory/provider -> 502'))).toBe('Hermes refused the change (HTTP 502).')
    expect(memoryErrorText(ipc('PUT /api/memory/provider -> 400: '))).toBe('Hermes refused the change (HTTP 400).')
    expect(memoryErrorText(ipc('PUT /api/memory/provider -> 500: <!DOCTYPE html><html><body>Internal Server Error</body></html>'))).toBe('Hermes refused the change (HTTP 500).')
    expect(memoryErrorText(ipc('PUT /api/memory/provider -> 502: \n  <html><title>502 Bad Gateway</title></html>'))).toBe('Hermes refused the change (HTTP 502).')
    expect(memoryErrorText(ipc('GET /api/memory -> 503: <html>Service Unavailable</html>'))).toBe('Hermes did not send its memory status (HTTP 503).')
    expect(memoryErrorText(ipc('GET /api/memory -> 500'))).toBe('Hermes did not send its memory status (HTTP 500).')
  })

  it('keeps a reason that spans lines', () => {
    expect(memoryErrorText(new Error('PUT /api/memory/provider -> 400: First line.\nSecond line.'))).toBe('First line.\nSecond line.')
  })
})

describe('parseMemoryStatus', () => {
  it('accepts what Hermes sends', () => {
    expect(parseMemoryStatus({ active: 'honcho', providers: PROVIDERS }).providers?.map(row => row.name)).toEqual(['honcho', 'mem0'])
    expect(parseMemoryStatus({ active: null, providers: [] }).active).toBeNull()
  })

  it('drops non-string descriptions and statuses rather than rendering them', () => {
    expect(parseMemoryStatus({ active: '', providers: [{ name: 'honcho', description: 5, status: {} }] }).providers).toEqual([{ name: 'honcho', description: undefined, status: undefined }])
  })

  it('refuses payloads the row cannot read', () => {
    for (const raw of [null, undefined, {}, [], '<html>oops</html>', { active: '', providers: { a: 1 } }, { active: 5, providers: [] }, { active: '', providers: [{ name: 7 }] }, { active: '', providers: [null] }]) {
      expect(() => parseMemoryStatus(raw)).toThrow('Hermes sent a memory status Herald does not understand.')
    }
  })
})
