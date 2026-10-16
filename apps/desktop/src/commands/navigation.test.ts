import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../store/os-commands.ts'
import { $focusedWindowId, $windows, type OSWindow } from '../store/windows.ts'
import { navigationCommands, resolveAppId } from './navigation.ts'

const AGENT: CommandContext = { source: 'agent' }

// The stores read the preload bridge and the viewport when they load; tests run without a DOM.
vi.hoisted(() => {
  Object.assign(globalThis, { window: { innerWidth: 1440, innerHeight: 900 } })
})

function terminal(id: string, z: number): OSWindow {
  return { id, appId: 'terminal', title: 'Terminal', bounds: { x: 0, y: 0, width: 800, height: 500 }, z, phase: 'open', maximized: false }
}

function command(id: string) {
  const found = navigationCommands.find(c => c.id === id)

  if (!found) {
    throw new Error(`no command ${id}`)
  }

  return found
}

describe('window commands', () => {
  beforeEach(() => {
    $windows.set({ 'w-1': terminal('w-1', 1), 'w-2': terminal('w-2', 2) })
    $focusedWindowId.set('w-1')
  })

  it('take the ids window.list returns, even when two windows share a title', async () => {
    const result = await command('window.focus').run({ name: 'w-2' }, AGENT)

    expect(result.ok).toBe(true)
    expect($focusedWindowId.get()).toBe('w-2')
  })

  it('still match an app name', async () => {
    $focusedWindowId.set(null)

    expect((await command('window.focus').run({ name: 'terminal' }, AGENT)).ok).toBe(true)
    expect($focusedWindowId.get()).toBe('w-1')
  })
})

describe('app names', () => {
  it('finds Herald Calc as the calculator too', () => {
    expect(['calculator', 'the calculator', 'calculator app', 'Herald Calc', 'calc'].map(resolveAppId)).toEqual(['calc', 'calc', 'calc', 'calc', 'calc'])
  })
})
