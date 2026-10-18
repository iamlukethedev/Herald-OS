// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A stand-in for xterm: the key handler the Terminal installs runs first, and a key it lets
// through reaches the shell as xterm would send it (Ctrl+C as ^C).
const xterm = vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

  class FakeTerminal {
    options = {}
    selection = ''
    textarea?: HTMLTextAreaElement
    paste = vi.fn()
    focus = vi.fn()
    keys: (event: KeyboardEvent) => boolean = () => true
    private input: (data: string) => void = () => {}

    constructor() {
      xterm.terminal = this
    }

    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keys = handler
    }

    open(parent: HTMLElement) {
      this.textarea = document.createElement('textarea')
      parent.append(this.textarea)
    }

    /** What xterm does with a key from the keyboard. */
    press(key: string, init: KeyboardEventInit = {}, type = 'keydown'): KeyboardEvent {
      const event = new KeyboardEvent(type, { key, cancelable: true, ...init })

      if (this.keys(event) && type === 'keydown' && event.ctrlKey && /^[a-z]$/i.test(key)) {
        this.input(String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64))
      }

      return event
    }

    getSelection() {
      return this.selection
    }

    hasSelection() {
      return this.selection.length > 0
    }

    onData(listener: (data: string) => void) {
      this.input = listener

      return { dispose() {} }
    }

    onResize() {
      return { dispose() {} }
    }

    loadAddon() {}
    write() {}
    dispose() {}
  }

  return { terminal: null as unknown as FakeTerminal, FakeTerminal }
})

const bridge = vi.hoisted(() => ({ write: vi.fn(), readClipboard: vi.fn(), writeClipboard: vi.fn() }))

vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
vi.mock('../../store/catalog.ts', async () => {
  const { atom } = await import('nanostores')

  return { $catalog: atom({ groups: [], loaded: true }), loadCatalog: vi.fn() }
})
vi.mock('../../store/terminal.ts', async () => {
  const { atom } = await import('nanostores')

  return { $terminalRequest: atom(null) }
})
vi.mock('../../shell/surfaces/shell-utils.ts', () => ({ useShellCommands() {} }))

const { $env, $prefs } = await import('../../store/backend.ts')
const { $notifications } = await import('../../store/notifications.ts')
const { TerminalSurface } = await import('./TerminalSurface.tsx')
const PREFS = $prefs.get()

let root: Root
let container: HTMLDivElement

async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

const menu = () => container.querySelector<HTMLElement>('[role="menu"][aria-label]')
const item = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.startsWith(label))

