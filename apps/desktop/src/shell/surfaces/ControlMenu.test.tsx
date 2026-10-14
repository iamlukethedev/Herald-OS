// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $env } from '../../store/backend.ts'
import { ControlMenu } from './ControlMenu.tsx'

// The preload bridge the menu talks to: every `herald-os` run is recorded instead of spawned.
const bridge = vi.hoisted(() => {
  const ran: string[][] = []
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, {
    heraldOS: {
      shell: {
        heraldOs: async (argv: string[]) => {
          ran.push(argv)

          return { code: 0, stdout: 'done\n', stderr: '' }
        },
        menuExtensions: async () => ({ entries: [], errors: [] }),
        relay: async () => undefined,
        open: async () => undefined
      }
    }
  })

  return { ran }
})

const ENV = { hermesHome: '/h/.hermes', homeDir: '/h', version: '0.0.0', isDev: false, shellMode: 'panels' as const }

let root: Root | null = null
let container: HTMLElement

async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function openMenu(platform: NodeJS.Platform) {
  $env.set({ ...ENV, platform })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<ControlMenu onClose={() => undefined} onApplications={() => undefined} />))
  await settle()
}

/** The labels of the rows the menu shows now. */
const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map(row => row.querySelector('.truncate')?.textContent ?? '')

async function choose(label: string) {
  const row = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(candidate => candidate.querySelector('.truncate')?.textContent === label)

  if (!row) {
    throw new Error(`no "${label}" in ${rows().join(', ')}`)
  }

  await act(async () => row.click())
  await settle()
}

beforeEach(() => {
  bridge.ran.length = 0
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
})

describe('System > Fix in the control menu', () => {
  it('lists a restart for each device on Linux', async () => {
    await openMenu('linux')
    await choose('System')
    expect(rows()).toContain('Fix')

    await choose('Fix')
    expect(rows()).toEqual(['Restart Wi-Fi', 'Restart Bluetooth', 'Restart Sound', 'Restart Touchpad'])
  })

  it.each([
    ['Restart Wi-Fi', 'wifi'],
    ['Restart Bluetooth', 'bluetooth'],
    ['Restart Sound', 'sound'],
    ['Restart Touchpad', 'touchpad']
  ])('%s runs herald-os restart %s', async (label, device) => {
    await openMenu('linux')
    await choose('System')
    await choose('Fix')
    await choose(label)

    expect(bridge.ran).toEqual([['restart', device]])
    expect(container.textContent).toContain(`herald-os restart ${device}`)
  })

  it.each(['darwin', 'win32'] as const)('is not offered on %s, where the OS owns the devices', async platform => {
    await openMenu(platform)
    await choose('System')

    expect(rows()).not.toContain('Fix')
    expect(rows()).toContain('Lock')
  })
})
