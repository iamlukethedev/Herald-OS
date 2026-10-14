import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SystemInfo } from '../../shared/ipc.ts'

const bridge = vi.hoisted(() => {
  const info = vi.fn()
  Object.assign(globalThis, { window: { heraldOS: { system: { info } } } })

  return { info }
})

import { $systemInfo, $systemInfoFailed, loadSystemInfo } from './system.ts'

const INFO: SystemInfo = { hostname: 'studio', platform: 'darwin', arch: 'arm64', osVersion: '26.0', osName: 'macOS', cpuModel: 'Apple M4', cpuCount: 10, totalMemory: 32 * 1024 ** 3, userName: 'luke', homeDir: '/Users/luke' }

beforeEach(() => {
  bridge.info.mockReset()
  $systemInfo.set(null)
  $systemInfoFailed.set(false)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadSystemInfo', () => {
  it('asks once however many ask at a time, and clears an earlier failure', async () => {
    bridge.info.mockResolvedValue(INFO)
    $systemInfoFailed.set(true)

    await Promise.all([loadSystemInfo(), loadSystemInfo()])

    expect(bridge.info).toHaveBeenCalledOnce()
    expect($systemInfo.get()).toEqual(INFO)
    expect($systemInfoFailed.get()).toBe(false)
  })

  it('says it failed and logs which call failed and why, then asks again on the next try', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    bridge.info.mockRejectedValueOnce(new Error("Error invoking remote method 'herald-os:system:info': Error: sw_vers not found"))

    await loadSystemInfo()

    expect($systemInfoFailed.get()).toBe(true)
    expect(report.mock.calls[0][0]).toMatch(/^\[herald-os\] system\.info failed: Error: Error invoking remote method 'herald-os:system:info': Error: sw_vers not found/)

    bridge.info.mockResolvedValueOnce(INFO)
    await loadSystemInfo()

    expect(bridge.info).toHaveBeenCalledTimes(2)
    expect($systemInfoFailed.get()).toBe(false)
  })
})
