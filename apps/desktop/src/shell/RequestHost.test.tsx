// @vitest-environment happy-dom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $petHeldApproval } from '../features/pet/transport.ts'
import { $pendingRequests, type PendingRequest } from '../store/requests.ts'
import { ApprovalCard, RequestHost } from './RequestHost.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let host: HTMLElement
let page: HTMLElement
let field: HTMLInputElement
let elsewhere: HTMLButtonElement

beforeEach(() => {
  $pendingRequests.set([])
  $petHeldApproval.set(null)
  page = document.createElement('div')
  field = document.createElement('input')
  field.type = 'text'
  elsewhere = document.createElement('button')
  elsewhere.textContent = 'Something else'
  page.append(field, elsewhere)
  host = document.createElement('div')
  document.body.append(page, host)
  root = createRoot(host)
  act(() => root.render(<RequestHost />))
})

afterEach(() => {
  act(() => root.unmount())
  page.remove()
  host.remove()
  $pendingRequests.set([])
  $petHeldApproval.set(null)
})

function approval(id = 'r1'): { entry: PendingRequest; respond: ReturnType<typeof vi.fn> } {
  const respond = vi.fn()
  const entry = {
    kind: 'approval',
    request: { id, method: 'approval', params: { command: 'rm -rf ~/Old', description: 'Delete the Old folder', choices: ['once', 'session', 'always', 'deny'] }, respond, fail: vi.fn() },
    receivedAt: 0
  } as unknown as PendingRequest

  return { entry, respond }
}

function arrive(entry: PendingRequest): void {
  act(() => $pendingRequests.set([...$pendingRequests.get(), entry]))
}

/** A key pressed by the person, with the browser's own default action: Enter or Space on a focused button clicks it. */
function press(key: 'Enter' | ' '): void {
  const target = document.activeElement ?? document.body

  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

    if (target instanceof HTMLButtonElement) {
      target.click()
    }

    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
  })
}

const card = () => host.querySelector<HTMLElement>('[role="group"]')
const choices = () => [...host.querySelectorAll('button')]

describe('RequestHost focus', () => {
  it('leaves the focus in the field being typed in when an approval arrives, so Enter and Space do not answer it', () => {
    const { entry, respond } = approval()
    field.focus()

    arrive(entry)

    expect(card()).not.toBeNull()
    expect(document.activeElement).toBe(field)
    press('Enter')
    press(' ')
    expect(respond).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(field)
  })

  it('does the same while the desktop pet walks over to take the approval, and after it does', () => {
    const { entry, respond } = approval()
    field.focus()

    // Walking: the pet holds nothing yet, so the request host shows the card.
    arrive(entry)
    expect(card()).not.toBeNull()
    expect(document.activeElement).toBe(field)
    press('Enter')
    press(' ')

    // Arrived: the pet's card takes over and this one goes.
    act(() => $petHeldApproval.set('r1'))
    expect(card()).toBeNull()
    expect(document.activeElement).toBe(field)
    press('Enter')
    expect(respond).not.toHaveBeenCalled()
  })

  it('moves the focus, with nothing being typed in, to the card itself and never to an answer', () => {
    const { entry, respond } = approval()
    elsewhere.focus()

    arrive(entry)

    expect(document.activeElement).toBe(card())
    expect(choices()).not.toContain(document.activeElement)
    press('Enter')
    press(' ')
    expect(respond).not.toHaveBeenCalled()
  })

  it('gives the focus back to where it was when the pet takes the card', () => {
    const { entry } = approval()
    elsewhere.focus()
    arrive(entry)
    expect(document.activeElement).toBe(card())

    act(() => $petHeldApproval.set('r1'))

    expect(card()).toBeNull()
    expect(document.activeElement).toBe(elsewhere)
  })

  it('gives the focus back to the field after the person answers with a click', () => {
    const { entry, respond } = approval()
    field.focus()
    arrive(entry)
    const deny = choices().find(button => button.textContent === 'Deny')!

    act(() => {
      deny.focus()
      deny.click()
    })

    expect(respond).toHaveBeenCalledWith({ choice: 'deny' })
    expect(card()).toBeNull()
    expect(document.activeElement).toBe(field)
  })

  it('leaves the focus alone when the person has put it somewhere else meanwhile', () => {
    const { entry } = approval()
    field.focus()
    arrive(entry)
    elsewhere.focus()

    act(() => $petHeldApproval.set('r1'))

    expect(document.activeElement).toBe(elsewhere)
  })

  it('does not take the focus from a field for a password request either', () => {
    field.focus()
    arrive({ kind: 'sudo', request: { id: 's1', method: 'sudo', params: { command: 'apt upgrade' }, respond: vi.fn(), fail: vi.fn() }, receivedAt: 0 } as unknown as PendingRequest)

    expect(document.activeElement).toBe(field)
  })
})

describe('ApprovalCard', () => {
  it('focuses none of its answers wherever it is drawn', () => {
    elsewhere.focus()
    act(() => root.render(<ApprovalCard id="r1" params={{ description: 'Delete the Old folder', choices: ['once', 'session', 'always', 'deny'] }} onChoice={() => undefined} />))

    expect(choices().length).toBe(4)
    expect(choices()).not.toContain(document.activeElement)
    expect(document.activeElement).toBe(elsewhere)
  })

  it('is never given autoFocus by any caller, nor focuses an answer itself', () => {
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    const callers = ['shell/RequestHost.tsx', 'features/pet/PetView.tsx', 'features/room/scene/ApprovalPopover.tsx'].map(file => fs.readFileSync(path.join(src, file), 'utf8'))

    for (const source of callers) {
      expect(source).toContain('ApprovalCard')
      expect(source).not.toMatch(/<ApprovalCard\b[^>]*autoFocus/)
    }

    expect(callers[0]).not.toMatch(/autoFocus/)
  })
})
