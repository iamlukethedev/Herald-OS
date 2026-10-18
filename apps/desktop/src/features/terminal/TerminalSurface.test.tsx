// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A stand-in for xterm 6: the key handler the Terminal installs runs first, and a key it lets
// through reaches the shell as xterm would send it (Ctrl+C as ^C). A paste goes to the shell as
// xterm's Clipboard.ts sends it: line breaks as CR, wrapped in ESC[200~ and ESC[201~ while the
// program has bracketed paste on, and nothing else changed. A paste event that reaches xterm's
// own listeners (on its input and its element) goes the same way, unfiltered, and a copy event
// that reaches xterm's gets the whole selection, as its copyHandler gives it.
const xterm = vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

  class FakeTerminal {
    options = {}
    selection = ''
    bracketedPaste = true
    element?: HTMLElement
    textarea?: HTMLTextAreaElement
    paste = vi.fn((data: string) => this.send(data))
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
      this.element = document.createElement('div')
      this.textarea = document.createElement('textarea')
      this.textarea.className = 'xterm-helper-textarea'
      this.element.append(this.textarea)
      parent.append(this.element)
      const onPaste = (event: ClipboardEvent) => {
        event.stopPropagation()
        this.send(event.clipboardData?.getData('text/plain') ?? '')
      }
      this.textarea.addEventListener('paste', onPaste)
      this.element.addEventListener('paste', onPaste)
      // Where a drop would land if nothing took it first: xterm's hidden input.
      this.textarea.addEventListener('drop', () => xterm.dropsReachingXterm++)
      this.textarea.addEventListener('copy', event => {
        if (this.selection) {
          event.clipboardData?.setData('text/plain', this.selection)
          event.preventDefault()
        }
      })
    }

    private send(data: string) {
      const text = data.replace(/\r?\n/g, '\r')
      this.input(this.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text)
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

  return { terminal: null as unknown as FakeTerminal, FakeTerminal, dropsReachingXterm: 0 }
})

const bridge = vi.hoisted(() => ({ write: vi.fn(), readClipboard: vi.fn(), writeClipboard: vi.fn(), editPerform: vi.fn() }))

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
const { editCommands } = await import('../../commands/edit.ts')
const { defineCommands, resetCommands, runCommand } = await import('../../store/os-commands.ts')
const { rememberFocusedEditable } = await import('../../store/edit-target.ts')
const PREFS = $prefs.get()

let root: Root
let container: HTMLDivElement

async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

/** Everything the shell has been sent. */
const shell = () => bridge.write.mock.calls.map(([, data]) => data as string).join('')

/** A paste event on xterm's input, as Cmd+V, Shift+Insert and Edit > Paste make: it has the keyboard, unless `focus` is false. */
function nativePaste(text: string, { focus = true } = {}): ClipboardEvent {
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/plain', text)
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })

  if (focus) {
    xterm.terminal.textarea?.focus()
  }

  xterm.terminal.textarea?.dispatchEvent(event)

  return event
}

/** A copy event on xterm's input, as Cmd+C, Edit > Copy and a spoken "copy" make. */
function nativeCopy(): { event: ClipboardEvent; copied: string } {
  const clipboardData = new DataTransfer()
  const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData })
  xterm.terminal.textarea?.dispatchEvent(event)

  return { event, copied: clipboardData.getData('text/plain') }
}

/** A drag event on xterm's input carrying `data`; happy-dom's DragEvent does not take a dataTransfer. */
function drag(type: 'dragover' | 'drop', data: Record<string, string> | DataTransfer): DragEvent {
  const dataTransfer = data instanceof DataTransfer ? data : new DataTransfer()

  if (!(data instanceof DataTransfer)) {
    for (const [format, value] of Object.entries(data)) {
      dataTransfer.setData(format, value)
    }
  }

  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  xterm.terminal.textarea?.dispatchEvent(event)

  return event as DragEvent
}

/**
 * A drag released over xterm's input, in Chromium's order: dragover first, then a drop only if
 * dragover accepted it (called preventDefault and left dropEffect other than 'none').
 */
