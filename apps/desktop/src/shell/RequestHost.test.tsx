// @vitest-environment happy-dom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestCommands, resetRequestFocus } from '../commands/requests.ts'
import { PetApprovalCard } from '../features/pet/PetView.tsx'
import { $petHeldApproval } from '../features/pet/transport.ts'
import { $prefs } from '../store/backend.ts'
import { $pendingRequests, type PendingRequest } from '../store/requests.ts'
import { ApprovalCard, RequestHost } from './RequestHost.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let host: HTMLElement
let page: HTMLElement
let field: HTMLInputElement
let elsewhere: HTMLButtonElement

beforeEach(() => {
  resetRequestFocus()
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

const card = () => host.querySelector<HTMLElement>('[data-request-card]')
const spoken = () => host.querySelector('[role="status"]')
const choices = () => [...host.querySelectorAll('button')]
const focusRequest = () => requestCommands.find(command => command.id === 'requests.focus')!

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

describe('RequestHost cards', () => {
  it('gives each new request a card of its own, which takes and gives back the focus for itself', () => {
    elsewhere.focus()
    arrive(approval('r1').entry)
    const first = card()
    expect(document.activeElement).toBe(first)

    act(() => $pendingRequests.set([approval('r2').entry]))

    const second = card()
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    expect(document.activeElement).toBe(second)

    act(() => $pendingRequests.set([]))
    expect(document.activeElement).toBe(elsewhere)
  })

  it('names the request shortcut on the card', () => {
    arrive(approval().entry)

    expect(card()?.getAttribute('aria-keyshortcuts')).toBe('Meta+Alt+A')
    expect(card()?.getAttribute('aria-label')).toBe('Hermes is asking for permission')
  })
})

describe('RequestHost announcements', () => {
  it('says what a request asks as it arrives, politely, while the focus stays in the field', () => {
    field.focus()

    arrive(approval().entry)

    expect(spoken()?.getAttribute('aria-live')).toBe('polite')
    expect(spoken()?.textContent).toBe('Hermes is asking for permission: Delete the Old folder. Press Cmd+Option+A to go to it.')
    expect(document.activeElement).toBe(field)
  })

  it('announces a request once, not again as the host renders', () => {
    const { entry } = approval()
    arrive(entry)
    const said = spoken()?.firstElementChild

    act(() => $pendingRequests.set([...$pendingRequests.get()]))
    act(() => $petHeldApproval.set('r1'))
    act(() => $petHeldApproval.set(null))

    expect(spoken()?.firstElementChild).toBe(said)
  })

  it('announces the next request, even in the same words', () => {
    arrive(approval('r1').entry)
    const first = spoken()?.firstElementChild

    act(() => $pendingRequests.set([approval('r2').entry]))

    expect(spoken()?.firstElementChild).not.toBe(first)
    expect(spoken()?.textContent).toContain('Delete the Old folder')
  })

  it('announces an approval the pet takes straight away, and says how many more wait', () => {
    act(() => $petHeldApproval.set('r1'))

    act(() => $pendingRequests.set([approval('r1').entry, approval('r2').entry]))

    expect(spoken()?.textContent).toContain('1 more is waiting.')
  })
})

describe('the request shortcut', () => {
  const focusRequest = requestCommands.find(command => command.id === 'requests.focus')!

  it('moves the focus from the field to the card itself, and the card gives it back when answered', async () => {
    const { entry, respond } = approval()
    field.focus()
    arrive(entry)

    const result = await focusRequest.run({}, { source: 'shortcut' })

    expect(result.ok).toBe(true)
    expect(document.activeElement).toBe(card())
    press('Enter')
    press(' ')
    expect(respond).not.toHaveBeenCalled()

    const deny = choices().find(button => button.textContent === 'Deny')!
    act(() => {
      deny.focus()
      deny.click()
    })
    expect(respond).toHaveBeenCalledWith({ choice: 'deny' })
    expect(document.activeElement).toBe(field)
  })

  it('never lets Hermes or a plugin move the focus', async () => {
    field.focus()
    arrive(approval().entry)

    expect((await focusRequest.run({}, { source: 'agent' })).ok).toBe(false)
    expect((await focusRequest.run({}, { source: 'plugin' })).ok).toBe(false)
    expect(document.activeElement).toBe(field)
  })

  it('says so when nothing is waiting', async () => {
    field.focus()

    expect((await focusRequest.run({}, { source: 'shortcut' })).ok).toBe(false)
    expect(document.activeElement).toBe(field)
  })

  it('is checked before All applications in both window key handlers, which would take Super+Shift+A', () => {
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

    for (const file of ['shell/App.tsx', 'shell/surfaces/MainSurface.tsx']) {
      const source = fs.readFileSync(path.join(src, file), 'utf8')
      const shortcut = source.indexOf('isRequestShortcut(event)')

      expect(shortcut, file).toBeGreaterThan(-1)
      expect(shortcut, file).toBeLessThan(source.indexOf("event.shiftKey && key === 'a'"))
      expect(source, file).toContain("runCommand('requests.focus', {}, { source: 'shortcut' })")
    }
  })
})

function asking(id: string, description: string): { entry: PendingRequest; respond: ReturnType<typeof vi.fn> } {
  const respond = vi.fn()
  const entry = { kind: 'approval', request: { id, method: 'approval', params: { description, choices: ['once', 'session', 'always', 'deny'] }, respond, fail: vi.fn() }, receivedAt: 0 } as unknown as PendingRequest

  return { entry, respond }
}

/** The answers a Tab from the card reaches, in order. */
const tabStops = (from: HTMLElement) => [...from.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex]')].filter(element => element.tabIndex >= 0 && !element.hasAttribute('disabled'))

describe('a request arriving while another waits', () => {
  it('counts everything waiting and names the card the shortcut reaches, the oldest', async () => {
    field.focus()
    arrive(asking('r1', 'Delete the Old folder').entry)

    arrive(asking('r2', 'Move Budget.xlsx').entry)

    expect(spoken()?.textContent).toBe('Hermes is asking for permission: Move Budget.xlsx. 2 requests are waiting. Press Cmd+Option+A to go to the first one: Delete the Old folder.')

    expect((await focusRequest().run({}, { source: 'shortcut' })).ok).toBe(true)
    expect(document.activeElement).toBe(card())
    expect(card()?.getAttribute('data-request-card')).toBe('r1')
  })

  it('counts every other request waiting when the arrival is the first', () => {
    act(() => $pendingRequests.set([asking('r1', 'Delete the Old folder').entry, asking('r2', 'Move Budget.xlsx').entry, asking('r3', 'Rename Notes').entry]))

    expect(spoken()?.textContent).toBe('Hermes is asking for permission: Delete the Old folder. 2 more are waiting. Press Cmd+Option+A to go to it.')
  })

  it("reaches the pet's card when the pet holds the oldest, though the request host shows the next one first on the page", async () => {
    const petHost = document.createElement('div')
    document.body.append(petHost)
    const petRoot = createRoot(petHost)
    const question = { kind: 'clarify', request: { id: 'c2', method: 'clarify', params: { question: 'Which folder?' }, respond: vi.fn(), fail: vi.fn() }, receivedAt: 0 } as unknown as PendingRequest

    try {
      act(() => $petHeldApproval.set('r1'))
      act(() => $pendingRequests.set([asking('r1', 'Delete the Old folder').entry, question]))
      act(() => petRoot.render(<PetApprovalCard approval={{ id: 'r1', params: { description: 'Delete the Old folder' }, voice: false }} waiting={0} />))
      field.focus()

      expect(card()?.getAttribute('data-request-card')).toBe('c2')
      expect((await focusRequest().run({}, { source: 'shortcut' })).ok).toBe(true)
      expect((document.activeElement as HTMLElement).getAttribute('data-request-card')).toBe('r1')
    } finally {
      act(() => petRoot.unmount())
      petHost.remove()
    }
  })

  it('leaves the approvals queued behind the one the pet holds to the pet', () => {
    act(() => $petHeldApproval.set('r1'))

    act(() => $pendingRequests.set([asking('r1', 'Delete the Old folder').entry, asking('r2', 'Move Budget.xlsx').entry]))

    expect(card()).toBeNull()
  })
})

describe('the order of the answers', () => {
  it('puts Deny first after the card, so Tab and Enter from the card deny', async () => {
    const { entry, respond } = asking('r1', 'Delete the Old folder')
    field.focus()
    arrive(entry)
    expect((await focusRequest().run({}, { source: 'cli' })).ok).toBe(false)
    expect(document.activeElement).toBe(field)
    await focusRequest().run({}, { source: 'shortcut' })
    expect(document.activeElement).toBe(card())

    const [first] = tabStops(card()!)
    expect(first.textContent).toBe('Deny')
    act(() => first.focus())
    press('Enter')

    expect(respond).toHaveBeenCalledWith({ choice: 'deny' })
  })

  it('draws Deny first wherever the card is drawn, and keeps Allow once the primary answer', () => {
    act(() => root.render(<ApprovalCard id="r1" params={{ choices: ['once', 'session', 'always', 'deny'] }} onChoice={() => undefined} />))

    expect(choices().map(button => button.textContent)).toEqual(['Deny', 'Allow once', 'Allow this session', 'Always allow'])
    expect(tabStops(host)[0].textContent).toBe('Deny')
  })

  it('keeps Allow once the one primary answer while Deny stays first in the tab order', () => {
    act(() => root.render(<ApprovalCard id="r1" params={{ choices: ['once', 'session', 'always', 'deny'] }} onChoice={() => undefined} />))

    const [first, ...after] = tabStops(host)
    const allowOnce = after.find(button => button.textContent === 'Allow once')!

    expect(first.textContent).toBe('Deny')
    expect(first.classList).toContain('text-danger')
    expect(first.classList).not.toContain('bg-accent')
    expect(allowOnce.classList).toContain('bg-accent')
    expect(choices().filter(button => button.classList.contains('bg-accent'))).toEqual([allowOnce])
  })
})

describe('password and secret cards', () => {
  function asked(kind: 'sudo' | 'secret'): { entry: PendingRequest; respond: ReturnType<typeof vi.fn> } {
    const respond = vi.fn()
    const params = kind === 'sudo' ? { command: 'apt upgrade' } : { env_var: 'OPENAI_API_KEY', prompt: 'Your OpenAI key' }

    return { entry: { kind, request: { id: `${kind}-1`, method: kind, params, respond, fail: vi.fn() }, receivedAt: 0 } as unknown as PendingRequest, respond }
  }

  /** Type into the field as a person does, so React sees the change. */
  function type(input: HTMLInputElement, text: string): void {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const continueAnswer = () => choices().find(button => button.textContent === 'Continue')!

  it.each(['sudo', 'secret'] as const)('%s: Tab then Return from the card sends nothing while the field is empty', async kind => {
    const { entry, respond } = asked(kind)
    field.focus()
    arrive(entry)
    await focusRequest().run({}, { source: 'shortcut' })

    const [first] = tabStops(card()!)
    expect(first).toBeInstanceOf(HTMLInputElement)
    act(() => first.focus())
    press('Enter')

    expect(respond).not.toHaveBeenCalled()
    expect(choices().find(button => button.textContent === 'Continue')?.disabled).toBe(true)
    expect(tabStops(card()!).map(element => element.textContent)).not.toContain('Continue')
  })

  it.each(['sudo', 'secret'] as const)('%s: sends what was typed on Return', kind => {
    const { entry, respond } = asked(kind)
    arrive(entry)
    const input = card()!.querySelector('input')!

    type(input, 'hunter2')
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

    expect(respond).toHaveBeenCalledWith({ value: 'hunter2' })
  })

  it.each(['sudo', 'secret'] as const)('%s: Continue sends the typed value once it is filled', kind => {
    const { entry, respond } = asked(kind)
    arrive(entry)
    type(card()!.querySelector('input')!, 'hunter2')
    const continueButton = choices().find(button => button.textContent === 'Continue')!

    expect(continueButton.disabled).toBe(false)
    act(() => continueButton.click())

    expect(respond).toHaveBeenCalledWith({ value: 'hunter2' })
  })

  it.each(['sudo', 'secret'] as const)('%s: Cancel still sends an empty value on purpose', kind => {
    const { entry, respond } = asked(kind)
    arrive(entry)

    act(() => choices().find(button => button.textContent === 'Cancel')!.click())

    expect(respond).toHaveBeenCalledWith({ value: '' })
  })

  it.each(['sudo', 'secret'] as const)('%s: Cancel sends an empty value even after something was typed, never what was typed', kind => {
    const { entry, respond } = asked(kind)
    arrive(entry)
    type(card()!.querySelector('input')!, 'hunter2')

    act(() => choices().find(button => button.textContent === 'Cancel')!.click())

    expect(respond).toHaveBeenCalledTimes(1)
    expect(respond.mock.calls[0]).toStrictEqual([{ value: '' }])
  })

  it.each(['sudo', 'secret'] as const)('%s: counts as empty, so neither Return nor Continue sends it', kind => {
    const { entry, respond } = asked(kind)
    arrive(entry)
    const input = card()!.querySelector('input')!

    for (const blank of [' ', '   ', '\t', ' \t ']) {
      type(input, blank)
      act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

      expect(continueAnswer().disabled, JSON.stringify(blank)).toBe(true)
    }

    act(() => continueAnswer().click())
    expect(respond).not.toHaveBeenCalled()
  })

  it.each(['sudo', 'secret'] as const)('%s: a value with spaces around it is sent exactly as typed, not trimmed', kind => {
    const { entry, respond } = asked(kind)
    arrive(entry)
    const input = card()!.querySelector('input')!

    type(input, '  pass word ')
    expect(continueAnswer().disabled).toBe(false)
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

    expect(respond).toHaveBeenCalledTimes(1)
    expect(respond.mock.calls[0]).toStrictEqual([{ value: '  pass word ' }])
  })

  it.each(['sudo', 'secret'] as const)('%s: Continue sends a value with spaces around it as typed too', kind => {
    const { entry, respond } = asked(kind)
    arrive(entry)
    type(card()!.querySelector('input')!, ' secret ')

    act(() => continueAnswer().click())

    expect(respond.mock.calls[0]).toStrictEqual([{ value: ' secret ' }])
  })
})

describe('the count of requests behind the card', () => {
  const waitingLabel = () => [...host.querySelectorAll('div')].find(element => element.className.includes('self-end'))?.textContent ?? null

  it.each([
    ['en', 2, '1 more request waiting'],
    ['en', 4, '3 more requests waiting'],
    ['pt-BR', 2, 'Mais 1 pedido aguardando'],
    ['pt-BR', 4, 'Mais 3 pedidos aguardando'],
    ['zh-CN', 2, '还有 1 个请求在等待'],
    ['zh-CN', 4, '还有 3 个请求在等待']
  ] as const)('in %s, with %i requests waiting, reads "%s"', (language, total, text) => {
    act(() => $prefs.set({ ...$prefs.get(), language }))

    try {
      act(() => $pendingRequests.set(Array.from({ length: total }, (_, index) => asking(`r${index + 1}`, `Request ${index + 1}`).entry)))

      expect(waitingLabel()).toBe(text)
    } finally {
      act(() => $prefs.set({ ...$prefs.get(), language: 'en' }))
    }
  })

  it('shows no count for a request alone', () => {
    arrive(asking('r1', 'Request 1').entry)

    expect(waitingLabel()).toBeNull()
  })
})
