// @vitest-environment happy-dom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomApproval } from '../model/types.ts'
import { ApprovalPopover } from './ApprovalPopover.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root
let host: HTMLElement

const approval: RoomApproval = {
  requestId: 'q1',
  rpcId: null,
  sessionId: 's1',
  params: { description: 'Delete the Old folder', command: null, tool_name: null, choices: ['once', 'session', 'always', 'deny'], allow_permanent: true, allow_session: true }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe("the Room's approval popover", () => {
  it('draws Deny first, keeps every answer off the tab path, and takes no focus', () => {
    const before = document.activeElement

    act(() => root.render(<ApprovalPopover approval={approval} placement={{ above: true, align: 'center' }} pet={{ width: 96, height: 104, scale: 0.5 }} still popoverRef={createRef()} onChoice={vi.fn()} />))

    const buttons = [...host.querySelectorAll('button')]
    expect(buttons.map(button => button.textContent)).toEqual(['Deny', 'Allow once', 'Allow this session', 'Always allow'])
    expect(buttons.every(button => button.tabIndex === -1)).toBe(true)
    expect(document.activeElement).toBe(before)
  })
})
