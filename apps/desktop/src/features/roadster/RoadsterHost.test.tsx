// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $roadsterFlight, launchRoadster } from './flight.ts'
import { RoadsterHost } from './RoadsterHost.tsx'

vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

const loaded = vi.hoisted(() => ({ count: 0 }))

vi.mock('./RoadsterFlight.tsx', () => {
  loaded.count += 1

  return { RoadsterFlight: ({ onDone }: { onDone: () => void }) => <button type="button" data-testid="flight" onClick={onDone} /> }
})

let host: HTMLDivElement
let root: Root

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  $roadsterFlight.set(0)
})

describe('the roadster host', () => {
  it('mounts nothing, and loads nothing, until a flight starts', async () => {
    await act(async () => root.render(<RoadsterHost />))

    expect(host.innerHTML).toBe('')
    expect(loaded.count).toBe(0)
  })

  it('shows the flight once loaded and leaves nothing behind when it ends', async () => {
    await act(async () => root.render(<RoadsterHost />))
    act(() => {
      launchRoadster()
    })
    await settle()

    const flight = host.querySelector<HTMLElement>('[data-testid="flight"]')
    expect(flight).not.toBeNull()
    expect(loaded.count).toBe(1)

    act(() => flight!.click())

    expect($roadsterFlight.get()).toBe(0)
    expect(host.innerHTML).toBe('')
  })
})
