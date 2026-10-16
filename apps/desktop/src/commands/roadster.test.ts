import { afterEach, describe, expect, it } from 'vitest'
import { $roadsterFlight } from '../features/roadster/flight.ts'
import { defineCommands, resetCommands, runCommand } from '../store/os-commands.ts'
import { roadsterCommands } from './roadster.ts'

afterEach(() => {
  resetCommands()
  $roadsterFlight.set(0)
})

describe('the roadster command', () => {
  it('starts a flight in this window and says so', async () => {
    defineCommands(roadsterCommands)

    const result = await runCommand('roadster.fly', {}, { source: 'palette' })

    expect(result).toMatchObject({ ok: true, summary: 'The roadster took off' })
    expect($roadsterFlight.get()).toBeGreaterThan(0)
  })
})
