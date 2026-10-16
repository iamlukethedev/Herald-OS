import { afterEach, describe, expect, it, vi } from 'vitest'
import { $roadsterFlight } from '../features/roadster/flight.ts'
import { $prefs } from '../store/backend.ts'
import { defineCommands, resetCommands, runCommand } from '../store/os-commands.ts'
import { roadsterCommands } from './roadster.ts'

const backend = vi.hoisted(() => ({ updatePrefs: vi.fn(async (_patch: unknown) => undefined) }))

vi.mock('../store/backend.ts', async original => ({ ...(await original<typeof import('../store/backend.ts')>()), updatePrefs: backend.updatePrefs }))

afterEach(() => {
  resetCommands()
  $roadsterFlight.set(0)
  $prefs.set({ ...$prefs.get(), flyovers: undefined })
  vi.clearAllMocks()
})

describe('the roadster commands', () => {
  it('start a flight in this window and say so', async () => {
    defineCommands(roadsterCommands)

    const result = await runCommand('roadster.fly', {}, { source: 'palette' })

    expect(result).toMatchObject({ ok: true, summary: 'The roadster took off' })
    expect($roadsterFlight.get()).toBeGreaterThan(0)
  })

  it('fly the roadster when asked even with Flyover animations off', async () => {
    defineCommands(roadsterCommands)
    $prefs.set({ ...$prefs.get(), flyovers: false })

    await runCommand('roadster.fly', {}, { source: 'voice' })

    expect($roadsterFlight.get()).toBeGreaterThan(0)
  })

  it('turn Flyover animations on and off, by words too', async () => {
    defineCommands(roadsterCommands)

    expect(await runCommand('roadster.flyovers.set', { enabled: false }, { source: 'palette' })).toMatchObject({ ok: true, summary: 'Flyover animations off' })
    expect(backend.updatePrefs).toHaveBeenLastCalledWith({ flyovers: false })

    expect(await runCommand('roadster.flyovers.set', { enabled: true }, { source: 'palette' })).toMatchObject({ ok: true, summary: 'Flyover animations on' })
    expect(backend.updatePrefs).toHaveBeenLastCalledWith({ flyovers: true })

    const phrases = roadsterCommands.find(command => command.id === 'roadster.flyovers.set')?.phrases ?? []
    expect(phrases).toContainEqual({ phrase: 'turn off flyover animations', args: { enabled: false } })
  })
})