function dragAndDrop(data: Record<string, string>): { over: DragEvent; drop: DragEvent | null } {
  const dataTransfer = new DataTransfer()

  for (const [format, value] of Object.entries(data)) {
    dataTransfer.setData(format, value)
  }

  const over = drag('dragover', dataTransfer)
  const accepted = over.defaultPrevented && dataTransfer.dropEffect !== 'none'

  return { over, drop: accepted ? drag('drop', dataTransfer) : null }
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

// Each test runs a minute after the last, so a notice one test raised is not held back as a repeat in the next.
const realNow = Date.now.bind(Date)
let testsRun = 0
let clock: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  const offset = (testsRun += 1) * 60_000
  clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0))
  bridge.write.mockReset()
  bridge.editPerform.mockReset().mockResolvedValue(undefined)
  bridge.readClipboard.mockReset().mockResolvedValue({ text: 'echo pasted' })
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
        write: bridge.write,
        readClipboard: bridge.readClipboard,
        writeClipboard: bridge.writeClipboard
      },
      edit: { perform: bridge.editPerform }
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
  clock.mockRestore()
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
    bridge.readClipboard.mockResolvedValue({ text: 'first\nsecond' })
    const event = xterm.terminal.press('V', { ctrlKey: true, shiftKey: true })
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(xterm.terminal.paste).toHaveBeenCalledExactlyOnceWith('first\nsecond')
    expect(shell()).toBe('\x1b[200~first\rsecond\x1b[201~')
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

  it('says nothing when the clipboard fails after the tab closed', async () => {
    let reject!: (error: Error) => void
    bridge.readClipboard.mockImplementation(() => new Promise((_done, fail) => (reject = fail)))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    xterm.terminal.press('V', { ctrlKey: true, shiftKey: true })
    act(() => root.unmount())
    reject(new Error('no clipboard'))
    await new Promise(done => setTimeout(done, 0))
    root = createRoot(container)

    expect($notifications.get()).toEqual([])
  })

  it('drops a paste that arrives after the tab closed', async () => {
    let resolve!: (clipboard: { text: string }) => void
    bridge.readClipboard.mockImplementation(() => new Promise<{ text: string }>(done => (resolve = done)))
    const terminal = xterm.terminal
    terminal.press('V', { ctrlKey: true, shiftKey: true })
    act(() => root.unmount())
    resolve({ text: 'too late' })
    await new Promise(done => setTimeout(done, 0))

    expect(terminal.paste).not.toHaveBeenCalled()
    root = createRoot(container)
  })
})

describe('a copy event (Cmd+C, Edit > Copy)', () => {
  it('copies the selection as Ctrl+Shift+C does, and xterm never answers it', () => {
    xterm.terminal.selection = 'selected output'
    const { event, copied } = nativeCopy()

    expect(event.defaultPrevented).toBe(true)
    expect(copied).toBe('')
    expect(bridge.writeClipboard).toHaveBeenCalledExactlyOnceWith('selected output')
  })

  it('holds the copy to the same limit', () => {
    xterm.terminal.selection = 'a'.repeat(1024 * 1024 + 1)
    const { copied } = nativeCopy()

    expect(copied).toBe('')
    expect(bridge.writeClipboard).not.toHaveBeenCalled()
    expect($notifications.get().map(n => n.title)).toEqual(['Too much to copy'])
  })

  it('leaves the clipboard alone with nothing selected', () => {
    const { event } = nativeCopy()

    expect(event.defaultPrevented).toBe(true)
    expect(bridge.writeClipboard).not.toHaveBeenCalled()
  })
})