async function rightClick() {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 30 })
  await act(async () => {
    xterm.terminal.textarea?.dispatchEvent(event)
  })

  return event
}

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0))
  bridge.write.mockReset()
  bridge.readClipboard.mockReset().mockResolvedValue('echo pasted')
  bridge.writeClipboard.mockReset().mockResolvedValue(undefined)
  $notifications.set([])
  $prefs.set({ ...PREFS, language: 'en' })
  $env.set({ hermesHome: '/h/.hermes', homeDir: '/h', version: '0.0.0', isDev: false, platform: 'linux' } as never)
  Object.assign(window, {
    heraldOS: {
      terminal: {
        create: async () => ({ id: 't1', pid: 1, shell: '/bin/bash' }),
        dispose: async () => undefined,
        onData: () => () => {},
        onExit: () => () => {},
        resize: () => {},
        ...bridge
      }
    }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<TerminalSurface />))
  await settle()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('the Terminal keys', () => {
  it('sends Ctrl+C to the shell as an interrupt and copies nothing', () => {
    xterm.terminal.selection = 'selected output'
    const event = xterm.terminal.press('c', { ctrlKey: true })

    expect(event.defaultPrevented).toBe(false)
    expect(bridge.write).toHaveBeenCalledExactlyOnceWith('t1', '\x03')
    expect(bridge.writeClipboard).not.toHaveBeenCalled()
  })

  it('copies the selection with Ctrl+Shift+C, without sending the shell anything', () => {
    xterm.terminal.selection = 'selected output'
    const event = xterm.terminal.press('C', { ctrlKey: true, shiftKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(bridge.writeClipboard).toHaveBeenCalledExactlyOnceWith('selected output')
    expect(bridge.write).not.toHaveBeenCalled()
  })

  it('leaves the clipboard alone when nothing is selected', () => {
    xterm.terminal.press('C', { ctrlKey: true, shiftKey: true })

    expect(bridge.writeClipboard).not.toHaveBeenCalled()
    expect(bridge.write).not.toHaveBeenCalled()
  })

  it('pastes with Ctrl+Shift+V through xterm, not straight to the shell', async () => {
    bridge.readClipboard.mockResolvedValue('first\nsecond')
    const event = xterm.terminal.press('V', { ctrlKey: true, shiftKey: true })
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(xterm.terminal.paste).toHaveBeenCalledExactlyOnceWith('first\nsecond')
    expect(bridge.write).not.toHaveBeenCalled()
  })

  it('finds the keys by position on a layout without Latin letters', () => {
    xterm.terminal.selection = 'selected output'
    xterm.terminal.press('С', { code: 'KeyC', ctrlKey: true, shiftKey: true })

    expect(bridge.writeClipboard).toHaveBeenCalledExactlyOnceWith('selected output')
  })

  it.each([
    ['Alt', { altKey: true }],
    ['Meta', { metaKey: true }],
    ['an IME composition', { isComposing: true }]
  ])('leaves Ctrl+Shift+C with %s to xterm', (_label, init) => {
    xterm.terminal.selection = 'selected output'

    expect(xterm.terminal.keys(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, ...init }))).toBe(true)
    expect(bridge.writeClipboard).not.toHaveBeenCalled()
  })

  it('acts once per press: a held key and its release do nothing more', async () => {
    xterm.terminal.press('V', { ctrlKey: true, shiftKey: true, repeat: true })
    xterm.terminal.press('V', { ctrlKey: true, shiftKey: true }, 'keyup')
    await settle()

    expect(bridge.readClipboard).not.toHaveBeenCalled()
    expect(bridge.write).not.toHaveBeenCalled()
  })

  it('says so when the clipboard cannot be read, and keeps working', async () => {
    bridge.readClipboard.mockRejectedValue(new Error('clipboard-read denied'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    xterm.terminal.press('V', { ctrlKey: true, shiftKey: true })
    await settle()

    expect(xterm.terminal.paste).not.toHaveBeenCalled()
    expect($notifications.get().map(n => [n.title, n.level])).toEqual([['Could not paste into the Terminal', 'error']])

    xterm.terminal.press('c', { ctrlKey: true })
    expect(bridge.write).toHaveBeenCalledWith('t1', '\x03')
  })

  it('says so when the selection cannot be copied', async () => {
    bridge.writeClipboard.mockRejectedValue(new Error('no clipboard'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    xterm.terminal.selection = 'selected output'
    xterm.terminal.press('C', { ctrlKey: true, shiftKey: true })
    await settle()

    expect($notifications.get().map(n => n.title)).toEqual(['Could not copy the selection'])
  })

  it('drops a paste that arrives after the tab closed', async () => {
    let resolve!: (text: string) => void
    bridge.readClipboard.mockImplementation(() => new Promise<string>(done => (resolve = done)))
    const terminal = xterm.terminal
    terminal.press('V', { ctrlKey: true, shiftKey: true })
    act(() => root.unmount())
    resolve('too late')
    await new Promise(done => setTimeout(done, 0))

    expect(terminal.paste).not.toHaveBeenCalled()
    root = createRoot(container)
  })
})

describe('the Terminal menu', () => {
  it('opens on a right-click with Copy and Paste, Copy off with nothing selected', async () => {
    const event = await rightClick()

    expect(event.defaultPrevented).toBe(true)
    expect(menu()?.getAttribute('aria-label')).toBe('Copy and paste')
    expect(item('Copy')?.disabled).toBe(true)
    expect(item('Paste')?.disabled).toBe(false)
    expect(document.activeElement).toBe(item('Paste'))
  })

  it('copies the text that was selected when it opened', async () => {
    xterm.terminal.selection = 'selected output'
    await rightClick()
    xterm.terminal.selection = ''

    expect(document.activeElement).toBe(item('Copy'))
    await act(async () => item('Copy')?.click())

    expect(bridge.writeClipboard).toHaveBeenCalledExactlyOnceWith('selected output')
    expect(menu()).toBeNull()
    expect(xterm.terminal.focus).toHaveBeenCalled()
  })

  it('pastes through xterm', async () => {
    await rightClick()
    await act(async () => item('Paste')?.click())
    await settle()

    expect(xterm.terminal.paste).toHaveBeenCalledExactlyOnceWith('echo pasted')
    expect(bridge.write).not.toHaveBeenCalled()
  })

  it('moves between its items with the arrow keys', async () => {
    xterm.terminal.selection = 'selected output'
    await rightClick()
    const key = (name: string) => act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })))

    key('ArrowDown')
    expect(document.activeElement).toBe(item('Paste'))
    key('ArrowDown')
    expect(document.activeElement).toBe(item('Copy'))
    key('ArrowUp')
    expect(document.activeElement).toBe(item('Paste'))
    key('Home')
    expect(document.activeElement).toBe(item('Copy'))
  })

  it('closes on Escape and gives the keyboard back to the terminal', async () => {
    await rightClick()
    xterm.terminal.focus.mockClear()
    act(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })

    expect(menu()).toBeNull()
    expect(xterm.terminal.focus).toHaveBeenCalled()
    expect(bridge.writeClipboard).not.toHaveBeenCalled()
    expect(xterm.terminal.paste).not.toHaveBeenCalled()
  })

  it('closes on a click outside it, doing nothing', async () => {
    await rightClick()
    expect(menu()).not.toBeNull()
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(menu()).toBeNull()
    expect(bridge.writeClipboard).not.toHaveBeenCalled()
    expect(bridge.readClipboard).not.toHaveBeenCalled()
  })

  it('opens from the keyboard menu key', async () => {
    let event!: KeyboardEvent
    await act(async () => {
      event = xterm.terminal.press('ContextMenu')
    })

    expect(event.defaultPrevented).toBe(true)
    expect(menu()).not.toBeNull()
    expect(bridge.write).not.toHaveBeenCalled()
  })

  it('reads in the chosen language, with the Mac keys on a Mac', async () => {
    act(() => {
      $prefs.set({ ...PREFS, language: 'pt-BR' })
      $env.set({ ...$env.get(), platform: 'darwin' } as never)
    })
    await rightClick()

    expect(menu()?.getAttribute('aria-label')).toBe('Copiar e colar')
    expect(item('Copiar')?.textContent).toContain('⌘C')
    expect(item('Colar')?.textContent).toContain('⌘V')
  })
})
