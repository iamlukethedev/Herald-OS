import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RESTART_TARGETS, restartArgv, restartForPanel } from './restart-devices.ts'

const cli = readFileSync(fileURLToPath(new URL('../../../../linux/bin/herald-os', import.meta.url)), 'utf8')

describe('restarting a device that stopped working', () => {
  it('runs the same herald-os restart the CLI knows, one per device', () => {
    const known = /^RESTART_TARGETS = \(([^)]*)\)/m.exec(cli)?.[1].match(/"([a-z-]+)"/g)?.map(name => name.slice(1, -1))

    expect(RESTART_TARGETS.map(target => target.device)).toEqual(known)
    expect(restartArgv('touchpad')).toEqual(['restart', 'touchpad'])
  })

  it('puts Restart in the Wi-Fi, Bluetooth and Sound panels only', () => {
    expect(restartForPanel('wifi')?.device).toBe('wifi')
    expect(restartForPanel('bluetooth')?.device).toBe('bluetooth')
    expect(restartForPanel('audio')?.device).toBe('sound')

    for (const panel of ['display', 'power', 'clock'] as const) {
      expect(restartForPanel(panel)).toBeUndefined()
    }
  })
})
