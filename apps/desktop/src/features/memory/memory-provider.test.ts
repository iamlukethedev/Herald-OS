import { describe, expect, it } from 'vitest'
import { BUILT_IN, memoryProviderBody, memoryProviderView, type MemoryStatusPayload } from './memory-provider.ts'

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

  it('names an external provider and says it remembers outside the two files', () => {
    const view = memoryProviderView({ active: 'honcho', providers: PROVIDERS })

    expect(view.active).toBe('honcho')
    expect(view.label).toBe('honcho')
    expect(view.description).toBe('honcho also saves and recalls memories outside the two files on the Memory page.')
  })

  it('says when the configured provider is not installed', () => {
    const view = memoryProviderView({ active: 'supermemory', providers: [...PROVIDERS!, { name: 'supermemory', description: 'Configured provider was not found.', available: false, configured: false, status: 'missing' }] })

    expect(view.label).toBe('supermemory')
    expect(view.description).toBe("supermemory is set in Hermes's config but isn't installed.")
  })

  it('offers built-in first, then every provider with its readiness, including ones not set up', () => {
    expect(memoryProviderView({ active: 'honcho', providers: PROVIDERS }).choices).toEqual([
      { id: BUILT_IN, label: 'Built-in only', description: 'MEMORY.md and USER.md', status: null },
      { id: 'honcho', label: 'honcho', description: 'Cross-session user modelling', status: 'ready' },
      { id: 'mem0', label: 'mem0', description: 'Mem0 cloud memory', status: 'needs_config' }
    ])
  })

  it('keeps the active provider selectable when discovery did not list it', () => {
    const view = memoryProviderView({ active: 'honcho', providers: [] })

    expect(view.choices.map(choice => choice.id)).toEqual([BUILT_IN, 'honcho'])
  })
})

describe('memoryProviderBody', () => {
  it('sends an empty provider for built-in, and the name otherwise', () => {
    expect(memoryProviderBody(BUILT_IN)).toEqual({ provider: '' })
    expect(memoryProviderBody('honcho')).toEqual({ provider: 'honcho' })
  })
})