describe('a spoken or Hermes "paste" into the Terminal', () => {
  beforeEach(() => {
    resetCommands()
    defineCommands(editCommands)
    xterm.terminal.textarea?.focus()
  })

  it('forgets a Terminal that was unmounted, and pastes into the one mounted in its place', async () => {
    const old = xterm.terminal
    const oldInput = old.textarea!
    act(() => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(<TerminalSurface />))
    await settle()
    const fresh = xterm.terminal

    expect(fresh).not.toBe(old)

    // The old input back on the page and focused: nothing of the old Terminal may answer for it.
    document.body.append(oldInput)
    oldInput.focus()
    await runCommand('edit.paste', {}, { source: 'voice' })
    oldInput.remove()

    expect(bridge.readClipboard).not.toHaveBeenCalled()
    expect(bridge.editPerform).toHaveBeenCalledExactlyOnceWith({ kind: 'paste' })

    bridge.readClipboard.mockResolvedValue({ text: 'echo fresh' })
    fresh.textarea!.focus()
    const result = await runCommand('edit.paste', {}, { source: 'voice' })

    expect(result).toMatchObject({ ok: true, summary: 'Pasted into the terminal' })
    expect(fresh.paste).toHaveBeenCalledExactlyOnceWith('echo fresh')
    expect(old.paste).not.toHaveBeenCalled()
  })

  it('pastes nothing, and does not say it pasted, when the Terminal is unmounted while the clipboard is read', async () => {
    let resolve!: (clipboard: { text: string }) => void
    bridge.readClipboard.mockImplementation(() => new Promise<{ text: string }>(done => (resolve = done)))
    const terminal = xterm.terminal
    const pending = runCommand('edit.paste', {}, { source: 'voice' })
    await settle()
    act(() => root.unmount())
    resolve({ text: 'echo too late\r' })
    const result = await pending
    root = createRoot(container)

    expect(bridge.readClipboard).toHaveBeenCalledOnce()
    expect(terminal.paste).not.toHaveBeenCalled()
    expect(bridge.write).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.summary).not.toMatch(/^Pasted/)
  })

  it('does not take a spoken paste into a Terminal that cannot have the keyboard, such as a hidden tab', async () => {
    const input = xterm.terminal.textarea!
    rememberFocusedEditable()
    input.blur()
    // A hidden tab's input is still on the page but cannot take the focus.
    vi.spyOn(input, 'focus').mockImplementation(() => {})
    const result = await runCommand('edit.paste', {}, { source: 'voice' })

    expect(result).toMatchObject({ ok: false, error: 'Nothing to type into. Click a text field (or the terminal) first, then say it again.' })
    expect(bridge.readClipboard).not.toHaveBeenCalled()
    expect(bridge.editPerform).not.toHaveBeenCalled()
    expect(xterm.terminal.paste).not.toHaveBeenCalled()
  })

  it('takes a spoken "copy" as a copy: the clipboard is not read and nothing is pasted', async () => {
    xterm.terminal.selection = 'selected output'
    const result = await runCommand('edit.copy', {}, { source: 'voice' })
    await settle()

    expect(result).toMatchObject({ ok: true, summary: 'Copied' })
    expect(bridge.editPerform).toHaveBeenCalledExactlyOnceWith({ kind: 'copy' })
    expect(bridge.readClipboard).not.toHaveBeenCalled()
    expect(xterm.terminal.paste).not.toHaveBeenCalled()
    expect(bridge.write).not.toHaveBeenCalled()
  })

  it('pastes through main and the filter, and says it did', async () => {
    bridge.readClipboard.mockResolvedValue({ text: '\x1b[201~echo pwned\r' })
    const result = await runCommand('edit.paste', {}, { source: 'voice' })
    await settle()

    expect(result).toMatchObject({ ok: true, summary: 'Pasted into the terminal' })
    expect(shell()).toBe('\x1b[200~echo pwned\r\x1b[201~')
    expect(bridge.editPerform).not.toHaveBeenCalled()
  })

  it.each([
    ['its window is in the background', { refused: 'unfocused' }, 'The Terminal pastes only while its window is in front. Click in the Terminal, then paste again.'],
    ['pastes come too fast', { refused: 'rate-limited' }, 'The Terminal pastes a few times a second at most. Wait a moment, then paste again.'],
    ['the clipboard holds too much', { tooLarge: true }, 'The clipboard holds more than 1 MiB of text, more than the Terminal pastes at once.'],
    ['the clipboard holds no text', { text: '\x1b\x7f' }, 'The clipboard has no text to paste.']
  ])('does not claim a paste when %s', async (_label, clipboard, reason) => {
    bridge.readClipboard.mockResolvedValue(clipboard)
    const result = await runCommand('edit.paste', {}, { source: 'voice' })

    expect(result).toMatchObject({ ok: false, error: reason })
    expect(result.summary).not.toMatch(/^Pasted/)
    expect(bridge.write).not.toHaveBeenCalled()
    expect(bridge.editPerform).not.toHaveBeenCalled()
  })

  it('does not claim a paste when the clipboard cannot be read', async () => {
    bridge.readClipboard.mockRejectedValue(new Error('no clipboard'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await runCommand('edit.paste', {}, { source: 'voice' })

    expect(result).toMatchObject({ ok: false, error: 'Herald OS could not reach the system clipboard. Try again in a moment.' })
  })
})

describe('a drop on the Terminal', () => {
  it('pastes dropped text, filtered, and leaves nothing in xterm’s input', async () => {
    // What Chromium would have put in the hidden input, had the drop not been taken.
    xterm.terminal.textarea!.value = '\x1b[201~echo pwned\r'
    // Mounting focused the terminal; only the drop may focus it now.
    xterm.terminal.textarea!.blur()
    xterm.terminal.focus.mockClear()
    const { over, drop } = dragAndDrop({ 'text/plain': '\x1b[201~echo pwned\r' })
    await settle()

    expect(over.dataTransfer?.dropEffect).toBe('copy')
    expect(drop?.defaultPrevented).toBe(true)
    expect(shell()).toBe('\x1b[200~echo pwned\r\x1b[201~')
    expect(xterm.terminal.textarea!.value).toBe('')
    expect(xterm.terminal.focus).toHaveBeenCalledOnce()
  })

  it('holds dropped text to the paste limit', async () => {
    dragAndDrop({ 'text/plain': 'a'.repeat(1024 * 1024 + 1) })
    await settle()

    expect(bridge.write).not.toHaveBeenCalled()
    expect($notifications.get().map(n => [n.title, n.body])).toEqual([
      ['Too much to paste', 'The dropped text is more than 1 MiB, more than the Terminal pastes at once.']
    ])
  })

  it('takes a drop on its way down, before xterm’s input or anything above the Terminal sees it', async () => {
    xterm.dropsReachingXterm = 0
    let reachedDocument = 0
    const onDocument = () => reachedDocument++
    document.addEventListener('drop', onDocument)
    dragAndDrop({ 'text/plain': 'echo hello' })
    dragAndDrop({ Files: '' })
    await settle()
    document.removeEventListener('drop', onDocument)

    expect(xterm.dropsReachingXterm).toBe(0)
    expect(reachedDocument).toBe(0)
  })

  it.each([
    ['a file', { Files: '' }],
    ['a picture', { Files: '', 'image/png': '' }],
    ['a file:// link with no text', { 'text/uri-list': 'file:///etc/passwd' }],
    ['a link from an app that sends only text/x-moz-url', { 'text/x-moz-url': 'https://example.com/\nExample' }]
  ])('accepts %s while it is dragged over, then refuses it on the drop, pasting nothing and saying so', async (_label, data) => {
    const { over, drop } = dragAndDrop(data)
    await settle()

    expect(over.defaultPrevented).toBe(true)
    expect(over.dataTransfer?.dropEffect).toBe('copy')
    expect(drop?.defaultPrevented).toBe(true)
    expect(bridge.write).not.toHaveBeenCalled()
    expect(xterm.terminal.paste).not.toHaveBeenCalled()
    expect($notifications.get().map(n => [n.title, n.body])).toEqual([
      ['That can’t be dropped here', 'Only text is pasted. A link or picture dragged from a browser pastes as its address; files can’t be dropped.']
    ])
  })

  it('says only text can be dropped once in five seconds, not once a drop', async () => {
    let now = Date.now()
    clock.mockImplementation(() => now)
    const raised: string[] = []
    const stop = $notifications.listen(list => raised.push(list[0]?.title ?? ''))

    const first = dragAndDrop({ Files: '' })
    now += 1000
    const second = dragAndDrop({ Files: '', 'image/png': '' })
    await settle()

    expect(raised).toEqual(['That can’t be dropped here'])
    expect(first.drop?.defaultPrevented).toBe(true)
    expect(second.drop?.defaultPrevented).toBe(true)

    now += 5000
    dragAndDrop({ Files: '' })
    await settle()
    stop()

    expect(raised).toEqual(['That can’t be dropped here', 'That can’t be dropped here'])
    expect(bridge.write).not.toHaveBeenCalled()
  })

  it('pastes a picture dragged from a browser as its address, bracketed, with no notice', async () => {
    const url = 'https://example.com/images/cat.png'
    const { drop } = dragAndDrop({ 'text/uri-list': url, 'text/html': `<img src="${url}">`, 'text/plain': url })
    await settle()

    expect(drop?.defaultPrevented).toBe(true)
    expect(shell()).toBe(`\x1b[200~${url}\x1b[201~`)
    expect($notifications.get()).toEqual([])
  })

  it('pastes a link dragged from a browser as its address, bracketed, with no notice', async () => {
    const url = 'https://example.com/docs?page=2'
    const { over, drop } = dragAndDrop({ 'text/uri-list': url, 'text/plain': url })
    await settle()

    expect(over.dataTransfer?.dropEffect).toBe('copy')
    expect(drop?.defaultPrevented).toBe(true)
    expect(shell()).toBe(`\x1b[200~${url}\x1b[201~`)
    expect($notifications.get()).toEqual([])
  })

  it.each([
    ['pt-BR', 'Não dá para soltar isso aqui', 'O Terminal cola só texto. Um link ou uma imagem arrastados do navegador entram como endereço; já arquivos não podem ser soltos aqui.'],
    ['zh-CN', '无法拖入此内容', '终端只粘贴文本。从浏览器拖入的链接或图片会粘贴成链接地址；文件无法拖入。']
  ] as const)('says the same in %s', async (language, title, body) => {
    act(() => $prefs.set({ ...PREFS, language }))
    dragAndDrop({ Files: '' })
    await settle()

    expect($notifications.get().map(n => [n.title, n.body])).toEqual([[title, body]])
  })

  it('does not accept a drag that carries nothing', async () => {
    const { over, drop } = dragAndDrop({})
    await settle()

    expect(over.dataTransfer?.dropEffect).toBe('none')
    expect(drop).toBeNull()
    expect($notifications.get()).toEqual([])
  })
})

describe('what a paste sends the shell', () => {
  const PATHS: [string, (text: string) => Promise<void>][] = [
    [
      'Ctrl+Shift+V',
      async text => {
        bridge.readClipboard.mockResolvedValue({ text })
        xterm.terminal.press('V', { ctrlKey: true, shiftKey: true })
        await settle()
      }
    ],
    [
      'the menu’s Paste',
      async text => {
        bridge.readClipboard.mockResolvedValue({ text })
        await rightClick()
        await act(async () => item('Paste')?.click())
        await settle()
      }
    ],
    [
      'a paste event (Cmd+V, Shift+Insert)',
      async text => {
        nativePaste(text)
        await settle()
      }
    ]
  ]

  const CLIPBOARDS: [string, string, string][] = [
    ['ESC[201~ at the start', '\x1b[201~echo pwned\r', 'echo pwned\r'],
    ['ESC[201~ in the middle', 'echo safe\x1b[201~echo pwned\r', 'echo safeecho pwned\r'],
    ['ESC[201~ at the end', 'echo safe\x1b[201~', 'echo safe'],
    ['ESC[200~ at the start', '\x1b[200~echo pwned', 'echo pwned'],
    ['ESC[200~ in the middle', 'echo safe\x1b[200~echo pwned', 'echo safeecho pwned'],
    ['ESC[200~ at the end', 'echo safe\x1b[200~', 'echo safe'],
    ['a bare ESC', 'echo \x1bsafe\x1b', 'echo safe'],
    ['the 8-bit CSI and 201~', '\x9b201~echo pwned\r', 'echo pwned\r'],
    ['other C0 controls and DEL', 'echo\x00\x03\x04\x08\x1a\x7f safe', 'echo safe'],
    ['lines and tabs', 'echo one\necho two\r\nprintf "a\tb"\n', 'echo one\recho two\rprintf "a\tb"\r']
  ]

  for (const [path, paste] of PATHS) {
    it.each(CLIPBOARDS)(`through ${path}, with %s`, async (_label, clipboard, expected) => {
      await paste(clipboard)

      expect(shell()).toBe(`\x1b[200~${expected}\x1b[201~`)
    })
  }

  it('pastes nothing from a paste event while the window is in the background', async () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const event = nativePaste('echo hello\r')
    await settle()
    focus.mockRestore()

    expect(event.defaultPrevented).toBe(true)
    expect(xterm.terminal.paste).not.toHaveBeenCalled()
    expect(bridge.write).not.toHaveBeenCalled()
  })

  it('pastes nothing from a paste event aimed at a terminal without the keyboard', async () => {
    const elsewhere = document.createElement('input')
    document.body.append(elsewhere)
    elsewhere.focus()
    const event = nativePaste('echo hello\r', { focus: false })
    await settle()
    elsewhere.remove()

    expect(event.defaultPrevented).toBe(true)
    expect(bridge.write).not.toHaveBeenCalled()
  })

  it('says why a paste event into a window in the background pasted nothing, once in five seconds', async () => {
    let now = Date.now()
    clock.mockImplementation(() => now)
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const raised: string[] = []
    const stop = $notifications.listen(list => raised.push(list[0]?.body ?? ''))

    nativePaste('echo hello\r')
    expect($notifications.get()[0]?.title).toBe('The Terminal is not in front')
    now += 1000
    nativePaste('echo hello\r')
    await settle()

    expect(raised).toEqual(['The Terminal pastes only while its window is in front. Click in the Terminal, then paste again.'])

    now += 5000
    nativePaste('echo hello\r')
    await settle()
    stop()
    focus.mockRestore()

    expect(raised).toHaveLength(2)
    expect(bridge.write).not.toHaveBeenCalled()
  })

  it('takes a paste event from xterm, which never sees it', async () => {
    const event = nativePaste('\x1b[201~echo pwned\r')
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(xterm.terminal.paste).toHaveBeenCalledExactlyOnceWith('echo pwned\r')
    expect(bridge.write).toHaveBeenCalledOnce()
  })

  it('filters one paste event as a whole, before xterm splits anything', async () => {
    const big = `${'x'.repeat(5000)}\x1b[201~echo pwned\r${'y'.repeat(5000)}`
    nativePaste(big)
    await settle()

    expect(xterm.terminal.paste).toHaveBeenCalledExactlyOnceWith(`${'x'.repeat(5000)}echo pwned\r${'y'.repeat(5000)}`)
  })

  it('cannot be fooled by a marker split across two pastes', async () => {
    nativePaste('echo safe\x1b')
    nativePaste('[201~echo pwned\r')
    await settle()

    expect(shell()).toBe('\x1b[200~echo safe\x1b[201~\x1b[200~[201~echo pwned\r\x1b[201~')
  })

  it('says the window has to be in front when main refuses a background window', async () => {
    bridge.readClipboard.mockResolvedValue({ refused: 'unfocused' })
    xterm.terminal.press('V', { ctrlKey: true, shiftKey: true })
    await settle()

    expect(xterm.terminal.paste).not.toHaveBeenCalled()
    expect($notifications.get().map(n => [n.title, n.body])).toEqual([
      ['The Terminal is not in front', 'The Terminal pastes only while its window is in front. Click in the Terminal, then paste again.']
    ])
  })

  it('says once, not once a press, that pastes are coming too fast', async () => {
    let now = 50_000_000
    clock.mockImplementation(() => now)
    bridge.readClipboard.mockResolvedValue({ refused: 'rate-limited' })
    const raised: string[] = []
    const stop = $notifications.listen(list => raised.push(list[0]?.title ?? ''))

    for (let i = 0; i < 4; i++) {
      xterm.terminal.press('V', { ctrlKey: true, shiftKey: true })
      await settle()
      now += 500
    }

    expect(raised).toEqual(['Pasting too fast'])
    expect($notifications.get().map(n => n.body)).toEqual(['The Terminal pastes a few times a second at most. Wait a moment, then paste again.'])

    now += 5000
    xterm.terminal.press('V', { ctrlKey: true, shiftKey: true })
    await settle()
    stop()

    expect(raised).toEqual(['Pasting too fast', 'Pasting too fast'])
    expect(xterm.terminal.paste).not.toHaveBeenCalled()
  })

  it('says so, and pastes nothing, when the clipboard holds more than the Terminal pastes at once', async () => {
    bridge.readClipboard.mockResolvedValue({ tooLarge: true })
    xterm.terminal.press('V', { ctrlKey: true, shiftKey: true })
    await settle()

    expect(xterm.terminal.paste).not.toHaveBeenCalled()
    expect($notifications.get().map(n => [n.title, n.body, n.level])).toEqual([['Too much to paste', 'The clipboard holds more than 1 MiB of text, more than the Terminal pastes at once.', 'warn']])
  })

  it.each([
    ['pt-BR', 'A área de transferência tem mais de 1 MiB de texto, mais do que o Terminal cola de uma vez.'],
    ['zh-CN', '剪贴板中的文本超过 1 MiB，超出了终端一次能粘贴的上限。']
  ] as const)('names the limit as 1 MiB in %s too', async (language, body) => {
    act(() => $prefs.set({ ...PREFS, language }))
    bridge.readClipboard.mockResolvedValue({ tooLarge: true })
    xterm.terminal.press('V', { ctrlKey: true, shiftKey: true })
    await settle()

    expect($notifications.get().map(n => n.body)).toEqual([body])
  })

  it('holds a paste event to the same limit', async () => {
    const event = nativePaste('a'.repeat(1024 * 1024 + 1))
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(bridge.write).not.toHaveBeenCalled()
    expect($notifications.get().map(n => n.title)).toEqual(['Too much to paste'])
  })

  it('says so, and copies nothing, when the selection is more than it copies at once', () => {
    xterm.terminal.selection = 'a'.repeat(1024 * 1024 + 1)
    xterm.terminal.press('C', { ctrlKey: true, shiftKey: true })

    expect(bridge.writeClipboard).not.toHaveBeenCalled()
    expect($notifications.get().map(n => n.title)).toEqual(['Too much to copy'])
  })

  it('sends nothing for a clipboard of nothing but controls', async () => {
    nativePaste('\x1b[201~\x1b\x9b\x7f')
    await settle()

    expect(bridge.write).not.toHaveBeenCalled()
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
    expect(shell()).toBe('\x1b[200~echo pasted\x1b[201~')
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

  it.each([
    ['the menu key', 'ContextMenu', {}],
    ['Shift+F10', 'F10', { shiftKey: true }]
  ])('opens from the keyboard with %s', async (_label, key, init) => {
    let event!: KeyboardEvent
    await act(async () => {
      event = xterm.terminal.press(key, init)
    })

    expect(event.defaultPrevented).toBe(true)
    expect(menu()).not.toBeNull()
    expect(document.activeElement).toBe(item('Paste'))
    expect(bridge.write).not.toHaveBeenCalled()
  })

  it('leaves F10 without Shift, and Ctrl+Shift+F10, to the program', () => {
    expect(xterm.terminal.keys(new KeyboardEvent('keydown', { key: 'F10' }))).toBe(true)
    expect(xterm.terminal.keys(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, ctrlKey: true }))).toBe(true)
    expect(menu()).toBeNull()
  })

  it('gives the keyboard back to the terminal when the window loses focus', async () => {
    await rightClick()
    xterm.terminal.focus.mockClear()
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })

    expect(menu()).toBeNull()
    expect(xterm.terminal.focus).toHaveBeenCalled()
  })

  it('names each item’s keys for assistive technology', async () => {
    await rightClick()

    expect(item('Copy')?.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+C')
    expect(item('Paste')?.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+V')
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
    expect(item('Copiar')?.getAttribute('aria-keyshortcuts')).toBe('Meta+C Control+Shift+C')
    expect(item('Colar')?.getAttribute('aria-keyshortcuts')).toBe('Meta+V Control+Shift+V')
  })
})
