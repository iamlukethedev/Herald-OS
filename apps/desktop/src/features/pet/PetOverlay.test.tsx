// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PET_IDLE_SNAPSHOT, PET_OFF, type PetHideReason } from '../../../shared/pet.ts'
import { RequestHost } from '../../shell/RequestHost.tsx'
import { $prefs } from '../../store/backend.ts'
import { $pendingRequests, type PendingRequest } from '../../store/requests.ts'
import { approvalOf } from '../petdex/activity.ts'
import { $petPrefs } from './actions.ts'
import { $petInfo, $petSheet } from './info.ts'
import { PetOverlay } from './PetOverlay.tsx'
import type { LoadedSheet } from './sheet.ts'
import { $petHeldApproval, $petSnapshot } from './transport.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/*
 * The desktop pet as Desktop.tsx draws it, beside the request host. While the pet holds an approval
 * the host leaves the approvals queued behind it to the pet; when the pet goes away, its cleanup must
 * hand them all back.
 */

const SHEET: LoadedSheet = { url: 'blob:pet', width: 1536, height: 1872, layout: { columns: 8, rows: 9, rowNames: [], frames: [] } }

let root: Root
let host: HTMLElement

function approval(id: string, description: string): PendingRequest {
  return { kind: 'approval', request: { id, method: 'approval', params: { description, choices: ['once', 'deny'] }, respond: vi.fn(), fail: vi.fn() }, receivedAt: 0 } as unknown as PendingRequest
}

/** The snapshot the pet's brain publishes for what is pending, with a reason to step away if any. */
function publish(hiddenBy: PetHideReason | null = null): void {
  const { approval: held, waiting } = approvalOf($pendingRequests.get(), { active: false, sessionId: null })
  act(() => $petSnapshot.set({ ...PET_IDLE_SNAPSHOT, activity: 'waiting', approval: held, approvalsWaiting: waiting, hiddenBy }))
}

function setHidden(hidden: boolean): void {
  act(() => $prefs.set({ ...$prefs.get(), pet: { ...$petPrefs.get(), hidden } }))
}

const pet = () => host.querySelector(`[aria-label^="Hermes's pet"]`)
const cards = () => [...host.querySelectorAll('[data-request-card]')].map(card => card.getAttribute('data-request-card'))

beforeEach(() => {
  $petInfo.set({ ...PET_OFF, enabled: true, slug: 'boba', displayName: 'Boba' })
  $petSheet.set(SHEET)
  setHidden(false)
  $pendingRequests.set([approval('r1', 'Delete the Old folder'), approval('r2', 'Move Budget.xlsx'), approval('r3', 'Rename Notes')])
  publish()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <>
        <RequestHost />
        <PetOverlay />
      </>
    )
  )
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  $pendingRequests.set([])
  $petSnapshot.set(PET_IDLE_SNAPSHOT)
  $petInfo.set(PET_OFF)
  $petSheet.set(null)
  $petHeldApproval.set(null)
  setHidden(false)
})

describe('the desktop pet going away with approvals queued', () => {
  it('holds the oldest and the queue while it is shown', () => {
    expect(pet()).not.toBeNull()
    expect($petHeldApproval.get()).toBe('r1')
    expect(cards()).toEqual(['r1'])
    expect(host.textContent).toContain('2 more approvals waiting')
  })

  it('hands every approval back to the request host when it is hidden', () => {
    setHidden(true)

    expect($petHeldApproval.get()).toBeNull()
    expect(cards()).toEqual(['r1'])
    expect(pet()).toBeNull()
    expect(host.textContent).toContain('2 more requests waiting')
    expect(host.textContent).not.toContain('approvals waiting')
  })

  it.each(['doNotDisturb', 'fullscreen', 'presenting'] as const)('hands them back when it steps away for %s', reason => {
    publish(reason)

    expect($petHeldApproval.get()).toBeNull()
    expect(cards()).toEqual(['r1'])
    expect(host.textContent).toContain('2 more requests waiting')
  })

  it('takes them again when it comes back', () => {
    setHidden(true)
    setHidden(false)

    expect($petHeldApproval.get()).toBe('r1')
    expect(host.textContent).toContain('2 more approvals waiting')
  })

  it('lets go of the card while it walks, still on screen, and the host shows it once for one answer', () => {
    vi.useFakeTimers()

    try {
      const [first, second] = $pendingRequests.get().map(entry => entry.request.respond as ReturnType<typeof vi.fn>)

      // The Dock stops hiding: the approval corner moves up, and the pet walks there.
      act(() => $prefs.set({ ...$prefs.get(), dockAutoHide: false }))

      expect(pet()).not.toBeNull()
      expect($petHeldApproval.get()).toBeNull()
      expect(cards()).toEqual(['r1'])
      expect(host.textContent).toContain('2 more requests waiting')
      expect(host.textContent).not.toContain('approvals waiting')

      const deny = [...host.querySelectorAll<HTMLButtonElement>('[data-request-card="r1"] button')].find(button => button.textContent === 'Deny')!
      act(() => deny.click())
      publish()
      act(() => vi.advanceTimersByTime(5000))

      expect(first).toHaveBeenCalledTimes(1)
      expect(first).toHaveBeenCalledWith({ choice: 'deny' })
      expect(second).not.toHaveBeenCalled()
      expect($petHeldApproval.get()).toBe('r2')
      expect(cards()).toEqual(['r2'])
      expect(host.textContent).toContain('1 more approval waiting')
    } finally {
      vi.useRealTimers()
      act(() => $prefs.set({ ...$prefs.get(), dockAutoHide: undefined }))
    }
  })
})
