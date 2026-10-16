// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WmWindow } from '../../shared/ipc.ts'
import { $env } from '../store/backend.ts'
import { $wm } from '../store/shell.ts'
import { $windows } from '../store/windows.ts'
import { Dock } from './Dock.tsx'
import { DockSurface } from './surfaces/DockSurface.tsx'

// The preload bridge and openApp: what the Dock opens and focuses is recorded instead of shown.
const edges = vi.hoisted(() => {
  const opened: string[] = []
  const actions: unknown[] = []
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, {
    heraldOS: {
      apps: { list: async () => [], icon: async () => '' },
      fs: { openPath: async () => undefined },
      wm: { action: async (action: unknown) => void actions.push(action) },
      shell: { open: async () => undefined }
    }
  })

  return { opened, actions }
})

vi.mock('../store/windows.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../store/windows.ts')>()),
  openApp: (appId: string) => {
    edges.opened.push(appId)

    return appId
  }
}))

const ENV = { hermesHome: '/h/.hermes', homeDir: '/h', version: '0.0.0', isDev: false }
const WM = $wm.get()
const CALC_WINDOW: WmWindow = { id: 7, title: 'Herald OS · Calc', appId: 'herald-os', pid: 1, workspaceId: 1, focused: false, floating: true, urgent: false, ours: true }

let root: Root | null = null
let container: HTMLElement

async function show(dock: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(dock))
}

const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Dock"] button')]

function button(label: string): HTMLButtonElement {
  const found = buttons().find(candidate => candidate.getAttribute('aria-label') === label)

  if (!found) {
    throw new Error(`no "${label}" in the Dock`)
  }

  return found
}

/** The dot under an icon is lit while its app runs. */
const running = (label: string) => button(label).lastElementChild?.classList.contains('opacity-90') ?? false

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  $windows.set({})
  $wm.set(WM)
  edges.opened.length = 0
  edges.actions.length = 0
})

describe('the Dock on the Mac', () => {
  it('has Herald Calc after Herald Office, before Applications', async () => {
    $env.set({ ...ENV, platform: 'darwin', shellMode: 'desktop' })
    await show(<Dock />)

    expect(buttons().map(item => item.dataset.dockItem)).toEqual(['hermes', 'files', 'room', 'canvas', 'office', 'calc', 'applications', 'trash'])
    expect(button('Herald Calc').dataset.dockItem).toBe('calc')
  })

  it('opens Herald Calc, and shows it running while its window is open', async () => {
    $env.set({ ...ENV, platform: 'darwin', shellMode: 'desktop' })
    await show(<Dock />)
    await act(async () => button('Herald Calc').click())

    expect(edges.opened).toEqual(['calc'])
    expect(running('Herald Calc')).toBe(false)

    act(() => $windows.set({ w1: { id: 'w1', appId: 'calc', title: 'Herald Calc', bounds: { x: 0, y: 0, width: 780, height: 560 }, z: 1, phase: 'open', maximized: false } }))

    expect(running('Herald Calc')).toBe(true)
    expect(running('Pet Room')).toBe(false)
  })
})

describe('the Dock in panels mode', () => {
  it('pins Herald Calc after Herald Office, and opens it', async () => {
    $env.set({ ...ENV, platform: 'linux', shellMode: 'panels' })
    await show(<DockSurface />)

    expect(buttons().map(item => item.getAttribute('aria-label'))).toEqual(['Hermes', 'Files', 'Pet Room', 'Herald Canvas', 'Herald Office', 'Herald Calc', 'Applications', 'Trash'])

    await act(async () => button('Herald Calc').click())

    expect(edges.opened).toEqual(['calc'])
  })

  it('gives an open Calc window to its shortcut, which focuses it', async () => {
    $env.set({ ...ENV, platform: 'linux', shellMode: 'panels' })
    $wm.set({ ...WM, available: true, windows: [CALC_WINDOW] })
    await show(<DockSurface />)

    expect(buttons().filter(item => item.getAttribute('aria-label') === 'Herald Calc')).toHaveLength(1)
    expect(running('Herald Calc')).toBe(true)

    await act(async () => button('Herald Calc').click())

    expect(edges.actions).toEqual([{ type: 'focus-window', id: 7 }])
    expect(edges.opened).toEqual([])
  })
})
