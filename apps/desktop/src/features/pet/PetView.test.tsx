// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { focusRequestCard } from '../../lib/request-focus.ts'
import { PetApprovalCard } from './PetView.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let host: HTMLElement
let field: HTMLInputElement
let elsewhere: HTMLButtonElement

const approval = { id: 'r1', params: { description: 'Delete the Old folder', choices: ['once', 'deny'] }, voice: false }
const card = () => host.querySelector<HTMLElement>('[data-request-card]')

beforeEach(() => {
  field = Object.assign(document.createElement('input'), { type: 'text' })
  elsewhere = document.createElement('button')
  host = document.createElement('div')
  document.body.append(field, elsewhere, host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

describe("the approval card in the pet's hands", () => {
  it('takes no focus as it appears, even with nothing being typed in', () => {
    elsewhere.focus()

    act(() => root.render(<PetApprovalCard approval={approval} waiting={0} />))

    expect(card()).not.toBeNull()
    expect(document.activeElement).toBe(elsewhere)
  })

  it('is where the request shortcut goes, and gives the focus back when it goes', () => {
    field.focus()
    act(() => root.render(<PetApprovalCard approval={approval} waiting={0} />))

    expect(focusRequestCard()).toBe(true)
    expect(document.activeElement).toBe(card())
    expect(card()?.getAttribute('aria-keyshortcuts')).toBe('Meta+Alt+A')

    act(() => root.render(<></>))
    expect(document.activeElement).toBe(field)
  })

  it('puts Deny first after the card, so Tab and Enter from it deny', () => {
    act(() => root.render(<PetApprovalCard approval={{ ...approval, params: { ...approval.params, choices: ['once', 'session', 'always', 'deny'] } }} waiting={0} />))

    const stops = [...card()!.querySelectorAll<HTMLElement>('button, input, [tabindex]')].filter(element => element.tabIndex >= 0)
    expect(stops[0].textContent).toBe('Deny')
  })
})
