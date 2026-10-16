// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { roadsterCommands } from '../commands/roadster.ts'
import { $roadsterFlight } from '../features/roadster/flight.ts'
import { defineCommands, resetCommands } from '../store/os-commands.ts'
import { CommandPalette } from './CommandBar.tsx'

vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

const chat = vi.hoisted(() => ({ sendPrompt: vi.fn(async () => undefined), runSlash: vi.fn(async () => undefined), openStoredSession: vi.fn(async () => undefined) }))
const shell = vi.hoisted(() => ({ relayToMain: vi.fn(), openSurface: vi.fn() }))

vi.mock('../store/chat.ts', () => chat)
vi.mock('../store/shell.ts', () => shell)
vi.mock('../store/native-apps.ts', () => ({ useNativeApps: () => ({ apps: [], iconFor: () => null }) }))
vi.mock('../features/chat/use-slash-catalog.ts', () => ({ useSlashCatalog: () => [] }))
vi.mock('../store/windows.ts', () => ({ openApp: vi.fn(), showPage: vi.fn() }))

let host: HTMLDivElement
let root: Root

function input(): HTMLInputElement {
  return host.querySelector<HTMLInputElement>('input')!
}

async function type(text: string): Promise<void> {
  const field = input()
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const items = (): string[] => [...host.querySelectorAll('[cmdk-item]')].map(item => item.getAttribute('data-value') ?? '')
const selected = (): string | null => host.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute('data-value') ?? null

async function enter(): Promise<void> {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
}

async function open(onClose = vi.fn(), standalone = false): Promise<void> {
  await act(async () => root.render(<CommandPalette onClose={onClose} standalone={standalone} />))
}

beforeEach(() => {
  defineCommands(roadsterCommands)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  resetCommands()
  $roadsterFlight.set(0)
  vi.clearAllMocks()
})

describe('the command bar’s roadster easter egg', () => {
  it.each(['fly', 'roadster', 'FLY', ' Roadster '])('offers the flight first for "%s", so Enter takes off rather than asking Hermes', async word => {
    const onClose = vi.fn()
    await open(onClose)
    await type(word)

    expect(items()[0]).toBe('fun:roadster')
    expect(selected()).toBe('fun:roadster')
    expect(items().filter(value => value.includes('roadster.fly'))).toEqual([])

    await enter()

    expect(onClose).toHaveBeenCalled()
    expect($roadsterFlight.get()).toBeGreaterThan(0)
    expect(chat.sendPrompt).not.toHaveBeenCalled()
  })

  it.each(['flying', 'fly to Lisbon', 'roadsters', '/fly'])('stays out of the way for "%s"', async text => {
    await open()
    await type(text)

    expect(items()).not.toContain('fun:roadster')
  })

  it('in its own window, hands the flight to the Hermes window', async () => {
    await open(vi.fn(), true)
    await type('fly')
    await enter()

    expect(shell.relayToMain).toHaveBeenCalledWith({ type: 'os', args: ['roadster.fly'], payload: {} })
    expect($roadsterFlight.get()).toBe(0)
  })
})
