// @vitest-environment happy-dom
import { useStore } from '@nanostores/react'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PET_IDLE_SNAPSHOT, type PetSnapshot } from '../../shared/pet.ts'
import { requestCommands, resetRequestFocus } from '../commands/requests.ts'
import { heldApprovalOf, type PetUi } from '../features/pet/hooks.ts'
import { PetView } from '../features/pet/PetView.tsx'
import type { LoadedSheet } from '../features/pet/sheet.ts'
import { $petHeldApproval, handlePetActions } from '../features/pet/transport.ts'
import { approvalOf } from '../features/petdex/activity.ts'
import { $pendingRequests, type PendingRequest, resolveRequest } from '../store/requests.ts'
import { RequestHost } from './RequestHost.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/*
 * Desktop mode as Desktop.tsx draws it: the request host and the pet in one page, the pet's snapshot
 * worked out from the pending requests as the pet's brain does, and its answers resolved as the brain
 * resolves them.
 */

const SHEET: LoadedSheet = { url: 'blob:pet', width: 1536, height: 1872, layout: { columns: 8, rows: 9, rowNames: [], frames: [] } }
const UI: PetUi = { bubble: false, setBubble: () => undefined, drop: null, setDrop: () => undefined, say: null, hush: () => undefined }

function DesktopPet() {
  const pending = useStore($pendingRequests)
  const { approval, waiting } = approvalOf(pending, { active: false, sessionId: null })
  const snapshot: PetSnapshot = { ...PET_IDLE_SNAPSHOT, activity: approval ? 'waiting' : 'idle', approval, approvalsWaiting: waiting }
  const extras = approval ? 'card' : null
  const held = heldApprovalOf(snapshot, extras)

  useEffect(() => $petHeldApproval.set(held), [held])

  return <PetView sheet={SHEET} scale={0.5} snapshot={snapshot} ui={UI} extras={extras} layout={{ above: true, align: 'end' }} pose="waiting" poseSince={0} rest reduced paused dropping={false} onDropping={() => undefined} spriteProps={{}} />
}

let root: Root
let host: HTMLElement
let field: HTMLInputElement
let offActions: () => void

function approval(id: string, description: string): { entry: PendingRequest; respond: ReturnType<typeof vi.fn> } {
  const respond = vi.fn()
  const entry = { kind: 'approval', request: { id, method: 'approval', params: { description, choices: ['once', 'session', 'always', 'deny'] }, respond, fail: vi.fn() }, receivedAt: 0 } as unknown as PendingRequest

  return { entry, respond }
}

/** A key pressed by the person, with the browser's own default action: Enter on a focused button clicks it. */
function press(key: 'Enter' | ' ' = 'Enter'): void {
  const target = document.activeElement ?? document.body

  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

    if (target instanceof HTMLButtonElement) {
      target.click()
    }

    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
  })
}

/** Tab from the focused card to its first answer, as the browser would. */
function tabIntoCard(): HTMLButtonElement {
  const card = document.activeElement as HTMLElement
  const first = [...card.querySelectorAll<HTMLButtonElement>('button')].find(button => button.tabIndex >= 0)!
  act(() => first.focus())

  return first
}

const answersOnScreen = () => [...document.querySelectorAll('[data-request-card] button')]
const focusRequest = () => requestCommands.find(command => command.id === 'requests.focus')!.run({}, { source: 'shortcut' })

beforeEach(() => {
  resetRequestFocus()
  $pendingRequests.set([])
  $petHeldApproval.set(null)
  offActions = handlePetActions(action => {
    if (action.type === 'answer') {
      resolveRequest(String(action.id), { choice: action.choice })
    }
  })
  field = Object.assign(document.createElement('input'), { type: 'text' })
  host = document.createElement('div')
  document.body.append(field, host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  offActions()
  document.body.replaceChildren()
  $pendingRequests.set([])
  $petHeldApproval.set(null)
})

describe('two queued requests', () => {
  it("with the pet: after the first is answered from the keyboard, a second Enter does not answer the second", async () => {
    const first = approval('r1', 'Delete the Old folder')
    const second = approval('r2', 'Move Budget.xlsx')
    act(() =>
      root.render(
        <>
          <RequestHost />
          <DesktopPet />
        </>
      )
    )
    act(() => $pendingRequests.set([first.entry, second.entry]))
    field.focus()

    await act(async () => void (await focusRequest()))
    expect((document.activeElement as HTMLElement).getAttribute('data-request-card')).toBe('r1')
    expect(tabIntoCard().textContent).toBe('Deny')
    press()
    expect(first.respond).toHaveBeenCalledWith({ choice: 'deny' })

    expect(document.querySelector('[data-request-card]')?.getAttribute('data-request-card')).toBe('r2')
    expect(answersOnScreen()).not.toContain(document.activeElement)
    expect(document.activeElement).toBe(field)
    press()
    press(' ')
    expect(second.respond).not.toHaveBeenCalled()
  })

  it('without the pet: after the first is answered from the keyboard, a second Enter does not answer the second', async () => {
    const first = approval('r1', 'Delete the Old folder')
    const second = approval('r2', 'Move Budget.xlsx')
    act(() => root.render(<RequestHost />))
    act(() => $pendingRequests.set([first.entry, second.entry]))
    field.focus()

    await act(async () => void (await focusRequest()))
    tabIntoCard()
    press()
    expect(first.respond).toHaveBeenCalledWith({ choice: 'deny' })

    expect(document.querySelector('[data-request-card]')?.getAttribute('data-request-card')).toBe('r2')
    expect(answersOnScreen()).not.toContain(document.activeElement)
    expect(document.activeElement).toBe(field)
    press()
    expect(second.respond).not.toHaveBeenCalled()
  })

  it('with the pet: only the pet draws and counts the approvals queued behind the one it holds', () => {
    act(() =>
      root.render(
        <>
          <RequestHost />
          <DesktopPet />
        </>
      )
    )

    act(() => $pendingRequests.set([approval('r1', 'Delete the Old folder').entry, approval('r2', 'Move Budget.xlsx').entry, approval('r3', 'Rename Notes').entry]))

    expect([...document.querySelectorAll('[data-request-card]')].map(card => card.getAttribute('data-request-card'))).toEqual(['r1'])
    expect(document.body.textContent).toContain('2 more approvals waiting')
    expect(document.body.textContent).not.toMatch(/\d more waiting/)
  })
})
