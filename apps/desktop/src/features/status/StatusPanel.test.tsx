// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatusPanelId, StatusPanelState } from '../../../shared/ipc.ts'
import { $env } from '../../store/backend.ts'
import { StatusPanel } from './StatusPanel.tsx'

// The preload bridge the panels talk to: `herald-os` runs and status reads are recorded.
const bridge = vi.hoisted(() => {
  const ran: string[][] = []
  const loaded: string[] = []
  const states: Record<string, unknown> = {
    wifi: { panel: 'wifi', wifi: { available: true, enabled: true, networks: [] } },
    bluetooth: { panel: 'bluetooth', bluetooth: { available: true, powered: true, devices: [] } },
    audio: { panel: 'audio', audio: { available: true, outputs: [], inputs: [] } },
    display: { panel: 'display', display: { available: true, displays: [] } },
    power: { panel: 'power', power: { available: true, battery: { present: false }, profiles: [] } }
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, {
    heraldOS: {
      shell: {
        heraldOs: async (argv: string[]) => {
          ran.push(argv)

          return { code: 0, stdout: `${argv[1]} restarted\n`, stderr: '' }
        },
        relay: async () => undefined,
        open: async () => undefined
      },
      controls: {
        status: async (panel: string) => {
          loaded.push(panel)

          return states[panel]
        },
        act: async () => undefined
      },
      calendar: { today: async () => ({ events: [] }) }
    }
  })

  return { ran, loaded, states: states as Record<string, StatusPanelState> }
})

const ENV = { hermesHome: '/h/.hermes', homeDir: '/h', version: '0.0.0', isDev: false, shellMode: 'panels' as const }

let root: Root | null = null
let container: HTMLElement

async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function openPanel(panel: StatusPanelId, platform: NodeJS.Platform) {
  $env.set({ ...ENV, platform })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<StatusPanel panel={panel} />))
  await settle()
}

const restartButton = () => [...container.querySelectorAll('button')].find(button => button.textContent?.startsWith('Restart'))

beforeEach(() => {
  bridge.ran.length = 0
  bridge.loaded.length = 0
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
})

describe('Restart at the bottom of a quick panel', () => {
  it.each([
    ['wifi', 'Restart Wi-Fi', 'wifi'],
    ['bluetooth', 'Restart Bluetooth', 'bluetooth'],
    ['audio', 'Restart Sound', 'sound']
  ] as const)('the %s panel runs herald-os restart with its own device and reloads', async (panel, label, device) => {
    await openPanel(panel, 'linux')
    const button = restartButton()

    expect(button?.textContent).toBe(label)
    bridge.loaded.length = 0

    await act(async () => button?.click())
    await settle()

    expect(bridge.ran).toEqual([['restart', device]])
    expect(bridge.loaded).toEqual([panel])
    expect(container.textContent).toContain(`${device} restarted`)
  })

  it.each(['display', 'power', 'clock'] as const)('the %s panel has none', async panel => {
    await openPanel(panel, 'linux')

    expect(restartButton()).toBeUndefined()
  })

  it.each(['darwin', 'win32'] as const)('is not offered on %s', async platform => {
    for (const panel of ['wifi', 'bluetooth', 'audio'] as const) {
      await openPanel(panel, platform)

      expect(restartButton()).toBeUndefined()
      act(() => root?.unmount())
      root = null
      container.remove()
      container = document.createElement('div')
    }
  })
})
