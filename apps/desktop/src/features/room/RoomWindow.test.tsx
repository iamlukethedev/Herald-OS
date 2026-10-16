// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $prefs } from '../../store/backend.ts'
import { RoomWindow } from './RoomWindow.tsx'

vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

const flyover = vi.hoisted(() => ({ flight: 1, land: () => undefined, props: null as Record<string, unknown> | null }))

vi.mock('./scene/RoomScene.tsx', () => ({ RoomScene: () => <div data-testid="room-scene" /> }))
vi.mock('./store.ts', async () => {
  const { atom } = await import('nanostores')
  const { EMPTY_ROOM } = await import('./model/reducer.ts')

  return { $room: atom(EMPTY_ROOM), answerRoomApproval: vi.fn(), openRoomAgent: vi.fn(), useRoomFeed: () => undefined }
})
vi.mock('./bridge.ts', () => ({ roomBridge: () => null }))
vi.mock('../roadster/room-flyover.ts', () => ({ useRoomFlyover: () => ({ flight: flyover.flight, land: flyover.land }) }))
vi.mock('../roadster/RoadsterFlight.tsx', () => ({
  RoadsterFlight: (props: Record<string, unknown>) => {
    flyover.props = props

    return <div data-testid="roadster" />
  }
}))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  $prefs.set({ ...$prefs.get(), flyovers: undefined })
  flyover.props = null
})

async function show(): Promise<void> {
  await act(async () => root.render(<RoomWindow />))
  await act(async () => {
    await Promise.resolve()
  })
}

describe('the Pet Room’s flyover', () => {
  it('plays over the Room alone, and takes the press that ends it: nobody asked for it', async () => {
    await show()

    expect(host.querySelector('[data-testid="roadster"]')).not.toBeNull()
    expect(flyover.props).toMatchObject({ contained: true, claimsClick: true })
  })

  it('plays nothing with Flyover animations off', async () => {
    $prefs.set({ ...$prefs.get(), flyovers: false })
    await show()

    expect(host.querySelector('[data-testid="room-scene"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="roadster"]')).toBeNull()
  })
})
