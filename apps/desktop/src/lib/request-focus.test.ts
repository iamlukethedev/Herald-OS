// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { focusRequestCard, takeRequestFocus } from './request-focus.ts'

let field: HTMLInputElement
let other: HTMLButtonElement
let card: HTMLDivElement
let answer: HTMLButtonElement

beforeEach(() => {
  field = Object.assign(document.createElement('input'), { type: 'text' })
  other = document.createElement('button')
  card = document.createElement('div')
  card.tabIndex = -1
  card.setAttribute('data-request-card', '')
  answer = document.createElement('button')
  answer.textContent = 'Allow once'
  card.append(answer)
  document.body.append(field, other, card)
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('takeRequestFocus', () => {
  it('leaves the focus in a field being typed in, and has nothing to give back', () => {
    field.focus()

    const release = takeRequestFocus(card)
    expect(document.activeElement).toBe(field)

    release()
    expect(document.activeElement).toBe(field)
  })

  it('takes the focus onto the card itself, never an answer, when nothing is being typed in', () => {
    other.focus()

    takeRequestFocus(card)

    expect(document.activeElement).toBe(card)
    expect(document.activeElement).not.toBe(answer)
  })

  it('takes nothing when asked not to', () => {
    other.focus()

    takeRequestFocus(card, { take: false })

    expect(document.activeElement).toBe(other)
  })

  it('gives the focus back to where it was when the card goes', () => {
    other.focus()
    const release = takeRequestFocus(card)

    release()

    expect(document.activeElement).toBe(other)
  })

  it('gives it back from an answer the person moved to', () => {
    field.focus()
    const release = takeRequestFocus(card)
    answer.focus()

    release()

    expect(document.activeElement).toBe(field)
  })

  it('leaves the focus where the person has since put it', () => {
    other.focus()
    const release = takeRequestFocus(card)
    expect(document.activeElement).toBe(card)
    field.focus()

    release()

    expect(document.activeElement).toBe(field)
  })

  it('gives the focus back to where the person last came into the card from', () => {
    field.focus()
    const release = takeRequestFocus(card)
    other.focus()
    card.focus()

    release()

    expect(document.activeElement).toBe(other)
  })

  it('gives nothing back to an element that has left the page', () => {
    other.focus()
    const release = takeRequestFocus(card)
    other.remove()

    expect(() => release()).not.toThrow()
    expect(document.activeElement).toBe(card)
  })
})

describe('focusRequestCard', () => {
  it('moves the focus from a field to the card itself, not an answer', () => {
    field.focus()

    expect(focusRequestCard()).toBe(true)
    expect(document.activeElement).toBe(card)
  })

  it('says so when no card is shown', () => {
    card.remove()
    field.focus()

    expect(focusRequestCard()).toBe(false)
    expect(document.activeElement).toBe(field)
  })
})
