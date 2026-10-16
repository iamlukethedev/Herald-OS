// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $prefs } from '../../../store/backend.ts'
import { $notifications, $toasts } from '../../../store/notifications.ts'
import { FlyoverRow } from './FlyoverRow.tsx'

vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

const backend = vi.hoisted(() => ({ updatePrefs: vi.fn(async (_patch: unknown) => undefined) }))

vi.mock('../../../store/backend.ts', async original => ({ ...(await original<typeof import('../../../store/backend.ts')>()), updatePrefs: backend.updatePrefs }))

let host: HTMLDivElement
let root: Root

const toggle = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('[role="switch"]')!

async function show(): Promise<void> {
  await act(async () => root.render(<FlyoverRow />))
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  $prefs.set({ ...$prefs.get(), flyovers: undefined })
  $toasts.set([])
  $notifications.set([])
  vi.clearAllMocks()
})

describe('Settings > Appearance > Flyover animations', () => {
  it('is on by default, under its translated name and what it does', async () => {
    await show()

    expect(toggle().getAttribute('aria-label')).toBe('Flyover animations')
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(host.textContent).toContain('Flyover animations')
    expect(host.textContent).toContain('Pet Room')
    expect(host.textContent).toContain('screensaver')
  })

  it('shows what is saved, and saves the switch when flipped', async () => {
    $prefs.set({ ...$prefs.get(), flyovers: false })
    await show()

    expect(toggle().getAttribute('aria-checked')).toBe('false')

    await act(async () => toggle().click())
    expect(backend.updatePrefs).toHaveBeenCalledWith({ flyovers: true })

    act(() => $prefs.set({ ...$prefs.get(), flyovers: true }))
    await act(async () => toggle().click())
    expect(backend.updatePrefs).toHaveBeenLastCalledWith({ flyovers: false })
  })

  it('says so when the setting could not be saved', async () => {
    backend.updatePrefs.mockRejectedValueOnce(new Error('disk full'))
    await show()

    await act(async () => toggle().click())

    expect($notifications.get()[0]).toMatchObject({ title: 'Could not change flyover animations', body: 'disk full', level: 'error' })
  })
})
