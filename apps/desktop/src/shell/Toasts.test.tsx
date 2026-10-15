// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { $notifications, $toasts, notify } from '../store/notifications.ts'
import { Toasts } from './Toasts.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let container: HTMLElement

beforeEach(() => {
  $toasts.set([])
  $notifications.set([])
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Toasts', () => {
  it('wraps a long body in full but caps its height and scrolls it, so the toasts under it stay on screen', async () => {
    const long = `${'A reason Hermes gave that runs on for a while. '.repeat(60)}End of reason.`

    act(() => {
      notify({ title: 'Older toast', body: 'Short body.', level: 'info' })
      notify({ title: 'Could not change memory provider', body: long, level: 'error' })
    })
    await act(async () => root.render(<Toasts />))

    const bodies = [...container.querySelectorAll('.text-fg-2')].filter(node => node.textContent === long || node.textContent === 'Short body.')

    expect(bodies.map(body => body.textContent)).toEqual([long, 'Short body.'])

    for (const body of bodies) {
      expect(body.classList).toContain('max-h-40')
      expect(body.classList).toContain('overflow-y-auto')
      expect(body.classList).toContain('break-words')
      expect(body.className).not.toMatch(/line-clamp|truncate/)
    }
  })
})
